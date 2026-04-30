import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";

const router = express.Router();

const isString = (v) => typeof v === "string";

function validateCounsellorInput(body, { requireCreds = false } = {}) {
  const { name, whatsapp, email, username, password } = body;
  if (!isString(name) || name.trim().length < 1 || name.length > 200) {
    return "name must be a non-empty string up to 200 chars";
  }
  if (whatsapp !== undefined && whatsapp !== null && whatsapp !== "") {
    if (!isString(whatsapp) || !/^\d{8,15}$/.test(whatsapp)) {
      return "whatsapp must be digits only, 8-15 chars";
    }
  }
  if (email !== undefined && email !== null && email !== "") {
    if (!isString(email) || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return "email must be a valid email address (max 320 chars)";
    }
  }
  // Counsellor must be reachable on at least one channel; otherwise the
  // notify path silently no-ops for them.
  const hasWa = !!(whatsapp && whatsapp !== "");
  const hasEmail = !!(email && email !== "");
  if (!hasWa && !hasEmail) {
    return "at least one of whatsapp or email is required";
  }
  // Login creds. Required on POST so a counsellor is always login-able;
  // optional on PATCH (admin may only change name/contact).
  if (requireCreds) {
    if (!isString(username) || username.trim().length < 1 || username.length > 50) {
      return "username must be a non-empty string up to 50 chars";
    }
    if (!isString(password) || password.length < 1 || password.length > 100) {
      return "password must be a non-empty string up to 100 chars";
    }
  } else {
    if (username !== undefined && username !== null && username !== "") {
      if (!isString(username) || username.length > 50) {
        return "username must be a string up to 50 chars";
      }
    }
    if (password !== undefined && password !== null && password !== "") {
      if (!isString(password) || password.length > 100) {
        return "password must be a string up to 100 chars";
      }
    }
  }
  return null;
}

// Explicit column list to keep `password` out of the wire response.
// The login flow goes through POST /api/auth/login instead; nothing on
// the client should ever see another counsellor's password.
const PUBLIC_COLUMNS =
  "id, name, whatsapp, email, username, created_at";

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM counsellors ORDER BY name ASC`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const validationError = validateCounsellorInput(req.body, { requireCreds: true });
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
        [id, cleanName, cleanWa, cleanEmail, cleanUsername, password]
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
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = ["name", "whatsapp", "email", "username", "password"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: "no valid fields to update" });

    const validationError = validateCounsellorInput(
      // Merge with any unsupplied existing fields for the "at least one
      // contact channel" check. Pull current row first.
      req.body,
      { requireCreds: false }
    );
    // We don't apply the validator wholesale because PATCH may only touch
    // creds without name/contact present. Skip channel-presence enforcement
    // here — it ran on the original POST.
    if (validationError && !validationError.startsWith("at least one of")) {
      return res.status(400).json({ error: validationError });
    }

    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => {
      const v = req.body[f];
      if (f === "name" && typeof v === "string") return v.trim();
      if (f === "email" && typeof v === "string") return v.trim().toLowerCase() || null;
      // Lowercase usernames here too — same case-collision reason as POST.
      if (f === "username" && typeof v === "string") return v.trim().toLowerCase() || null;
      if (f === "whatsapp") return v || null;
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
