import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import pool from "../db.js";
import { fireAssignmentNotifications } from "../notify/dispatch.js";
import { seedLeads } from "../seed.js";
import { isValidUtcIso } from "../../lib/time.js";
import { extractActionables, transcribeAudio } from "../extract.js";

// Disk storage instead of memory: streamed straight from disk to Whisper
// later, so 5 simultaneous 10 MB uploads don't blow the 512 MB Render free
// tier RAM. 10 MB cap ≈ ~10 min audio at standard mp3 bitrate, which
// transcribes inside Whisper's expected window and keeps total request time
// below Render's HTTP timeout.
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 8) || ".audio";
      cb(null, `persona-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Per-lead upload lock — serializes concurrent uploads to the same lead so
// the transcript + actionables pipeline can't race. Two webhooks for the
// same lead within seconds is the realistic case once Twilio recordings
// arrive (e.g. retry, or a re-recorded segment); this Map keeps them from
// stepping on each other's UPDATE.
const uploadLocks = new Map(); // leadId -> Promise
async function withUploadLock(leadId, fn) {
  const prev = uploadLocks.get(leadId);
  if (prev) {
    try { await prev; } catch { /* prior failed; we still proceed */ }
  }
  const p = (async () => fn())();
  uploadLocks.set(leadId, p);
  try {
    return await p;
  } finally {
    if (uploadLocks.get(leadId) === p) uploadLocks.delete(leadId);
  }
}

const router = express.Router();

function isString(v) {
  return typeof v === "string";
}
function validateLeadInput(body) {
  const { name, contact, email, purpose, notes, service_date } = body;
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
  // Reject bare "YYYY-MM-DDTHH:mm" strings: Postgres TIMESTAMPTZ would
  // silently reinterpret them as UTC, shifting the stored time by the
  // submitter's offset. Require an explicit Z or ±HH:MM.
  if (service_date !== undefined && service_date !== null && service_date !== "") {
    if (!isValidUtcIso(service_date)) {
      return "service_date must be ISO 8601 with explicit timezone (Z or ±HH:MM)";
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
    if (!isValidUtcIso(body.service_date)) {
      return "service_date must be ISO 8601 with explicit timezone (Z or ±HH:MM)";
    }
  }
  if (body.counsellor_name !== undefined && body.counsellor_name !== null && body.counsellor_name !== "") {
    if (!isString(body.counsellor_name) || body.counsellor_name.length > 200) {
      return "counsellor_name must be a string up to 200 chars";
    }
  }
  return null;
}

async function attachActivity(leads) {
  if (leads.length === 0) return [];
  const ids = leads.map((l) => l.id);
  const [actRes, actionRes] = await Promise.all([
    pool.query(
      "SELECT * FROM lead_activity WHERE lead_id = ANY($1) ORDER BY ts ASC",
      [ids]
    ),
    pool.query(
      "SELECT * FROM lead_actionables WHERE lead_id = ANY($1) ORDER BY id ASC",
      [ids]
    ),
  ]);
  const byLead = {};
  const actionsByLead = {};
  for (const a of actRes.rows) {
    if (!byLead[a.lead_id]) byLead[a.lead_id] = [];
    byLead[a.lead_id].push(a);
  }
  for (const a of actionRes.rows) {
    if (!actionsByLead[a.lead_id]) actionsByLead[a.lead_id] = [];
    actionsByLead[a.lead_id].push(a);
  }
  return leads.map((l) => ({
    ...l,
    activity: byLead[l.id] || [],
    actionables: actionsByLead[l.id] || [],
  }));
}

// GET /api/leads — leads with their activity. Hides archived rows by default
// so the staff dashboard never surfaces archived leads to counsellors. Admin
// passes ?include_archived=true to also receive the archived set.
router.get("/", async (req, res, next) => {
  try {
    const includeArchived = req.query.include_archived === "true";
    const sql = includeArchived
      ? "SELECT * FROM leads ORDER BY service_date ASC NULLS LAST"
      : "SELECT * FROM leads WHERE archived = FALSE ORDER BY service_date ASC NULLS LAST";
    const { rows } = await pool.query(sql);
    const enriched = await attachActivity(rows);
    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads — create a new lead
router.post("/", async (req, res, next) => {
  try {
    const { name, contact, email, purpose, service_date, counsellor_id, counsellor_name, notes, inquiry_date, status: bodyStatus } = req.body;
    if (!name || !contact || !purpose) {
      return res.status(400).json({ error: "name, contact, and purpose are required" });
    }

    const validationError = validateLeadInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // inquiry_date is optional from the client. If provided it must be a
    // YYYY-MM-DD string (DATE column), otherwise the DB default fills today.
    if (inquiry_date !== undefined && inquiry_date !== null && inquiry_date !== "") {
      if (!isString(inquiry_date) || !/^\d{4}-\d{2}-\d{2}$/.test(inquiry_date)) {
        return res.status(400).json({ error: "inquiry_date must be YYYY-MM-DD" });
      }
    }
    if (bodyStatus !== undefined && bodyStatus !== null && bodyStatus !== "") {
      if (!["scheduled", "completed", "no_show", "unassigned"].includes(bodyStatus)) {
        return res.status(400).json({ error: "invalid status" });
      }
    }
    // counsellor_name: free-text field used by the simple panel where
    // counsellors don't need a notification-capable counsellors row. Cap at
    // 200 chars to keep parity with counsellors.name. Empty string is
    // normalized to null so the column doesn't accumulate "" rows.
    if (counsellor_name !== undefined && counsellor_name !== null && counsellor_name !== "") {
      if (!isString(counsellor_name) || counsellor_name.length > 200) {
        return res.status(400).json({ error: "counsellor_name must be a string up to 200 chars" });
      }
    }

    const id = "L" + randomUUID().replace(/-/g, "").slice(0, 10);
    // If client supplied a status use it; otherwise derive from counsellor.
    const status = bodyStatus || (counsellor_id ? "scheduled" : "unassigned");

    // Normalize whitespace at the boundary so " John " and "John" don't end up
    // as distinct leads in dedup/search. Email lowercased for the same reason.
    const cleanName = name.trim();
    const cleanPurpose = purpose.trim();
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    const cleanNotes = notes ? notes.trim() : null;
    const cleanInquiry = inquiry_date && inquiry_date !== "" ? inquiry_date : null;
    const cleanCounsellorName = counsellor_name && counsellor_name.trim() ? counsellor_name.trim() : null;

    await pool.query(
      `INSERT INTO leads (id, name, contact, email, purpose, service_date, counsellor_id, status, notes, inquiry_date, counsellor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::date, CURRENT_DATE), $11)`,
      [id, cleanName, contact, cleanEmail, cleanPurpose, service_date || null, counsellor_id || null, status, cleanNotes, cleanInquiry, cleanCounsellorName]
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
    const allowed = ["counsellor_id", "counsellor_name", "status", "notes", "purpose", "service_date"];
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

    // Reasons to reset reminder_sent so the cron re-fires the 12hr reminder:
    //   1. Counsellor changed — the new counsellor needs to be notified.
    //   2. service_date changed — the existing reminder was anchored to the
    //      OLD time. If staff moves the appointment forward, the old reminder
    //      is now wrong; we need a fresh one anchored to the new time.
    //      (Without this, rescheduling silently skips the reminder for the new slot.)
    let extraSet = "";
    const counsellorChanged =
      req.body.counsellor_id && req.body.counsellor_id !== before.counsellor_id;
    const serviceDateChanged =
      req.body.service_date !== undefined &&
      req.body.service_date !== null &&
      req.body.service_date !== "" &&
      new Date(req.body.service_date).getTime() !==
        (before.service_date ? new Date(before.service_date).getTime() : NaN);

    if (counsellorChanged) {
      extraSet = ", status = 'scheduled', reminder_sent = FALSE";
    } else if (serviceDateChanged) {
      extraSet = ", reminder_sent = FALSE";
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
    } else if (counsellorChanged && before.status === "unassigned") {
      // counsellor_id assigned → extraSet auto-flipped status to 'scheduled'.
      // Log it explicitly so the activity feed reflects the implicit change.
      await pool.query(
        "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
        [id, "status", "Status changed to scheduled."]
      );
    }

    const { rows: finalRows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
    const enriched = await attachActivity(finalRows);
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/archive — soft-delete: hide from main admin table,
// remove from counsellor staff dashboard. Idempotent.
router.post("/:id/archive", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE leads SET archived = TRUE, archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived = FALSE RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT archived FROM leads WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "lead not found" });
      // already archived — return current state without re-logging
      const enriched = await attachActivity(exists.rows);
      return res.json(enriched[0]);
    }
    await pool.query(
      "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'archived', $2)",
      [id, "Lead archived by admin."]
    );
    const { rows: finalRows } = await pool.query("SELECT * FROM leads WHERE id = $1", [id]);
    const enriched = await attachActivity(finalRows);
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/unarchive — restore an archived lead.
router.post("/:id/unarchive", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE leads SET archived = FALSE, archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND archived = TRUE RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT archived FROM leads WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "lead not found" });
      const enriched = await attachActivity(exists.rows);
      return res.json(enriched[0]);
    }
    await pool.query(
      "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'unarchived', $2)",
      [id, "Lead unarchived by admin."]
    );
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
    await pool.query("DELETE FROM lead_actionables");
    await pool.query("DELETE FROM lead_activity");
    await pool.query("DELETE FROM leads");
    await seedLeads();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ----------------------------------------------------------------------------
// Staff workflow endpoints
// ----------------------------------------------------------------------------

async function getCounsellorName(counsellor_id) {
  if (!counsellor_id) return null;
  const { rows } = await pool.query("SELECT name FROM counsellors WHERE id = $1", [counsellor_id]);
  return rows[0]?.name || null;
}

// POST /api/leads/:id/view — record that a counsellor viewed the lead.
// Idempotent per (lead, counsellor): only the first view is logged.
router.post("/:id/view", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { counsellor_id } = req.body;
    if (!isString(counsellor_id) || counsellor_id.length < 1) {
      return res.status(400).json({ error: "counsellor_id is required" });
    }
    const cname = await getCounsellorName(counsellor_id);
    if (!cname) return res.status(400).json({ error: "counsellor not found" });

    // Skip if already logged
    const existing = await pool.query(
      `SELECT 1 FROM lead_activity
       WHERE lead_id = $1 AND type = 'viewed' AND recipient = $2 LIMIT 1`,
      [id, counsellor_id]
    );
    if (existing.rows.length > 0) {
      return res.status(204).end();
    }

    await pool.query(
      `INSERT INTO lead_activity (lead_id, type, recipient, text)
       VALUES ($1, 'viewed', $2, $3)`,
      [id, counsellor_id, `Viewed by ${cname}.`]
    );
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/call — log a call event.
router.post("/:id/call", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { counsellor_id, called_at, note } = req.body;
    if (!isString(counsellor_id) || counsellor_id.length < 1) {
      return res.status(400).json({ error: "counsellor_id is required" });
    }
    if (called_at !== undefined && called_at !== null && called_at !== "") {
      if (!isValidUtcIso(called_at)) {
        return res.status(400).json({ error: "called_at must be ISO 8601 with explicit timezone" });
      }
    }
    if (note !== undefined && note !== null && note !== "" && (!isString(note) || note.length > 2000)) {
      return res.status(400).json({ error: "note must be a string up to 2000 chars" });
    }
    const cname = await getCounsellorName(counsellor_id);
    if (!cname) return res.status(400).json({ error: "counsellor not found" });

    const ts = called_at || new Date().toISOString();
    const text = note?.trim()
      ? `${cname} called the lead at ${ts}. Note: ${note.trim()}`
      : `${cname} called the lead at ${ts}.`;

    const { rows } = await pool.query(
      `INSERT INTO lead_activity (lead_id, type, recipient, ts, text)
       VALUES ($1, 'call_logged', $2, $3, $4)
       RETURNING *`,
      [id, counsellor_id, ts, text]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// GET /api/leads/:id/actionables — list
router.get("/:id/actionables", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM lead_actionables WHERE lead_id = $1 ORDER BY id ASC",
      [id]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/actionables — create one
router.post("/:id/actionables", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    if (!isString(text) || text.trim().length < 1 || text.length > 1000) {
      return res.status(400).json({ error: "text must be a non-empty string up to 1000 chars" });
    }
    const leadCheck = await pool.query("SELECT 1 FROM leads WHERE id = $1", [id]);
    if (leadCheck.rows.length === 0) return res.status(404).json({ error: "lead not found" });

    const trimmed = text.trim();
    const { rows } = await pool.query(
      "INSERT INTO lead_actionables (lead_id, text) VALUES ($1, $2) RETURNING *",
      [id, trimmed]
    );
    await pool.query(
      "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'actionable_added', $2)",
      [id, `Actionable added: ${trimmed.slice(0, 200)}`]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/leads/:leadId/actionables/:id — toggle complete / edit
router.patch("/:leadId/actionables/:id", async (req, res, next) => {
  try {
    const { leadId, id } = req.params;
    const { text, completed, completed_note } = req.body;
    const sets = [];
    const values = [id, leadId];
    if (text !== undefined) {
      if (!isString(text) || text.trim().length < 1 || text.length > 1000) {
        return res.status(400).json({ error: "text must be a non-empty string up to 1000 chars" });
      }
      values.push(text.trim());
      sets.push(`text = $${values.length}`);
    }
    if (completed !== undefined) {
      if (typeof completed !== "boolean") {
        return res.status(400).json({ error: "completed must be a boolean" });
      }
      values.push(completed);
      sets.push(`completed = $${values.length}`);
      sets.push(`completed_at = ${completed ? "NOW()" : "NULL"}`);
    }
    if (completed_note !== undefined) {
      if (completed_note !== null && (!isString(completed_note) || completed_note.length > 2000)) {
        return res.status(400).json({ error: "completed_note must be a string up to 2000 chars" });
      }
      values.push(completed_note);
      sets.push(`completed_note = $${values.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: "no valid fields to update" });

    const { rows } = await pool.query(
      `UPDATE lead_actionables SET ${sets.join(", ")}
       WHERE id = $1 AND lead_id = $2 RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: "actionable not found" });
    const updated = rows[0];

    // Surface the meaningful state change to the admin activity log.
    if (completed !== undefined) {
      const action = completed ? "actionable_completed" : "actionable_uncompleted";
      const verb = completed ? "Completed" : "Reopened";
      await pool.query(
        "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
        [leadId, action, `${verb}: ${updated.text.slice(0, 200)}`]
      );
    } else if (text !== undefined) {
      await pool.query(
        "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'actionable_edited', $2)",
        [leadId, `Edited actionable: ${updated.text.slice(0, 200)}`]
      );
    }

    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/actionables/extract — run Gemini on the lead's
// transcript and bulk-insert the extracted actionables.
router.post("/:id/actionables/extract", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query("SELECT transcript FROM leads WHERE id = $1", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "lead not found" });
    const transcript = rows[0].transcript;
    if (!transcript || transcript.trim().length < 20) {
      return res.status(400).json({ error: "transcript is empty or too short to extract from" });
    }

    let extracted;
    try {
      extracted = await extractActionables(transcript);
    } catch (e) {
      if (/GEMINI_API_KEY/.test(e.message)) {
        return res.status(503).json({ error: "Gemini API not configured (set GEMINI_API_KEY on the server)" });
      }
      console.error("[extract] Gemini error:", e.message);
      return res.status(502).json({ error: `Gemini error: ${e.message}` });
    }

    const inserted = [];
    for (const text of extracted) {
      const { rows: r } = await pool.query(
        "INSERT INTO lead_actionables (lead_id, text) VALUES ($1, $2) RETURNING *",
        [id, text]
      );
      inserted.push(r[0]);
    }
    if (inserted.length > 0) {
      await pool.query(
        "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'actionables_extracted', $2)",
        [id, `${inserted.length} actionable${inserted.length === 1 ? "" : "s"} auto-extracted from transcript`]
      );
    }
    res.json({ count: inserted.length, actionables: inserted });
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/transcript/audio — multipart upload of an audio
// recording. Server transcribes via Whisper (any-language → English), stores
// transcript on the lead, then auto-runs the actionables extractor on the
// result. Same code path the Twilio recording webhook will hit when WABA
// goes live.
router.post("/:id/transcript/audio", audioUpload.single("audio"), async (req, res, next) => {
  // The handler body always cleans up the temp file, even on early-returns.
  const cleanup = () => {
    if (req.file?.path) {
      fs.unlink(req.file.path, () => { /* swallow */ });
    }
  };

  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: "no audio file uploaded (field name: 'audio')" });
    const { path: tmpPath, mimetype, originalname, size } = req.file;
    if (!mimetype || !mimetype.startsWith("audio/")) {
      cleanup();
      return res.status(400).json({ error: `expected audio/* mime type, got ${mimetype}` });
    }

    const lead = await pool.query("SELECT id FROM leads WHERE id = $1", [id]);
    if (lead.rows.length === 0) {
      cleanup();
      return res.status(404).json({ error: "lead not found" });
    }

    // Per-lead lock: serialize concurrent uploads against the same lead so
    // their transcript writes + actionable inserts can't race.
    const result = await withUploadLock(id, async () => {
      // 1. Transcribe (Whisper, translates any-language → English)
      let transcript;
      try {
        transcript = await transcribeAudio(tmpPath);
      } catch (e) {
        if (/OPENAI_API_KEY/.test(e.message)) {
          return { status: 503, body: { error: "OpenAI API not configured (set OPENAI_API_KEY on the server)" } };
        }
        console.error("[upload] Whisper transcription error:", e.message);
        return { status: 502, body: { error: `Transcription error: ${e.message}` } };
      }

      // 2. Persist transcript + log activity
      await pool.query(
        "UPDATE leads SET transcript = $1, updated_at = NOW() WHERE id = $2",
        [transcript, id]
      );
      await pool.query(
        `INSERT INTO lead_activity (lead_id, type, text)
         VALUES ($1, 'transcript_attached', $2)`,
        [id, `Audio "${originalname}" (${(size / 1024).toFixed(0)} KB) transcribed via Whisper (translated to English) — ${transcript.length} chars.`]
      );

      // 3. Extract actionables (best-effort; transcript is saved either way).
      //    On re-upload we replace the previous auto-extracted set instead
      //    of accumulating duplicates — counsellor-added or counsellor-
      //    completed actionables are preserved.
      let extracted = [];
      let extract_error = null;
      let replaced_count = 0;
      try {
        extracted = await extractActionables(transcript);

        const { rows: prev } = await pool.query(
          `SELECT ts FROM lead_activity
           WHERE lead_id = $1 AND type = 'actionables_extracted'
           ORDER BY ts DESC LIMIT 1`,
          [id]
        );
        if (prev.length > 0) {
          const { rowCount } = await pool.query(
            `DELETE FROM lead_actionables
             WHERE lead_id = $1
               AND completed = FALSE
               AND created_at >= $2`,
            [id, prev[0].ts]
          );
          replaced_count = rowCount || 0;
        }

        for (const text of extracted) {
          await pool.query(
            "INSERT INTO lead_actionables (lead_id, text) VALUES ($1, $2) RETURNING id",
            [id, text]
          );
        }
        if (extracted.length > 0) {
          const note = replaced_count > 0
            ? `${extracted.length} actionable${extracted.length === 1 ? "" : "s"} auto-extracted from uploaded audio (replaced ${replaced_count} from prior extraction)`
            : `${extracted.length} actionable${extracted.length === 1 ? "" : "s"} auto-extracted from uploaded audio`;
          await pool.query(
            "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'actionables_extracted', $2)",
            [id, note]
          );
        }
      } catch (e) {
        console.error("[upload] extractor failed (transcript still saved):", e.message);
        extract_error = e.message;
      }

      return {
        status: 200,
        body: {
          transcript_chars: transcript.length,
          actionables_count: extracted.length,
          extract_error,
        },
      };
    });

    res.status(result.status).json(result.body);
  } catch (e) {
    next(e);
  } finally {
    cleanup();
  }
});

// Multer error handler (file size limit etc.) — produces a clean JSON error
// instead of the default HTML "PayloadTooLargeError" page when files exceed
// the 10 MB cap or violate other limits.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE"
      ? "audio file too large — max 10 MB"
      : `upload error: ${err.message}`;
    return res.status(413).json({ error: msg });
  }
  next(err);
});

// DELETE /api/leads/:leadId/actionables/:id
router.delete("/:leadId/actionables/:id", async (req, res, next) => {
  try {
    const { leadId, id } = req.params;
    // Capture the text before deleting so the activity log row is meaningful.
    const { rows: pre } = await pool.query(
      "SELECT text FROM lead_actionables WHERE id = $1 AND lead_id = $2",
      [id, leadId]
    );
    const actionableText = pre[0]?.text || "(unknown)";

    const { rowCount } = await pool.query(
      "DELETE FROM lead_actionables WHERE id = $1 AND lead_id = $2",
      [id, leadId]
    );
    if (rowCount === 0) return res.status(404).json({ error: "actionable not found" });

    await pool.query(
      "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'actionable_deleted', $2)",
      [leadId, `Removed actionable: ${actionableText.slice(0, 200)}`]
    );

    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// GET /api/leads/:id/appointments — full per-lead appointment history.
// The simple panel uses this to draw past dates yellow on the calendar.
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
// leads.service_date so the cron reminder + admin/staff legacy code keep
// working unchanged. Notes stay in lead_appointments only — leads.notes is
// the general per-lead annotation and must not get clobbered by per-day
// appointment notes (which would otherwise wipe admin-side context).
//
// Wrapped in a transaction so a partial failure (e.g. INSERT succeeds but
// UPDATE fails) never leaves leads.service_date out of sync with the
// appointment row.
//
// Accepted behavior — status is NOT auto-promoted: if a lead is currently
// 'completed' / 'no_show' / 'unassigned' and someone reschedules via the
// simple panel, the cron's reminder query (status='scheduled' AND
// counsellor_id IS NOT NULL) will silently skip the new slot. Counsellor
// won't get a 12hr reminder; the meeting will likely be missed unless they
// remember on their own. This was an explicit product decision — the
// alternative (auto-revive a completed lead) is more dangerous than a
// missed reminder. To re-arm reminders, edit status via admin first.
router.post("/:id/appointments", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scheduled_for, notes } = req.body;
    if (!scheduled_for || !isValidUtcIso(scheduled_for)) {
      return res
        .status(400)
        .json({ error: "scheduled_for must be ISO 8601 with explicit timezone (Z or ±HH:MM)" });
    }
    // Reject past timestamps server-side as well as in the UI — anyone
    // hitting the API directly shouldn't be able to "schedule" something
    // that's already happened.
    if (new Date(scheduled_for).getTime() < Date.now()) {
      return res.status(400).json({ error: "scheduled_for must be in the future" });
    }
    if (notes !== undefined && notes !== null && notes !== "") {
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
        `UPDATE leads
         SET service_date = $2, reminder_sent = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [id, scheduled_for]
      );
      // Audit trail: admin's activity timeline must reflect simple-panel
      // edits. Truncate the notes preview so a 2000-char note doesn't bloat
      // the activity row.
      const preview = cleanNotes ? ` — ${cleanNotes.slice(0, 200)}` : "";
      await client.query(
        "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'appointment', $2)",
        [id, `Appointment scheduled for ${scheduled_for}${preview}`]
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

// PATCH /api/leads/:leadId/appointments/:apptId — edit a single appointment.
// Currently only `notes` is mutable; the scheduled time is locked once the
// row exists (rescheduling = creating a new appointment). This is the
// "fill in details after the session" path: counsellor opens the calendar,
// clicks the day of a meeting that just happened, and writes what was
// discussed.
router.patch("/:leadId/appointments/:apptId", async (req, res, next) => {
  try {
    const { leadId, apptId } = req.params;
    const { notes } = req.body;
    if (notes !== undefined && notes !== null && notes !== "") {
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
    const preview = cleanNotes ? ` — ${cleanNotes.slice(0, 200)}` : " — (cleared)";
    await pool.query(
      "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, 'appointment', $2)",
      [leadId, `Appointment notes updated${preview}`]
    );
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

export default router;
