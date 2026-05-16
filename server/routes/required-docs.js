// Required-documents routes: per-student LOR / Internship / SOP rows.
// See server/migrate.js → intake_required_docs for the data model.
//
// Two surfaces:
//   - Staff (admin / counsellor) manages drafts, marks-done, sends
//     requests, approves SOP. Counsellors are scoped to their own
//     students; admin sees all.
//   - Student fills briefs during intake, uploads stamped finals on
//     their dashboard after a request is sent.
//
// "Send requests" is a single bulk action: it flips requested_at +
// deadline_at on every LOR/Internship row whose marked_done_at is set
// and requested_at is null. Pre-flight gate: ALL such rows must be
// marked done — partial sends are rejected per product call.
//
// Final-file uploads ride the existing intake_files plumbing
// (server/routes/students.js → /me/upload), so this router just stores
// the resulting file_id on the matching required_doc row.

import express from "express";
import pool from "../db.js";
import { requireStaff, requireStudent } from "../middleware/auth.js";
import { audit } from "../audit.js";

const router = express.Router();
const isPositiveInt = (s) => /^[1-9][0-9]*$/.test(String(s));
const isString = (v) => typeof v === "string";

const KINDS = new Set(["lor", "internship", "sop", "ngo"]);

function wordCount(s) {
  if (typeof s !== "string") return 0;
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

// 5 business days from `from`. Skip Saturday and Sunday only — no
// holiday calendar today (operator's call). Returns a YYYY-MM-DD string
// (no time component) since deadline_at is a DATE column.
function fiveBusinessDaysFrom(from = new Date()) {
  const d = new Date(from);
  let added = 0;
  while (added < 5) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

// Centralised ownership check: returns { row, ok } where ok is true
// when caller may operate on the row. Counsellor sees only their own
// students; admin sees all.
async function loadOwnership(client, id) {
  const { rows } = await client.query(
    `SELECT r.*, s.counsellor_id, s.display_name, s.username
       FROM intake_required_docs r
       JOIN intake_students s ON s.student_id = r.student_id
      WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// =============================================================
// STAFF: list + manage rows for a given student
// =============================================================

// GET /api/required-docs/student/:student_id — list every row for the
// student, ordered by kind then seq.
router.get("/student/:student_id", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const own = await pool.query(
      `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: "student not found" });
    if (
      req.user.kind === "counsellor" &&
      own.rows[0].counsellor_id !== req.user.counsellorId
    ) {
      return res.status(404).json({ error: "student not found" });
    }
    const { rows } = await pool.query(
      `SELECT r.*, f.original_name AS final_file_name, f.size AS final_file_size
         FROM intake_required_docs r
         LEFT JOIN intake_files f ON f.id = r.final_file_id
        WHERE r.student_id = $1
        ORDER BY
          CASE r.kind WHEN 'lor' THEN 1 WHEN 'internship' THEN 2 WHEN 'ngo' THEN 3 WHEN 'sop' THEN 4 ELSE 5 END,
          r.seq`,
      [sid]
    );
    // r.* already pulls student_accepted_at since the migration added it.
    res.json(rows.map((r) => ({ ...r, id: String(r.id), final_file_id: r.final_file_id ? String(r.final_file_id) : null })));
  } catch (e) {
    next(e);
  }
});

// PATCH /api/required-docs/:id — staff edits any subset of:
//   { staff_draft, recipient_name, recipient_role, reason_brief,
//     company_name, company_website, activity_brief }
// Word-count caps are enforced server-side as a defence-in-depth check
// against the client UI.
router.patch("/:id", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return res.status(404).json({ error: "not found" });
    if (
      req.user.kind === "counsellor" &&
      own.counsellor_id !== req.user.counsellorId
    ) {
      return res.status(404).json({ error: "not found" });
    }
    const allowed = [
      "staff_draft",
      "recipient_name", "recipient_role", "reason_brief",
      "company_name", "company_website", "activity_brief",
    ];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        const v = req.body[key];
        if (key === "reason_brief" && wordCount(v) > 20) {
          return res.status(400).json({ error: "reason_brief exceeds 20 words" });
        }
        if (key === "activity_brief" && wordCount(v) > 30) {
          return res.status(400).json({ error: "activity_brief exceeds 30 words" });
        }
        params.push(v === "" ? null : v);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });
    params.push(Number(req.params.id));
    const { rows } = await pool.query(
      `UPDATE intake_required_docs
          SET ${sets.join(", ")}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING *`,
      params
    );
    audit(req, {
      table: "intake_required_docs",
      id: req.params.id,
      action: "update",
      diff: req.body,
    });
    res.json({ ...rows[0], id: String(rows[0].id) });
  } catch (e) {
    next(e);
  }
});

// POST /api/required-docs/:id/mark-done — staff flips marked_done_at
// (LOR/Internship). Setting body { undo: true } clears the flag.
router.post("/:id/mark-done", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return res.status(404).json({ error: "not found" });
    if (req.user.kind === "counsellor" && own.counsellor_id !== req.user.counsellorId) {
      return res.status(404).json({ error: "not found" });
    }
    if (own.kind === "sop") {
      return res.status(400).json({ error: "SOP uses /approve, not /mark-done" });
    }
    const undo = req.body?.undo === true;
    // Don't allow un-marking a row that's already been requested — it
    // would create a confusing state where the student is mid-deadline
    // but the staff side claims "not done." Force them to also clear
    // requested_at if they really want to walk it back (no UI for that
    // today; intentional friction).
    if (undo && own.requested_at) {
      return res.status(409).json({ error: "row already requested; cannot un-mark" });
    }
    await pool.query(
      `UPDATE intake_required_docs
          SET marked_done_at = $1, updated_at = NOW()
        WHERE id = $2`,
      [undo ? null : new Date(), Number(req.params.id)]
    );
    audit(req, {
      table: "intake_required_docs",
      id: req.params.id,
      action: undo ? "mark_done_undo" : "mark_done",
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/required-docs/:id/approve — admin approves an SOP draft.
// Counsellor cannot self-approve their own SOP draft (operator's
// "admin must approve" rule); admin can approve any. body { undo: true }
// clears the approval.
router.post("/:id/approve", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "invalid id" });
    if (req.user.kind !== "admin") {
      return res.status(403).json({ error: "only admin can approve SOP" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return res.status(404).json({ error: "not found" });
    if (own.kind !== "sop") {
      return res.status(400).json({ error: "approve is for SOP only" });
    }
    const undo = req.body?.undo === true;
    await pool.query(
      `UPDATE intake_required_docs
          SET approved_by_admin_at = $1, updated_at = NOW()
        WHERE id = $2`,
      [undo ? null : new Date(), Number(req.params.id)]
    );
    audit(req, {
      table: "intake_required_docs",
      id: req.params.id,
      action: undo ? "approve_sop_undo" : "approve_sop",
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/required-docs/student/:student_id/send-requests — bulk
// flip requested_at + deadline_at on every LOR/Internship row whose
// marked_done_at is set and requested_at is null. Pre-flight: every
// LOR/Internship row MUST be marked done; partial sends rejected.
router.post("/student/:student_id/send-requests", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const own = await pool.query(
      `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: "student not found" });
    if (
      req.user.kind === "counsellor" &&
      own.rows[0].counsellor_id !== req.user.counsellorId
    ) {
      return res.status(404).json({ error: "student not found" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Lock all of this student's LOR/Internship rows for the
      // duration so a concurrent PATCH can't change marked_done_at
      // between the gate-check and the bulk update.
      const allRows = await client.query(
        `SELECT id, kind, seq, marked_done_at, requested_at
           FROM intake_required_docs
          WHERE student_id = $1 AND kind IN ('lor','internship','ngo')
          ORDER BY kind, seq
          FOR UPDATE`,
        [sid]
      );
      const rows = allRows.rows;
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "no LOR, internship, or NGO rows to send" });
      }
      const notDone = rows.filter((r) => !r.marked_done_at);
      if (notDone.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "all LOR / internship / NGO rows must be marked done before sending",
          notDone: notDone.map((r) => `${r.kind}#${r.seq}`),
        });
      }
      const toSend = rows.filter((r) => !r.requested_at);
      if (toSend.length === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "all rows already requested" });
      }
      const deadline = fiveBusinessDaysFrom(new Date());
      const now = new Date();
      await client.query(
        `UPDATE intake_required_docs
            SET requested_at = $1, deadline_at = $2, updated_at = NOW()
          WHERE student_id = $3
            AND kind IN ('lor','internship','ngo')
            AND marked_done_at IS NOT NULL
            AND requested_at IS NULL`,
        [now, deadline, sid]
      );
      await client.query("COMMIT");
      audit(req, {
        table: "intake_required_docs",
        id: sid,
        action: "send_requests_bulk",
        diff: {
          count: toSend.length,
          ids: toSend.map((r) => String(r.id)),
          deadline,
        },
      });
      res.json({ ok: true, sent: toSend.length, deadline });
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

// POST /api/required-docs/student/:student_id — staff creates a new row
// for any kind (lor / internship / ngo). Auto-allocates next seq for
// that kind. Used by the "Add document" button in the admin panel.
router.post("/student/:student_id", requireStaff, express.json(), async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const own = await pool.query(
      `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: "student not found" });
    if (
      req.user.kind === "counsellor" &&
      own.rows[0].counsellor_id !== req.user.counsellorId
    ) {
      return res.status(404).json({ error: "student not found" });
    }
    const body = req.body || {};
    const kind = isString(body.kind) ? body.kind.trim() : "";
    if (!KINDS.has(kind) || kind === "sop") {
      return res.status(400).json({ error: "kind must be lor, internship, or ngo" });
    }
    const recipient_name  = isString(body.recipient_name)  ? body.recipient_name.trim()  : "";
    const recipient_role  = isString(body.recipient_role)  ? body.recipient_role.trim()  : "";
    const reason_brief    = isString(body.reason_brief)    ? body.reason_brief.trim()    : "";
    const company_name    = isString(body.company_name)    ? body.company_name.trim()    : "";
    const company_website = isString(body.company_website) ? body.company_website.trim() : "";
    const activity_brief  = isString(body.activity_brief)  ? body.activity_brief.trim()  : "";
    if (wordCount(reason_brief) > 20)   return res.status(400).json({ error: "reason_brief exceeds 20 words" });
    if (wordCount(activity_brief) > 30) return res.status(400).json({ error: "activity_brief exceeds 30 words" });
    const seqRes = await pool.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM intake_required_docs
        WHERE student_id = $1 AND kind = $2`,
      [sid, kind]
    );
    const nextSeq = seqRes.rows[0].next_seq;
    const ins = await pool.query(
      `INSERT INTO intake_required_docs
         (student_id, kind, seq, recipient_name, recipient_role, reason_brief,
          company_name, company_website, activity_brief, student_accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING id`,
      [sid, kind, nextSeq,
       recipient_name || null, recipient_role || null, reason_brief || null,
       company_name || null, company_website || null, activity_brief || null]
    );
    audit(req, {
      table: "intake_required_docs",
      id: String(ins.rows[0].id),
      action: "create_required_doc_staff",
      diff: { kind, seq: nextSeq, recipient_name, company_name },
    });
    res.json({ ok: true, id: String(ins.rows[0].id) });
  } catch (e) {
    next(e);
  }
});

// =============================================================
// STUDENT: read own rows + upload finals
// =============================================================

// GET /api/required-docs/me — student reads their own rows. Used by
// the dashboard card. Excludes staff_draft fields the student
// shouldn't see while a row is still mid-draft (only the "request
// sent" rows expose staff_draft as the printable text).
router.get("/me", requireStudent, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.kind, r.seq,
              r.recipient_name, r.recipient_role, r.reason_brief,
              r.company_name, r.company_website, r.activity_brief,
              CASE WHEN r.requested_at IS NOT NULL OR r.approved_by_admin_at IS NOT NULL
                   THEN r.staff_draft ELSE NULL END AS staff_draft,
              r.marked_done_at, r.approved_by_admin_at,
              r.requested_at, r.deadline_at, r.final_file_id,
              r.student_accepted_at,
              r.created_at, r.updated_at,
              f.original_name AS final_file_name, f.size AS final_file_size
         FROM intake_required_docs r
         LEFT JOIN intake_files f ON f.id = r.final_file_id
        WHERE r.student_id = $1
        ORDER BY
          CASE r.kind WHEN 'lor' THEN 1 WHEN 'internship' THEN 2 WHEN 'ngo' THEN 3 WHEN 'sop' THEN 4 ELSE 5 END,
          r.seq`,
      [req.user.studentId]
    );
    res.json(rows.map((r) => ({
      ...r,
      id: String(r.id),
      final_file_id: r.final_file_id ? String(r.final_file_id) : null,
    })));
  } catch (e) {
    next(e);
  }
});

// POST /api/required-docs/me/:id/accept-suggestion — student accepts
// an AI-suggested LOR row. Sets student_accepted_at = NOW() so the
// row leaves the suggestion bucket and enters the regular drafting
// lifecycle. Refuses if the row isn't theirs, isn't kind='lor', or
// is already accepted (no-op idempotent path returns ok=true).
router.post("/me/:id/accept-suggestion", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const { rows } = await pool.query(
      `SELECT id, kind, student_accepted_at FROM intake_required_docs
        WHERE id = $1 AND student_id = $2`,
      [Number(req.params.id), req.user.studentId]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: "not found" });
    if (doc.kind !== "lor") {
      return res.status(400).json({ error: "only LOR suggestions can be accepted" });
    }
    if (doc.student_accepted_at) {
      return res.json({ ok: true, already_accepted: true });
    }
    await pool.query(
      `UPDATE intake_required_docs
          SET student_accepted_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [Number(req.params.id)]
    );
    audit(req, {
      table: "intake_required_docs",
      id: req.params.id,
      action: "accept_lor_suggestion",
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/required-docs/me/:id — student rejects / removes a
// kind='lor' row that is still a suggestion (student_accepted_at
// IS NULL). Refuses to delete rows the student already accepted
// (those go through the staff workflow and should be removed by
// the counsellor instead) and refuses anything that isn't kind='lor'.
router.delete("/me/:id", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const { rows } = await pool.query(
      `SELECT id, kind, student_accepted_at, requested_at, final_file_id
         FROM intake_required_docs
        WHERE id = $1 AND student_id = $2`,
      [Number(req.params.id), req.user.studentId]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: "not found" });
    if (doc.kind !== "lor") {
      return res.status(400).json({ error: "only LOR rows can be deleted by the student" });
    }
    if (doc.student_accepted_at) {
      return res.status(409).json({ error: "row already accepted; ask your counsellor to remove it" });
    }
    await pool.query(
      `DELETE FROM intake_required_docs WHERE id = $1`,
      [Number(req.params.id)]
    );
    audit(req, {
      table: "intake_required_docs",
      id: req.params.id,
      action: "delete_lor_suggestion",
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/required-docs/me — student adds a new LOR row themselves
// (the "+ add another" button beneath the suggestion list). Lands as
// already-accepted (student_accepted_at = NOW()) since the student is
// the one inserting it. Auto-allocates the next seq for kind='lor'.
router.post("/me", requireStudent, express.json(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const recipient_name = isString(body.recipient_name) ? body.recipient_name.trim() : "";
    const recipient_role = isString(body.recipient_role) ? body.recipient_role.trim() : "";
    const reason_brief = isString(body.reason_brief) ? body.reason_brief.trim() : "";
    if (!recipient_name && !recipient_role && !reason_brief) {
      return res.status(400).json({ error: "at least one of recipient_name / recipient_role / reason_brief required" });
    }
    if (wordCount(reason_brief) > 20) {
      return res.status(400).json({ error: "reason_brief exceeds 20 words" });
    }
    const seqRes = await pool.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM intake_required_docs
        WHERE student_id = $1 AND kind = 'lor'`,
      [req.user.studentId]
    );
    const nextSeq = seqRes.rows[0].next_seq;
    const ins = await pool.query(
      `INSERT INTO intake_required_docs
         (student_id, kind, seq, recipient_name, recipient_role, reason_brief, student_accepted_at)
       VALUES ($1, 'lor', $2, $3, $4, $5, NOW())
       RETURNING id`,
      [req.user.studentId, nextSeq, recipient_name || null, recipient_role || null, reason_brief || null]
    );
    audit(req, {
      table: "intake_required_docs",
      id: String(ins.rows[0].id),
      action: "create_lor_self",
      diff: { recipient_name, recipient_role, reason_brief },
    });
    res.json({ ok: true, id: String(ins.rows[0].id) });
  } catch (e) {
    next(e);
  }
});

// POST /api/required-docs/me/:id/attach-final — link a file the
// student already uploaded (via /api/students/me/upload) to their
// required-doc row. The upload endpoint stays generic; this just
// attaches an existing intake_files row id to the matching required-doc.
// Refuses if the row is SOP (no upload) or hasn't been requested yet.
router.post("/me/:id/attach-final", requireStudent, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const { file_id } = req.body || {};
    if (!isPositiveInt(file_id)) return res.status(400).json({ error: "file_id required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const docRes = await client.query(
        `SELECT id, kind, requested_at FROM intake_required_docs
          WHERE id = $1 AND student_id = $2 FOR UPDATE`,
        [Number(req.params.id), req.user.studentId]
      );
      const doc = docRes.rows[0];
      if (!doc) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not found" }); }
      if (doc.kind === "sop") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "SOP has no student upload" });
      }
      if (!doc.requested_at) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "request not yet sent — wait for your counsellor" });
      }
      const fileRes = await client.query(
        `SELECT id, student_id, superseded_at FROM intake_files WHERE id = $1`,
        [Number(file_id)]
      );
      const file = fileRes.rows[0];
      if (!file || file.student_id !== req.user.studentId || file.superseded_at) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "file not found" });
      }
      await client.query(
        `UPDATE intake_required_docs SET final_file_id = $1, updated_at = NOW() WHERE id = $2`,
        [Number(file_id), Number(req.params.id)]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    audit(req, {
      table: "intake_required_docs",
      id: req.params.id,
      action: "attach_final",
      diff: { file_id: String(file_id) },
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;

// Exposed for use by server/routes/students.js when intake completes:
// reads paths_list-style briefs out of data.answers and creates the
// LOR/Internship rows + the auto-SOP row in one transaction.
//
// Downward reconciliation: if a student deletes one of N existing LOR
// or internship rows from the intake form, we delete the now-orphan
// `seq > newCount` rows so the staff side doesn't keep showing
// stale recipient data for a row the student no longer wants. We
// only delete rows that haven't been sent to the student yet
// (requested_at IS NULL); once a request is out the door, the row
// is operationally meaningful and deleting it would lose audit trail.
export async function seedRequiredDocsForStudent(client, studentId, answers) {
  const lors = Array.isArray(answers?.lors_list) ? answers.lors_list : [];
  const interns = Array.isArray(answers?.internships_list) ? answers.internships_list : [];

  // Count of valid (non-blank) entries in the new lists, used as the
  // upper-bound seq to keep. Mirrors the per-row "skip if blank" rule
  // below so we don't accidentally delete a real row.
  const liveLorCount = lors.filter((r) => {
    if (!r || typeof r !== "object") return false;
    const name = (r.recipient_name || "").trim();
    const role = (r.recipient_role || "").trim();
    const reason = (r.reason_brief || "").trim();
    return !!(name || role || reason);
  }).length;
  const liveInternCount = interns.filter((r) => {
    if (!r || typeof r !== "object") return false;
    const company = (r.company_name || "").trim();
    const website = (r.company_website || "").trim();
    const activity = (r.activity_brief || "").trim();
    return !!(company || website || activity);
  }).length;

  let seq = 0;
  for (const r of lors) {
    if (!r || typeof r !== "object") continue;
    const name = (r.recipient_name || "").trim();
    const role = (r.recipient_role || "").trim();
    const reason = (r.reason_brief || "").trim();
    if (!name && !role && !reason) continue;
    seq++;
    await client.query(
      `INSERT INTO intake_required_docs
         (student_id, kind, seq, recipient_name, recipient_role, reason_brief)
       VALUES ($1, 'lor', $2, $3, $4, $5)
       ON CONFLICT (student_id, kind, seq) DO UPDATE
          SET recipient_name = EXCLUDED.recipient_name,
              recipient_role = EXCLUDED.recipient_role,
              reason_brief = EXCLUDED.reason_brief,
              updated_at = NOW()`,
      [studentId, seq, name || null, role || null, reason || null]
    );
  }
  // Drop tail rows the student removed (only if not already requested).
  await client.query(
    `DELETE FROM intake_required_docs
       WHERE student_id = $1 AND kind = 'lor'
         AND seq > $2 AND requested_at IS NULL`,
    [studentId, liveLorCount]
  );

  seq = 0;
  for (const r of interns) {
    if (!r || typeof r !== "object") continue;
    const company = (r.company_name || "").trim();
    const website = (r.company_website || "").trim();
    const activity = (r.activity_brief || "").trim();
    if (!company && !website && !activity) continue;
    seq++;
    await client.query(
      `INSERT INTO intake_required_docs
         (student_id, kind, seq, company_name, company_website, activity_brief)
       VALUES ($1, 'internship', $2, $3, $4, $5)
       ON CONFLICT (student_id, kind, seq) DO UPDATE
          SET company_name = EXCLUDED.company_name,
              company_website = EXCLUDED.company_website,
              activity_brief = EXCLUDED.activity_brief,
              updated_at = NOW()`,
      [studentId, seq, company || null, website || null, activity || null]
    );
  }
  await client.query(
    `DELETE FROM intake_required_docs
       WHERE student_id = $1 AND kind = 'internship'
         AND seq > $2 AND requested_at IS NULL`,
    [studentId, liveInternCount]
  );

  // Mandatory internship slots: always ensure seq 1 and 2 exist even if
  // the student's intake had fewer entries. ON CONFLICT DO NOTHING
  // preserves any existing data (name/website/etc.) already seeded above.
  for (const mandatorySeq of [1, 2]) {
    await client.query(
      `INSERT INTO intake_required_docs (student_id, kind, seq)
       VALUES ($1, 'internship', $2)
       ON CONFLICT (student_id, kind, seq) DO NOTHING`,
      [studentId, mandatorySeq]
    );
  }

  // NGO — one mandatory slot, always present.
  await client.query(
    `INSERT INTO intake_required_docs (student_id, kind, seq)
     VALUES ($1, 'ngo', 1)
     ON CONFLICT (student_id, kind, seq) DO NOTHING`,
    [studentId]
  );

  // SOP — exactly one row, auto-created. Idempotent via the
  // (student, kind, seq) unique index.
  await client.query(
    `INSERT INTO intake_required_docs (student_id, kind, seq)
     VALUES ($1, 'sop', 1)
     ON CONFLICT (student_id, kind, seq) DO NOTHING`,
    [studentId]
  );
}
