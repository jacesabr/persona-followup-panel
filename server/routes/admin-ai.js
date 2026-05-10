// Admin-only HTTP surface for the AI artifact pipeline (the routine
// described in manual_opus_generate.md). Two endpoints:
//
//   GET  /api/admin/ai/pending
//        → list candidate students who haven't been processed yet.
//
//   POST /api/admin/ai/dispatch
//        → atomic write of one student's complete artifact set:
//          per-file descriptions + autofilled answers + resume +
//          SOP draft + LOR drafts + internship drafts. Marks
//          ai_artifacts_generated_at on commit so the same student
//          is never processed twice.
//
// The remote Claude Code routine logs in via /api/auth/login as
// admin, calls /pending, walks each candidate (using the existing
// admin endpoints to load context + download files), authors the
// artifacts in-prompt, then POSTs to /dispatch.
//
// Atomicity: a single transaction wraps every write. If anything
// fails, nothing lands and the candidate stays in the queue for
// the next hourly tick. Never overwrites existing answers or
// existing staff_drafts unless explicitly forced.

import express from "express";
import pool from "../db.js";
import { requireAdmin, requireStaff } from "../middleware/auth.js";
import { audit } from "../audit.js";

const router = express.Router();

const isString = (v) => typeof v === "string";

// Word count walker for the structured resume payload — sums all
// visible text fields (lede, bullet labels + bodies + meta,
// closing_note, inline strips). Mirrors the helper in
// server/scripts/ai/persist-resume.js so the legacy markdown path and
// the new JSON path produce comparable length_words values for the
// staff "may be stale" detector + the dashboard size warning.
function countWordsInResumeJson(payload) {
  if (!payload || typeof payload !== "object") return 0;
  const buckets = [];
  buckets.push(payload.name || "", payload.headline || "", payload.lede || "", payload.closing_note || "");
  for (const arr of [payload.education, payload.standardized_tests, payload.activities, payload.internships, payload.volunteer]) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      buckets.push(it?.label || "", it?.body || "", it?.meta || "");
    }
  }
  if (Array.isArray(payload.skills)) buckets.push(...payload.skills);
  if (Array.isArray(payload.languages)) buckets.push(...payload.languages);
  return buckets.join(" ").trim().split(/\s+/).filter(Boolean).length;
}

// ============================================================
// GET /api/admin/ai/pending
// ============================================================
// Mirrors server/scripts/ai/list-pending.js but over HTTP, so the
// remote routine can pull the candidate set without DB credentials.
router.get("/pending", requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50);
    // Two cohorts qualify (mirrors server/scripts/ai/list-pending.js):
    //   - intake_phase='done' (canonical: student finished their intake)
    //   - ai_eligible_via_pre_upload=TRUE (counsellor pre-uploaded
    //     starter docs via /api/students/with-docs; intake form is
    //     still 'intake' but the AI should read the docs + autofill).
    const { rows } = await pool.query(
      `
      SELECT s.student_id,
             s.display_name,
             s.username,
             s.intake_phase,
             s.intake_complete,
             s.ai_eligible_via_pre_upload,
             CASE
               WHEN s.intake_phase = 'done' THEN 'intake_done'
               WHEN s.ai_eligible_via_pre_upload = TRUE THEN 'pre_upload'
               ELSE 'unknown'
             END AS source_kind,
             s.updated_at,
             c.name AS counsellor_name,
             (SELECT COUNT(*) FROM intake_files f
                WHERE f.student_id = s.student_id AND f.superseded_at IS NULL) AS files_count
        FROM intake_students s
        LEFT JOIN counsellors c ON c.id = s.counsellor_id
       WHERE s.is_archived = FALSE
         AND s.ai_artifacts_generated_at IS NULL
         AND (s.intake_phase = 'done' OR s.ai_eligible_via_pre_upload = TRUE)
       ORDER BY s.updated_at ASC
       LIMIT $1
      `,
      [limit]
    );
    res.json({ candidates: rows });
  } catch (e) {
    next(e);
  }
});

// ============================================================
// Manual-fill request queue
// ============================================================
// The AI pipeline routine (trig_01BTTjNjGDpdGyywLqBTtk1a) no longer
// runs on a cron — Jace triggers it manually from claude.ai/code/
// routines. Counsellors signal "please run AI fill on this student"
// by POSTing to /request-manual-fill, which inserts a row into
// manual_ai_requests. The dispatch endpoint resolves the most-recent
// matching open row when it commits.
//
// requireStaff lets both admin and counsellor request a run; only
// admin sees the queue (the dev does the actual run, after all).

router.post("/request-manual-fill", requireStaff, express.json(), async (req, res, next) => {
  try {
    const { student_id, notes } = req.body || {};
    if (!isString(student_id) || !student_id.startsWith("s_")) {
      return res.status(400).json({ error: "student_id (s_… string) is required" });
    }
    if (notes != null && (!isString(notes) || notes.length > 1000)) {
      return res.status(400).json({ error: "notes must be a string up to 1000 chars" });
    }
    // Verify the student exists (and, for counsellors, that they own
    // them — same scope rule the rest of the staff endpoints use).
    const sRes = await pool.query(
      `SELECT student_id, display_name, counsellor_id FROM intake_students WHERE student_id = $1`,
      [student_id]
    );
    if (sRes.rows.length === 0) {
      return res.status(404).json({ error: "student not found" });
    }
    const student = sRes.rows[0];
    if (req.user.kind === "counsellor" && student.counsellor_id !== req.user.counsellorId) {
      // 404 (not 403) to avoid disclosing the student exists.
      return res.status(404).json({ error: "student not found" });
    }
    // Idempotency: if there's already a pending request for this
    // student, just return that row instead of stacking duplicates.
    // The dispatch endpoint will resolve whichever pending row is
    // most recent.
    const existing = await pool.query(
      `SELECT id, requested_at FROM manual_ai_requests
        WHERE student_id = $1 AND processed_at IS NULL
        ORDER BY requested_at DESC LIMIT 1`,
      [student_id]
    );
    if (existing.rows.length > 0) {
      return res.json({
        ok: true,
        request_id: String(existing.rows[0].id),
        already_pending: true,
        requested_at: existing.rows[0].requested_at,
      });
    }
    const requested_by_kind = req.user.kind === "admin" ? "admin" : "counsellor";
    const requested_by_id = req.user.kind === "counsellor" ? req.user.counsellorId : null;
    const requested_by_admin_username = req.user.kind === "admin" ? req.user.adminUsername : null;
    const ins = await pool.query(
      `INSERT INTO manual_ai_requests
         (student_id, requested_by_kind, requested_by_id, requested_by_admin_username, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, requested_at`,
      [student_id, requested_by_kind, requested_by_id, requested_by_admin_username, notes ? notes.trim() : null]
    );
    audit(req, {
      table: "manual_ai_requests",
      id: String(ins.rows[0].id),
      action: "create",
      diff: { student_id, display_name: student.display_name, notes: notes || null },
    });
    res.json({
      ok: true,
      request_id: String(ins.rows[0].id),
      already_pending: false,
      requested_at: ins.rows[0].requested_at,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/admin/ai/manual-requests?status=pending|all
//   Admin-only queue view. Counsellors get their own student's
//   request status via /request-status/:student_id (below).
router.get("/manual-requests", requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status === "all" ? "all" : "pending";
    const filter = status === "pending" ? "WHERE r.processed_at IS NULL" : "";
    const { rows } = await pool.query(
      `SELECT r.id, r.student_id, r.requested_at, r.processed_at,
              r.requested_by_kind, r.requested_by_id, r.requested_by_admin_username,
              r.processed_by_admin_username, r.notes,
              s.display_name AS student_display_name,
              s.username AS student_username,
              c.name AS counsellor_name,
              c.id AS counsellor_id,
              s.ai_artifacts_generated_at
         FROM manual_ai_requests r
         JOIN intake_students s ON s.student_id = r.student_id
         LEFT JOIN counsellors c ON c.id = s.counsellor_id
         ${filter}
         ORDER BY r.requested_at DESC
         LIMIT 200`
    );
    res.json({ requests: rows });
  } catch (e) {
    next(e);
  }
});

// GET /api/admin/ai/request-status/:student_id
//   Returns the most-recent request row for this student (any
//   status) so the counsellor's UI can poll the banner state. Both
//   admin and counsellor (scoped to own student).
router.get("/request-status/:student_id", requireStaff, async (req, res, next) => {
  try {
    const studentId = req.params.student_id;
    if (req.user.kind === "counsellor") {
      const own = await pool.query(
        `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
        [studentId]
      );
      if (own.rows.length === 0 || own.rows[0].counsellor_id !== req.user.counsellorId) {
        return res.status(404).json({ error: "student not found" });
      }
    }
    const { rows } = await pool.query(
      `SELECT r.id, r.student_id, r.requested_at, r.processed_at,
              r.processed_by_admin_username, r.notes,
              s.ai_artifacts_generated_at
         FROM manual_ai_requests r
         JOIN intake_students s ON s.student_id = r.student_id
        WHERE r.student_id = $1
        ORDER BY r.requested_at DESC
        LIMIT 1`,
      [studentId]
    );
    res.json({ request: rows[0] || null });
  } catch (e) {
    next(e);
  }
});

// ============================================================
// POST /api/admin/ai/dispatch
// ============================================================
// Atomic write of a complete artifact set for one student.
//
// Body shape:
//   {
//     "student_id": "s_...",
//     "file_descriptions": [
//       { "file_id": 24, "description": "...", "extracted": { "aadhar": "...", "name": "..." } },
//       ...
//     ],
//     "autofill_answers": { "aadhar": "1234 5678 9012", "marks10pct": 92, ... },
//     "resume_md": "## Pratham Aggarwal\n…",
//     "sop_draft": "I have always been drawn to…",
//     "lor_drafts": [
//       { "doc_id": 31, "draft": "…" },
//       ...
//     ],
//     "internship_drafts": [
//       { "doc_id": 33, "draft": "…" },
//       ...
//     ],
//     "summary_notes": "free-form notes for the audit row"
//   }
//
// Every field except student_id is optional — the routine sends
// whatever it managed to author. Missing fields = "didn't generate
// this artifact for this student" (probably because input data
// wasn't there). The student is marked done either way.
//
// Idempotency:
//   - file_descriptions: overwrites whatever's there (re-runs improve).
//   - autofill_answers: never overwrites a populated answer.
//   - resume_md: always INSERTs a new resume row. Re-running creates
//     additional resume rows; the dashboard shows the most recent.
//   - sop_draft / lor_drafts / internship_drafts: skip if existing
//     staff_draft is non-empty, unless body.force === true.
//   - ai_artifacts_generated_at: stamped only if currently NULL;
//     re-runs leave the original timestamp.
router.post("/dispatch", requireAdmin, express.json({ limit: "5mb" }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const studentId = body.student_id;
    if (!isString(studentId) || !studentId.startsWith("s_")) {
      return res.status(400).json({ error: "student_id (s_… string) is required" });
    }
    const force = body.force === true;
    const file_descriptions = Array.isArray(body.file_descriptions) ? body.file_descriptions : [];
    const autofill_answers = body.autofill_answers && typeof body.autofill_answers === "object"
      ? body.autofill_answers : {};
    // Two paths for the resume: structured JSON (preferred — feeds
    // <ResumeTemplate> on the frontend) or legacy markdown (kept for
    // back-compat). If both are sent we honour JSON and ignore the
    // markdown rather than writing both, since rendering a row with
    // both populated would be ambiguous.
    const resume_json = body.resume_json && typeof body.resume_json === "object" && !Array.isArray(body.resume_json)
      ? body.resume_json : null;
    const resume_md = !resume_json && isString(body.resume_md) ? body.resume_md : null;
    const sop_draft = isString(body.sop_draft) ? body.sop_draft : null;
    const lor_drafts = Array.isArray(body.lor_drafts) ? body.lor_drafts : [];
    const internship_drafts = Array.isArray(body.internship_drafts) ? body.internship_drafts : [];

    const client = await pool.connect();
    const summary = {
      files_described: 0,
      answers_autofilled: 0,
      answers_skipped_already_set: 0,
      resume_inserted: false,
      sop_set: false,
      sop_skipped_already_set: false,
      lors_set: 0,
      lors_skipped: 0,
      internships_set: 0,
      internships_skipped: 0,
    };
    let resumeId = null;

    try {
      await client.query("BEGIN");

      // Verify the student exists + scope all file/doc writes to it.
      const sRes = await client.query(
        `SELECT student_id, data, ai_artifacts_generated_at
           FROM intake_students
          WHERE student_id = $1
          FOR UPDATE`,
        [studentId]
      );
      if (sRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "student not found" });
      }
      const student = sRes.rows[0];

      // ── 1. Per-file descriptions + extracted ──────────────────
      for (const fd of file_descriptions) {
        if (!fd || !fd.file_id) continue;
        if (!isString(fd.description) || fd.description.length === 0) continue;
        // FK: file must belong to this student. The WHERE clause
        // enforces it; UPDATE silently no-ops if the file is
        // someone else's.
        const r = await client.query(
          `UPDATE intake_files
              SET ai_description = $2,
                  ai_extracted = $3
            WHERE id = $1 AND student_id = $4`,
          [
            fd.file_id,
            fd.description.slice(0, 4000),
            fd.extracted ? JSON.stringify(fd.extracted) : null,
            studentId,
          ]
        );
        if (r.rowCount > 0) summary.files_described++;
      }

      // ── 2. Autofill answers (no-overwrite) ───────────────────
      const isEmptyAnswer = (v) => {
        if (v === null || v === undefined) return true;
        if (typeof v === "string" && v.trim() === "") return true;
        if (v && typeof v === "object" && "status" in v) return v.status !== "uploaded";
        return false;
      };
      const data = student.data || {};
      const answers = { ...(data.answers || {}) };
      const writtenKeys = [];
      const skippedKeys = [];
      for (const [k, v] of Object.entries(autofill_answers)) {
        if (isEmptyAnswer(answers[k])) {
          answers[k] = v;
          writtenKeys.push(k);
        } else {
          skippedKeys.push(k);
        }
      }
      if (writtenKeys.length > 0) {
        await client.query(
          "UPDATE intake_students SET data = $2, updated_at = NOW() WHERE student_id = $1",
          [studentId, { ...data, answers }]
        );
      }
      summary.answers_autofilled = writtenKeys.length;
      summary.answers_skipped_already_set = skippedKeys.length;

      // ── 3. Resume INSERT ──────────────────────────────────────
      // JSON path is preferred (feeds <ResumeTemplate> on the
      // frontend); markdown is the legacy fallback for older
      // routine runs.
      if (resume_json) {
        const wordCount = countWordsInResumeJson(resume_json);
        const ins = await client.query(
          `INSERT INTO intake_resumes
             (student_id, label, length_words, status, content_json, model)
           VALUES ($1, 'auto-summary', $2, 'succeeded', $3, 'claude-opus-via-routine')
           RETURNING id`,
          [studentId, wordCount, resume_json]
        );
        resumeId = ins.rows[0].id;
        summary.resume_inserted = true;
        summary.resume_format = "json";
      } else if (resume_md && resume_md.trim().length > 0) {
        const wordCount = resume_md.trim().split(/\s+/).length;
        const ins = await client.query(
          `INSERT INTO intake_resumes
             (student_id, label, length_words, status, content_md, model)
           VALUES ($1, 'auto-summary', $2, 'succeeded', $3, 'claude-opus-via-routine')
           RETURNING id`,
          [studentId, wordCount, resume_md]
        );
        resumeId = ins.rows[0].id;
        summary.resume_inserted = true;
        summary.resume_format = "markdown";
      }

      // ── 4. SOP / LOR / internship drafts ─────────────────────
      // Each row gets staff_draft set only when currently empty
      // (or when force=true). The doc_id MUST belong to this
      // student — the WHERE clause double-checks via student_id.
      const setDraft = async (docId, kind, draft) => {
        if (!docId || !isString(draft) || draft.trim().length === 0) return false;
        const cur = await client.query(
          "SELECT staff_draft FROM intake_required_docs WHERE id = $1 AND student_id = $2 AND kind = $3",
          [docId, studentId, kind]
        );
        if (cur.rows.length === 0) return false;
        const existing = cur.rows[0].staff_draft;
        const isEmpty = !existing || existing.trim().length === 0;
        if (!isEmpty && !force) return false;
        await client.query(
          "UPDATE intake_required_docs SET staff_draft = $2, updated_at = NOW() WHERE id = $1",
          [docId, draft]
        );
        return true;
      };

      // SOP — playbook sends the draft + we look up the row by
      // (student, kind='sop', seq=1) since there's only ever one
      // SOP per student.
      if (sop_draft) {
        const r = await client.query(
          "SELECT id FROM intake_required_docs WHERE student_id = $1 AND kind = 'sop' AND seq = 1",
          [studentId]
        );
        if (r.rows.length > 0) {
          if (await setDraft(r.rows[0].id, "sop", sop_draft)) {
            summary.sop_set = true;
          } else {
            summary.sop_skipped_already_set = true;
          }
        }
      }

      for (const lor of lor_drafts) {
        if (!lor) continue;
        if (await setDraft(lor.doc_id, "lor", lor.draft)) summary.lors_set++;
        else summary.lors_skipped++;
      }
      for (const it of internship_drafts) {
        if (!it) continue;
        if (await setDraft(it.doc_id, "internship", it.draft)) summary.internships_set++;
        else summary.internships_skipped++;
      }

      // ── 5. Mark complete (only if not already marked) ────────
      if (!student.ai_artifacts_generated_at) {
        await client.query(
          "UPDATE intake_students SET ai_artifacts_generated_at = NOW(), updated_at = NOW() WHERE student_id = $1",
          [studentId]
        );
      }

      // ── 6. Resolve the most-recent open manual-fill request,
      //      if any. Stamps processed_at + processed_by_admin_username
      //      so the counsellor's banner flips to "fill-in complete".
      summary.manual_request_resolved = false;
      const adminUsername = req.user.kind === "admin" ? (req.user.adminUsername || null) : null;
      const reqUpd = await client.query(
        `UPDATE manual_ai_requests
            SET processed_at = NOW(),
                processed_by_admin_username = $2,
                resolved_resume_id = $3
          WHERE id = (
            SELECT id FROM manual_ai_requests
             WHERE student_id = $1 AND processed_at IS NULL
             ORDER BY requested_at DESC
             LIMIT 1
          )
          RETURNING id`,
        [studentId, adminUsername, resumeId]
      );
      if (reqUpd.rowCount > 0) summary.manual_request_resolved = true;

      await client.query("COMMIT");

      audit(req, {
        table: "intake_students",
        id: studentId,
        action: "ai_artifacts_generated",
        diff: { ...summary, resume_id: resumeId, written_keys: writtenKeys, skipped_keys: skippedKeys, notes: body.summary_notes || null },
      });

      res.json({ ok: true, student_id: studentId, summary, resume_id: resumeId });
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
