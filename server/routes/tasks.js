import express from "express";
import pool from "../db.js";

const router = express.Router();

function isString(v) {
  return typeof v === "string";
}

// GET /api/tasks — flat list of every task with the student's name joined
// in. The simple panel groups/sorts client-side (small N, single user).
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, l.name AS student_name, l.archived AS student_archived
       FROM counsellor_tasks t
       JOIN leads l ON l.id = t.lead_id
       ORDER BY t.priority DESC, t.due_date ASC, t.id ASC`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks — create a new task tied to a lead.
router.post("/", async (req, res, next) => {
  try {
    const { lead_id, text, due_date, priority } = req.body;
    if (!isString(lead_id) || lead_id.length < 1 || lead_id.length > 50) {
      return res.status(400).json({ error: "lead_id is required" });
    }
    if (!isString(text) || text.trim().length < 1 || text.length > 1000) {
      return res.status(400).json({ error: "text must be 1–1000 chars" });
    }
    if (!isString(due_date) || !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
      return res.status(400).json({ error: "due_date must be YYYY-MM-DD" });
    }

    const leadCheck = await pool.query("SELECT 1 FROM leads WHERE id = $1", [lead_id]);
    if (leadCheck.rows.length === 0) {
      return res.status(404).json({ error: "lead not found" });
    }

    const { rows } = await pool.query(
      `INSERT INTO counsellor_tasks (lead_id, text, due_date, priority)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [lead_id, text.trim(), due_date, !!priority]
    );
    // Re-fetch with the joined student_name so the client doesn't need a
    // second roundtrip to render the row.
    const { rows: enriched } = await pool.query(
      `SELECT t.*, l.name AS student_name, l.archived AS student_archived
       FROM counsellor_tasks t JOIN leads l ON l.id = t.lead_id
       WHERE t.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tasks/:id — toggle priority/completed, edit text, or change date.
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = ["text", "due_date", "priority", "completed"];
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

    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => {
      const v = req.body[f];
      if (f === "text" && typeof v === "string") return v.trim();
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
      `SELECT t.*, l.name AS student_name, l.archived AS student_archived
       FROM counsellor_tasks t JOIN leads l ON l.id = t.lead_id
       WHERE t.id = $1`,
      [rows[0].id]
    );
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query("DELETE FROM counsellor_tasks WHERE id = $1", [id]);
    if (rowCount === 0) return res.status(404).json({ error: "task not found" });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
