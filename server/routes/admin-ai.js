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
import { requireAdmin } from "../middleware/auth.js";
import { audit } from "../audit.js";

const router = express.Router();

const isString = (v) => typeof v === "string";

// ============================================================
// GET /api/admin/ai/pending
// ============================================================
// Mirrors server/scripts/ai/list-pending.js but over HTTP, so the
// remote routine can pull the candidate set without DB credentials.
router.get("/pending", requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50);
    const { rows } = await pool.query(
      `
      SELECT s.student_id,
             s.display_name,
             s.username,
             s.intake_phase,
             s.intake_complete,
             s.updated_at,
             c.name AS counsellor_name,
             (SELECT COUNT(*) FROM intake_files f
                WHERE f.student_id = s.student_id AND f.superseded_at IS NULL) AS files_count
        FROM intake_students s
        LEFT JOIN counsellors c ON c.id = s.counsellor_id
       WHERE s.intake_phase = 'done'
         AND s.is_archived = FALSE
         AND s.ai_artifacts_generated_at IS NULL
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
    const resume_md = isString(body.resume_md) ? body.resume_md : null;
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
      if (resume_md && resume_md.trim().length > 0) {
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
