import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";
import { isValidUtcIso, isValidYmd } from "../../lib/time.js";
import { audit } from "../audit.js";

const router = express.Router();

const isString = (v) => typeof v === "string";

// Per-lead ownership gate. Admin always passes; counsellors only on
// leads where counsellor_id matches their session. Returns true if the
// caller is allowed; otherwise sends a 404/403 response and returns
// false (so the route handler can early-return without leaking
// existence info to a counsellor poking at IDs).
//
// 404 vs 403: counsellors get 404 for both "doesn't exist" and "exists
// but not yours" so a poker can't probe ID space. Admin gets 404 only
// when the lead actually doesn't exist.
async function checkLeadAccess(req, res, leadId) {
  const { rows } = await pool.query(
    "SELECT counsellor_id FROM leads WHERE id = $1",
    [leadId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "lead not found" });
    return false;
  }
  if (req.user?.kind === "admin") return true;
  if (rows[0].counsellor_id !== req.user?.counsellorId) {
    res.status(404).json({ error: "lead not found" });
    return false;
  }
  return true;
}

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
  // counsellor_name intentionally not validated here — it's no longer in
  // the PATCH allow-list, so any value the client sends is dropped before
  // SQL.
  return null;
}

// GET /api/leads — leads scoped server-side. Counsellors only ever see
// their own (req.user enforces the scope so a forged ?counsellor_id query
// can't widen access). Admin sees everything by default but may opt-in
// to a server-side scope via ?counsellor_id= (used by the impersonation
// view so the wire response only carries that counsellor's leads).
// Archived rows hidden by default, surfaced via ?include_archived=true.
router.get("/", async (req, res, next) => {
  try {
    const includeArchived = req.query.include_archived === "true";
    const where = [];
    const params = [];
    if (!includeArchived) where.push("archived = FALSE");

    if (req.user?.kind === "counsellor") {
      params.push(req.user.counsellorId);
      where.push(`counsellor_id = $${params.length}`);
    } else if (typeof req.query.counsellor_id === "string" && req.query.counsellor_id.length > 0) {
      // Express parses repeated query strings as arrays; without the
      // string check, ?counsellor_id=A&counsellor_id=B would push an
      // array parameter and trigger a Postgres type-mismatch 500.
      params.push(req.query.counsellor_id);
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
    let { name, contact, email, purpose, service_date, counsellor_id, inquiry_date, status: bodyStatus } = req.body;

    // Counsellor sessions: clamp counsellor_id to self regardless of body.
    // Admin sessions: counsellor_id is REQUIRED and must reference a real
    // counsellor row. We deliberately no longer accept counsellor_name on
    // create — the free-text path produced "ghost" leads that never showed
    // up in any counsellor's scoped view, which is exactly the fabrication
    // risk we're closing here.
    if (req.user?.kind === "counsellor") {
      counsellor_id = req.user.counsellorId;
    } else {
      if (!isString(counsellor_id) || counsellor_id.trim().length === 0 || counsellor_id.length > 50) {
        return res.status(400).json({ error: "counsellor_id is required" });
      }
      const cExists = await pool.query("SELECT 1 FROM counsellors WHERE id = $1", [counsellor_id]);
      if (cExists.rows.length === 0) {
        return res.status(400).json({ error: "counsellor_id does not match any counsellor" });
      }
    }

    if (!name || !contact || !purpose) {
      return res.status(400).json({ error: "name, contact, and purpose are required" });
    }

    const validationError = validateLeadInput(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    if (inquiry_date) {
      if (!isValidYmd(inquiry_date)) {
        return res.status(400).json({ error: "inquiry_date must be a valid YYYY-MM-DD date" });
      }
    }
    if (bodyStatus) {
      if (!["scheduled", "completed", "no_show", "unassigned"].includes(bodyStatus)) {
        return res.status(400).json({ error: "invalid status" });
      }
    }

    const id = "L" + randomUUID().replace(/-/g, "").slice(0, 10);
    // counsellor_id is now always present (counsellor: clamped to self;
    // admin: required + validated above), so a fresh lead is always
    // "scheduled" unless the caller explicitly sets a different status.
    const status = bodyStatus || "scheduled";

    const cleanName = name.trim();
    const cleanPurpose = purpose.trim();
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    const cleanInquiry = inquiry_date && inquiry_date !== "" ? inquiry_date : null;

    // counsellor_name column is left in the schema for legacy display
    // fallback (older rows may have a value) but never written by new
    // creates — counsellor_id is the single source of truth going
    // forward.
    const { rows } = await pool.query(
      `INSERT INTO leads (id, name, contact, email, purpose, service_date, counsellor_id, status, inquiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE))
       RETURNING *`,
      [id, cleanName, contact, cleanEmail, cleanPurpose, service_date || null, counsellor_id, status, cleanInquiry]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkLeadAccess(req, res, id))) return;

    // Counsellors cannot reassign ownership; admin can. counsellor_name
    // is no longer accepted on writes — counsellor_id is the single
    // source of truth for ownership going forward.
    const allowedAll = ["counsellor_id", "status", "purpose", "service_date"];
    const allowedCounsellor = ["status", "purpose", "service_date"];
    const allowed = req.user?.kind === "admin" ? allowedAll : allowedCounsellor;
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: "no valid fields to update" });

    if (req.body.status !== undefined && !["scheduled", "completed", "no_show", "unassigned"].includes(req.body.status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    const patchError = validatePatchFields(req.body);
    if (patchError) return res.status(400).json({ error: patchError });

    // If admin is changing counsellor_id to a non-null value, verify the
    // referenced counsellor actually exists. The DB FK would catch a bad
    // value too, but a 400 is friendlier than a 500 from a constraint
    // violation. Null is allowed (admin may unassign a lead).
    if (req.body.counsellor_id) {
      const cExists = await pool.query(
        "SELECT 1 FROM counsellors WHERE id = $1",
        [req.body.counsellor_id]
      );
      if (cExists.rows.length === 0) {
        return res.status(400).json({ error: "counsellor_id does not match any counsellor" });
      }
    }

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
    if (!(await checkLeadAccess(req, res, id))) return;
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
    if (!(await checkLeadAccess(req, res, id))) return;
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
    if (!(await checkLeadAccess(req, res, id))) return;
    const { rows } = await pool.query(
      "SELECT * FROM lead_appointments WHERE lead_id = $1 ORDER BY scheduled_for ASC",
      [id]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/leads/:id/appointments — schedule a new appointment. Inserts
// a row in lead_appointments AND recomputes leads.service_date to reflect
// the *next upcoming* appointment (falling back to the most recent past
// one when none are upcoming). The previous behaviour was to overwrite
// service_date with the just-inserted row's time, which produced wrong
// "Next follow" displays + sort order whenever an out-of-order
// appointment was inserted (e.g. backfilling an earlier date after a
// later one was already booked).
//
// Wrapped in a transaction so a partial failure (e.g. INSERT succeeds but
// the recompute UPDATE fails) never leaves leads.service_date out of sync.
//
// Response shape: { appointment, lead } so the client can update both the
// per-lead appointments cache and the lead row's service_date without
// having to recompute or refetch.
router.post("/:id/appointments", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkLeadAccess(req, res, id))) return;

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

    const cleanNotes = notes ? notes.trim() : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: apptRows } = await client.query(
        "INSERT INTO lead_appointments (lead_id, scheduled_for, notes) VALUES ($1, $2, $3) RETURNING *",
        [id, scheduled_for, cleanNotes]
      );
      // Recompute service_date from the appointments table itself so the
      // value always reflects "next upcoming, else most recent past" no
      // matter what order rows were inserted.
      const { rows: leadRows } = await client.query(
        `UPDATE leads SET
           service_date = COALESCE(
             (SELECT MIN(scheduled_for) FROM lead_appointments
                WHERE lead_id = $1 AND scheduled_for >= NOW()),
             (SELECT MAX(scheduled_for) FROM lead_appointments
                WHERE lead_id = $1)
           ),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id]
      );
      await client.query("COMMIT");
      res.status(201).json({ appointment: apptRows[0], lead: leadRows[0] });
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
    // BIGSERIAL means apptId must be all digits — without this guard a
    // path like /appointments/abc casts to bigint at the DB layer and
    // raises a 500 from the global error handler. 400 is friendlier.
    if (!/^\d+$/.test(apptId)) {
      return res.status(400).json({ error: "invalid appointment id" });
    }
    if (!(await checkLeadAccess(req, res, leadId))) return;
    // Only touch `notes` when the request explicitly sends it. Earlier
    // version unconditionally SET notes = $3, so a PATCH {} (or any
    // partial PATCH that omitted notes — none yet but inevitable as
    // this route grows) silently NULLed any existing notes. Reject
    // empty-body PATCH outright to make the contract explicit.
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "notes")) {
      return res.status(400).json({ error: "no fields to update" });
    }
    const { notes } = req.body;
    if (notes != null && (!isString(notes) || notes.length > 2000)) {
      return res.status(400).json({ error: "notes must be a string up to 2000 chars" });
    }
    const cleanNotes = isString(notes) && notes.trim() ? notes.trim() : null;

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
