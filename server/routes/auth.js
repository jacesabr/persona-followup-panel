import express from "express";
import pool from "../db.js";

const router = express.Router();

// Same allowlist used by counsellors.js — keeps the password column out
// of every wire response, including this one.
const PUBLIC_COLUMNS = "id, name, whatsapp, email, username, created_at";

// POST /api/auth/login — trial-mode plaintext credential check. Returns
// the counsellor row (sans password) on success, 401 on failure. The
// frontend stores the returned row's id in sessionStorage as the active
// counsellorId; nothing about the password leaves the server.
//
// Username compare is case-insensitive: usernames are stored lowercased
// (counsellors POST/PATCH normalize), but accept any case here so users
// don't have to remember exact casing.
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password are required" });
    }
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_COLUMNS}, password
       FROM counsellors
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [username.trim()]
    );
    const row = rows[0];
    if (!row || row.password !== password) {
      return res.status(401).json({ error: "Incorrect username or password" });
    }
    // Strip password before returning.
    const { password: _pw, ...safe } = row;
    res.json(safe);
  } catch (e) {
    next(e);
  }
});

export default router;
