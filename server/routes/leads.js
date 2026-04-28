import express from "express";
import pool from "../db.js";
import { fireAssignmentNotifications } from "../notify/dispatch.js";

const router = express.Router();

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

    const id = `L${Date.now().toString().slice(-6)}`;
    const status = counsellor_id ? "scheduled" : "unassigned";

    await pool.query(
      `INSERT INTO leads (id, name, contact, email, purpose, service_date, counsellor_id, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, name, contact, email || null, purpose, service_date || null, counsellor_id || null, status, notes || null]
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

    const { rows: beforeRows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
    if (beforeRows.length === 0) return res.status(404).json({ error: "lead not found" });
    const before = beforeRows[0];

    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => req.body[f])];

    let extraSet = "";
    if (req.body.counsellor_id && !before.counsellor_id) {
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
    const { seedLeads } = await import("../seed.js");
    await pool.query("DELETE FROM lead_activity");
    await pool.query("DELETE FROM leads");
    if (typeof seedLeads === "function") await seedLeads();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
