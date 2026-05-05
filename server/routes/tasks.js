import express from "express";
import pool from "../db.js";
import { isValidYmd } from "../../lib/time.js";

const router = express.Router();

function isString(v) {
  return typeof v === "string";
}

// Per-task ownership gate. Admin always passes; counsellors only on
// tasks they're either directly assigned to (assignee_id = self) OR
// pinned to a student whose lead.counsellor_id is them. Mirrors the
// client-side visibility filter so wire and UI agree.
//
// 404 (not 403) for non-owners so a poker can't probe ID space. Path
// param is validated as digits-only here too — without that, a request
// like /api/tasks/abc/archive would cast-error at the bigint layer
// and surface as a 500.
async function checkTaskAccess(req, res, taskId) {
  if (!/^\d+$/.test(String(taskId))) {
    res.status(400).json({ error: "invalid task id" });
    return false;
  }
  const { rows } = await pool.query(
    `SELECT t.assignee_id, l.counsellor_id AS lead_counsellor_id
     FROM counsellor_tasks t
     LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.id = $1`,
    [taskId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "task not found" });
    return false;
  }
  if (req.user?.kind === "admin") return true;
  const me = req.user?.counsellorId;
  if (rows[0].assignee_id !== me && rows[0].lead_counsellor_id !== me) {
    res.status(404).json({ error: "task not found" });
    return false;
  }
  return true;
}

// Single source of truth for the joined SELECT used after every mutation.
// LEFT JOIN both leads and counsellors because tasks may have a free-text
// student_name (no lead FK) and may also be unassigned. The optional
// appointment join surfaces the session a task was logged from so the UI
// can render a "from session of <date>" badge without a second round-trip.
// comment_count is a correlated subquery so the row carries the badge
// number for the UI's Comment button without an N+1 fetch.
const SELECT_JOINED = `
  SELECT t.*,
         l.name AS lead_name,
         l.archived AS student_archived,
         c.name AS assignee_name,
         la.scheduled_for AS appointment_scheduled_for,
         (SELECT COUNT(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count
  FROM counsellor_tasks t
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN counsellors c ON c.id = t.assignee_id
  LEFT JOIN lead_appointments la ON la.id = t.appointment_id
`;

// GET /api/tasks — admin sees the flat list of every task. Counsellors
// see only tasks they own (assignee_id = self OR lead.counsellor_id =
// self). Server-side scoping prevents another counsellor's tasks
// leaking via devtools — without it, the client filter alone meant the
// raw network response carried tasks from across the firm.
//
// Default hides archived; ?include_archived=true returns both sets.
router.get("/", async (req, res, next) => {
  try {
    const includeArchived = req.query.include_archived === "true";
    const conds = [];
    const params = [];
    if (!includeArchived) conds.push("t.archived = FALSE");
    if (req.user?.kind === "counsellor") {
      params.push(req.user.counsellorId);
      const i = `$${params.length}`;
      conds.push(`(t.assignee_id = ${i} OR l.counsellor_id = ${i})`);
    }
    // Optional ?appointment_id=N filter — used by the Session popup to
    // list only the tasks created during one specific appointment. The
    // counsellor scope above still applies so a counsellor can never see
    // another counsellor's session-tasks via this filter.
    if (req.query.appointment_id !== undefined) {
      const apptId = String(req.query.appointment_id);
      if (!/^\d+$/.test(apptId)) {
        return res.status(400).json({ error: "appointment_id must be a positive integer" });
      }
      params.push(apptId);
      conds.push(`t.appointment_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `${SELECT_JOINED} ${where}
       ORDER BY t.priority DESC, t.due_date ASC, t.id ASC`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks — create a new task. Either lead_id (FK to a real lead)
// or student_name (free-text label) is required for the student field.
// assignee_id is optional — admin's create flow sets it, counsellor's
// create flow auto-assigns to themselves (also via assignee_id). Tasks
// with no assignee render as "Unassigned" in the admin view.
router.post("/", async (req, res, next) => {
  try {
    let { lead_id, student_name, assignee_id, text, due_date, priority, appointment_id } = req.body;
    if (
      (lead_id === undefined || lead_id === null || lead_id === "") &&
      (student_name === undefined || student_name === null || student_name === "")
    ) {
      return res.status(400).json({ error: "lead_id or student_name is required" });
    }
    if (lead_id) {
      if (!isString(lead_id) || lead_id.length > 50) {
        return res.status(400).json({ error: "lead_id must be a string up to 50 chars" });
      }
    }
    if (student_name) {
      if (!isString(student_name) || student_name.length > 200) {
        return res.status(400).json({ error: "student_name must be a string up to 200 chars" });
      }
    }
    if (assignee_id) {
      if (!isString(assignee_id) || assignee_id.length > 50) {
        return res.status(400).json({ error: "assignee_id must be a string up to 50 chars" });
      }
    }
    if (!isString(text) || text.trim().length < 1 || text.length > 1000) {
      return res.status(400).json({ error: "text must be 1–1000 chars" });
    }
    if (!isValidYmd(due_date)) {
      return res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" });
    }

    // Counsellors: clamp assignee_id to self regardless of body
    // (stops them dumping work onto someone else's queue) and refuse
    // a lead_id they don't manage.
    //
    // Admin: assignee_id is REQUIRED. Letting it be null would create
    // an "Unassigned" task that nobody owns — same fabrication risk
    // class as orphan leads. The UI already enforces this; the server
    // check is the second line of defense for direct API calls.
    if (req.user?.kind === "counsellor") {
      assignee_id = req.user.counsellorId;
      if (lead_id) {
        const own = await pool.query(
          "SELECT 1 FROM leads WHERE id = $1 AND counsellor_id = $2",
          [lead_id, req.user.counsellorId]
        );
        if (own.rows.length === 0) {
          return res.status(404).json({ error: "lead not found" });
        }
      }
    } else {
      if (!isString(assignee_id) || assignee_id.trim().length === 0) {
        return res.status(400).json({ error: "assignee_id is required" });
      }
    }

    const cleanLeadId = lead_id || null;
    const cleanStudentName =
      student_name && student_name.trim() ? student_name.trim() : null;
    const cleanAssigneeId = assignee_id || null;

    if (cleanLeadId && req.user?.kind === "admin") {
      const leadCheck = await pool.query("SELECT 1 FROM leads WHERE id = $1", [cleanLeadId]);
      if (leadCheck.rows.length === 0) {
        return res.status(404).json({ error: "lead not found" });
      }
    }
    if (cleanAssigneeId) {
      const cCheck = await pool.query("SELECT 1 FROM counsellors WHERE id = $1", [cleanAssigneeId]);
      if (cCheck.rows.length === 0) {
        return res.status(404).json({ error: "assignee (counsellor) not found" });
      }
    }

    // Optional appointment_id (integer) — must point at an appointment
    // belonging to the same lead the task is attached to. Without that
    // pairing check, a caller could link a task to an unrelated lead's
    // appointment and the badge would render the wrong session date.
    let cleanAppointmentId = null;
    if (appointment_id !== undefined && appointment_id !== null && appointment_id !== "") {
      const apptStr = String(appointment_id);
      if (!/^\d+$/.test(apptStr)) {
        return res.status(400).json({ error: "appointment_id must be a positive integer" });
      }
      if (!cleanLeadId) {
        return res.status(400).json({ error: "appointment_id requires a lead_id" });
      }
      const apptCheck = await pool.query(
        "SELECT 1 FROM lead_appointments WHERE id = $1 AND lead_id = $2",
        [apptStr, cleanLeadId]
      );
      if (apptCheck.rows.length === 0) {
        return res.status(404).json({ error: "appointment not found for this lead" });
      }
      cleanAppointmentId = apptStr;
    }

    const { rows } = await pool.query(
      `INSERT INTO counsellor_tasks (lead_id, student_name, assignee_id, text, due_date, priority, appointment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [cleanLeadId, cleanStudentName, cleanAssigneeId, text.trim(), due_date, !!priority, cleanAppointmentId]
    );
    const { rows: enriched } = await pool.query(
      `${SELECT_JOINED} WHERE t.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tasks/:id — toggle priority/completed, edit text, change date,
// or rename the free-text student. Counsellors can only patch tasks they
// own and cannot reassign them; admin has full reach.
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;

    // Admin can edit anything about a task. Counsellors are restricted
    // to status toggles (priority pin + done). They cannot rewrite the
    // task text, change the due date, or rename the student — that's
    // admin-only since the admin is the one assigning work. If a
    // counsellor needs to add context they use the comments thread.
    const allowedAll = ["text", "due_date", "priority", "completed", "student_name", "assignee_id", "lead_id"];
    const allowedCounsellor = ["priority", "completed"];
    const allowed = req.user?.kind === "admin" ? allowedAll : allowedCounsellor;
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (fields.length === 0) {
      return res.status(400).json({ error: "no valid fields to update" });
    }
    if (req.body.text !== undefined) {
      if (!isString(req.body.text) || req.body.text.trim().length < 1 || req.body.text.length > 1000) {
        return res.status(400).json({ error: "text must be 1–1000 chars" });
      }
    }
    if (req.body.due_date !== undefined) {
      if (!isValidYmd(req.body.due_date)) {
        return res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" });
      }
    }
    if (req.body.student_name) {
      if (!isString(req.body.student_name) || req.body.student_name.length > 200) {
        return res.status(400).json({ error: "student_name must be a string up to 200 chars" });
      }
    }
    if (req.body.assignee_id) {
      if (!isString(req.body.assignee_id) || req.body.assignee_id.length > 50) {
        return res.status(400).json({ error: "assignee_id must be a string up to 50 chars" });
      }
    }
    if (req.body.lead_id) {
      if (!isString(req.body.lead_id) || req.body.lead_id.length > 50) {
        return res.status(400).json({ error: "lead_id must be a string up to 50 chars" });
      }
    }

    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => {
      const v = req.body[f];
      if (f === "text" && typeof v === "string") return v.trim();
      if (f === "student_name") {
        if (typeof v !== "string") return null;
        return v.trim() || null;
      }
      // assignee_id / lead_id: coerce empty string to null so admin can
      // unassign a task or unlink it from a lead via the form.
      if (f === "assignee_id" || f === "lead_id") {
        return v && v !== "" ? v : null;
      }
      if (f === "priority" || f === "completed") return !!v;
      return v;
    })];

    const { rows } = await pool.query(
      `UPDATE counsellor_tasks SET ${set}, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: "task not found" });

    const { rows: enriched } = await pool.query(
      `${SELECT_JOINED} WHERE t.id = $1`,
      [rows[0].id]
    );
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/:id/archive — soft-delete: hide from active list but
// keep the row recoverable via the Archived section.
router.post("/:id/archive", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;
    const { rows } = await pool.query(
      `UPDATE counsellor_tasks
       SET archived = TRUE, archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived = FALSE
       RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT archived FROM counsellor_tasks WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "task not found" });
      const { rows: current } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
      return res.json(current[0]);
    }
    const { rows: enriched } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/unarchive", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;
    const { rows } = await pool.query(
      `UPDATE counsellor_tasks
       SET archived = FALSE, archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND archived = TRUE
       RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT archived FROM counsellor_tasks WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "task not found" });
      const { rows: current } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
      return res.json(current[0]);
    }
    const { rows: enriched } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// GET /api/tasks/:id/comments — chronological list. Same access gate as
// the task itself: admin sees any task's thread, counsellors only see
// threads on tasks they own.
router.get("/:id/comments", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;
    const { rows } = await pool.query(
      `SELECT tc.id, tc.task_id, tc.author_counsellor_id, tc.author_kind,
              tc.body, tc.created_at,
              c.name AS author_name
         FROM task_comments tc
    LEFT JOIN counsellors c ON c.id = tc.author_counsellor_id
        WHERE tc.task_id = $1
     ORDER BY tc.created_at ASC, tc.id ASC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/:id/comments — append a comment. Append-only by
// design: no PATCH/DELETE so the thread stays an honest record.
// Author_kind tracks whether admin or counsellor wrote it; admin posts
// have null author_counsellor_id.
router.post("/:id/comments", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;
    const { body } = req.body;
    if (!isString(body) || body.trim().length < 1 || body.length > 2000) {
      return res.status(400).json({ error: "body must be 1–2000 chars" });
    }
    const kind = req.user?.kind;
    const authorCounsellorId = kind === "counsellor" ? req.user.counsellorId : null;
    const { rows } = await pool.query(
      `INSERT INTO task_comments (task_id, author_counsellor_id, author_kind, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, task_id, author_counsellor_id, author_kind, body, created_at`,
      [id, authorCounsellorId, kind, body.trim()]
    );
    const enriched = await pool.query(
      `SELECT tc.id, tc.task_id, tc.author_counsellor_id, tc.author_kind,
              tc.body, tc.created_at,
              c.name AS author_name
         FROM task_comments tc
    LEFT JOIN counsellors c ON c.id = tc.author_counsellor_id
        WHERE tc.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(enriched.rows[0]);
  } catch (e) {
    next(e);
  }
});

export default router;
