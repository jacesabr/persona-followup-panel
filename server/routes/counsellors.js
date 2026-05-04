import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";
import { hashPassword } from "../../lib/password.js";
import { requireAdmin } from "../middleware/auth.js";

const router = express.Router();

const isString = (v) => typeof v === "string";

// Same denylist used in students.js — drawn from rockyou top-50
// filtered to >=6 chars, plus admin/test/changeme variants. Counsellor
// accounts shouldn't be the cheapest backdoor in the system.
const COUNSELLOR_WEAK_PASSWORDS = new Set([
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

// Validate any subset of counsellor fields. mode = "create" requires name,
// at-least-one channel (whatsapp/email), username, and password. mode =
// "patch" only validates the fields that ARE present, since admin may
// reset just the password without touching anything else.
function validateCounsellorInput(body, { mode = "create" } = {}) {
  const { name, whatsapp, email, username, password } = body;
  const isCreate = mode === "create";

  if (isCreate || name !== undefined) {
    if (!isString(name) || name.trim().length < 1 || name.length > 200) {
      return "name must be a non-empty string up to 200 chars";
    }
  }
  if (whatsapp) {
    if (!isString(whatsapp) || !/^\d{8,15}$/.test(whatsapp)) {
      return "whatsapp must be digits only, 8-15 chars";
    }
  }
  if (email) {
    if (!isString(email) || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return "email must be a valid email address (max 320 chars)";
    }
  }
  // Counsellor must be reachable on at least one channel — but only
  // enforced on create. On PATCH we'd need to merge with the existing
  // row to know the effective state; the controller does that.
  if (isCreate) {
    const hasWa = !!(whatsapp && whatsapp !== "");
    const hasEmail = !!(email && email !== "");
    if (!hasWa && !hasEmail) {
      return "at least one of whatsapp or email is required";
    }
  }
  if (isCreate || username !== undefined) {
    if (isCreate) {
      if (!isString(username) || username.trim().length < 1 || username.length > 50) {
        return "username must be a non-empty string up to 50 chars";
      }
    } else if (username !== null && username !== "") {
      if (!isString(username) || username.length > 50) {
        return "username must be a string up to 50 chars";
      }
    }
  }
  if (isCreate || password !== undefined) {
    if (isCreate) {
      if (!isString(password) || password.length < 6 || password.length > 100) {
        // 6-char floor matches the student-create path. Counsellors have
        // strictly more access than students; the prior floor (length<1
        // — typo'd from <6) let admin provision a counsellor with
        // password "a" and the adversarial walkthrough confirmed login
        // worked end-to-end. Defence in depth.
        return "password must be 6-100 characters";
      }
      if (COUNSELLOR_WEAK_PASSWORDS.has(password.toLowerCase())) {
        return "password is too common; pick something else";
      }
    } else if (password !== null && password !== "") {
      if (!isString(password) || password.length < 6 || password.length > 100) {
        return "password must be 6-100 characters";
      }
      if (COUNSELLOR_WEAK_PASSWORDS.has(password.toLowerCase())) {
        return "password is too common; pick something else";
      }
    }
  }
  return null;
}

// Explicit column list to keep `password` out of the wire response.
// The login flow goes through POST /api/auth/login instead; nothing on
// the client should ever see another counsellor's password. Exported
// so server/routes/auth.js can reuse the same allow-list — preventing
// drift where one endpoint leaks a column the other hides.
export const COUNSELLOR_PUBLIC_COLUMNS =
  "id, name, whatsapp, email, username, created_at";
const PUBLIC_COLUMNS = COUNSELLOR_PUBLIC_COLUMNS;

// GET /api/counsellors — admin sees the full roster (used by the
// counsellors tab + the assignee dropdown). Counsellor sessions only
// need their own row (for the impersonation-banner name lookup paths
// in App.jsx, and the lead-counsellor name map — both are self-only
// for a counsellor view), so the response is server-scoped to prevent
// other counsellors' contact details from leaking via devtools.
router.get("/", async (req, res, next) => {
  try {
    let sql, params;
    const kind = req.user?.kind;
    if (kind === "counsellor") {
      sql = `SELECT ${PUBLIC_COLUMNS} FROM counsellors WHERE id = $1 ORDER BY name ASC`;
      params = [req.user.counsellorId];
    } else if (kind === "admin") {
      sql = `SELECT ${PUBLIC_COLUMNS} FROM counsellors ORDER BY name ASC`;
      params = [];
    } else {
      // Students (and any other future role) get an empty list. The
      // counsellor roster is staff-only PII (phone, email) — without
      // this gate, the App.jsx-level fetch on every authenticated
      // session was leaking the full directory to every logged-in
      // student. Server-side defense in depth.
      return res.json([]);
    }
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Mutations are admin-only. Without this gate, any authenticated
// counsellor could create new counsellor rows or reset another
// counsellor's password — the auth middleware confirms a session but
// doesn't distinguish role, and the wire client never sent these
// requests from a counsellor view, so the gap was previously unprobed.
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const validationError = validateCounsellorInput(req.body, { mode: "create" });
    if (validationError) return res.status(400).json({ error: validationError });

    const { name, whatsapp, email, username, password } = req.body;
    const id = "c" + randomUUID().replace(/-/g, "").slice(0, 10);
    const cleanName = name.trim();
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    const cleanWa = whatsapp ? whatsapp : null;
    // Lowercase usernames so login matching is case-insensitive at the DB
    // level — avoids the case where "C1" and "c1" become two distinct
    // accounts and the login form non-deterministically picks one.
    const cleanUsername = username.trim().toLowerCase();

    try {
      const { rows } = await pool.query(
        `INSERT INTO counsellors (id, name, whatsapp, email, username, password)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PUBLIC_COLUMNS}`,
        [id, cleanName, cleanWa, cleanEmail, cleanUsername, hashPassword(password)]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      // Postgres unique_violation on username
      if (e.code === "23505") {
        return res.status(409).json({ error: "username already taken" });
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

// PATCH /api/counsellors/:id — admin-only edits to name/contact/creds.
// Existing notify routing keys off the FK, not the username, so renames
// are safe.
router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = ["name", "whatsapp", "email", "username", "password"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: "no valid fields to update" });

    const validationError = validateCounsellorInput(req.body, { mode: "patch" });
    if (validationError) return res.status(400).json({ error: validationError });

    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => {
      const v = req.body[f];
      if (f === "name" && typeof v === "string") return v.trim();
      if (f === "email" && typeof v === "string") return v.trim().toLowerCase() || null;
      // Lowercase usernames here too — same case-collision reason as POST.
      if (f === "username" && typeof v === "string") return v.trim().toLowerCase() || null;
      if (f === "whatsapp") return v || null;
      // Hash on write so the DB never holds plaintext. Empty patch values
      // are blocked by validateCounsellorInput above.
      if (f === "password" && typeof v === "string") return hashPassword(v);
      return v;
    })];

    try {
      const { rows } = await pool.query(
        `UPDATE counsellors SET ${set} WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "counsellor not found" });
      res.json(rows[0]);
    } catch (e) {
      if (e.code === "23505") {
        return res.status(409).json({ error: "username already taken" });
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

export default router;
