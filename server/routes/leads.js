import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";
import { fireAssignmentNotifications } from "../notify/dispatch.js";
import { seedLeads } from "../seed.js";

const router = express.Router();

function isString(v) {
  return typeof v === "string";
}
function validateLeadInput(body) {
  const { name, contact, email, purpose, notes } = body;
  if (!isString(name) || name.trim().length < 1 || name.length > 200) {
    return "name must be a non-empty string up to 200 chars";
  }
  if (!isString(contact) || !/^\d{8,15}$/.test(contact)) {
    return "contact must be digits only, 8-15 chars";
  }
  if (email !== undefined && email !== null && email !== "") {
    if (!isString(email) || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return "email must be a valid email address (max 320 chars)";
    }
  }
  if (!isString(purpose) || purpose.trim().length < 1 || purpose.length > 200) {
    return "purpose must be a non-empty string up to 200 chars";
  }
  if (notes !== undefined && notes !== null && notes !== "") {
    if (!isString(notes) || notes.length > 2000) {
      return "notes must be a string up to 2000 chars";
    }
  }
  return null;
}

// PATCH-allowed subset. Mirrors validateLeadInput rigor for fields that PATCH lets
// through, so /api/leads/:id can't be used to slip a 1MB note past the validator.
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
  if (body.notes !== undefined && body.notes !== null && body.notes !== "") {
    if (!isString(body.notes) || body.notes.length > 2000) {
      return "notes must be a string up to 2000 chars";
    }
  }
  if (body.service_date !== undefined && body.service_date !== null && body.service_date !== "") {
    if (!isString(body.service_date) || isNaN(Date.parse(body.service_date))) {
      return "service_date must be a valid ISO 8601 timestamp";
    }
  }
  return null;
}

async function attachActivity(leads) {
  if (leads.length === 0) return [];
  const ids = leads.map((l) => l.id);
  const { rows } = await pool.query(
    "SELECT * FROM lead_activity WHERE lead_id = ANY($1) ORDER BY ts ASC",
    [ids]
  );
  const byLead = {};
  for (const a of rows) {
    if (!byLead[a.lead_id]) byLead[a.lead_id] = [];
    byLead[a.lead_id].push(a);
  }
  return leads.map((l) => ({ ...l, activity: byLead[l.id] || [] }));
}

// GET /api/leads — all leads with their activity
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM leads ORDER BY service_date ASC NULLS LAST"
    );
    const enriched = await attachActivity(rows);
    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads — create a new lead
router.post("/", async (req, res, next) => {
  try {
    const { name, contact, email, purpose, service_date, counsellor_id, notes } = req.body;
    if (!name || !contact || !purpose) {
      return res.status(400).json({ error: "name, contact, and purpose are required" });
    }

    const validationError = validateLeadInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const id = "L" + randomUUID().replace(/-/g, "").slice(0, 10);
    const status = counsellor_id ? "scheduled" : "unassigned";

    // Normalize whitespace at the boundary so " John " and "John" don't end up
    // as distinct leads in dedup/search. Email lowercased for the same reason.
    const cleanName = name.trim();
    const cleanPurpose = purpose.trim();
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    const cleanNotes = notes ? notes.trim() : null;

    await pool.query(
      `INSERT INTO leads (id, name, contact, email, purpose, service_date, counsellor_id, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, cleanName, contact, cleanEmail, cleanPurpose, service_date || null, counsellor_id || null, status, cleanNotes]
    );
    await pool.query(
      "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
      [id, "inquiry", "Lead added by admin."]
    );

    if (counsellor_id) {
      const { rows: cRows } = await pool.query("SELECT * FROM counsellors WHERE id = $1", [counsellor_id]);
      if (cRows.length > 0) {
        const counsellor = cRows[0];
        await pool.query(
          "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
          [id, "assignment", `Assigned to ${counsellor.name}.`]
        );
        // Fire notifications in the background; don't block the response
        const { rows: lRows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
        fireAssignmentNotifications(lRows[0], counsellor).catch((e) =>
          console.error("[POST /leads] notify fail:", e)
        );
      }
    }

    const { rows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
    const enriched = await attachActivity(rows);
    res.status(201).json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/leads/:id — update fields (assign counsellor, change status, etc.)
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = ["counsellor_id", "status", "notes", "purpose", "service_date"];
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
      // Trim free-text fields at the boundary, matching POST normalization.
      if ((f === "purpose" || f === "notes") && typeof v === "string") return v.trim();
      return v;
    })];

    let extraSet = "";
    if (req.body.counsellor_id && req.body.counsellor_id !== before.counsellor_id) {
      extraSet = ", status = 'scheduled', reminder_sent = FALSE";
    }

    const sql = `UPDATE leads SET ${set}${extraSet}, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const { rows: updatedRows } = await pool.query(sql, values);
    const updated = updatedRows[0];

    if (req.body.counsellor_id && req.body.counsellor_id !== before.counsellor_id) {
      const { rows: cRows } = await pool.query("SELECT * FROM counsellors WHERE id = $1", [req.body.counsellor_id]);
      if (cRows.length > 0) {
        const counsellor = cRows[0];
        await pool.query(
          "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
          [id, "assignment", `Assigned to ${counsellor.name}.`]
        );
        fireAssignmentNotifications(updated, counsellor).catch((e) =>
          console.error("[PATCH /leads/:id] notify fail:", e)
        );
      }
    }

    if (req.body.status && req.body.status !== before.status) {
      await pool.query(
        "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
        [id, "status", `Status changed to ${req.body.status}.`]
      );
    }

    const { rows: finalRows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
    const enriched = await attachActivity(finalRows);
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/reset — wipe all leads + activity, then reseed
router.post("/reset", async (req, res, next) => {
  try {
    await pool.query("DELETE FROM lead_activity");
    await pool.query("DELETE FROM leads");
    await seedLeads();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
