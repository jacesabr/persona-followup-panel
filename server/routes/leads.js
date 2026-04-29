import express from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import pool from "../db.js";
import { fireAssignmentNotifications } from "../notify/dispatch.js";
import { seedLeads } from "../seed.js";
import { isValidUtcIso } from "../../lib/time.js";
import { extractActionables, transcribeAudio } from "../extract.js";

// In-memory storage; counsellor calls cap at ~15 min ≈ 5MB at standard
// audio rates. 25MB ceiling matches Whisper API's well-tested upper bound
// and stays within Gemini's inline-data limit so we don't have to use the
// Files API for the common case.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

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

// PUT /api/leads/:id/transcript — set / replace the transcript.
router.put("/:id/transcript", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { counsellor_id, transcript } = req.body;
    if (!isString(counsellor_id) || counsellor_id.length < 1) {
      return res.status(400).json({ error: "counsellor_id is required" });
    }
    if (!isString(transcript) || transcript.length > 100_000) {
      return res.status(400).json({ error: "transcript must be a string up to 100k chars" });
    }
    const cname = await getCounsellorName(counsellor_id);
    if (!cname) return res.status(400).json({ error: "counsellor not found" });

    const { rows } = await pool.query(
      "UPDATE leads SET transcript = $1, updated_at = NOW() WHERE id = $2 RETURNING transcript",
      [transcript, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "lead not found" });

    await pool.query(
      `INSERT INTO lead_activity (lead_id, type, recipient, text)
       VALUES ($1, 'transcript_attached', $2, $3)`,
      [id, counsellor_id, `Transcript updated by ${cname} (${transcript.length} chars).`]
    );
    res.json({ transcript: rows[0].transcript });
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
    // Confirm the lead exists; otherwise PG will throw an FK violation.
    const leadCheck = await pool.query("SELECT 1 FROM leads WHERE id = $1", [id]);
    if (leadCheck.rows.length === 0) return res.status(404).json({ error: "lead not found" });

    const { rows } = await pool.query(
      "INSERT INTO lead_actionables (lead_id, text) VALUES ($1, $2) RETURNING *",
      [id, text.trim()]
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
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/actionables/extract — run Claude on the lead's
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
    res.json({ count: inserted.length, actionables: inserted });
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/transcript/audio — multipart upload of an audio
// recording. Server transcribes via Gemini, stores transcript on the lead,
// then auto-runs the actionables extractor on the result. Same code path
// the Twilio recording webhook will hit when WABA goes live; this endpoint
// lets us validate the audio→transcript→actionables loop today against any
// pre-recorded file.
router.post("/:id/transcript/audio", audioUpload.single("audio"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: "no audio file uploaded (field name: 'audio')" });
    const { buffer, mimetype, originalname, size } = req.file;
    if (!mimetype || !mimetype.startsWith("audio/")) {
      return res.status(400).json({ error: `expected audio/* mime type, got ${mimetype}` });
    }

    const lead = await pool.query("SELECT id FROM leads WHERE id = $1", [id]);
    if (lead.rows.length === 0) return res.status(404).json({ error: "lead not found" });

    // 1. Transcribe (Whisper, translates any-language → English)
    let transcript;
    try {
      transcript = await transcribeAudio(buffer, mimetype);
    } catch (e) {
      if (/OPENAI_API_KEY/.test(e.message)) {
        return res.status(503).json({ error: "OpenAI API not configured (set OPENAI_API_KEY on the server)" });
      }
      console.error("[upload] Whisper transcription error:", e.message);
      return res.status(502).json({ error: `Transcription error: ${e.message}` });
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

    // 3. Extract actionables (best-effort; transcript is saved either way)
    let extracted = [];
    let extract_error = null;
    try {
      extracted = await extractActionables(transcript);
      for (const text of extracted) {
        await pool.query(
          "INSERT INTO lead_actionables (lead_id, text) VALUES ($1, $2) RETURNING id",
          [id, text]
        );
      }
    } catch (e) {
      console.error("[upload] extractor failed (transcript still saved):", e.message);
      extract_error = e.message;
    }

    res.json({
      transcript_chars: transcript.length,
      actionables_count: extracted.length,
      extract_error,
    });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/leads/:leadId/actionables/:id
router.delete("/:leadId/actionables/:id", async (req, res, next) => {
  try {
    const { leadId, id } = req.params;
    const { rowCount } = await pool.query(
      "DELETE FROM lead_actionables WHERE id = $1 AND lead_id = $2",
      [id, leadId]
    );
    if (rowCount === 0) return res.status(404).json({ error: "actionable not found" });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
