import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import pool from "../db.js";
import { hashPassword } from "../../lib/password.js";
import { requireStaff, requireStudent } from "../middleware/auth.js";
import { validateUploadedFile } from "../middleware/validateFile.js";
import { scheduleExtraction } from "../extractors/run.js";

const router = express.Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || "uploads";
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "10", 10);

const isPositiveInt = (s) => /^[1-9][0-9]*$/.test(String(s));
const isString = (v) => typeof v === "string";
const sanitizeForFs = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);

const uploadsRoot = path.resolve(UPLOADS_DIR);
fs.mkdirSync(uploadsRoot, { recursive: true });

// Generate an 8-char password the counsellor copies and sends to the
// student. Excludes ambiguous chars (0/O, 1/l/I) to reduce typos.
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
    const { username, lead_id, display_name } = req.body || {};
    if (!isString(username) || username.trim().length < 3 || username.length > 50) {
      return res.status(400).json({ error: "username must be 3-50 characters" });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
      return res.status(400).json({ error: "username may only contain letters, digits, _ . -" });
    }
    if (lead_id != null && !isString(lead_id)) {
      return res.status(400).json({ error: "lead_id must be a string" });
    }
    if (display_name != null && (!isString(display_name) || display_name.length > 200)) {
      return res.status(400).json({ error: "display_name must be a string up to 200 chars" });
    }

    const cleanUsername = username.trim();
    const password = generatePassword();
    const password_hash = hashPassword(password);
    const studentId = newStudentId();

    // Counsellor that created this — admins act on behalf of nobody.
    const counsellorId = req.user.kind === "counsellor" ? req.user.counsellorId : null;

    try {
      const { rows } = await pool.query(
        `INSERT INTO intake_students
           (student_id, username, password_hash, lead_id, counsellor_id, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING student_id, username, display_name, lead_id, counsellor_id, created_at`,
        [studentId, cleanUsername, password_hash, lead_id || null, counsellorId, display_name || null]
      );
      const row = rows[0];
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
router.post("/:student_id/reset-password", requireStaff, async (req, res, next) => {
  try {
    const password = generatePassword();
    const password_hash = hashPassword(password);
    const { rows } = await pool.query(
      `UPDATE intake_students SET password_hash = $1
        WHERE student_id = $2
        RETURNING student_id, username`,
      [password_hash, req.params.student_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "student not found" });
    res.json({ ...rows[0], password });
  } catch (e) {
    next(e);
  }
});

// GET /api/students — list all student accounts (admin sees everyone,
// counsellor sees only their own creations).
router.get("/", requireStaff, async (req, res, next) => {
  try {
    let sql = `
      SELECT s.student_id, s.username, s.display_name, s.intake_complete,
             s.lead_id, s.counsellor_id, s.created_at, s.updated_at,
             l.name AS lead_name,
             c.name AS counsellor_name,
             (SELECT COUNT(*) FROM intake_files     f WHERE f.student_id = s.student_id) AS file_count,
             (SELECT COUNT(*) FROM intake_resumes   r WHERE r.student_id = s.student_id) AS resume_count
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
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// GET /api/students/:student_id — full detail. Admin sees any; counsellor
// sees only their own creations. Returns the intake data + extractions
// + resumes for the admin "students panel" detail view.
router.get("/:student_id", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    const studentRes = await pool.query(
      `SELECT s.student_id, s.username, s.display_name, s.intake_complete,
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
    const extractionsRes = await pool.query(
      `SELECT id, file_id, extractor, model, status, data, confirmed_data,
              confirmed_at, error, cost_cents, created_at
         FROM intake_extractions WHERE student_id = $1
         ORDER BY created_at DESC`,
      [sid]
    );
    const resumesRes = await pool.query(
      `SELECT id, label, length_pages, length_words, style, domain,
              status, content_md, content_html, pdf_file_id,
              cost_cents, error, created_at, updated_at
         FROM intake_resumes WHERE student_id = $1
         ORDER BY created_at DESC`,
      [sid]
    );

    res.json({
      student,
      files: filesRes.rows,
      extractions: extractionsRes.rows,
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
    const { rows } = await pool.query(
      `SELECT student_id, intake_complete, data, updated_at
         FROM intake_students WHERE student_id = $1`,
      [req.user.studentId]
    );
    const row = rows[0];
    if (!row) {
      return res.json({
        studentId: req.user.studentId,
        intakeComplete: false,
        data: {},
      });
    }
    res.json({
      studentId: row.student_id,
      intakeComplete: row.intake_complete,
      data: row.data || {},
      updatedAt: row.updated_at,
    });
  } catch (e) {
    next(e);
  }
});

router.put("/me/record", requireStudent, express.json({ limit: "2mb" }), async (req, res, next) => {
  try {
    const { data, intakeComplete } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE intake_students
          SET data = $1::jsonb,
              intake_complete = $2,
              updated_at = NOW()
        WHERE student_id = $3
        RETURNING student_id, intake_complete, updated_at`,
      [JSON.stringify(data || {}), !!intakeComplete, req.user.studentId]
    );
    const row = rows[0];
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

// ============================================================
// FILE UPLOAD — student uploads a document. Multer disk storage,
// magic-byte recheck, FK row inserted, then auto-trigger extraction
// in the background and surface the extraction id so the client can
// poll /me/extractions/:id immediately.
// ============================================================

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(uploadsRoot, sanitizeForFs(req.user?.studentId || "anon"));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(12).toString("hex");
    const ext = path.extname(file.originalname) || "";
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

router.post("/me/upload", requireStudent, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const { fieldId, rowIndex, accept } = req.body;
    if (!fieldId) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "fieldId is required." });
    }
    const v = validateUploadedFile(req.file.path, accept || "application/pdf");
    if (!v.ok) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: v.error });
    }

    const studentId = req.user.studentId;
    const rowIdx = rowIndex != null && rowIndex !== "" ? Number(rowIndex) : null;

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
        [studentId, fieldId, rowIdx, req.file.originalname, req.file.path, req.file.size, v.actualType]
      );
      await client.query("COMMIT");
      const doc = ins.rows[0];

      let extraction = null;
      try {
        const sched = await scheduleExtraction({
          id: doc.id,
          student_id: studentId,
          field_id: fieldId,
          original_name: req.file.originalname,
          storage_path: req.file.path,
          mime_type: v.actualType,
        });
        if (sched.supported) {
          extraction = { id: sched.id, status: sched.status, extractor: sched.extractor };
        }
      } catch (e) {
        console.error("[upload] auto-extract schedule failed:", e);
      }

      res.json({
        fileId: String(doc.id),
        url: `/api/students/me/files/${doc.id}`,
        uploadedAt: doc.created_at.toISOString(),
        actualType: v.actualType,
        size: req.file.size,
        extraction,
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
    if (!fs.existsSync(doc.storage_path)) {
      return res.status(410).json({ error: "File missing on disk." });
    }
    res.set("Content-Type", doc.mime_type);
    res.set("Content-Length", String(doc.size));
    res.set(
      "Content-Disposition",
      `inline; filename="${path.basename(doc.original_name).replace(/"/g, "")}"`
    );
    fs.createReadStream(doc.storage_path).pipe(res);
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
    if (!fs.existsSync(doc.storage_path)) {
      return res.status(410).json({ error: "File missing on disk." });
    }
    res.set("Content-Type", doc.mime_type);
    res.set("Content-Length", String(doc.size));
    res.set(
      "Content-Disposition",
      `inline; filename="${path.basename(doc.original_name).replace(/"/g, "")}"`
    );
    fs.createReadStream(doc.storage_path).pipe(res);
  } catch (e) {
    next(e);
  }
});

// ============================================================
// EXTRACTIONS — student-side polling + confirm; staff-side read
// is via the /:student_id detail endpoint above.
// ============================================================

router.get("/me/extractions/:id", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { rows } = await pool.query(
      `SELECT id, file_id, student_id, extractor, model, status, data,
              confirmed_data, confirmed_at, error, cost_cents, created_at
         FROM intake_extractions WHERE id = $1`,
      [Number(req.params.id)]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not found" });
    if (row.student_id !== req.user.studentId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.json({
      id: String(row.id),
      fileId: String(row.file_id),
      extractor: row.extractor,
      model: row.model,
      status: row.status,
      data: row.data || null,
      confirmedData: row.confirmed_data || null,
      confirmedAt: row.confirmed_at,
      error: row.error,
      costCents: row.cost_cents,
      createdAt: row.created_at,
    });
  } catch (e) {
    next(e);
  }
});

router.get("/me/extractions", requireStudent, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.file_id, e.extractor, e.model, e.status,
              e.data, e.confirmed_data, e.confirmed_at, e.error, e.created_at,
              f.field_id, f.original_name
         FROM intake_extractions e
         JOIN intake_files f ON f.id = e.file_id
        WHERE e.student_id = $1
        ORDER BY e.created_at DESC`,
      [req.user.studentId]
    );
    res.json(
      rows.map((r) => ({
        id: String(r.id),
        fileId: String(r.file_id),
        fieldId: r.field_id,
        fileName: r.original_name,
        extractor: r.extractor,
        model: r.model,
        status: r.status,
        data: r.data || null,
        confirmedData: r.confirmed_data || null,
        confirmedAt: r.confirmed_at,
        error: r.error,
        createdAt: r.created_at,
      }))
    );
  } catch (e) {
    next(e);
  }
});

router.post("/me/extractions", requireStudent, express.json(), async (req, res, next) => {
  try {
    const { fileId } = req.body || {};
    if (!isPositiveInt(fileId)) return res.status(400).json({ error: "fileId required" });

    const { rows } = await pool.query(
      `SELECT id, student_id, field_id, original_name, storage_path, mime_type
         FROM intake_files WHERE id = $1`,
      [Number(fileId)]
    );
    const file = rows[0];
    if (!file) return res.status(404).json({ error: "file not found" });
    if (file.student_id !== req.user.studentId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const result = await scheduleExtraction(file);
    if (!result.supported) {
      return res.status(422).json({ error: `no extractor for field ${file.field_id}` });
    }
    res.json({
      id: result.id,
      status: result.status,
      fileId: String(file.id),
      extractor: result.extractor,
    });
  } catch (e) {
    next(e);
  }
});

router.put("/me/extractions/:id/confirm", requireStudent, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const { data } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE intake_extractions
          SET confirmed_data = $1::jsonb, confirmed_at = NOW()
        WHERE id = $2 AND student_id = $3
        RETURNING id, confirmed_at`,
      [JSON.stringify(data ?? null), Number(req.params.id), req.user.studentId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not found" });
    res.json({ id: String(row.id), confirmedAt: row.confirmed_at });
  } catch (e) {
    next(e);
  }
});

// Student changes their own password.
router.post("/me/change-password", requireStudent, express.json(), async (req, res, next) => {
  try {
    const { newPassword } = req.body || {};
    if (!isString(newPassword) || newPassword.length < 6 || newPassword.length > 100) {
      return res.status(400).json({ error: "password must be 6-100 chars" });
    }
    await pool.query(
      `UPDATE intake_students SET password_hash = $1 WHERE student_id = $2`,
      [hashPassword(newPassword), req.user.studentId]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
