import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";
import { isValidUtcIso, isValidYmd } from "../../lib/time.js";
import { audit } from "../audit.js";
import { requireAdmin } from "../middleware/auth.js";
import { getStorage } from "../storage.js";

const router = express.Router();

// Append-only R2 backup for lead + appointment mutations.
async function backupLeadEvent(event, payload) {
  try {
    const storage = getStorage();
    const leadId = payload.id ?? payload.lead_id ?? "unknown";
    const key = `leads/${leadId}/${event}-${Date.now()}.json`;
    await storage.putBlob({
      key,
      body: Buffer.from(JSON.stringify({ event, payload, timestamp: new Date().toISOString() })),
      contentType: "application/json",
    });
  } catch (e) {
    console.error("[backup] lead event failed:", e.message);
  }
}

async function backupAppointmentEvent(event, leadId, payload) {
  try {
    const storage = getStorage();
    const apptId = payload.id ?? "unknown";
    const key = `leads/${leadId}/appointments/${apptId}/${event}-${Date.now()}.json`;
    await storage.putBlob({
      key,
      body: Buffer.from(JSON.stringify({ event, lead_id: leadId, payload, timestamp: new Date().toISOString() })),
      contentType: "application/json",
    });
  } catch (e) {
    console.error("[backup] appointment event failed:", e.message);
  }
}

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
    // next_appointment_* columns let the followup row show a "Session"
    // button without round-tripping per lead. Picks the next upcoming
    // appointment, else falls back to the most recent past one — same
    // precedence as the service_date recompute in POST /:id/appointments.
    // The fallback keeps the Session button available after the meeting
    // time has passed so the counsellor can still add notes for that
    // session; once a followup is booked, the upcoming row takes over
    // and the Session target retargets to the new appointment.
    // Both subqueries use NOW() (statement-stable in Postgres) so id and
    // scheduled_for always come from the same row.
    // ad_hoc = FALSE filter on every appointment subquery so a
    // pre-appointment quick-call note never becomes the lead's
    // displayed "next session" or service_date. The Session button is
    // now always shown on the client regardless of next_appointment_id,
    // so the field's role here is purely "what calendar-booked session
    // is the lead currently focused on?".
    const sql = `
      SELECT leads.*,
        COALESCE(
          (SELECT id FROM lead_appointments
             WHERE lead_id = leads.id AND ad_hoc = FALSE AND scheduled_for >= NOW()
             ORDER BY scheduled_for ASC LIMIT 1),
          (SELECT id FROM lead_appointments
             WHERE lead_id = leads.id AND ad_hoc = FALSE AND scheduled_for < NOW()
             ORDER BY scheduled_for DESC LIMIT 1)
        ) AS next_appointment_id,
        COALESCE(
          (SELECT scheduled_for FROM lead_appointments
             WHERE lead_id = leads.id AND ad_hoc = FALSE AND scheduled_for >= NOW()
             ORDER BY scheduled_for ASC LIMIT 1),
          (SELECT scheduled_for FROM lead_appointments
             WHERE lead_id = leads.id AND ad_hoc = FALSE AND scheduled_for < NOW()
             ORDER BY scheduled_for DESC LIMIT 1)
        ) AS next_appointment_scheduled_for
      FROM leads
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY service_date ASC NULLS LAST
    `;
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

    backupLeadEvent("create", rows[0]).catch(() => {});
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

    // Cascade counsellor reassignment to dependent rows so ownership
    // stays consistent. Without this, admin reassigning a lead from
    // counsellor A to counsellor B leaves the lead's tasks pointing
    // at A and the linked student under A — the new owner couldn't
    // see them in their scoped views.
    //   - counsellor_tasks: only counsellor-kind, non-archived tasks
    //     pinned to this lead get reassigned. Admin-targeted tasks
    //     keep their assignee_admin_username (different inbox).
    //   - counsellor_task_assignees: the junction table that drives the
    //     scope filter + chip display. Replace every reference to the
    //     OLD lead owner with NEW. Multi-assignee tasks like [A, X, Y]
    //     become [B, X, Y] — co-assignees keep their access. For tasks
    //     that didn't have A in the junction (e.g. assigned solely to
    //     X), we still add B alongside so the legacy column we just
    //     wrote (assignee_id = B) has a matching junction row.
    //   - intake_students: any student linked to this lead inherits
    //     the new owner. The student's lead_id stays put.
    const client = await pool.connect();
    let updated;
    try {
      await client.query("BEGIN");
      const sql = `UPDATE leads SET ${set}${extraSet}, updated_at = NOW() WHERE id = $1 RETURNING *`;
      const { rows: updatedRows } = await client.query(sql, values);
      updated = updatedRows[0];
      if (counsellorChanged) {
        await client.query(
          `UPDATE counsellor_tasks
              SET assignee_id = $1
            WHERE lead_id = $2
              AND assignee_kind = 'counsellor'
              AND archived = FALSE`,
          [req.body.counsellor_id, id]
        );
        // Junction replace: where OLD counsellor is an assignee, swap
        // to NEW. Wrapped in a guard against the same person being on
        // both sides (no-op then). Only updates rows whose task is on
        // this lead, counsellor-kind, non-archived — matches the
        // legacy column update above.
        if (before.counsellor_id && before.counsellor_id !== req.body.counsellor_id) {
          await client.query(
            `UPDATE counsellor_task_assignees ja
                SET counsellor_id = $1
              WHERE ja.counsellor_id = $2
                AND ja.task_id IN (
                  SELECT t.id FROM counsellor_tasks t
                   WHERE t.lead_id = $3
                     AND t.assignee_kind = 'counsellor'
                     AND t.archived = FALSE
                )`,
            [req.body.counsellor_id, before.counsellor_id, id]
          );
        }
        // Ensure NEW is in the junction for every cascaded task — covers
        // the case where the task was solo-assigned to someone other
        // than the previous lead owner (so the UPDATE above didn't
        // touch it) but the legacy column was just rewritten to NEW.
        // The NOT EXISTS guard skips when NEW is already present so
        // the unique index doesn't trip.
        await client.query(
          `INSERT INTO counsellor_task_assignees (task_id, assignee_kind, counsellor_id, admin_username)
           SELECT t.id, 'counsellor', $1, NULL
             FROM counsellor_tasks t
            WHERE t.lead_id = $2
              AND t.assignee_kind = 'counsellor'
              AND t.archived = FALSE
              AND NOT EXISTS (
                SELECT 1 FROM counsellor_task_assignees ja
                 WHERE ja.task_id = t.id
                   AND ja.counsellor_id = $1
              )`,
          [req.body.counsellor_id, id]
        );
        await client.query(
          `UPDATE intake_students
              SET counsellor_id = $1, updated_at = NOW()
            WHERE lead_id = $2`,
          [req.body.counsellor_id, id]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    backupLeadEvent("update", updated).catch(() => {});
    res.json(updated);
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
      backupLeadEvent("archive", exists.rows[0]).catch(() => {});
      return res.json(exists.rows[0]);
    }
    backupLeadEvent("archive", rows[0]).catch(() => {});
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
      backupLeadEvent("unarchive", exists.rows[0]).catch(() => {});
      return res.json(exists.rows[0]);
    }
    backupLeadEvent("unarchive", rows[0]).catch(() => {});
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/leads/:id — admin-only hard delete. Used by the archived
// panel to clear out a finished followup series. Guarded to archived
// rows only so a stray click on an active lead can't wipe live work.
//
// Cascade behaviour (from migrate.js):
//   - lead_appointments.lead_id FK is ON DELETE CASCADE → history wiped
//   - counsellor_tasks.lead_id   FK is ON DELETE CASCADE → tasks wiped
//   - intake_students.lead_id    FK is ON DELETE SET NULL → student row
//     stays with all intake data; it just loses the back-reference to
//     this lead. This is the explicit invariant: deleting a lead must
//     never touch the student's intake-side data.
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: existing } = await pool.query(
      "SELECT * FROM leads WHERE id = $1",
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: "lead not found" });
    }
    if (!existing[0].archived) {
      return res
        .status(400)
        .json({ error: "lead must be archived before deletion" });
    }
    // Snapshot to R2 before deletion so the record is recoverable.
    await backupLeadEvent("delete", existing[0]);
    await pool.query("DELETE FROM leads WHERE id = $1", [id]);
    // 204 .end() bypasses autoAudit's res.json hook; log explicitly
    // so a destructive admin op never silently disappears from the
    // audit trail.
    audit(req, { table: "leads", id, action: "delete" });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// PUT /api/leads/:id/followup — set or clear the counsellor-facing
// "next check-in" date + required note. Separate from the formal
// appointment calendar: this is a lightweight reminder column, not
// a session-note entry. Notes are required when setting a date; both
// fields are cleared together when followup_date is null.
router.put("/:id/followup", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkLeadAccess(req, res, id))) return;

    const { followup_date, followup_notes } = req.body;

    if (followup_date === null || followup_date === undefined) {
      // Clear the followup entirely.
      const { rows } = await pool.query(
        `UPDATE leads SET followup_date = NULL, followup_notes = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "lead not found" });
      backupLeadEvent("followup-clear", rows[0]).catch(() => {});
      return res.json(rows[0]);
    }

    if (!isValidUtcIso(followup_date)) {
      return res.status(400).json({ error: "followup_date must be ISO 8601 with explicit timezone" });
    }
    if (new Date(followup_date).getTime() <= Date.now()) {
      return res.status(400).json({ error: "followup_date must be in the future" });
    }
    if (!followup_notes || typeof followup_notes !== "string" || !followup_notes.trim()) {
      return res.status(400).json({ error: "A note is required when setting a follow-up date" });
    }

    const { rows } = await pool.query(
      `UPDATE leads SET followup_date = $2, followup_notes = $3, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, followup_date, followup_notes.trim()]
    );
    if (rows.length === 0) return res.status(404).json({ error: "lead not found" });
    backupLeadEvent("followup-set", rows[0]).catch(() => {});
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

    const { scheduled_for, notes, ad_hoc } = req.body;
    if (!scheduled_for || !isValidUtcIso(scheduled_for)) {
      return res
        .status(400)
        .json({ error: "scheduled_for must be ISO 8601 with explicit timezone (Z or ±HH:MM)" });
    }
    // Past times are allowed: counsellors backfill missed/historical
    // sessions for note-taking purposes (e.g. logging a session that
    // happened off-platform). The lead.service_date recompute below
    // still picks "next upcoming, else most recent past" so the row's
    // visible "next session" header doesn't shift backwards.
    if (notes) {
      if (!isString(notes) || notes.length > 2000) {
        return res.status(400).json({ error: "notes must be a string up to 2000 chars" });
      }
    }

    const cleanNotes = notes ? notes.trim() : null;
    const cleanAdHoc = ad_hoc === true;

    // For ad_hoc quick-call rows: reuse an existing un-noted ad_hoc row
    // rather than creating a new one. Prevents repeated "Make Notes"
    // clicks from accumulating empty rows that show as "Session Missed"
    // in the history popup.
    if (cleanAdHoc && !cleanNotes) {
      const { rows: existing } = await pool.query(
        `SELECT * FROM lead_appointments
         WHERE lead_id = $1 AND ad_hoc = TRUE AND notes IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [id]
      );
      if (existing.length > 0) {
        return res.status(200).json({ appointment: existing[0] });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: apptRows } = await client.query(
        "INSERT INTO lead_appointments (lead_id, scheduled_for, notes, ad_hoc) VALUES ($1, $2, $3, $4) RETURNING *",
        [id, scheduled_for, cleanNotes, cleanAdHoc]
      );
      // Recompute service_date from the appointments table itself so the
      // value always reflects "next upcoming, else most recent past" —
      // filtered to ad_hoc = FALSE so a quick pre-appointment call never
      // becomes the lead's official next session date.
      const { rows: leadRows } = await client.query(
        `UPDATE leads SET
           service_date = COALESCE(
             (SELECT MIN(scheduled_for) FROM lead_appointments
                WHERE lead_id = $1 AND ad_hoc = FALSE AND scheduled_for >= NOW()),
             (SELECT MAX(scheduled_for) FROM lead_appointments
                WHERE lead_id = $1 AND ad_hoc = FALSE)
           ),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id]
      );
      await client.query("COMMIT");
      backupAppointmentEvent("create", id, apptRows[0]).catch(() => {});
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

// Patch one of {notes, scheduled_for}. At least one must be present —
// PATCH {} would silently no-op or, in earlier versions, NULL fields
// the caller didn't intend to touch. Each field is only updated when
// the body explicitly carries the key.
//
// scheduled_for changes recompute the lead's service_date in the same
// transaction as the appointment update, mirroring POST. The response
// shape is { appointment, lead } so the client can patch its lead-row
// cache (the followup table's "Appointment Date" column) without a
// refetch, and HistoryPopup / SessionPopup can read appointment from
// it. Old callers passing only notes still receive { appointment,
// lead: null } — see SimpleFollowup.jsx for the consumer side.
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
    const body = req.body || {};
    const hasNotes = Object.prototype.hasOwnProperty.call(body, "notes");
    const hasSchedule = Object.prototype.hasOwnProperty.call(body, "scheduled_for");
    if (!hasNotes && !hasSchedule) {
      return res.status(400).json({ error: "no fields to update" });
    }

    let cleanNotes = null;
    if (hasNotes) {
      const { notes } = body;
      if (notes != null && (!isString(notes) || notes.length > 2000)) {
        return res.status(400).json({ error: "notes must be a string up to 2000 chars" });
      }
      cleanNotes = isString(notes) && notes.trim() ? notes.trim() : null;
    }

    if (hasSchedule) {
      const { scheduled_for } = body;
      if (!scheduled_for || !isValidUtcIso(scheduled_for)) {
        return res
          .status(400)
          .json({ error: "scheduled_for must be ISO 8601 with explicit timezone (Z or ±HH:MM)" });
      }
    }

    const setFragments = [];
    const params = [apptId, leadId];
    if (hasNotes) {
      params.push(cleanNotes);
      setFragments.push(`notes = $${params.length}`);
    }
    if (hasSchedule) {
      params.push(body.scheduled_for);
      setFragments.push(`scheduled_for = $${params.length}`);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: apptRows } = await client.query(
        `UPDATE lead_appointments
         SET ${setFragments.join(", ")}
         WHERE id = $1 AND lead_id = $2
         RETURNING *`,
        params
      );
      if (apptRows.length === 0) {
        await client.query("ROLLBACK").catch(() => {});
        return res.status(404).json({ error: "appointment not found" });
      }
      let lead = null;
      if (hasSchedule) {
        // service_date = next-upcoming non-ad-hoc, else most-recent
        // non-ad-hoc — same recompute used by POST so a date change
        // can shift the row's "Appointment Date" column accurately.
        const { rows: leadRows } = await client.query(
          `UPDATE leads SET
             service_date = COALESCE(
               (SELECT MIN(scheduled_for) FROM lead_appointments
                  WHERE lead_id = $1 AND ad_hoc = FALSE AND scheduled_for >= NOW()),
               (SELECT MAX(scheduled_for) FROM lead_appointments
                  WHERE lead_id = $1 AND ad_hoc = FALSE)
             ),
             updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [leadId]
        );
        lead = leadRows[0] || null;
      }
      await client.query("COMMIT");
      backupAppointmentEvent("update", leadId, apptRows[0]).catch(() => {});
      res.json({ appointment: apptRows[0], lead });
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

export default router;
