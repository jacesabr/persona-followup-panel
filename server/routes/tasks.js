import express from "express";
import pool from "../db.js";
import { isValidYmd } from "../../lib/time.js";
import { adminUsernameSet } from "../admins.js";

const router = express.Router();

function isString(v) {
  return typeof v === "string";
}

// Per-task ownership gate. Returns the task row on success, null on failure
// (caller should return immediately when null). 404 instead of 403 so
// a probe can't distinguish "not yours" from "doesn't exist".
//
// Access rules:
//   admin → always allowed
//   counsellor on assignee_kind='admin' task → only the creator (creator_id = me)
//   counsellor on assignee_kind='counsellor' task → assignee_id = me, OR
//     lead.counsellor_id = me, OR the assignee is a counsellor I supervise
async function checkTaskAccess(req, res, taskId) {
  if (!/^\d+$/.test(String(taskId))) {
    res.status(400).json({ error: "invalid task id" });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT t.assignee_id, t.assignee_kind, t.assignee_admin_username,
            t.creator_id, t.creator_kind,
            l.counsellor_id AS lead_counsellor_id
     FROM counsellor_tasks t
     LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.id = $1`,
    [taskId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "task not found" });
    return null;
  }
  if (req.user?.kind === "admin") return rows[0];

  const me = req.user?.counsellorId;
  const t = rows[0];

  if (t.assignee_kind === "admin") {
    // Counsellor can only access an admin-assigned task they themselves created
    if (t.creator_id === me) return t;
    res.status(404).json({ error: "task not found" });
    return null;
  }

  // assignee_kind = 'counsellor'
  if (t.assignee_id === me || t.lead_counsellor_id === me) return t;

  // Check supervisor: can I see tasks assigned to counsellors I supervise?
  if (t.assignee_id) {
    const { rows: sub } = await pool.query(
      "SELECT 1 FROM counsellors WHERE id = $1 AND supervisor_id = $2",
      [t.assignee_id, me]
    );
    if (sub.length > 0) return t;
  }

  res.status(404).json({ error: "task not found" });
  return null;
}

// Joined SELECT reused after every mutation. Includes assignee_kind and
// assignee_admin_username so the client can display admin-assigned tasks
// correctly and hide archive/delete controls on them.
const SELECT_JOINED = `
  SELECT t.*,
         l.name AS lead_name,
         l.archived AS student_archived,
         c.name AS assignee_name,
         la.scheduled_for AS appointment_scheduled_for,
         (SELECT COUNT(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count,
         lc.body       AS latest_comment_body,
         lc.created_at AS latest_comment_at,
         lc.author_kind AS latest_comment_author_kind,
         lc.author_name AS latest_comment_author_name
  FROM counsellor_tasks t
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN counsellors c ON c.id = t.assignee_id
  LEFT JOIN lead_appointments la ON la.id = t.appointment_id
  LEFT JOIN LATERAL (
    SELECT tc.body, tc.created_at, tc.author_kind, ac.name AS author_name
    FROM task_comments tc
    LEFT JOIN counsellors ac ON ac.id = tc.author_counsellor_id
    WHERE tc.task_id = t.id
    ORDER BY tc.created_at DESC
    LIMIT 1
  ) lc ON TRUE
`;

// GET /api/tasks
// Admin: all tasks (counsellor-assigned + admin-assigned).
// Counsellor: tasks where they are the assignee, the lead owner, OR a
//   direct supervisor of the assignee — PLUS admin-assigned tasks they
//   themselves created.
router.get("/", async (req, res, next) => {
  try {
    const includeArchived = req.query.include_archived === "true";
    const conds = [];
    const params = [];
    if (!includeArchived) conds.push("t.archived = FALSE");
    if (req.user?.kind === "counsellor") {
      params.push(req.user.counsellorId);
      const i = `$${params.length}`;
      conds.push(`(
        (t.assignee_kind = 'counsellor' AND (t.assignee_id = ${i} OR l.counsellor_id = ${i}))
        OR (t.assignee_kind = 'counsellor' AND t.assignee_id IN (
              SELECT id FROM counsellors WHERE supervisor_id = ${i}
            ))
        OR (t.assignee_kind = 'admin' AND t.creator_id = ${i})
      )`);
    }
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

// POST /api/tasks
// Counsellors may assign to: self, a counsellor they supervise, or a named admin.
// Admin may assign to: any counsellor, or a named admin.
router.post("/", async (req, res, next) => {
  try {
    let {
      lead_id, student_name, assignee_id, assignee_admin_username,
      text, due_date, priority, appointment_id,
    } = req.body;

    if (
      (lead_id == null || lead_id === "") &&
      (student_name == null || student_name === "")
    ) {
      return res.status(400).json({ error: "lead_id or student_name is required" });
    }
    if (lead_id && (!isString(lead_id) || lead_id.length > 50)) {
      return res.status(400).json({ error: "lead_id must be a string up to 50 chars" });
    }
    if (student_name && (!isString(student_name) || student_name.length > 200)) {
      return res.status(400).json({ error: "student_name must be a string up to 200 chars" });
    }
    if (!isString(text) || text.trim().length < 1 || text.length > 1000) {
      return res.status(400).json({ error: "text must be 1–1000 chars" });
    }
    if (!isValidYmd(due_date)) {
      return res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" });
    }

    let assigneeKind = "counsellor";
    let cleanAssigneeAdminUsername = null;
    let creatorId = null;
    let creatorKind = "counsellor";

    if (req.user?.kind === "counsellor") {
      creatorId = req.user.counsellorId;
      creatorKind = "counsellor";

      if (assignee_admin_username) {
        // Assigning to a named admin
        const normalized = String(assignee_admin_username).toLowerCase().trim();
        if (!adminUsernameSet().has(normalized)) {
          return res.status(400).json({ error: "unknown admin username" });
        }
        assigneeKind = "admin";
        cleanAssigneeAdminUsername = normalized;
        assignee_id = null;
      } else {
        // Assigning to counsellor — default to self, else validate:
        // allowed targets are supervised counsellors OR your own supervisor.
        if (!assignee_id) assignee_id = req.user.counsellorId;
        if (assignee_id !== req.user.counsellorId) {
          const allowed = await pool.query(
            `SELECT 1 FROM counsellors
              WHERE id = $1
                AND (supervisor_id = $2
                     OR id = (SELECT supervisor_id FROM counsellors WHERE id = $2))`,
            [assignee_id, req.user.counsellorId]
          );
          if (allowed.rows.length === 0) {
            return res.status(403).json({ error: "cannot assign tasks to this counsellor" });
          }
        }
        assigneeKind = "counsellor";
        // Lead ownership check — lead must belong to the assigning counsellor
        if (lead_id) {
          const own = await pool.query(
            "SELECT 1 FROM leads WHERE id = $1 AND counsellor_id = $2",
            [lead_id, req.user.counsellorId]
          );
          if (own.rows.length === 0) {
            return res.status(404).json({ error: "lead not found" });
          }
        }
      }
    } else {
      // Admin creating a task
      creatorKind = "admin";
      creatorId = null;

      if (assignee_admin_username) {
        const normalized = String(assignee_admin_username).toLowerCase().trim();
        if (!adminUsernameSet().has(normalized)) {
          return res.status(400).json({ error: "unknown admin username" });
        }
        assigneeKind = "admin";
        cleanAssigneeAdminUsername = normalized;
        assignee_id = null;
      } else {
        if (!isString(assignee_id) || assignee_id.trim().length === 0) {
          return res.status(400).json({ error: "assignee_id is required" });
        }
        if (!isString(assignee_id) || assignee_id.length > 50) {
          return res.status(400).json({ error: "assignee_id must be a string up to 50 chars" });
        }
        assigneeKind = "counsellor";
        if (lead_id) {
          const leadCheck = await pool.query("SELECT 1 FROM leads WHERE id = $1", [lead_id]);
          if (leadCheck.rows.length === 0) {
            return res.status(404).json({ error: "lead not found" });
          }
        }
      }
    }

    // Validate counsellor assignee exists
    if (assigneeKind === "counsellor" && assignee_id) {
      const cCheck = await pool.query("SELECT 1 FROM counsellors WHERE id = $1", [assignee_id]);
      if (cCheck.rows.length === 0) {
        return res.status(404).json({ error: "assignee (counsellor) not found" });
      }
    }

    let cleanAppointmentId = null;
    if (appointment_id != null && appointment_id !== "") {
      const apptStr = String(appointment_id);
      if (!/^\d+$/.test(apptStr)) {
        return res.status(400).json({ error: "appointment_id must be a positive integer" });
      }
      const cleanLeadIdForAppt = lead_id || null;
      if (!cleanLeadIdForAppt) {
        return res.status(400).json({ error: "appointment_id requires a lead_id" });
      }
      const apptCheck = await pool.query(
        "SELECT 1 FROM lead_appointments WHERE id = $1 AND lead_id = $2",
        [apptStr, cleanLeadIdForAppt]
      );
      if (apptCheck.rows.length === 0) {
        return res.status(404).json({ error: "appointment not found for this lead" });
      }
      cleanAppointmentId = apptStr;
    }

    const cleanLeadId = lead_id || null;
    const cleanStudentName = student_name?.trim() || null;
    const cleanAssigneeId = assigneeKind === "counsellor" ? (assignee_id || null) : null;

    const { rows } = await pool.query(
      `INSERT INTO counsellor_tasks
         (lead_id, student_name, assignee_id, assignee_kind, assignee_admin_username,
          text, due_date, priority, appointment_id, creator_id, creator_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        cleanLeadId, cleanStudentName, cleanAssigneeId, assigneeKind, cleanAssigneeAdminUsername,
        text.trim(), due_date, !!priority, cleanAppointmentId, creatorId, creatorKind,
      ]
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

// PATCH /api/tasks/:id
// Admin: full edit. Counsellor: priority + completed toggles only.
// Supervisor counsellors have the same (limited) edit rights on tasks
// belonging to counsellors they supervise as on their own.
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const taskRow = await checkTaskAccess(req, res, id);
    if (!taskRow) return;

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
    if (req.body.due_date !== undefined && !isValidYmd(req.body.due_date)) {
      return res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" });
    }
    if (req.body.student_name && (!isString(req.body.student_name) || req.body.student_name.length > 200)) {
      return res.status(400).json({ error: "student_name must be a string up to 200 chars" });
    }
    if (req.body.assignee_id && (!isString(req.body.assignee_id) || req.body.assignee_id.length > 50)) {
      return res.status(400).json({ error: "assignee_id must be a string up to 50 chars" });
    }
    if (req.body.lead_id && (!isString(req.body.lead_id) || req.body.lead_id.length > 50)) {
      return res.status(400).json({ error: "lead_id must be a string up to 50 chars" });
    }

    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => {
      const v = req.body[f];
      if (f === "text" && typeof v === "string") return v.trim();
      if (f === "student_name") return typeof v === "string" ? (v.trim() || null) : null;
      if (f === "assignee_id" || f === "lead_id") return v && v !== "" ? v : null;
      if (f === "priority" || f === "completed") return !!v;
      return v;
    })];

    const { rows } = await pool.query(
      `UPDATE counsellor_tasks SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: "task not found" });

    const { rows: enriched } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [rows[0].id]);
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/:id/archive
// Counsellors cannot archive admin-assigned tasks (they don't own them enough
// to remove them from the admin's queue — they can only view them).
router.post("/:id/archive", async (req, res, next) => {
  try {
    const { id } = req.params;
    const taskRow = await checkTaskAccess(req, res, id);
    if (!taskRow) return;

    if (req.user?.kind === "counsellor" && taskRow.assignee_kind === "admin") {
      return res.status(403).json({ error: "cannot archive tasks assigned to admin" });
    }

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
    const taskRow = await checkTaskAccess(req, res, id);
    if (!taskRow) return;

    if (req.user?.kind === "counsellor" && taskRow.assignee_kind === "admin") {
      return res.status(403).json({ error: "cannot unarchive tasks assigned to admin" });
    }

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

// GET /api/tasks/:id/comments
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

// POST /api/tasks/:id/comments — append-only by design.
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
