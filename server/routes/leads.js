import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";
import { isValidUtcIso } from "../../lib/time.js";

const router = express.Router();

const isString = (v) => typeof v === "string";

function validateLeadInput(body) {
  const { name, contact, email, purpose, service_date } = body;
  if (!isString(name) || name.trim().length < 1 || name.length > 200) {
    return "name must be a non-empty string up to 200 chars";
  }
  if (!isString(contact) || !/^\d{8,15}$/.test(contact)) {
    return "contact must be digits only, 8-15 chars";
  }
  if (email) {
    if (!isString(email) || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return "email must be a valid email address (max 320 chars)";
    }
  }
  if (!isString(purpose) || purpose.trim().length < 1 || purpose.length > 200) {
    return "purpose must be a non-empty string up to 200 chars";
  }
  // Reject bare "YYYY-MM-DDTHH:mm" strings: Postgres TIMESTAMPTZ would
  // silently reinterpret them as UTC, shifting the stored time by the
  // submitter's offset. Require an explicit Z or ±HH:MM.
  if (service_date) {
    if (!isValidUtcIso(service_date)) {
      return "service_date must be ISO 8601 with explicit timezone (Z or ±HH:MM)";
    }
  }
  return null;
}

function validatePatchFields(body) {
  if (body.counsellor_id !== undefined && body.counsellor_id !== null) {
    if (!isString(body.counsellor_id) || body.counsellor_id.length < 1 || body.counsellor_id.length > 50) {
      return "counsellor_id must be a string of length 1..50 (or null to unassign)";
    }
  }
  if (body.purpose !== undefined) {
    if (!isString(body.purpose) || body.purpose.trim().length < 1 || body.purpose.length > 200) {
      return "purpose must be a non-empty string up to 200 chars";
    }
  }
  if (body.service_date) {
    if (!isValidUtcIso(body.service_date)) {
      return "service_date must be ISO 8601 with explicit timezone (Z or ±HH:MM)";
    }
  }
  if (body.counsellor_name) {
    if (!isString(body.counsellor_name) || body.counsellor_name.length > 200) {
      return "counsellor_name must be a string up to 200 chars";
    }
  }
  return null;
}

// GET /api/leads — counsellors are server-scoped to their own leads via
// req.user; admin sees everything. Archived rows hidden by default,
// surfaced via ?include_archived=true.
router.get("/", async (req, res, next) => {
  try {
    const includeArchived = req.query.include_archived === "true";
    const where = [];
    const params = [];
    if (!includeArchived) where.push("archived = FALSE");
    if (req.user?.kind === "counsellor") {
      params.push(req.user.counsellorId);
      where.push(`counsellor_id = $${params.length}`);
    }
    const sql = `SELECT * FROM leads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY service_date ASC NULLS LAST`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, contact, email, purpose, service_date, counsellor_id, counsellor_name, inquiry_date, status: bodyStatus } = req.body;
    if (!name || !contact || !purpose) {
      return res.status(400).json({ error: "name, contact, and purpose are required" });
    }

    const validationError = validateLeadInput(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    if (inquiry_date) {
      if (!isString(inquiry_date) || !/^\d{4}-\d{2}-\d{2}$/.test(inquiry_date)) {
        return res.status(400).json({ error: "inquiry_date must be YYYY-MM-DD" });
      }
    }
    if (bodyStatus) {
      if (!["scheduled", "completed", "no_show", "unassigned"].includes(bodyStatus)) {
        return res.status(400).json({ error: "invalid status" });
      }
    }
    if (counsellor_name) {
      if (!isString(counsellor_name) || counsellor_name.length > 200) {
        return res.status(400).json({ error: "counsellor_name must be a string up to 200 chars" });
      }
    }

    const id = "L" + randomUUID().replace(/-/g, "").slice(0, 10);
    const status = bodyStatus || (counsellor_id ? "scheduled" : "unassigned");

    const cleanName = name.trim();
    const cleanPurpose = purpose.trim();
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    const cleanInquiry = inquiry_date && inquiry_date !== "" ? inquiry_date : null;
    const cleanCounsellorName = counsellor_name && counsellor_name.trim() ? counsellor_name.trim() : null;

    const { rows } = await pool.query(
      `INSERT INTO leads (id, name, contact, email, purpose, service_date, counsellor_id, status, inquiry_date, counsellor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10)
       RETURNING *`,
      [id, cleanName, contact, cleanEmail, cleanPurpose, service_date || null, counsellor_id || null, status, cleanInquiry, cleanCounsellorName]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = ["counsellor_id", "counsellor_name", "status", "purpose", "service_date"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: "no valid fields to update" });

    if (req.body.status !== undefined && !["scheduled", "completed", "no_show", "unassigned"].includes(req.body.status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    const patchError = validatePatchFields(req.body);
    if (patchError) return res.status(400).json({ error: patchError });

    const { rows: beforeRows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
    if (beforeRows.length === 0) return res.status(404).json({ error: "lead not found" });
    const before = beforeRows[0];

    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => {
      const v = req.body[f];
      if (f === "purpose" && typeof v === "string") return v.trim();
      return v;
    })];

    // Counsellor change re-arms scheduling ONLY when the lead was
    // previously unassigned. Reassigning a counsellor on a 'completed' or
    // 'no_show' lead must not silently wipe the outcome. Also skip when
    // the caller has explicitly set a status in the same patch — their
    // value wins.
    let extraSet = "";
    const counsellorChanged =
      req.body.counsellor_id && req.body.counsellor_id !== before.counsellor_id;
    const statusInPatch = fields.includes("status");
    if (counsellorChanged && !statusInPatch && before.status === "unassigned") {
      extraSet = ", status = 'scheduled'";
    }

    const sql = `UPDATE leads SET ${set}${extraSet}, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const { rows: updatedRows } = await pool.query(sql, values);
    res.json(updatedRows[0]);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/archive", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE leads SET archived = TRUE, archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived = FALSE RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "lead not found" });
      return res.json(exists.rows[0]);
    }
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/unarchive", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE leads SET archived = FALSE, archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND archived = TRUE RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "lead not found" });
      return res.json(exists.rows[0]);
    }
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.get("/:id/appointments", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM lead_appointments WHERE lead_id = $1 ORDER BY scheduled_for ASC",
      [id]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/appointments — schedule (or reschedule) an appointment.
// Inserts a row in the history table AND mirrors the date onto
// leads.service_date so list ordering reflects the most recent appointment.
// Notes stay in lead_appointments only (per-appointment, not per-lead).
//
// Wrapped in a transaction so a partial failure (e.g. INSERT succeeds but
// UPDATE fails) never leaves leads.service_date out of sync.
router.post("/:id/appointments", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scheduled_for, notes } = req.body;
    if (!scheduled_for || !isValidUtcIso(scheduled_for)) {
      return res
        .status(400)
        .json({ error: "scheduled_for must be ISO 8601 with explicit timezone (Z or ±HH:MM)" });
    }
    if (new Date(scheduled_for).getTime() < Date.now()) {
      return res.status(400).json({ error: "scheduled_for must be in the future" });
    }
    if (notes) {
      if (!isString(notes) || notes.length > 2000) {
        return res.status(400).json({ error: "notes must be a string up to 2000 chars" });
      }
    }

    const leadCheck = await pool.query("SELECT 1 FROM leads WHERE id = $1", [id]);
    if (leadCheck.rows.length === 0) return res.status(404).json({ error: "lead not found" });

    const cleanNotes = notes ? notes.trim() : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "INSERT INTO lead_appointments (lead_id, scheduled_for, notes) VALUES ($1, $2, $3) RETURNING *",
        [id, scheduled_for, cleanNotes]
      );
      await client.query(
        "UPDATE leads SET service_date = $2, updated_at = NOW() WHERE id = $1",
        [id, scheduled_for]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    next(e);
  }
});

router.patch("/:leadId/appointments/:apptId", async (req, res, next) => {
  try {
    const { leadId, apptId } = req.params;
    const { notes } = req.body;
    if (notes) {
      if (!isString(notes) || notes.length > 2000) {
        return res.status(400).json({ error: "notes must be a string up to 2000 chars" });
      }
    }
    const cleanNotes = notes && notes.trim() ? notes.trim() : null;

    const { rows } = await pool.query(
      `UPDATE lead_appointments
       SET notes = $3
       WHERE id = $1 AND lead_id = $2
       RETURNING *`,
      [apptId, leadId, cleanNotes]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "appointment not found" });
    }
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

export default router;
