import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import sharp from "sharp";

// archiver v8 ships only named class exports ({ Archiver, ZipArchive,
// TarArchive, JsonArchive }) — no default export, and the v6/v7
// `archiver('zip', opts)` call form no longer works. Pull the
// ZipArchive class directly via createRequire (the ESM-from-CJS
// bridge) and instantiate it with `new` in the batch-download route.
const require = createRequire(import.meta.url);
const { ZipArchive } = require("archiver");
import pool from "../db.js";
import { hashPassword } from "../../lib/password.js";
import { requireStaff, requireStudent, SESSION_COOKIE_NAME } from "../middleware/auth.js";
import { validateUploadedFile } from "../middleware/validateFile.js";
import { audit } from "../audit.js";
import { getStorage } from "../storage.js";
import { scheduleResume, executeResume } from "../generators/run.js";
import { corpusHasExample } from "../generators/examples.js";
import { runImportFromCorpusDir } from "../scripts/import-examples.js";
import { validateIntakeRequired } from "../../lib/intakeSchema.js";
import { seedRequiredDocsForStudent } from "./required-docs.js";
import { seedApplicationsForStudent } from "./applications.js";
import { fileURLToPath } from "node:url";
import { requireAdmin } from "../middleware/auth.js";
import { generateResumeHtml } from "../pdf.js";

const router = express.Router();

// Append-only R2 audit trail for student lifecycle events (archive /
// unarchive / delete). Each call writes one JSON blob at:
//   students/{student_id}/{event}-{epoch}.json
// The delete snapshot includes every associated table's rows so the
// record is self-contained for future manual restoration.
async function backupStudentEvent(event, studentId, payload) {
  try {
    const storage = getStorage();
    const key = `students/${studentId}/${event}-${Date.now()}.json`;
    await storage.putBlob({
      key,
      body: Buffer.from(JSON.stringify({ event, student_id: studentId, payload, timestamp: new Date().toISOString() }, null, 2)),
      contentType: "application/json",
    });
  } catch (e) {
    console.error("[backup] student event failed:", e.message);
  }
}

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

// POST /api/students — staff signs a new student up.
// Body: { username, counsellor_id?, lead_id?, display_name? }
// counsellor_id: admin-only — picks the owning counsellor. Counsellor
// sessions ignore this field and self-assign (otherwise a counsellor
// could shift ownership to someone else by lying in the body).
// Returns: { student_id, username, password (PLAINTEXT, ONE TIME) }
router.post("/", requireStaff, express.json(), async (req, res, next) => {
  try {
    const { username, lead_id, counsellor_id: bodyCounsellorId, display_name, password: explicitPassword } = req.body || {};
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
    if (bodyCounsellorId != null && !isString(bodyCounsellorId)) {
      return res.status(400).json({ error: "counsellor_id must be a string" });
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

    // Owning counsellor. Counsellor sessions self-assign (we ignore any
    // bodyCounsellorId — a counsellor must NOT be able to hand a fresh
    // student over to someone else by lying in the body). Admin sessions
    // pick from the form's "Assign to counsellor" dropdown; null is
    // accepted (legacy unassigned behaviour) but the UI marks it required.
    let counsellorId;
    if (req.user.kind === "counsellor") {
      counsellorId = req.user.counsellorId;
    } else {
      counsellorId = bodyCounsellorId || null;
      if (counsellorId) {
        const ck = await pool.query(
          `SELECT 1 FROM counsellors WHERE id = $1`,
          [counsellorId]
        );
        if (ck.rows.length === 0) {
          return res.status(400).json({ error: "counsellor_id does not exist" });
        }
      }
    }

    // Lead ownership gate: a counsellor must only link a new student to
    // a lead THEY own. Without this check, counsellor A could attach
    // their student to counsellor B's lead by knowing/guessing the lead
    // id — silent cross-counsellor data leakage we do not want. Admin
    // can link to any lead. Skip when no lead specified.
    if (lead_id) {
      const leadOwn = await pool.query(
        `SELECT counsellor_id FROM leads WHERE id = $1`,
        [lead_id]
      );
      if (leadOwn.rows.length === 0) {
        return res.status(400).json({ error: "lead_id does not exist" });
      }
      if (
        req.user.kind === "counsellor" &&
        leadOwn.rows[0].counsellor_id !== req.user.counsellorId
      ) {
        return res.status(403).json({ error: "lead does not belong to you" });
      }
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO intake_students
           (student_id, username, password_hash, lead_id, counsellor_id, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING student_id, username, display_name, lead_id, counsellor_id, created_at`,
        [studentId, cleanUsername, password_hash, lead_id || null, counsellorId, display_name || null]
      );
      const row = rows[0];
      audit(req, {
        table: "intake_students",
        id: row.student_id,
        action: "create",
        diff: {
          username: row.username,
          lead_id: row.lead_id,
          counsellor_id: row.counsellor_id,
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

// POST /api/students/with-docs — staff signs a student up AND attaches
// a batch of starter documents in one shot. Drives the "counsellor
// already has the marksheets / passport / test slips on hand" flow:
// the AI pipeline picks the row up on its next hourly tick and
// pre-fills the intake form + drafts the resume / SOP / LOR letters
// before the student ever logs in.
//
// multipart/form-data:
//   username       (required) — same rules as POST /api/students
//   counsellor_id  (required for admin, ignored for counsellor sessions)
//   display_name   (optional)
//   files          (one or more) — PDF / JPEG / PNG / WebP
//
// Returns the same { student_id, username, password } shape as
// POST /api/students plus { uploaded_count } so the UI can confirm
// every file landed.
//
// Implementation note: this is a mostly-mechanical splice of the
// account-create handler above and the per-file upload handler below
// (multer + sharp orient/resize + storage backend + transactional
// insert). The handlers diverge enough on validation surface +
// transactional shape that DRYing them up would be more confusing
// than the duplication. If you change either, check the other.
//
// uploadManyMw is a lazy wrapper: multerStorage is declared further
// down the file (next to the single-file uploader) and is in the TDZ
// at this point in module load. Constructing the multer instance
// inside the function defers the reference until the first HTTP
// request, by which time the module is fully loaded.
let _uploadMany = null;
function uploadManyMw(req, res, next) {
  if (!_uploadMany) {
    _uploadMany = multer({
      storage: multerStorage,
      limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 30 },
    }).array("files");
  }
  _uploadMany(req, res, (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `one or more files exceed ${MAX_FILE_MB} MB limit` });
    }
    if (err && err.code === "LIMIT_FILE_COUNT") {
      return res.status(413).json({ error: "too many files (max 30)" });
    }
    if (err) return next(err);
    next();
  });
}
router.post("/with-docs", requireStaff, uploadManyMw, async (req, res, next) => {
  // Multer parses the multipart body into req.body for text fields and
  // req.files for the uploads. The caller may submit zero files (the
  // form falls back to the plain create path in that case, but defend
  // against direct callers who post the route with no files).
  const stagedPaths = (req.files || []).map((f) => f.path);
  const cleanupStaged = () => {
    for (const p of stagedPaths) {
      try { fs.unlinkSync(p); } catch {}
    }
  };
  try {
    const { username, counsellor_id: bodyCounsellorId, display_name } = req.body || {};
    if (!isString(username) || username.trim().length < 3 || username.length > 50) {
      cleanupStaged();
      return res.status(400).json({ error: "username must be 3-50 characters" });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
      cleanupStaged();
      return res.status(400).json({ error: "username may only contain letters, digits, _ . -" });
    }
    if (!/[a-zA-Z0-9]/.test(username.trim())) {
      cleanupStaged();
      return res.status(400).json({ error: "username must contain at least one letter or digit" });
    }
    if (display_name != null && (!isString(display_name) || display_name.length > 200)) {
      cleanupStaged();
      return res.status(400).json({ error: "display_name must be a string up to 200 chars" });
    }

    // Validate every staged file's magic bytes BEFORE any DB work — if
    // even one file is junk we reject the whole batch rather than
    // creating a half-attached student.
    const validated = [];
    for (const f of req.files || []) {
      const accept = "application/pdf,image/jpeg,image/png,image/webp";
      const v = validateUploadedFile(f.path, accept);
      if (!v.ok) {
        cleanupStaged();
        return res.status(400).json({ error: `file ${f.originalname}: ${v.error}` });
      }
      validated.push({ file: f, actualType: v.actualType });
    }

    // Owning counsellor — same rules as POST /api/students.
    let counsellorId;
    if (req.user.kind === "counsellor") {
      counsellorId = req.user.counsellorId;
    } else {
      counsellorId = bodyCounsellorId || null;
      if (counsellorId) {
        const ck = await pool.query(`SELECT 1 FROM counsellors WHERE id = $1`, [counsellorId]);
        if (ck.rows.length === 0) {
          cleanupStaged();
          return res.status(400).json({ error: "counsellor_id does not exist" });
        }
      }
    }

    const cleanUsername = username.trim();
    const password = generatePassword();
    const password_hash = hashPassword(password);
    const studentId = newStudentId();
    const store = await getStorage();

    // EXIF orientation bake + resize for image uploads, mirroring the
    // /me/upload path. Done outside the DB transaction so a slow sharp
    // pipeline doesn't hold the row lock; the storage.save call below
    // is also pre-transaction so a network blip on R2 surfaces as a
    // clean 5xx instead of an orphan row.
    for (const v of validated) {
      const f = v.file;
      if (v.actualType === "image/jpeg" || v.actualType === "image/png") {
        const baked = `${f.path}.oriented`;
        try {
          await sharp(f.path)
            .rotate()
            .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
            .withMetadata({ orientation: undefined })
            .toFile(baked);
          fs.renameSync(baked, f.path);
        } catch (e) {
          // Fall through to the raw upload — same forgiving approach
          // as /me/upload. A sideways image is better than a 500.
          console.warn(`[with-docs] sharp pipeline failed for ${f.originalname}:`, e.message);
          try { fs.unlinkSync(baked); } catch {}
        }
      }
    }

    // Push validated bytes to storage. If any save fails, attempt to
    // delete every blob we already wrote so we don't leak orphans.
    const savedKeys = [];
    try {
      for (const v of validated) {
        const saved = await store.save({
          tmpPath: v.file.path,
          scope: studentId,
          originalName: v.file.originalname,
          mimeType: v.actualType,
        });
        savedKeys.push({ ...v, saved });
      }
    } catch (e) {
      for (const k of savedKeys) {
        await store.deleteIfExists(k.saved.key).catch(() => {});
      }
      cleanupStaged();
      throw e;
    }

    // Atomic create + attach. If the username collides, roll back and
    // clean up the storage blobs we just wrote.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // ai_eligible_via_pre_upload flips the AI pipeline candidate
      // query so list-pending picks this row up despite intake_phase
      // still being 'intake'.
      const studentRow = await client.query(
        `INSERT INTO intake_students
           (student_id, username, password_hash, counsellor_id, display_name, ai_eligible_via_pre_upload)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING student_id, username, display_name, counsellor_id, created_at`,
        [studentId, cleanUsername, password_hash, counsellorId, display_name || null]
      );
      // Each starter document gets a generic field_id of "starter_doc"
      // with a sequential row_index. The AI pipeline's vision pass
      // doesn't care about the field_id; it just needs the bytes and
      // the original_name to identify what each file is. Once it
      // emits ai_extracted, the autofill stage maps each value to
      // its canonical answer key.
      let rowIdx = 0;
      for (const k of savedKeys) {
        await client.query(
          `INSERT INTO intake_files
             (student_id, field_id, row_index, original_name, storage_path, size, mime_type)
           VALUES ($1, 'starter_doc', $2, $3, $4, $5, $6)`,
          [studentId, rowIdx, k.file.originalname, k.saved.key, k.saved.size, k.actualType]
        );
        rowIdx += 1;
      }
      await client.query("COMMIT");
      const row = studentRow.rows[0];
      audit(req, {
        table: "intake_students",
        id: row.student_id,
        action: "create_with_docs",
        diff: {
          username: row.username,
          counsellor_id: row.counsellor_id,
          display_name: row.display_name,
          uploaded_count: savedKeys.length,
        },
      });
      cleanupStaged();
      res.status(201).json({ ...row, password, uploaded_count: savedKeys.length });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Roll back storage too.
      for (const k of savedKeys) {
        await store.deleteIfExists(k.saved.key).catch(() => {});
      }
      cleanupStaged();
      if (e.code === "23505") {
        return res.status(409).json({ error: "username already taken" });
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    cleanupStaged();
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
          ? `UPDATE intake_students SET password_hash = $1
               WHERE student_id = $2 AND counsellor_id = $3
               RETURNING student_id, username`
          : `UPDATE intake_students SET password_hash = $1
               WHERE student_id = $2
               RETURNING student_id, username`,
        req.user.kind === "counsellor"
          ? [password_hash, req.params.student_id, req.user.counsellorId]
          : [password_hash, req.params.student_id]
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

// POST /api/students/:student_id/ielts-archive — staff "I'm done
// tracking IELTS for this student" flag. Doesn't change anything about
// the student's account or intake answers; it just hides the row from
// the IELTS panel's active list and surfaces it under the collapsed
// "Archived" section. Counsellor scope mirrors the rest of this file:
// admin can archive anyone, counsellor only their own students.
router.post("/:student_id/ielts-archive", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const ownerSql = req.user.kind === "counsellor"
      ? `SELECT counsellor_id FROM intake_students WHERE student_id = $1`
      : `SELECT counsellor_id FROM intake_students WHERE student_id = $1`;
    const ownerRes = await pool.query(ownerSql, [sid]);
    const owner = ownerRes.rows[0];
    if (!owner) return res.status(404).json({ error: "student not found" });
    if (req.user.kind === "counsellor" && owner.counsellor_id !== req.user.counsellorId) {
      return res.status(403).json({ error: "not your student" });
    }
    await pool.query(
      `UPDATE intake_students SET ielts_archived_at = NOW() WHERE student_id = $1`,
      [sid]
    );
    audit(req, { table: "intake_students", id: sid, action: "ielts_archive" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/:student_id/ielts-unarchive", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const ownerRes = await pool.query(
      `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    const owner = ownerRes.rows[0];
    if (!owner) return res.status(404).json({ error: "student not found" });
    if (req.user.kind === "counsellor" && owner.counsellor_id !== req.user.counsellorId) {
      return res.status(403).json({ error: "not your student" });
    }
    await pool.query(
      `UPDATE intake_students SET ielts_archived_at = NULL WHERE student_id = $1`,
      [sid]
    );
    audit(req, { table: "intake_students", id: sid, action: "ielts_unarchive" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/students/:student_id/archive — staff soft-archives a student account.
// Admin can archive any student; counsellor only their own. Invalidates all
// active sessions for the student so they can no longer log in.
// Body: { reason? } — optional plain-text reason stored on the row.
router.post("/:student_id/archive", requireStaff, express.json(), async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const ownerRes = await pool.query(
      `SELECT counsellor_id, is_archived FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    const owner = ownerRes.rows[0];
    if (!owner) return res.status(404).json({ error: "student not found" });
    if (req.user.kind === "counsellor" && owner.counsellor_id !== req.user.counsellorId) {
      return res.status(403).json({ error: "not your student" });
    }
    if (owner.is_archived) return res.status(400).json({ error: "student is already archived" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    await pool.query(
      `UPDATE intake_students
          SET is_archived = TRUE, archived_at = NOW(), archived_reason = $2, updated_at = NOW()
        WHERE student_id = $1`,
      [sid, reason || null]
    );
    // Invalidate student sessions so they can't log in while archived.
    await pool.query(`DELETE FROM sessions WHERE student_id = $1`, [sid]);
    audit(req, { table: "intake_students", id: sid, action: "archive", diff: { reason } });
    await backupStudentEvent("archive", sid, {
      student: ownerRes.rows[0],
      reason,
      actor: req.user.kind === "admin" ? req.user.adminUsernameRaw : `counsellor:${req.user.counsellorId}`,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/students/:student_id/unarchive — admin only, restores an archived student.
router.post("/:student_id/unarchive", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (req.user.kind !== "admin") return res.status(403).json({ error: "admin only" });
    const sid = req.params.student_id;
    const ownerRes = await pool.query(
      `SELECT is_archived FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    const row = ownerRes.rows[0];
    if (!row) return res.status(404).json({ error: "student not found" });
    if (!row.is_archived) return res.status(400).json({ error: "student is not archived" });
    await pool.query(
      `UPDATE intake_students
          SET is_archived = FALSE, archived_at = NULL, archived_reason = NULL, updated_at = NOW()
        WHERE student_id = $1`,
      [sid]
    );
    audit(req, { table: "intake_students", id: sid, action: "unarchive" });
    await backupStudentEvent("unarchive", sid, {
      actor: req.user.adminUsernameRaw,
      previously_archived_at: row.archived_at,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PATCH /api/students/:student_id/assign-counsellor — admin reassigns a student
// to a different counsellor (or clears the assignment with counsellor_id: null).
router.patch("/:student_id/assign-counsellor", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (req.user.kind !== "admin") return res.status(403).json({ error: "admin only" });
    const sid = req.params.student_id;
    const { counsellor_id } = req.body;
    if (counsellor_id !== null && typeof counsellor_id !== "string") {
      return res.status(400).json({ error: "counsellor_id must be a string or null" });
    }
    // Pull the previous owner + lead linkage so the audit row captures
    // both sides AND we can detect a stale lead_id pointing at a lead
    // owned by the previous counsellor.
    const before = await pool.query(
      `SELECT counsellor_id, lead_id FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    if (!before.rows.length) return res.status(404).json({ error: "student not found" });
    const prevCounsellorId = before.rows[0].counsellor_id;
    const linkedLeadId = before.rows[0].lead_id;
    // Verify counsellor exists (if provided)
    if (counsellor_id) {
      const ccheck = await pool.query(`SELECT id FROM counsellors WHERE id = $1`, [counsellor_id]);
      if (!ccheck.rows.length) return res.status(404).json({ error: "counsellor not found" });
    }
    // If the student is linked to a lead owned by a DIFFERENT counsellor
    // than the new owner, drop the lead link so scoped queries don't
    // drift (otherwise the student moves but the lead stays under the
    // old counsellor — they'd see the lead, lose the student, or vice
    // versa). Admin can re-link explicitly via the leads tab if needed.
    let unlinkedLead = false;
    if (linkedLeadId) {
      const leadOwn = await pool.query(
        `SELECT counsellor_id FROM leads WHERE id = $1`,
        [linkedLeadId]
      );
      const leadCounsellorId = leadOwn.rows[0]?.counsellor_id;
      if (leadCounsellorId && leadCounsellorId !== (counsellor_id || null)) {
        unlinkedLead = true;
      }
    }
    const { rows } = await pool.query(
      unlinkedLead
        ? `UPDATE intake_students
              SET counsellor_id = $1, lead_id = NULL, updated_at = NOW()
            WHERE student_id = $2
            RETURNING student_id, counsellor_id, lead_id`
        : `UPDATE intake_students
              SET counsellor_id = $1, updated_at = NOW()
            WHERE student_id = $2
            RETURNING student_id, counsellor_id, lead_id`,
      [counsellor_id || null, sid]
    );
    audit(req, {
      table: "intake_students",
      id: sid,
      action: "assign_counsellor",
      diff: {
        before: { counsellor_id: prevCounsellorId, lead_id: linkedLeadId },
        after: { counsellor_id: counsellor_id || null, lead_id: rows[0].lead_id },
        unlinked_lead: unlinkedLead,
      },
    });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// POST /api/students/:student_id/hard-delete — admin-only, last-resort
// purge. Removes every row associated with a student across every
// related table (intake_files, intake_required_docs, intake_resumes,
// intake_applications, manual_ai_requests, sessions) and finally
// intake_students itself, all inside a single transaction. Returns a
// per-table delete count so the caller has a record of what went.
// Storage blobs (R2 / disk) are NOT touched, per the data-persistence
// rule. Intended for shell / test accounts that should never have
// existed; not for real student records.
router.post("/:student_id/hard-delete", requireStaff, async (req, res, next) => {
  try {
    if (req.user.kind !== "admin") return res.status(403).json({ error: "admin only" });
    const sid = req.params.student_id;
    if (typeof sid !== "string" || !sid.startsWith("s_")) {
      return res.status(400).json({ error: "student_id must start with s_" });
    }
    // Collect full snapshot BEFORE the transaction so R2 has a
    // complete record even if something goes wrong mid-delete.
    const [studentSnap, filesSnap, resumesSnap, requiredDocsSnap, applicationsSnap, aiRequestsSnap] =
      await Promise.all([
        pool.query(
          `SELECT s.*, c.name AS counsellor_name, l.name AS lead_name
             FROM intake_students s
             LEFT JOIN counsellors c ON c.id = s.counsellor_id
             LEFT JOIN leads      l ON l.id = s.lead_id
            WHERE s.student_id = $1`, [sid]),
        pool.query(`SELECT id, field_id, row_index, original_name, size, mime_type, storage_path, ai_description, superseded_at, created_at FROM intake_files WHERE student_id = $1 ORDER BY id`, [sid]),
        pool.query(`SELECT id, label, style, domain, status, length_words, length_pages, created_at, updated_at FROM intake_resumes WHERE student_id = $1 ORDER BY id`, [sid]),
        pool.query(`SELECT id, kind, recipient_name, recipient_role, reason_brief, staff_draft, marked_done_at, requested_at, created_at FROM intake_required_docs WHERE student_id = $1 ORDER BY id`, [sid]),
        pool.query(`SELECT id, school_name, program_name, status, deadline, created_at FROM intake_applications WHERE student_id = $1 ORDER BY id`, [sid]),
        pool.query(`SELECT id, notes, force_redraft, created_at FROM manual_ai_requests WHERE student_id = $1 ORDER BY id`, [sid]),
      ]);

    if (studentSnap.rows.length === 0) return res.status(404).json({ error: "student not found" });
    const profileBefore = studentSnap.rows[0];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = {};
      deleted.intake_files        = (await client.query(`DELETE FROM intake_files          WHERE student_id = $1`, [sid])).rowCount;
      deleted.intake_required_docs= (await client.query(`DELETE FROM intake_required_docs  WHERE student_id = $1`, [sid])).rowCount;
      deleted.intake_resumes      = (await client.query(`DELETE FROM intake_resumes         WHERE student_id = $1`, [sid])).rowCount;
      deleted.intake_applications = (await client.query(`DELETE FROM intake_applications    WHERE student_id = $1`, [sid])).rowCount;
      deleted.manual_ai_requests  = (await client.query(`DELETE FROM manual_ai_requests     WHERE student_id = $1`, [sid])).rowCount;
      deleted.sessions            = (await client.query(`DELETE FROM sessions               WHERE student_id = $1`, [sid])).rowCount;
      deleted.intake_students     = (await client.query(`DELETE FROM intake_students         WHERE student_id = $1`, [sid])).rowCount;
      await client.query("COMMIT");

      // Write the full snapshot to R2 after a successful commit.
      await backupStudentEvent("delete", sid, {
        actor: req.user.adminUsernameRaw,
        student: profileBefore,
        files: filesSnap.rows,
        resumes: resumesSnap.rows,
        required_docs: requiredDocsSnap.rows,
        applications: applicationsSnap.rows,
        manual_ai_requests: aiRequestsSnap.rows,
        deleted_counts: deleted,
      });

      res.json({ student_id: sid, profile_before: profileBefore, deleted });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) { next(e); }
});

// POST /api/students/:student_id/purge-superseded-files — admin-only.
// Hard-deletes every intake_files row for this student where
// superseded_at IS NOT NULL. Returns the deleted rows so the caller
// can keep an off-DB record. Storage-side blobs are NOT touched here
// (per the data-persistence rule: R2 / disk blobs stay even when DB
// rows go). The DB query filters explicitly on the student_id PK to
// avoid the wrong-student blast radius.
router.post("/:student_id/purge-superseded-files", requireStaff, async (req, res, next) => {
  try {
    if (req.user.kind !== "admin") return res.status(403).json({ error: "admin only" });
    const sid = req.params.student_id;
    if (typeof sid !== "string" || !sid.startsWith("s_")) {
      return res.status(400).json({ error: "student_id must start with s_" });
    }
    const exists = await pool.query(`SELECT 1 FROM intake_students WHERE student_id = $1`, [sid]);
    if (!exists.rows.length) return res.status(404).json({ error: "student not found" });
    const before = await pool.query(
      `SELECT id, field_id, row_index, original_name, storage_path, size, mime_type,
              created_at, superseded_at
         FROM intake_files
        WHERE student_id = $1 AND superseded_at IS NOT NULL
        ORDER BY id`,
      [sid]
    );
    if (before.rows.length === 0) {
      return res.json({ student_id: sid, deleted_count: 0, deleted_rows: [] });
    }
    const del = await pool.query(
      `DELETE FROM intake_files
        WHERE student_id = $1 AND superseded_at IS NOT NULL
        RETURNING id`,
      [sid]
    );
    res.json({
      student_id: sid,
      deleted_count: del.rowCount,
      deleted_rows: before.rows.map((r) => ({
        ...r,
        id: String(r.id),
      })),
    });
  } catch (e) { next(e); }
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
    const includeArchived = req.query.include_archived === "true";
    let sql = `
      SELECT s.student_id, s.username, s.display_name,
             s.intake_complete, s.intake_phase, s.data,
             s.lead_id, s.counsellor_id, s.created_at, s.updated_at,
             s.ielts_archived_at, s.is_archived, s.archived_at, s.archived_reason,
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
    if (!includeArchived) {
      sql += ` AND (s.is_archived = FALSE OR s.is_archived IS NULL)`;
    }
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

// GET /api/students/financial-summary — admin-only one-shot aggregate of
// per-student financial document status. Returns one row per active student
// with a boolean per financial section so the admin checklist tab can
// render green/red boxes without N separate per-student round-trips.
// IMPORTANT: this route MUST stay above GET /:student_id so Express
// doesn't treat the literal "financial-summary" as a student_id param.
router.get("/financial-summary", requireStaff, async (req, res, next) => {
  try {
    const params = [];
    let scopeClause = "";
    if (req.user.kind === "counsellor") {
      params.push(req.user.counsellorId);
      scopeClause = `AND s.counsellor_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT
        s.student_id, s.username, s.display_name,
        c.name AS counsellor_name,
        d.data AS dossier,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_itr\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS itr_files,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_income\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS income_files,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_business\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS business_files,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_kyc\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS kyc_files,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_loan\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS loan_files,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_networth\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS networth_files,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_affidavit\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS affidavit_files,
        (SELECT COUNT(*) FROM intake_files WHERE student_id = s.student_id AND field_id LIKE 'fin\\_banking\\_%' ESCAPE '\\' AND superseded_at IS NULL) AS banking_files
      FROM intake_students s
      LEFT JOIN counsellors c ON c.id = s.counsellor_id
      LEFT JOIN intake_financial_dossier d ON d.student_id = s.student_id
      WHERE (s.is_archived = FALSE OR s.is_archived IS NULL)
        AND s.username IS NOT NULL
        ${scopeClause}
      ORDER BY s.created_at DESC
    `, params);
    res.json(rows.map((r) => {
      const dossier = r.dossier || {};
      const trips = Array.isArray(dossier.travelTrips) ? dossier.travelTrips : [];
      return {
        student_id: r.student_id,
        username: r.username,
        display_name: r.display_name,
        counsellor_name: r.counsellor_name,
        sections: {
          itr: Number(r.itr_files) > 0,
          income: Number(r.income_files) > 0,
          business: Number(r.business_files) > 0,
          kyc: Number(r.kyc_files) > 0,
          loan: dossier.studentLoanTaken === false ? null : Number(r.loan_files) > 0,
          networth: Number(r.networth_files) > 0,
          affidavit: Number(r.affidavit_files) > 0,
          banking: Number(r.banking_files) > 0,
          travel: trips.length > 0,
        },
      };
    }));
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
              s.is_archived, s.archived_at, s.archived_reason,
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
              ai_description, ai_extracted,
              superseded_at, created_at
         FROM intake_files WHERE student_id = $1
         ORDER BY field_id, created_at ASC`,
      [sid]
    );
    const resumesRes = await pool.query(
      `SELECT id, label, length_pages, length_words, style, domain,
              status, content_md, content_html, content_json, pdf_file_id,
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

// POST /api/students/me/request-ai-fill — student self-submits for manual
// automation. Inserts a manual_ai_requests row (requested_by_kind='student')
// so the admin queue surfaces it. Idempotent: returns the existing pending
// row if one already exists so the UI can safely re-poll without creating
// duplicates. Body: { notes? }
router.post("/me/request-ai-fill", requireStudent, express.json(), async (req, res, next) => {
  try {
    const sid = req.user.studentId;
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() || null : null;
    // Return existing pending row rather than inserting a duplicate.
    const existing = await pool.query(
      `SELECT id, created_at FROM manual_ai_requests
        WHERE student_id = $1 AND processed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [sid]
    );
    if (existing.rows.length > 0) {
      return res.json({ ok: true, already_pending: true, request_id: existing.rows[0].id, requested_at: existing.rows[0].created_at });
    }
    const ins = await pool.query(
      `INSERT INTO manual_ai_requests (student_id, requested_by_kind, notes)
       VALUES ($1, 'student', $2)
       RETURNING id, created_at`,
      [sid, notes]
    );
    res.json({ ok: true, already_pending: false, request_id: ins.rows[0].id, requested_at: ins.rows[0].created_at });
  } catch (e) { next(e); }
});

// GET /api/students/me/ai-fill-status — lets the student poll whether
// their automation request has been processed and artifacts are ready.
router.get("/me/ai-fill-status", requireStudent, async (req, res, next) => {
  try {
    const sid = req.user.studentId;
    const [reqRow, studentRow] = await Promise.all([
      pool.query(
        `SELECT id, notes, processed_at, created_at FROM manual_ai_requests
          WHERE student_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [sid]
      ),
      pool.query(
        `SELECT ai_artifacts_generated_at FROM intake_students WHERE student_id = $1`,
        [sid]
      ),
    ]);
    const req_ = reqRow.rows[0] || null;
    const artifactsReady = !!(studentRow.rows[0]?.ai_artifacts_generated_at);
    res.json({
      has_request: !!req_,
      pending: req_ ? !req_.processed_at : false,
      processed: req_ ? !!req_.processed_at : false,
      requested_at: req_?.created_at || null,
      processed_at: req_?.processed_at || null,
      artifacts_ready: artifactsReady,
    });
  } catch (e) { next(e); }
});

router.get("/me/record", requireStudent, async (req, res, next) => {
  try {
    // intake_phase is the explicit state column (intake / done; legacy
    // rows may still read 'doc_review' until the migration coerces
    // them). Resume counts pulled so the dashboard can show generation
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

// GET /me/counsellor — name + contact for the assigned counsellor, or
// null when nobody's been attached yet. Surfaced on the student-side
// Application status tab so the student knows who's in their queue
// (and so an unassigned student is visible at a glance).
router.get("/me/counsellor", requireStudent, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.email
         FROM intake_students s
         LEFT JOIN counsellors c ON c.id = s.counsellor_id
        WHERE s.student_id = $1`,
      [req.user.studentId]
    );
    if (rows.length === 0 || !rows[0].id) {
      return res.json({ counsellor: null });
    }
    res.json({ counsellor: { id: rows[0].id, name: rows[0].name, email: rows[0].email } });
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
    const { data, expectedUpdatedAt } = req.body || {};
    // intake_complete is intentionally NOT writable from this endpoint.
    // The only valid path to flip it is PUT /me/intake/phase, which
    // also runs the required-field gate + auto-fires resume gen. A
    // hand-crafted PUT that set intakeComplete=true here used to drift
    // the flag out of sync with intake_phase and the resume pipeline.

    // Reject anything that isn't a plain object — the field is jsonb
    // and the SET clause stringifies whatever lands here. Without this
    // guard, `data: "stringy"` or `data: null` round-trips into the DB
    // and breaks the next client read (which expects an object). Arrays
    // pass typeof === "object" so block them too.
    if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
      return res.status(400).json({ error: "data must be a JSON object" });
    }

    // Probe the current phase so we can run the post-done lazy seeding
    // path below. The `phase=done` write block from the legacy intake
    // flow has been lifted: the linear intake now ends at p_activities
    // and the remaining chapters (LORs/internships, story, target
    // programs) are filled in from the dashboard as tabs, which means
    // the student keeps writing into data even after the phase flip.
    const phaseProbe = await pool.query(
      `SELECT intake_phase FROM intake_students WHERE student_id = $1`,
      [req.user.studentId]
    );
    const currentPhase = phaseProbe.rows[0]?.intake_phase || "intake";

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
                updated_at = NOW()
          WHERE student_id = $2
            AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz)
          RETURNING student_id, intake_complete, updated_at`
      : `UPDATE intake_students
            SET data = $1::jsonb,
                updated_at = NOW()
          WHERE student_id = $2
          RETURNING student_id, intake_complete, updated_at`;
    const params = expectedUpdatedAt
      ? [JSON.stringify(data || {}), req.user.studentId, expectedUpdatedAt]
      : [JSON.stringify(data || {}), req.user.studentId];

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

    // Lazy seeding for the post-intake panel tabs. After phase=done the
    // student keeps editing LORs / internships / paths from the
    // dashboard tabs — those rows must flow through to the staff side
    // (Required documents queue, Pending Applications) without an
    // explicit "submit" step. Both seeders are idempotent so re-running
    // them on every save costs ~1 SELECT per row at worst. Best-effort:
    // a seeder failure should not roll back the user's autosave.
    if (currentPhase === "done") {
      try {
        const answers = (data && data.answers) || {};
        await seedRequiredDocsForStudent(pool, req.user.studentId, answers);
        await seedApplicationsForStudent(pool, req.user.studentId, answers);
      } catch (seedErr) {
        console.error("[record save] post-done lazy seed failed:", seedErr);
      }
    }

    res.json({
      studentId: row.student_id,
      intakeComplete: row.intake_complete,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    next(e);
  }
});

// ============================================================
// Financial dossier — the post-intake "Financial documents" tab.
// One row per student in intake_financial_dossier; the actual file
// uploads live in intake_files under a 'fin_*' field_id namespace
// (same blob storage + audit path as every other intake upload).
// ============================================================

// GET /me/financial — full dossier + the active file list. Single
// round-trip: the client renders every section, including the green-
// tick "uploaded" UI, without a follow-up request.
router.get("/me/financial", requireStudent, async (req, res, next) => {
  try {
    const studentId = req.user.studentId;
    const dossierResult = await pool.query(
      `SELECT data, updated_at FROM intake_financial_dossier WHERE student_id = $1`,
      [studentId]
    );
    const filesResult = await pool.query(
      `SELECT id, field_id, row_index, original_name, size, mime_type, created_at
         FROM intake_files
        WHERE student_id = $1 AND field_id LIKE 'fin\\_%' ESCAPE '\\'
          AND superseded_at IS NULL
        ORDER BY field_id, row_index NULLS FIRST, created_at`,
      [studentId]
    );
    res.json({
      dossier: dossierResult.rows[0]?.data || {},
      updatedAt: dossierResult.rows[0]?.updated_at || null,
      files: filesResult.rows.map((r) => ({
        id: r.id,
        fieldId: r.field_id,
        rowIndex: r.row_index,
        name: r.original_name,
        size: Number(r.size),
        mime: r.mime_type,
        url: `/api/students/me/files/${r.id}`,
        uploadedAt: r.created_at,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// PUT /me/financial — overwrite the dossier jsonb. Same optimistic-
// concurrency pattern as /me/record: pass the expectedUpdatedAt the
// client last saw; mismatched → 409 with the latest body so the client
// can replay its local diff on top.
router.put("/me/financial", requireStudent, express.json({ limit: "1mb" }), async (req, res, next) => {
  try {
    const { data, expectedUpdatedAt } = req.body || {};
    if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
      return res.status(400).json({ error: "data must be a JSON object" });
    }
    const studentId = req.user.studentId;
    const payload = JSON.stringify(data || {});

    // No precondition (first save / explicit overwrite) → upsert.
    if (!expectedUpdatedAt) {
      const ins = await pool.query(
        `INSERT INTO intake_financial_dossier (student_id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (student_id) DO UPDATE
           SET data = EXCLUDED.data, updated_at = NOW()
         RETURNING updated_at`,
        [studentId, payload]
      );
      audit(req, { table: "intake_financial_dossier", id: studentId, action: "upsert" });
      return res.json({ updatedAt: ins.rows[0].updated_at });
    }

    const { rows } = await pool.query(
      `UPDATE intake_financial_dossier
          SET data = $1::jsonb, updated_at = NOW()
        WHERE student_id = $2
          AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz)
        RETURNING updated_at`,
      [payload, studentId, expectedUpdatedAt]
    );
    if (rows.length === 0) {
      const latest = await pool.query(
        `SELECT data, updated_at FROM intake_financial_dossier WHERE student_id = $1`,
        [studentId]
      );
      return res.status(409).json({
        error: "stale write — another tab updated this record",
        latest: {
          data: latest.rows[0]?.data || {},
          updatedAt: latest.rows[0]?.updated_at || null,
        },
      });
    }
    audit(req, { table: "intake_financial_dossier", id: studentId, action: "update" });
    res.json({ updatedAt: rows[0].updated_at });
  } catch (e) {
    next(e);
  }
});

// PUT /api/students/me/intake/phase — explicit phase transition.
//   { phase: "done" } → from 'intake' (general form done, including the
//                       transcribed values from each upload page).
//                       Flips intake_complete + auto-fires one 300-word
//                       resume gen, navigates the client to the
//                       dashboard.
//
// Forward-only (intake → done) so a refresh-bouncing client can't
// accidentally rewind state. Atomic: phase flip + resume insert happen
// in one transaction so a crash mid-call leaves no half-state.
//
// The legacy 'doc_review' phase has been folded into intake — uploads
// and their transcribed values now live on the same page — so the
// previous intake → doc_review → done two-step is collapsed.
router.put("/me/intake/phase", requireStudent, express.json(), async (req, res, next) => {
  try {
    const { phase } = req.body || {};
    if (phase !== "done") {
      return res.status(400).json({ error: "phase must be 'done'" });
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

      // Forward-only: only 'intake' can become 'done'. Legacy
      // 'doc_review' rows are coerced back to 'intake' by the migration
      // so they re-enter the merged flow; if one slips through here we
      // refuse and ask the client to refresh.
      if (currentPhase !== "intake") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `cannot move to done from '${currentPhase}'`,
          currentPhase,
        });
      }

      // Defence-in-depth: refuse to flip if any required field is empty.
      // Client's page-by-page advance gate enforces the same shape, but
      // a hand-crafted PUT or a stale draft restored mid-edit could
      // otherwise trigger resume gen against missing values (parent
      // details, marks %, passport #, etc.).
      const dataRes = await client.query(
        `SELECT data FROM intake_students WHERE student_id = $1`,
        [studentId]
      );
      const answers = dataRes.rows[0]?.data?.answers || {};
      const { ok, missing } = validateIntakeRequired(answers);
      if (!ok) {
        await client.query("ROLLBACK");
        return res.status(422).json({
          error: "intake fields still missing — fill them before finishing",
          missing,
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
      // Seed LOR / Internship / SOP rows from the student's intake
      // briefs. Idempotent — uses ON CONFLICT (student_id, kind, seq) —
      // so a re-fired phase transition (shouldn't happen, but defensive)
      // doesn't duplicate rows.
      await seedRequiredDocsForStudent(client, studentId, answers);
      // Seed pending applications from the student's selected paths.
      // Each {country, university, program} triple becomes one
      // intake_applications row with pending=true so it lands in the
      // Pending Review section of the staff Applications tab. The
      // counsellor reviews each one and promotes it into the active
      // workflow. Idempotent — re-runs on every post-done save as the
      // student fills the destination tab in their dashboard.
      await seedApplicationsForStudent(client, studentId, answers);
      await client.query("COMMIT");
      // Auto-fire of resume generation removed — the LLM-summarised
      // resume is on the roadmap but not the immediate path. The
      // manual /me/resumes route + staff regenerate route remain in
      // place so the feature can be turned back on without re-running
      // a phase transition. corpus checks / inflight reservation /
      // executeResume call all moved with it.
      audit(req, {
        table: "intake_students",
        id: studentId,
        action: "intake_done",
        diff: {},
      });
      return res.json({ phase: "done" });
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

// ============================================================
// FILE UPLOAD — student uploads a document. Multer disk storage,
// magic-byte recheck, FK row inserted. Doc-derived values (marks %,
// passport #, test scores) are typed by hand into the same intake
// page that holds the upload — no separate review step.
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

    // EXIF orientation bake + size cap for image uploads. Two birds, one
    // sharp pipeline:
    //
    //   - Phone-camera JPEGs/PNGs carry an "Orientation" EXIF tag that
    //     says "rotate 90/180/270 on display." Most modern browsers
    //     honour it for <img>, but embedded WebViews (Instagram,
    //     WhatsApp) and downstream PDF/print pipelines often don't —
    //     students see their marksheet/Aadhar sideways. .rotate() with
    //     no args reads the EXIF tag and rotates the pixels, then we
    //     strip the tag so every consumer renders the same picture.
    //
    //   - 4032×3024 phone JPEGs run 4–6 MB. We resize down to 1600px
    //     on the longest side (lossless if smaller — withoutEnlargement)
    //     so storage, downloads, and the inline preview stay snappy on
    //     slow Indian mobile connections. 1600px keeps text on a
    //     marksheet legible for transcription (the original use case)
    //     while typically shrinking the file to ~300–600 KB.
    //
    // PDFs pass through untouched — sharp can't rasterise them without
    // a libvips poppler build, which our Render deploy doesn't ship.
    const tmpForStorage = req.file.path;
    let bakedTmp = null;
    if (v.actualType === "image/jpeg" || v.actualType === "image/png") {
      bakedTmp = `${req.file.path}.oriented`;
      try {
        await sharp(req.file.path)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .withMetadata({ orientation: undefined })
          .toFile(bakedTmp);
        // Replace the original tmp with the oriented+resized one so
        // storage.save moves the canonical version. Failure here falls
        // through to the raw upload — better to ship a possibly-
        // sideways/oversized image than to 500 the upload entirely.
        fs.renameSync(bakedTmp, req.file.path);
        bakedTmp = null;
      } catch (e) {
        console.warn("[upload] sharp auto-orient/resize failed, falling back to raw upload:", e.message);
        try { if (bakedTmp) fs.unlinkSync(bakedTmp); } catch {}
      }
    }

    // Hand the validated bytes to the storage backend (local disk by
    // default, S3-compatible if STORAGE_BACKEND=s3). Returns the opaque
    // `key` we persist as storage_path; download routes stream by key.
    const store = await getStorage();
    const saved = await store.save({
      tmpPath: tmpForStorage,
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
      // Report the post-processing size (after sharp resize). For PDFs
      // this matches req.file.size; for images it's typically much
      // smaller, and we want the client's "filename · 423 KB" pill to
      // match what's actually stored.
      size: saved.size,
    });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    next(err);
  }
});

// GET /api/students/me/files — list every (active) document the
// student has uploaded. Drives the "Your documents" section on the
// post-intake dashboard. Returns the same shape as the admin-side
// listing (id, field_id, original_name, size, mime_type, created_at)
// so the same rendering code can render either source.
router.get("/me/files", requireStudent, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, field_id, row_index, original_name, size, mime_type,
              ai_description, ai_extracted,
              superseded_at, created_at
         FROM intake_files
        WHERE student_id = $1 AND superseded_at IS NULL
        ORDER BY field_id, created_at ASC`,
      [req.user.studentId]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Parse a single-range HTTP Range header against a known total size.
// Returns { start, end } (inclusive offsets) or null when the header is
// absent / malformed / multi-range — caller falls back to a full 200.
// pdf.js issues single-range fetches only, which is the case we care
// about; multipart byteranges are deliberately unsupported.
function parseRange(header, totalSize) {
  if (!header || typeof header !== "string" || !header.startsWith("bytes=")) return null;
  const spec = header.slice(6);
  if (spec.includes(",")) return null;
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const startStr = spec.slice(0, dash);
  const endStr = spec.slice(dash + 1);
  let start, end;
  if (startStr === "") {
    // suffix range: last N bytes
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, totalSize - n);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null;
    end = endStr === "" ? totalSize - 1 : Number(endStr);
    if (!Number.isFinite(end)) return null;
    if (end >= totalSize) end = totalSize - 1;
  }
  if (start > end) return null;
  return { start, end };
}

// Stream a stored file to the response, honouring HTTP Range requests
// when present. Used by both the student-side and staff-side download
// routes — same headers, same range-handling semantics, single source
// of truth. Range support matters for pdf.js: it issues partial fetches
// to stream large marksheets page-by-page instead of buffering the
// whole document.
async function streamStoredFile(req, res, next, doc) {
  try {
    const store = await getStorage();
    if (!(await store.exists(doc.storage_path))) {
      return res.status(410).json({ error: "File missing in storage." });
    }
    res.set("Content-Type", doc.mime_type);
    // private = single-user (cookie-gated, contains personal data —
    // Aadhar / passport scans). max-age = treat the response as
    // immutable for an hour: file IDs are unique-per-upload (BIGSERIAL),
    // so a "replace" gets a brand new URL and the browser cache for the
    // old one becomes irrelevant. immutable hints the browser away from
    // revalidating on back/forward nav.
    res.set("Cache-Control", "private, max-age=3600, immutable");
    res.set("Accept-Ranges", "bytes");
    res.set(
      "Content-Disposition",
      `inline; filename="${path.basename(doc.original_name).replace(/"/g, "")}"`
    );

    const range = parseRange(req.headers.range, doc.size);
    if (range) {
      res.status(206);
      res.set("Content-Range", `bytes ${range.start}-${range.end}/${doc.size}`);
      res.set("Content-Length", String(range.end - range.start + 1));
      const stream = await store.openReadStream(doc.storage_path, range);
      stream.on("error", (e) => next(e));
      stream.pipe(res);
    } else {
      res.set("Content-Length", String(doc.size));
      const stream = await store.openReadStream(doc.storage_path);
      stream.on("error", (e) => next(e));
      stream.pipe(res);
    }
  } catch (e) {
    next(e);
  }
}

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
    return streamStoredFile(req, res, next, doc);
  } catch (e) {
    next(e);
  }
});

// GET /api/students/:student_id/financial — staff. Read-only view of
// the student's financial dossier + the active file list. Mirrors
// /me/financial but scoped by URL param; counsellor scoping (only your
// own students) lands through the same requireStaff path the rest of
// this file uses for staff endpoints.
router.get("/:student_id/financial", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    // Counsellor scope check: a counsellor may only read their own
    // students. Admin sees everyone.
    if (req.user.kind === "counsellor") {
      const own = await pool.query(
        `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
        [sid]
      );
      if (own.rows.length === 0) return res.status(404).json({ error: "student not found" });
      if (own.rows[0].counsellor_id !== req.user.counsellorId) {
        return res.status(403).json({ error: "this student is not assigned to you" });
      }
    }
    const dossierResult = await pool.query(
      `SELECT data, updated_at FROM intake_financial_dossier WHERE student_id = $1`,
      [sid]
    );
    const filesResult = await pool.query(
      `SELECT id, field_id, row_index, original_name, size, mime_type, created_at
         FROM intake_files
        WHERE student_id = $1 AND field_id LIKE 'fin\\_%' ESCAPE '\\'
          AND superseded_at IS NULL
        ORDER BY field_id, row_index NULLS FIRST, created_at`,
      [sid]
    );
    res.json({
      dossier: dossierResult.rows[0]?.data || {},
      updatedAt: dossierResult.rows[0]?.updated_at || null,
      files: filesResult.rows.map((r) => ({
        id: r.id,
        fieldId: r.field_id,
        rowIndex: r.row_index,
        name: r.original_name,
        size: Number(r.size),
        mime: r.mime_type,
        url: `/api/students/${sid}/files/${r.id}`,
        uploadedAt: r.created_at,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// PUT /api/students/:student_id/financial — staff write. Same optimistic-
// concurrency model as /me/financial. Admin and counsellor (own student
// only) can fill/edit the financial dossier on the student's behalf.
router.put("/:student_id/financial", requireStaff, express.json({ limit: "1mb" }), async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    if (req.user.kind === "counsellor") {
      const own = await pool.query(
        `SELECT counsellor_id FROM intake_students WHERE student_id = $1`, [sid]
      );
      if (own.rows.length === 0) return res.status(404).json({ error: "student not found" });
      if (own.rows[0].counsellor_id !== req.user.counsellorId)
        return res.status(403).json({ error: "this student is not assigned to you" });
    }
    const { data, expectedUpdatedAt } = req.body || {};
    if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data)))
      return res.status(400).json({ error: "data must be a JSON object" });
    const payload = JSON.stringify(data || {});
    if (!expectedUpdatedAt) {
      const ins = await pool.query(
        `INSERT INTO intake_financial_dossier (student_id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (student_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
         RETURNING updated_at`,
        [sid, payload]
      );
      audit(req, { table: "intake_financial_dossier", id: sid, action: "upsert" });
      return res.json({ updatedAt: ins.rows[0].updated_at });
    }
    const { rows } = await pool.query(
      `UPDATE intake_financial_dossier
          SET data = $1::jsonb, updated_at = NOW()
        WHERE student_id = $2
          AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz)
        RETURNING updated_at`,
      [payload, sid, expectedUpdatedAt]
    );
    if (rows.length === 0) {
      const latest = await pool.query(
        `SELECT data, updated_at FROM intake_financial_dossier WHERE student_id = $1`, [sid]
      );
      return res.status(409).json({
        error: "stale write — another tab updated this record",
        latest: { data: latest.rows[0]?.data || {}, updatedAt: latest.rows[0]?.updated_at || null },
      });
    }
    audit(req, { table: "intake_financial_dossier", id: sid, action: "update" });
    res.json({ updatedAt: rows[0].updated_at });
  } catch (e) { next(e); }
});

// GET /api/students/:student_id/files/all.zip — staff. MUST be
// registered ABOVE the parameterised /:student_id/files/:id route
// below; Express matches in registration order and `:id = "all.zip"`
// would otherwise win the match and 400 on the integer-id validation.
//
// Streams every ACTIVE (superseded_at IS NULL) uploaded file for the
// student as a single ZIP. Same auth + scoping as the single-file
// download: admin sees any student's files; counsellor sees only
// students assigned to them. Filename is the student's display name
// slugified plus the date, so opening the ZIP later the reviewer
// knows whose docs are in it without unzipping.
//
// Inside the zip, each entry is named "<NN>-<original_name>" where NN
// is a 2-digit sequence in upload order. Original filenames vary in
// quality (UIDAI's "EAadhaar_065…_page-0001 (1).jpg.jpeg" vs the
// student's own "Class 11 Report card.pdf"); duplicates inside a
// student's slot history are handled by the active-only filter.
router.get("/:student_id/files/all.zip", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    // Verify the student exists, get display name + counsellor scope.
    const studentRes = await pool.query(
      `SELECT student_id, display_name, counsellor_id,
              data->'answers'->>'name' AS typed_name
         FROM intake_students WHERE student_id = $1`,
      [sid]
    );
    const student = studentRes.rows[0];
    if (!student) return res.status(404).json({ error: "student not found" });
    if (req.user.kind === "counsellor" && student.counsellor_id !== req.user.counsellorId) {
      return res.status(403).json({ error: "not your student" });
    }

    const filesRes = await pool.query(
      `SELECT id, original_name, storage_path, size, mime_type
         FROM intake_files
        WHERE student_id = $1 AND superseded_at IS NULL
        ORDER BY field_id, created_at ASC, id ASC`,
      [sid]
    );
    if (filesRes.rows.length === 0) {
      return res.status(404).json({ error: "no active files for this student" });
    }

    const slug = (student.typed_name || student.display_name || sid)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "student";
    const today = new Date().toISOString().slice(0, 10);
    const zipName = `${slug}-uploaded-documents-${today}.zip`;

    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${zipName}"`);
    res.set("Cache-Control", "private, no-store");

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("warning", (err) => {
      if (err.code !== "ENOENT") console.error("[zip] warning:", err.message);
    });
    archive.on("error", (err) => {
      console.error("[zip] error:", err.message);
      if (res.headersSent) res.destroy(err);
      else next(err);
    });
    archive.pipe(res);

    const store = await getStorage();
    let seq = 0;
    for (const f of filesRes.rows) {
      seq += 1;
      if (!(await store.exists(f.storage_path))) {
        // Skip silently — better to deliver N-1 files than to 500 the
        // whole batch because one R2 object went missing.
        console.error(`[zip] missing in storage: file ${f.id} key=${f.storage_path}`);
        continue;
      }
      const stream = await store.openReadStream(f.storage_path);
      const safeName = String(f.original_name || `file-${f.id}`).replace(/[/\\:*?"<>|]/g, "_");
      const entryName = `${String(seq).padStart(2, "0")}-${safeName}`;
      archive.append(stream, { name: entryName });
    }
    await archive.finalize();
  } catch (e) {
    next(e);
  }
});

// Staff-side single-file download — admin or owning counsellor only.
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
    return streamStoredFile(req, res, next, doc);
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

// GET /api/students/:student_id/resumes/:id/print — staff
// Returns a beautiful, self-contained HTML document ready for
// browser print → Save as PDF. The page auto-triggers window.print()
// after Google Fonts load so the Save as PDF dialog appears immediately.
router.get("/:student_id/resumes/:id/print", requireStaff, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { rows } = await pool.query(
      `SELECT r.content_json, r.status, s.display_name
         FROM intake_resumes r
         JOIN intake_students s ON s.student_id = r.student_id
        WHERE r.id = $1 AND r.student_id = $2`,
      [Number(req.params.id), req.params.student_id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not found" });
    if (!row.content_json) {
      return res.status(400).send("This resume does not have structured content and cannot be printed this way.");
    }
    const html = generateResumeHtml(row.content_json, row.display_name);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(html);
  } catch (e) {
    next(e);
  }
});

// POST /api/students/admin/import-examples — admin-only one-shot
// to sync automation/resume_corpus/example_resume/ on disk into the intake_examples
// table. Useful because external Render Postgres connections are
// flaky for long batches; running this server-side keeps everything
// inside Render's private network.
router.post("/admin/import-examples", requireAdmin, async (req, res, next) => {
  try {
    // Resolve the corpus dir relative to this file at runtime.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const corpusDir = path.resolve(here, "..", "..", "automation", "resume_corpus", "example_resume");
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

    // Precondition: the student must have completed intake
    // (intake_phase = 'done'). The auto-fire on the phase transition
    // handles the happy-path first resume; this manual route is now
    // only for regenerate-from-dashboard scenarios.
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
              example_ids, status, content_md, content_html, content_json, error,
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
        contentJson: r.content_json,
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
              example_ids, status, content_md, content_html, content_json, error,
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
      contentJson: row.content_json,
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

// GET /api/students/me/resumes/:id/print — student-facing print route.
// Same design as the staff route but scoped to the logged-in student.
router.get("/me/resumes/:id/print", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { rows } = await pool.query(
      `SELECT r.content_json, r.status, s.display_name
         FROM intake_resumes r
         JOIN intake_students s ON s.student_id = r.student_id
        WHERE r.id = $1 AND r.student_id = $2`,
      [Number(req.params.id), req.user.studentId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not found" });
    if (!row.content_json) {
      return res.status(400).send("This resume does not have structured content and cannot be printed this way.");
    }
    const html = generateResumeHtml(row.content_json, row.display_name);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(html);
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
        `UPDATE intake_students SET password_hash = $1 WHERE student_id = $2`,
        [hashPassword(newPassword), req.user.studentId]
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

// POST /api/students/:student_id/reset-intake — admin only.
// Clears intake_complete + intake_phase so the student can redo the
// intake flow from scratch. Also wipes required_docs rows + any
// pending applications so they get re-seeded / re-submitted when the
// student completes intake again. Active (non-archived) application
// rows would otherwise stay in the staff queue pointing at the
// now-empty intake — confusing and effectively phantom.
// Useful for test accounts or when the intake schema changes significantly.
router.post("/:student_id/reset-intake", requireAdmin, async (req, res, next) => {
  try {
    const { student_id } = req.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE intake_students
            SET intake_complete = FALSE,
                intake_phase     = NULL,
                data             = '{}'::jsonb,
                updated_at       = NOW()
          WHERE student_id = $1`,
        [student_id]
      );
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "student not found" });
      }
      await client.query(
        `DELETE FROM intake_required_docs WHERE student_id = $1`,
        [student_id]
      );
      // Drop unfinished application rows. Archived rows stay (they
      // are the historical record) — the student or admin can choose
      // to ignore them after reset. The CASCADE on intake_students
      // would handle this if the row itself were deleted, but reset
      // keeps the row alive, so we have to clear by hand.
      await client.query(
        `DELETE FROM intake_applications
           WHERE student_id = $1 AND archived = FALSE`,
        [student_id]
      );
      await client.query("COMMIT");
      audit(req, {
        table: "intake_students",
        id: student_id,
        action: "reset_intake",
        diff: {},
      });
      res.json({ ok: true });
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
