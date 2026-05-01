import express from "express";
import pool from "../db.js";

const router = express.Router();

function isString(v) {
  return typeof v === "string";
}

// Single source of truth for the joined SELECT used after every mutation.
// LEFT JOIN both leads and counsellors because tasks may have a free-text
// student_name (no lead FK) and may also be unassigned. Frontend resolves
// student via lead_name || student_name and renders assignee_name as the
// counsellor responsible for the task.
const SELECT_JOINED = `
  SELECT t.*,
         l.name AS lead_name,
         l.archived AS student_archived,
         c.name AS assignee_name
  FROM counsellor_tasks t
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN counsellors c ON c.id = t.assignee_id
`;

// GET /api/tasks — flat list of every task with the student's name joined
// in. The simple panel groups/sorts client-side (small N, single user).
// Default hides archived tasks; ?include_archived=true returns both sets.
router.get("/", async (req, res, next) => {
  try {
    const includeArchived = req.query.include_archived === "true";
    const where = includeArchived ? "" : "WHERE t.archived = FALSE";
    const { rows } = await pool.query(
      `${SELECT_JOINED} ${where}
       ORDER BY t.priority DESC, t.due_date ASC, t.id ASC`
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
    const { lead_id, student_name, assignee_id, text, due_date, priority } = req.body;
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
    if (!isString(due_date) || !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
      return res.status(400).json({ error: "due_date must be YYYY-MM-DD" });
    }

    const cleanLeadId = lead_id || null;
    const cleanStudentName =
      student_name && student_name.trim() ? student_name.trim() : null;
    const cleanAssigneeId = assignee_id || null;

    if (cleanLeadId) {
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

    const { rows } = await pool.query(
      `INSERT INTO counsellor_tasks (lead_id, student_name, assignee_id, text, due_date, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [cleanLeadId, cleanStudentName, cleanAssigneeId, text.trim(), due_date, !!priority]
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
// or rename the free-text student.
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = ["text", "due_date", "priority", "completed", "student_name", "assignee_id", "lead_id"];
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
      if (!isString(req.body.due_date) || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date)) {
        return res.status(400).json({ error: "due_date must be YYYY-MM-DD" });
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

export default router;
