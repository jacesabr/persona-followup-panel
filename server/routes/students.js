import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import pool from "../db.js";
import { hashPassword } from "../../lib/password.js";
import { requireStaff, requireStudent, SESSION_COOKIE_NAME } from "../middleware/auth.js";
import { validateUploadedFile } from "../middleware/validateFile.js";
import { audit } from "../audit.js";
import { getStorage } from "../storage.js";
import { scheduleResume, executeResume } from "../generators/run.js";
import { corpusHasExample } from "../generators/examples.js";
import { runImportFromCorpusDir } from "../scripts/import-examples.js";
import { validateDocReview } from "../../lib/docReviewManifest.js";
import { fileURLToPath } from "node:url";
import { requireAdmin } from "../middleware/auth.js";

const router = express.Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || "uploads";
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "10", 10);

const isPositiveInt = (s) => /^[1-9][0-9]*$/.test(String(s));
const isString = (v) => typeof v === "string";
const sanitizeForFs = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);

// Multer's staging area — every upload lands here briefly while we
// run validation, then storage.save() moves it to its permanent home
// (local disk, S3, R2, …). Lives under UPLOADS_DIR so the local backend
// can do an atomic rename instead of a copy.
const tmpRoot = path.resolve(UPLOADS_DIR, "_tmp");
fs.mkdirSync(tmpRoot, { recursive: true });

// Generate an 8-char password the counsellor copies and sends to the
// student. Excludes ambiguous chars (0/O, 1/l/I) to reduce typos.
//
// Common-password denylist shared by every place a student password is
// set: admin-create with explicit_password, and the /me/change-password
// route. Drawn from the SecLists rockyou top-50 filtered to entries 6+
// chars (our minimum length), plus admin/test/changeme variants.
// Module-scoped so both handlers see the same set; previously the
// const was inline in the create handler and the change-password route
// had no denylist at all.
const STUDENT_WEAK_PASSWORDS = new Set([
  "123456", "1234567", "12345678", "123456789", "1234567890",
  "111111", "000000", "222222", "121212", "654321",
  "password", "password1", "password12", "passw0rd", "p@ssword",
  "qwerty", "qwerty1", "qwerty12", "qwertyui", "qwertyuiop",
  "abcdef", "abc123", "abcd1234", "asdfgh", "asdfghjkl",
  "zxcvbn", "zxcvbnm", "letmein", "iloveyou", "trustno1",
  "welcome", "welcome1", "monkey", "dragon", "master",
  "admin", "admin1", "admin12", "admin123", "administrator",
  "login", "guest", "test", "test123", "testing",
  "default", "changeme", "secret", "shadow", "freedom",
]);

function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function newStudentId() {
  return `s_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

// ============================================================
// STAFF ROUTES — admin or counsellor creating / listing students.
// All gated by requireStaff (auth was already applied at mount).
// ============================================================

// POST /api/students — counsellor signs a lead up as a student.
// Body: { username, lead_id?, display_name? }
// Returns: { student_id, username, password (PLAINTEXT, ONE TIME) }
router.post("/", requireStaff, express.json(), async (req, res, next) => {
  try {
    const { username, lead_id, display_name, password: explicitPassword } = req.body || {};
    if (!isString(username) || username.trim().length < 3 || username.length > 50) {
      return res.status(400).json({ error: "username must be 3-50 characters" });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
      return res.status(400).json({ error: "username may only contain letters, digits, _ . -" });
    }
    // Require at least one alphanumeric so usernames like "...", ".",
    // ".._.." aren't accepted. Without this the dot/dash-only namespace
    // is reachable and creates unreadable login screens.
    if (!/[a-zA-Z0-9]/.test(username.trim())) {
      return res.status(400).json({ error: "username must contain at least one letter or digit" });
    }
    if (lead_id != null && !isString(lead_id)) {
      return res.status(400).json({ error: "lead_id must be a string" });
    }
    if (display_name != null && (!isString(display_name) || display_name.length > 200)) {
      return res.status(400).json({ error: "display_name must be a string up to 200 chars" });
    }
    // Admins (only) can supply an explicit password — used for test
    // accounts and for the rare case where a counsellor needs a known
    // value. Counsellors always get a system-generated random password,
    // because if they picked it themselves they could deliberately set
    // a weak / known value and impersonate the student. Keep this gate
    // tight.
    if (explicitPassword != null) {
      if (req.user.kind !== "admin") {
        return res.status(403).json({ error: "only admin can supply an explicit password" });
      }
      if (!isString(explicitPassword) || explicitPassword.length < 6 || explicitPassword.length > 100) {
        return res.status(400).json({ error: "password must be 6-100 characters" });
      }
      // Reject obvious-weak values so a compromised admin can't trivially
      // build a backdoor pool of accounts with known credentials. The
      // adversarial-on-change agent flagged this — admin-only path was
      // capped at 4 chars with no value check. "student" still passes
      // the floor (7 chars, not in denylist) so the explicit test
      // account works; common weak patterns don't.
      // .trim() before .toLowerCase(): defends the trivial whitespace
      // bypass ("qwerty " or " admin123") the audit-on-change agent
      // demonstrated. Anyone whose password is "qwerty + space" still
      // had a denylist-trivial password.
      const lower = explicitPassword.trim().toLowerCase();
      if (STUDENT_WEAK_PASSWORDS.has(lower)) {
        return res.status(400).json({ error: "password is too common; pick something else" });
      }
    }

    const cleanUsername = username.trim();
    const password = explicitPassword || generatePassword();
    const password_hash = hashPassword(password);
    const studentId = newStudentId();

    // Counsellor that created this — admins act on behalf of nobody.
    const counsellorId = req.user.kind === "counsellor" ? req.user.counsellorId : null;

    try {
      const { rows } = await pool.query(
        `INSERT INTO intake_students
           (student_id, username, password_hash, password_plain, lead_id, counsellor_id, display_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING student_id, username, display_name, lead_id, counsellor_id, created_at`,
        [studentId, cleanUsername, password_hash, password, lead_id || null, counsellorId, display_name || null]
      );
      const row = rows[0];
      audit(req, {
        table: "intake_students",
        id: row.student_id,
        action: "create",
        diff: {
          username: row.username,
          lead_id: row.lead_id,
          display_name: row.display_name,
          password_source: explicitPassword ? "admin_supplied" : "system_generated",
        },
      });
      // Plaintext password is RETURNED ONCE here. We never store it
      // anywhere except the bcrypt-style hash above.
      res.status(201).json({
        ...row,
        password,
      });
    } catch (e) {
      if (e.code === "23505") {
        return res.status(409).json({ error: "username already taken" });
      }
      if (e.code === "23503") {
        return res.status(400).json({ error: "lead_id does not exist" });
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

// POST /api/students/:student_id/reset-password — staff regenerates a
// student's password. Returns the new plaintext one-time. Useful when
// the student loses their credentials.
//
// Invalidates ALL existing student sessions in the same transaction —
// a stolen cookie that prompted the reset can NOT survive the reset.
router.post("/:student_id/reset-password", requireStaff, async (req, res, next) => {
  try {
    const password = generatePassword();
    const password_hash = hashPassword(password);
    const client = await pool.connect();
    let row;
    try {
      await client.query("BEGIN");
      // Ownership gate: a counsellor session must only be able to reset
      // passwords for students THEY created. Without this gate the
      // adversarial walkthrough demonstrated a full account takeover —
      // counsellor A reset counsellor B's student's password and got the
      // new plaintext back. SELECT first so we can 404 on both
      // not-found AND not-yours (parity with peer-id-probe protection
      // elsewhere in this file — counsellors should not be able to
      // distinguish "doesn't exist" from "exists but not yours").
      const own = await client.query(
        `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
        [req.params.student_id]
      );
      if (own.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "student not found" });
      }
      if (
        req.user.kind === "counsellor" &&
        own.rows[0].counsellor_id !== req.user.counsellorId
      ) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "student not found" });
      }
      // Belt+suspenders on the ownership check: filter the UPDATE by
      // counsellor_id too. Without this, a TOCTOU window between the
      // SELECT above and this UPDATE would let a counsellor reset a
      // student that admin reassigned away from them mid-transaction.
      // Tight window (~ms) but trivial to close.
      const u = await client.query(
        req.user.kind === "counsellor"
          ? `UPDATE intake_students SET password_hash = $1, password_plain = $2
               WHERE student_id = $3 AND counsellor_id = $4
               RETURNING student_id, username`
          : `UPDATE intake_students SET password_hash = $1, password_plain = $2
               WHERE student_id = $3
               RETURNING student_id, username`,
        req.user.kind === "counsellor"
          ? [password_hash, password, req.params.student_id, req.user.counsellorId]
          : [password_hash, password, req.params.student_id]
      );
      if (u.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "student not found" });
      }
      row = u.rows[0];
      // Invalidate every session for this student. The new password
      // takes effect immediately; any old cookie is now dead.
      await client.query(
        `DELETE FROM sessions WHERE student_id = $1`,
        [row.student_id]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    audit(req, {
      table: "intake_students",
      id: row.student_id,
      action: "password_reset",
      diff: { sessions_invalidated: true },
    });
    res.json({ ...row, password });
  } catch (e) {
    next(e);
  }
});

// GET /api/students — list all student accounts (admin sees everyone,
// counsellor sees only their own creations).
//
// Returns intake_phase + data so the staff panel can show specific
// step-of-N progress per row without a second round-trip. The
// auto-fired resume bumps intake_phase from 'done' back to a synthetic
// 'generating' until the resume row terminates — same trick the
// student-side /me/record uses.
router.get("/", requireStaff, async (req, res, next) => {
  try {
    let sql = `
      SELECT s.student_id, s.username, s.password_plain, s.display_name,
             s.intake_complete, s.intake_phase, s.data,
             s.lead_id, s.counsellor_id, s.created_at, s.updated_at,
             l.name AS lead_name,
             c.name AS counsellor_name,
             (SELECT COUNT(*) FROM intake_files     f WHERE f.student_id = s.student_id) AS file_count,
             (SELECT COUNT(*) FROM intake_resumes   r WHERE r.student_id = s.student_id) AS resume_count,
             (SELECT COUNT(*) FROM intake_resumes   r WHERE r.student_id = s.student_id AND r.status IN ('pending','running'))::int AS resumes_inflight,
             (SELECT COUNT(*) FROM intake_resumes   r WHERE r.student_id = s.student_id AND r.status = 'succeeded')::int AS resumes_succeeded
        FROM intake_students s
        LEFT JOIN leads       l ON l.id = s.lead_id
        LEFT JOIN counsellors c ON c.id = s.counsellor_id
       WHERE s.username IS NOT NULL`;
    const params = [];
    if (req.user.kind === "counsellor") {
      sql += ` AND s.counsellor_id = $1`;
      params.push(req.user.counsellorId);
    }
    sql += ` ORDER BY s.created_at DESC`;
    const { rows } = await pool.query(sql, params);
    // Synthesize 'generating' the same way /me/record does — keeps the
    // student-side dashboard label and the staff list label in sync.
    for (const r of rows) {
      if (r.intake_phase === "done" && r.resumes_inflight > 0 && r.resumes_succeeded === 0) {
        r.intake_phase = "generating";
      }
    }
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// GET /api/students/:student_id — full detail. Admin sees any; counsellor
// sees only their own creations. Returns the intake data + uploaded
// files + resumes for the admin "students panel" detail view.
router.get("/:student_id", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const studentRes = await pool.query(
      `SELECT s.student_id, s.username, s.display_name, s.intake_complete,
              s.intake_phase,
              s.data, s.lead_id, s.counsellor_id, s.created_at, s.updated_at,
              l.name AS lead_name,
              c.name AS counsellor_name
         FROM intake_students s
         LEFT JOIN leads       l ON l.id = s.lead_id
         LEFT JOIN counsellors c ON c.id = s.counsellor_id
        WHERE s.student_id = $1`,
      [sid]
    );
    const student = studentRes.rows[0];
    if (!student) return res.status(404).json({ error: "student not found" });
    if (req.user.kind === "counsellor" && student.counsellor_id !== req.user.counsellorId) {
      return res.status(403).json({ error: "not your student" });
    }

    const filesRes = await pool.query(
      `SELECT id, field_id, row_index, original_name, size, mime_type,
              superseded_at, created_at
         FROM intake_files WHERE student_id = $1
         ORDER BY field_id, created_at ASC`,
      [sid]
    );
    const resumesRes = await pool.query(
      `SELECT id, label, length_pages, length_words, style, domain,
              status, content_md, content_html, pdf_file_id,
              cost_cents, error, source_snapshot, created_at, updated_at
         FROM intake_resumes WHERE student_id = $1
         ORDER BY created_at DESC`,
      [sid]
    );

    res.json({
      student,
      files: filesRes.rows,
      resumes: resumesRes.rows,
    });
  } catch (e) {
    next(e);
  }
});

// ============================================================
// STUDENT ROUTES — the student themselves operating on their own data.
// All gated by requireStudent. /me reads/writes the canonical record.
// ============================================================

router.get("/me/record", requireStudent, async (req, res, next) => {
  try {
    // intake_phase is the explicit state column (intake / doc_review /
    // done). Resume counts pulled so the dashboard can show generation
    // progress.
    const { rows } = await pool.query(
      `SELECT s.student_id, s.intake_complete, s.data, s.updated_at,
              s.intake_phase,
              COALESCE(rs.inflight, 0) AS resumes_inflight,
              COALESCE(rs.succeeded, 0) AS resumes_succeeded
         FROM intake_students s
         LEFT JOIN (
           SELECT student_id,
                  SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END)::int AS inflight,
                  SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END)::int AS succeeded
             FROM intake_resumes GROUP BY student_id
         ) rs ON rs.student_id = s.student_id
        WHERE s.student_id = $1`,
      [req.user.studentId]
    );
    const row = rows[0];
    if (!row) {
      return res.json({
        studentId: req.user.studentId,
        intakeComplete: false,
        data: {},
        phase: "intake",
      });
    }

    // Phase resolver — read the column directly. Legacy rows that were
    // saved before the migration land here as NULL; coerce to 'intake'
    // on read so they restart the new flow from the top.
    let phase = row.intake_phase || "intake";
    // Even with phase='done', if the auto-fired resume hasn't completed
    // yet, surface 'generating' so the dashboard polls instead of
    // showing an empty resume card.
    if (phase === "done" && row.resumes_inflight > 0 && row.resumes_succeeded === 0) {
      phase = "generating";
    }
    res.json({
      studentId: row.student_id,
      intakeComplete: row.intake_complete,
      data: row.data || {},
      updatedAt: row.updated_at,
      phase,
      counts: {
        resumesInflight: row.resumes_inflight,
        resumesSucceeded: row.resumes_succeeded,
      },
    });
  } catch (e) {
    next(e);
  }
});

// PUT /me/record — accepts optional `expectedUpdatedAt` precondition.
// When the student has the form open in two tabs and tab A's debounced
// save fires after tab B's, naive last-write-wins silently wipes A's
// edits. Precondition check: if the body's expectedUpdatedAt doesn't
// match the row's current updated_at, return 409 with the latest data
// so the client can refetch + replay the user's local diff on top.
router.put("/me/record", requireStudent, express.json({ limit: "2mb" }), async (req, res, next) => {
  try {
    const { data, intakeComplete, expectedUpdatedAt } = req.body || {};

    // Reject anything that isn't a plain object — the field is jsonb
    // and the SET clause stringifies whatever lands here. Without this
    // guard, `data: "stringy"` or `data: null` round-trips into the DB
    // and breaks the next client read (which expects an object). Arrays
    // pass typeof === "object" so block them too.
    if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
      return res.status(400).json({ error: "data must be a JSON object" });
    }

    // Refuse edits once the student has finished doc-review. The UI
    // doesn't expose a path back to the form after phase=done, but a
    // tab left open in doc_review or a hand-crafted PUT could land
    // here and silently drift the data behind the already-generated
    // resume. Surface a 409 instead so the client can refresh and
    // discover the dashboard.
    const phaseProbe = await pool.query(
      `SELECT intake_phase FROM intake_students WHERE student_id = $1`,
      [req.user.studentId]
    );
    if ((phaseProbe.rows[0]?.intake_phase || "intake") === "done") {
      return res.status(409).json({
        error: "intake is closed — no further edits accepted after phase=done",
        currentPhase: "done",
      });
    }

    // The conflict-detecting UPDATE: filter on student_id AND on the
    // optional expectedUpdatedAt. If expectedUpdatedAt is null/undefined
    // we skip the precondition (initial save, mock data autofill, etc).
    //
    // Compare via date_trunc to milliseconds: Postgres timestamptz has
    // microsecond precision, but the `updated_at` we hand the client
    // is JSON-serialised which truncates to milliseconds. A naive
    // `updated_at = $4::timestamptz` therefore NEVER matches because
    // the µs digits round-tripped through JSON are gone — every PUT
    // returned 409 even on a fresh value. Truncating both sides to ms
    // makes the round-trip equality work as the API caller expects.
    const sql = expectedUpdatedAt
      ? `UPDATE intake_students
            SET data = $1::jsonb,
                intake_complete = $2,
                updated_at = NOW()
          WHERE student_id = $3
            AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $4::timestamptz)
          RETURNING student_id, intake_complete, updated_at`
      : `UPDATE intake_students
            SET data = $1::jsonb,
                intake_complete = $2,
                updated_at = NOW()
          WHERE student_id = $3
          RETURNING student_id, intake_complete, updated_at`;
    const params = expectedUpdatedAt
      ? [JSON.stringify(data || {}), !!intakeComplete, req.user.studentId, expectedUpdatedAt]
      : [JSON.stringify(data || {}), !!intakeComplete, req.user.studentId];

    const { rows } = await pool.query(sql, params);
    const row = rows[0];
    if (!row && expectedUpdatedAt) {
      // Precondition failed — surface the latest state so the client
      // can decide how to merge (refetch + replay user's pending diff).
      const latest = await pool.query(
        `SELECT data, intake_complete, updated_at
           FROM intake_students WHERE student_id = $1`,
        [req.user.studentId]
      );
      const cur = latest.rows[0];
      if (!cur) return res.status(404).json({ error: "student row missing" });
      return res.status(409).json({
        error: "stale write — another tab or device updated this record",
        latest: {
          data: cur.data || {},
          intakeComplete: cur.intake_complete,
          updatedAt: cur.updated_at,
        },
      });
    }
    if (!row) return res.status(404).json({ error: "student row missing" });

    res.json({
      studentId: row.student_id,
      intakeComplete: row.intake_complete,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    next(e);
  }
});

// PUT /api/students/me/intake/phase — explicit phase transitions.
//   { phase: "doc_review" }  → from 'intake' (general form done, move to
//                              the side-by-side doc verification step)
//   { phase: "done" }        → from 'doc_review' (everything filled,
//                              flip intake_complete + auto-fire one
//                              300-word resume gen, navigate to dashboard)
//
// Allowed transitions are forward-only (intake → doc_review → done) so
// a refresh-bouncing client can't accidentally rewind state. The
// `done` transition is atomic: phase flip + resume insert happen in
// one transaction so a crash mid-call leaves no half-state.
router.put("/me/intake/phase", requireStudent, express.json(), async (req, res, next) => {
  try {
    const { phase } = req.body || {};
    if (phase !== "doc_review" && phase !== "done") {
      return res.status(400).json({ error: "phase must be 'doc_review' or 'done'" });
    }
    const studentId = req.user.studentId;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(
        `SELECT intake_phase FROM intake_students WHERE student_id = $1 FOR UPDATE`,
        [studentId]
      );
      if (cur.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "student row missing" });
      }
      const currentPhase = cur.rows[0].intake_phase || "intake";

      // Forward-only transition rules.
      if (phase === "doc_review" && currentPhase !== "intake") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `cannot move to doc_review from '${currentPhase}'`,
          currentPhase,
        });
      }
      if (phase === "done" && currentPhase !== "doc_review") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `cannot move to done from '${currentPhase}'`,
          currentPhase,
        });
      }

      // Apply the phase change. 'done' also flips intake_complete.
      if (phase === "done") {
        // Defence-in-depth: refuse to flip phase if any non-optional
        // doc-review field is empty for an uploaded doc. Client guards
        // the same shape; without this check a hand-crafted PUT could
        // fast-forward through doc-review and trigger resume gen
        // against missing values (marks %, passport #, test scores).
        const dataRes = await client.query(
          `SELECT data FROM intake_students WHERE student_id = $1`,
          [studentId]
        );
        const answers = dataRes.rows[0]?.data?.answers || {};
        const { ok, missing } = validateDocReview(answers);
        if (!ok) {
          await client.query("ROLLBACK");
          return res.status(422).json({
            error: "doc-review fields still missing — fill them before finishing",
            missing,
          });
        }
        // Pre-flight: refuse to flip phase if the style corpus is empty.
        // Without this the auto-fire would insert a 'pending' row,
        // hit NoCorpusError in executeResume, and flip to 'failed'
        // 30s later — confusing both student and staff. Catch it
        // before the transaction commits so the student stays on the
        // doc-review screen with an actionable message.
        if (!(await corpusHasExample())) {
          await client.query("ROLLBACK");
          return res.status(503).json({
            error: "Resume style corpus not loaded yet — your counsellor needs to import the example. Try again in a few minutes.",
            code: "NO_CORPUS",
          });
        }
        await client.query(
          `UPDATE intake_students
              SET intake_phase = 'done',
                  intake_complete = TRUE,
                  updated_at = NOW()
            WHERE student_id = $1`,
          [studentId]
        );
        // Auto-fire one 300-word resume in the same transaction. Hard-
        // coded shape for v1 — multi-resume picker comes back later.
        // Take the per-student inflight lock so a refresh-spam can't
        // stack multiple auto-resumes.
        await reserveInflightOrThrow(client, studentId, 1);
        const ins = await client.query(
          `INSERT INTO intake_resumes
             (student_id, label, length_pages, length_words, style, domain, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING id`,
          [studentId, "auto-summary", null, 300, null, null]
        );
        const resumeId = ins.rows[0].id;
        await client.query("COMMIT");
        // Fire-and-forget after commit so a runner crash leaves the row
        // in 'pending' for the boot sweeper, not orphaned-mid-tx.
        executeResume({
          resumeId,
          spec: { label: "auto-summary", length_words: 300 },
        }).catch((e) => console.error("[resume] auto-fire unhandled:", e));
        audit(req, {
          table: "intake_students",
          id: studentId,
          action: "intake_done",
          diff: { resume_id: String(resumeId) },
        });
        return res.json({ phase: "done", resumeId: String(resumeId) });
      }

      // doc_review transition.
      await client.query(
        `UPDATE intake_students
            SET intake_phase = 'doc_review', updated_at = NOW()
          WHERE student_id = $1`,
        [studentId]
      );
      await client.query("COMMIT");
      audit(req, {
        table: "intake_students",
        id: studentId,
        action: "intake_to_doc_review",
      });
      res.json({ phase: "doc_review" });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "INFLIGHT_CAP") {
        return res.status(429).json({
          error: "a resume is already generating; refresh to see it",
        });
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    next(e);
  }
});

// ============================================================
// FILE UPLOAD — student uploads a document. Multer disk storage,
// magic-byte recheck, FK row inserted. The student types any doc-
// derived values (marks %, passport #, test scores) by hand in the
// doc-review step.
// ============================================================

// Multer always lands in tmpRoot — we move (or upload) to the configured
// storage backend after validating magic bytes.
const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tmpRoot),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(12).toString("hex");
    const ext = path.extname(file.originalname) || "";
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({ storage: multerStorage, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

// Wrap multer.single() so size-limit failures translate to 413 (the
// HTTP status that actually means "payload too large") instead of
// escaping to the global error middleware as a 500. Matches the QA
// expectation and surfaces a usable error message to the client.
function uploadOne(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `file exceeds ${MAX_FILE_MB} MB limit` });
    }
    if (err) return next(err);
    next();
  });
}

// fieldId is a partition key for intake_files. Without a shape check
// we accepted arbitrary strings — `../../etc/passwd`, 5000-char blobs,
// anything. Tighter rule: alphanumeric + underscore, optionally
// followed by an indexed-list suffix `[N].fieldname` (the
// activities_list[3].proof pattern). Caps at 64 chars.
const FIELD_ID_RE = /^[a-zA-Z0-9_]{1,40}(?:\[\d{1,3}\]\.[a-zA-Z0-9_]{1,20})?$/;

router.post("/me/upload", requireStudent, uploadOne, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const { fieldId, rowIndex, accept } = req.body;
    if (!fieldId) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "fieldId is required." });
    }
    if (!FIELD_ID_RE.test(fieldId)) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "fieldId must be alphanumeric (optionally suffixed with [N].name)" });
    }
    const v = validateUploadedFile(req.file.path, accept || "application/pdf");
    if (!v.ok) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: v.error });
    }

    const studentId = req.user.studentId;
    const rowIdx = rowIndex != null && rowIndex !== "" ? Number(rowIndex) : null;

    // Hand the validated bytes to the storage backend (local disk by
    // default, S3-compatible if STORAGE_BACKEND=s3). Returns the opaque
    // `key` we persist as storage_path; download routes stream by key.
    const store = await getStorage();
    const saved = await store.save({
      tmpPath: req.file.path,
      scope: studentId,
      originalName: req.file.originalname,
      mimeType: v.actualType,
    });

    // Race guard: two simultaneous uploads to the same slot would both
    // see "no active row, supersede no-op" and both INSERT, leaving two
    // active rows. The unique partial index idx_intake_files_one_active
    // prevents that — a 23505 here means the other upload won; we
    // retry the supersede + insert once. Second attempt sees the now-
    // existing active row and supersedes it cleanly.
    const insertWithRetry = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE intake_files
              SET superseded_at = NOW()
            WHERE student_id = $1 AND field_id = $2
              AND ((row_index IS NULL AND $3::int IS NULL) OR row_index = $3)
              AND superseded_at IS NULL`,
          [studentId, fieldId, rowIdx]
        );
        const ins = await client.query(
          `INSERT INTO intake_files
             (student_id, field_id, row_index, original_name, storage_path, size, mime_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
          [studentId, fieldId, rowIdx, req.file.originalname, saved.key, saved.size, v.actualType]
        );
        await client.query("COMMIT");
        return ins.rows[0];
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    };

    let doc;
    try {
      doc = await insertWithRetry();
    } catch (e) {
      if (e.code === "23505") {
        doc = await insertWithRetry();
      } else {
        // DB insert failed — orphaned blob in storage. Best-effort cleanup.
        await store.deleteIfExists(saved.key).catch(() => {});
        throw e;
      }
    }

    audit(req, {
      table: "intake_files",
      id: doc.id,
      action: "upload",
      diff: { field_id: fieldId, original_name: req.file.originalname, size: req.file.size },
    });
    res.json({
      fileId: String(doc.id),
      url: `/api/students/me/files/${doc.id}`,
      uploadedAt: doc.created_at.toISOString(),
      actualType: v.actualType,
      size: req.file.size,
    });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    next(err);
  }
});

// File download — student gets their own files only.
router.get("/me/files/:id", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "Invalid file id." });
    }
    const { rows } = await pool.query(
      `SELECT student_id, original_name, storage_path, size, mime_type
         FROM intake_files WHERE id = $1`,
      [Number(req.params.id)]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: "File not found." });
    if (doc.student_id !== req.user.studentId) {
      return res.status(403).json({ error: "Forbidden." });
    }
    const store = await getStorage();
    if (!(await store.exists(doc.storage_path))) {
      return res.status(410).json({ error: "File missing in storage." });
    }
    res.set("Content-Type", doc.mime_type);
    res.set("Content-Length", String(doc.size));
    res.set(
      "Content-Disposition",
      `inline; filename="${path.basename(doc.original_name).replace(/"/g, "")}"`
    );
    const stream = await store.openReadStream(doc.storage_path);
    stream.on("error", (e) => next(e));
    stream.pipe(res);
  } catch (e) {
    next(e);
  }
});

// Staff-side file download — admin or owning counsellor only.
router.get("/:student_id/files/:id", requireStaff, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "Invalid file id." });
    }
    const { rows } = await pool.query(
      `SELECT f.student_id, f.original_name, f.storage_path, f.size, f.mime_type,
              s.counsellor_id
         FROM intake_files f
         JOIN intake_students s ON s.student_id = f.student_id
        WHERE f.id = $1`,
      [Number(req.params.id)]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: "File not found." });
    if (doc.student_id !== req.params.student_id) {
      return res.status(403).json({ error: "File does not belong to this student." });
    }
    if (req.user.kind === "counsellor" && doc.counsellor_id !== req.user.counsellorId) {
      return res.status(403).json({ error: "not your student" });
    }
    const store = await getStorage();
    if (!(await store.exists(doc.storage_path))) {
      return res.status(410).json({ error: "File missing in storage." });
    }
    res.set("Content-Type", doc.mime_type);
    res.set("Content-Length", String(doc.size));
    res.set(
      "Content-Disposition",
      `inline; filename="${path.basename(doc.original_name).replace(/"/g, "")}"`
    );
    const stream = await store.openReadStream(doc.storage_path);
    stream.on("error", (e) => next(e));
    stream.pipe(res);
  } catch (e) {
    next(e);
  }
});

// POST /api/students/:student_id/resumes/:id/regenerate — staff
// triggers regeneration on a student's behalf. Used when the staff
// panel surfaces the "may be stale" badge: counsellor sees the
// student edited their data after the resume was generated, hits
// regenerate without asking the student to log in.
//
// Same atomic gate as the student-side route: per-student lock,
// inflight-cap check, CAS-flip on row status, all in one tx.
router.post("/:student_id/resumes/:id/regenerate", requireStaff, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const studentId = req.params.student_id;
    const { rows } = await pool.query(
      `SELECT r.id, r.student_id, r.label, r.length_pages, r.length_words, r.style, r.domain,
              s.counsellor_id
         FROM intake_resumes r
         JOIN intake_students s ON s.student_id = r.student_id
        WHERE r.id = $1`,
      [Number(req.params.id)]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.student_id !== studentId) {
      return res.status(403).json({ error: "resume does not belong to this student" });
    }
    if (req.user.kind === "counsellor" && row.counsellor_id !== req.user.counsellorId) {
      return res.status(403).json({ error: "not your student" });
    }
    // Pre-flight: refuse to fire if the corpus is empty (same gate
    // the student-side phase transition uses, for the same reason).
    if (!(await corpusHasExample())) {
      return res.status(503).json({
        error: "Resume style corpus not loaded — re-import via the admin panel before regenerating.",
        code: "NO_CORPUS",
      });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await reserveInflightOrThrow(client, row.student_id, 1);
      const swap = await client.query(
        `UPDATE intake_resumes
            SET status = 'pending', error = NULL, updated_at = NOW()
          WHERE id = $1
            AND status NOT IN ('pending','running')
          RETURNING id`,
        [row.id]
      );
      if (swap.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "regeneration already in progress for this resume",
        });
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "INFLIGHT_CAP") {
        return res.status(429).json({
          error: `student has ${e.currentInflight} resume${e.currentInflight === 1 ? "" : "s"} still generating; wait for those to finish`,
          currentInflight: e.currentInflight,
          cap: e.cap,
        });
      }
      throw e;
    } finally {
      client.release();
    }
    executeResume({
      resumeId: row.id,
      spec: {
        label: row.label,
        length_pages: row.length_pages,
        length_words: row.length_words,
        style: row.style,
        domain: row.domain,
      },
    }).catch((e) => console.error("[resume] staff-regenerate unhandled:", e));
    audit(req, { table: "intake_resumes", id: row.id, action: "staff_regenerate" });
    res.status(202).json({ id: String(row.id), status: "pending" });
  } catch (e) {
    next(e);
  }
});

// POST /api/students/admin/import-examples — admin-only one-shot
// to sync resume/example_resume/ on disk into the intake_examples
// table. Useful because external Render Postgres connections are
// flaky for long batches; running this server-side keeps everything
// inside Render's private network.
router.post("/admin/import-examples", requireAdmin, async (req, res, next) => {
  try {
    // Resolve the corpus dir relative to this file at runtime.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const corpusDir = path.resolve(here, "..", "..", "resume", "example_resume");
    const result = await runImportFromCorpusDir(corpusDir);
    audit(req, {
      table: "intake_examples",
      action: "bulk_import",
      diff: { count: result.results.length, dir: result.dir },
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ============================================================
// RESUMES — generation kick-off + listing + polling. Per-student.
// One POST creates N rows (one per spec) and fires N background
// generations. Client polls GET /me/resumes/:id until terminal.
// ============================================================

// Hard cap on per-student concurrent generations. Prevents one student
// (whether bored, malicious, or stuck in a refresh loop) from queueing
// 100+ Gemini-backed generation calls and blowing through the API
// budget. Enforced atomically — the prior version did SELECT COUNT then
// INSERTed in a loop, which raced trivially under N parallel POSTs all
// observing currentInflight=0 and passing the gate. Now: take a per-
// student advisory lock, count, and either reserve all N slots in one
// transaction or reject 429.
const MAX_INFLIGHT_RESUMES_PER_STUDENT = 3;

// Hash a student_id to a stable bigint for pg_advisory_xact_lock().
// Postgres advisory locks key on bigint; hash so the same student
// always serialises against itself but different students don't
// contend. Using sha256 (overkill but boring) → take 8 bytes →
// signed bigint. Result is deterministic across processes.
async function takeStudentLock(client, studentId) {
  await client.query(
    `SELECT pg_advisory_xact_lock( ('x' || substr(md5($1), 1, 16))::bit(64)::bigint )`,
    [`resumes:${studentId}`]
  );
}

// Reserve N inflight slots atomically inside an open transaction.
// Throws { code: "INFLIGHT_CAP", currentInflight, cap } when over.
async function reserveInflightOrThrow(client, studentId, n) {
  await takeStudentLock(client, studentId);
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM intake_resumes
       WHERE student_id = $1 AND status IN ('pending','running')`,
    [studentId]
  );
  const currentInflight = rows[0]?.n || 0;
  if (currentInflight + n > MAX_INFLIGHT_RESUMES_PER_STUDENT) {
    const e = new Error("inflight cap exceeded");
    e.code = "INFLIGHT_CAP";
    e.currentInflight = currentInflight;
    e.cap = MAX_INFLIGHT_RESUMES_PER_STUDENT;
    throw e;
  }
  return currentInflight;
}

// POST /api/students/me/resumes — body { specs: [{ label, length_pages,
// length_words?, style?, domain? }, ...] }. Returns the created rows.
router.post("/me/resumes", requireStudent, express.json(), async (req, res, next) => {
  try {
    const { specs } = req.body || {};
    if (!Array.isArray(specs) || specs.length === 0) {
      return res.status(400).json({ error: "specs[] required" });
    }
    if (specs.length > 5) {
      return res.status(400).json({ error: "max 5 resumes per batch" });
    }
    // Per-spec validation. Without this, length_pages: "two" reached
    // the INSERT bind and surfaced as a 500 leaking the Postgres error
    // text; length_pages: 0 / -5 inserted rows that the generator then
    // tried to honour. Cap at 10 pages (longer than any actual resume
    // would be useful for).
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      if (!s || typeof s !== "object") {
        return res.status(400).json({ error: `specs[${i}] must be an object` });
      }
      if (s.length_pages != null) {
        if (!Number.isInteger(s.length_pages) || s.length_pages < 1 || s.length_pages > 10) {
          return res.status(400).json({ error: `specs[${i}].length_pages must be an integer between 1 and 10` });
        }
      }
      if (s.length_words != null) {
        if (!Number.isInteger(s.length_words) || s.length_words < 50 || s.length_words > 5000) {
          return res.status(400).json({ error: `specs[${i}].length_words must be an integer between 50 and 5000` });
        }
      }
      if (s.label != null && (typeof s.label !== "string" || s.label.length > 200)) {
        return res.status(400).json({ error: `specs[${i}].label must be a string up to 200 chars` });
      }
    }

    // Precondition: the student must have completed both intake +
    // doc-review (intake_phase = 'done'). The auto-fire on the phase
    // transition handles the happy-path first resume; this manual
    // route is now only for regenerate-from-dashboard scenarios.
    const phaseCheck = await pool.query(
      `SELECT intake_phase FROM intake_students WHERE student_id = $1`,
      [req.user.studentId]
    );
    if ((phaseCheck.rows[0]?.intake_phase || "intake") !== "done") {
      return res.status(400).json({
        error: "finish intake + document review before generating a resume",
      });
    }

    // Atomic gate: take the per-student advisory lock, recount, and
    // insert all N rows inside one transaction. Concurrent POSTs from
    // the same student serialise on the lock; the cap is honoured even
    // under refresh-loop-style hostility.
    const client = await pool.connect();
    let createdRows;
    try {
      await client.query("BEGIN");
      await reserveInflightOrThrow(client, req.user.studentId, specs.length);
      // Insert each row inside the transaction so they all commit or
      // none do. We can't reuse scheduleResume() (which uses the pool)
      // — inline the INSERT here, then fire the background runners
      // AFTER commit so a rollback doesn't leak runaway generations.
      const insertedIds = [];
      for (const spec of specs) {
        const ins = await client.query(
          `INSERT INTO intake_resumes
             (student_id, label, length_pages, length_words, style, domain, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING id`,
          [
            req.user.studentId,
            spec.label || `${spec.length_pages}-page`,
            spec.length_pages || null,
            spec.length_words || null,
            spec.style || null,
            spec.domain || null,
          ]
        );
        insertedIds.push({ id: ins.rows[0].id, spec });
      }
      await client.query("COMMIT");
      createdRows = insertedIds;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "INFLIGHT_CAP") {
        return res.status(429).json({
          error: `you have ${e.currentInflight} resume${e.currentInflight === 1 ? "" : "s"} still generating; wait for those to finish before starting more`,
          currentInflight: e.currentInflight,
          cap: e.cap,
        });
      }
      throw e;
    } finally {
      client.release();
    }

    // Fire background generators AFTER commit. If a runner immediately
    // crashes, its row is still 'pending' for the boot sweeper to
    // catch on the next restart.
    const created = [];
    for (const { id, spec } of createdRows) {
      executeResume({ resumeId: id, spec }).catch((e) =>
        console.error("[resume] batch generator unhandled:", e)
      );
      created.push({
        id: String(id),
        status: "pending",
        label: spec.label,
        length_pages: spec.length_pages,
        style: spec.style,
        domain: spec.domain,
      });
    }
    audit(req, {
      table: "intake_resumes",
      action: "batch_kickoff",
      diff: { count: created.length, ids: created.map((c) => c.id) },
    });
    res.status(202).json({ resumes: created });
  } catch (e) {
    next(e);
  }
});

// GET /api/students/me/resumes — list every resume for the current
// student. Drives the generation-progress + viewer screens.
router.get("/me/resumes", requireStudent, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, length_pages, length_words, style, domain,
              example_ids, status, content_md, content_html, error,
              cost_cents, source_snapshot, created_at, updated_at
         FROM intake_resumes
        WHERE student_id = $1
        ORDER BY created_at DESC`,
      [req.user.studentId]
    );
    res.json(
      rows.map((r) => ({
        id: String(r.id),
        label: r.label,
        lengthPages: r.length_pages,
        lengthWords: r.length_words,
        style: r.style,
        domain: r.domain,
        exampleIds: r.example_ids,
        status: r.status,
        contentMd: r.content_md,
        contentHtml: r.content_html,
        error: r.error,
        costCents: r.cost_cents,
        sourceSnapshot: r.source_snapshot,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    );
  } catch (e) {
    next(e);
  }
});

// GET /api/students/me/resumes/:id — single resume detail. Polled by
// the generating screen until status is terminal (succeeded | failed).
router.get("/me/resumes/:id", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { rows } = await pool.query(
      `SELECT id, student_id, label, length_pages, length_words, style, domain,
              example_ids, status, content_md, content_html, error,
              cost_cents, source_snapshot, created_at, updated_at
         FROM intake_resumes WHERE id = $1`,
      [Number(req.params.id)]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.student_id !== req.user.studentId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.json({
      id: String(row.id),
      label: row.label,
      lengthPages: row.length_pages,
      lengthWords: row.length_words,
      style: row.style,
      domain: row.domain,
      exampleIds: row.example_ids,
      status: row.status,
      contentMd: row.content_md,
      contentHtml: row.content_html,
      error: row.error,
      costCents: row.cost_cents,
      sourceSnapshot: row.source_snapshot,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/students/me/resumes/:id/regenerate — re-run generation
// for an existing row (typically after a failure or after the student
// edits their intake data). Reuses the row id so the polling client
// stays subscribed.
router.post("/me/resumes/:id/regenerate", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { rows } = await pool.query(
      `SELECT id, student_id, label, length_pages, length_words, style, domain
         FROM intake_resumes WHERE id = $1`,
      [Number(req.params.id)]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.student_id !== req.user.studentId) {
      return res.status(403).json({ error: "forbidden" });
    }
    // Atomic: take the per-student lock, check the cap (a regenerate
    // counts toward the cap exactly like a fresh generation), CAS-flip
    // status if the row isn't already pending/running, all in one
    // transaction. Without the cap check here a student with N old
    // resumes could trigger N concurrent regenerations and bypass the
    // POST /me/resumes cap entirely.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await reserveInflightOrThrow(client, req.user.studentId, 1);
      const swap = await client.query(
        `UPDATE intake_resumes
            SET status = 'pending', error = NULL, updated_at = NOW()
          WHERE id = $1
            AND status NOT IN ('pending','running')
          RETURNING id`,
        [row.id]
      );
      if (swap.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "regeneration already in progress for this resume",
        });
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "INFLIGHT_CAP") {
        return res.status(429).json({
          error: `you have ${e.currentInflight} resume${e.currentInflight === 1 ? "" : "s"} still generating; wait for those to finish before starting more`,
          currentInflight: e.currentInflight,
          cap: e.cap,
        });
      }
      throw e;
    } finally {
      client.release();
    }

    executeResume({
      resumeId: row.id,
      spec: {
        label: row.label,
        length_pages: row.length_pages,
        length_words: row.length_words,
        style: row.style,
        domain: row.domain,
      },
    }).catch((e) => console.error("[resume] regenerate unhandled:", e));
    audit(req, { table: "intake_resumes", id: row.id, action: "regenerate" });
    res.status(202).json({ id: String(row.id), status: "pending" });
  } catch (e) {
    next(e);
  }
});

// Student changes their own password.
//
// Invalidates every OTHER session for this student so a previously-
// stolen cookie can't survive the rotation. Keeps the current session
// alive so the tab the student typed in stays logged in.
router.post("/me/change-password", requireStudent, express.json(), async (req, res, next) => {
  try {
    const { newPassword } = req.body || {};
    if (!isString(newPassword) || newPassword.length < 6 || newPassword.length > 100) {
      return res.status(400).json({ error: "password must be 6-100 chars" });
    }
    // Same denylist + .trim() guard as the create path. Previously the
    // student self-rotation route had no denylist at all — a logged-in
    // student could quietly downgrade to "qwerty". The trim closes the
    // trivial "qwerty " whitespace bypass.
    if (STUDENT_WEAK_PASSWORDS.has(newPassword.trim().toLowerCase())) {
      return res.status(400).json({ error: "password is too common; pick something else" });
    }
    // Validate the cookie value is a UUID before letting it hit the
    // SQL cast — without this, a non-UUID cookie (browser extension
    // edited it; reverse-proxy stripped it; legacy non-UUID session
    // id) either makes the cast throw 22P02 (rolling back the password
    // change → 500) or, if NULL, the `id <> $2::uuid` clause evaluates
    // to NULL and the DELETE matches zero rows — silent bypass that
    // defeats the whole point. Coerce to null on bad input + use
    // IS DISTINCT FROM so the NULL case nukes ALL sessions (which is
    // correct: if we can't identify the current cookie, treat it as
    // potentially compromised and re-login everywhere).
    const rawSid = req.cookies?.[SESSION_COOKIE_NAME];
    const isUuid = (s) =>
      typeof s === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const currentSid = isUuid(rawSid) ? rawSid : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE intake_students SET password_hash = $1, password_plain = $2 WHERE student_id = $3`,
        [hashPassword(newPassword), newPassword, req.user.studentId]
      );
      // Drop every session row for this student that isn't the one
      // making the request right now. IS DISTINCT FROM handles NULL
      // correctly (NULL is distinct from every UUID) — when currentSid
      // is null this becomes a full purge, which is the safer default.
      const del = await client.query(
        `DELETE FROM sessions
           WHERE student_id = $1 AND id IS DISTINCT FROM $2::uuid`,
        [req.user.studentId, currentSid]
      );
      await client.query("COMMIT");
      audit(req, {
        table: "intake_students",
        id: req.user.studentId,
        action: "change_password",
        diff: { other_sessions_invalidated: del.rowCount },
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
