import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";
import { COUNSELLOR_PUBLIC_COLUMNS } from "./counsellors.js";
import {
  SESSION_COOKIE_NAME,
  SLIDING_EXPIRY_DAYS,
  setSessionCookie,
  clearSessionCookie,
} from "../middleware/auth.js";

const router = express.Router();

// Trial-mode hardcoded admin creds. The counsellor table holds per-row
// usernames/passwords; admin is its own kind without a row. Move to env
// var when this leaves trial.
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";

// POST /api/auth/login — single endpoint that resolves admin vs counsellor
// based on the typed username. On success, INSERTs a session row, sets the
// httpOnly cookie, and returns the role + (for counsellors) the public
// counsellor fields. The cookie is the source of truth for subsequent
// requests; the response body is just enough for the client to render the
// right UI on first paint.
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password are required" });
    }
    const u = username.trim();

    // Admin path
    if (u.toLowerCase() === ADMIN_USER && password === ADMIN_PASS) {
      const sid = randomUUID();
      await pool.query(
        "INSERT INTO sessions (id, user_kind) VALUES ($1, 'admin')",
        [sid]
      );
      setSessionCookie(res, sid);
      return res.json({ user_kind: "admin" });
    }

    // Counsellor path — case-insensitive username lookup against the
    // (lowercased) stored value.
    const { rows } = await pool.query(
      `SELECT ${COUNSELLOR_PUBLIC_COLUMNS}, password
       FROM counsellors
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [u]
    );
    const row = rows[0];
    if (!row || row.password !== password) {
      return res.status(401).json({ error: "Incorrect username or password" });
    }

    const sid = randomUUID();
    await pool.query(
      "INSERT INTO sessions (id, user_kind, counsellor_id) VALUES ($1, 'counsellor', $2)",
      [sid, row.id]
    );
    setSessionCookie(res, sid);
    const { password: _pw, ...safe } = row;
    res.json({ user_kind: "counsellor", counsellor: safe });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/logout — delete the session row + clear the cookie.
// Tolerant of missing/unknown cookies so a stale browser tab can still
// "log out" cleanly.
router.post("/logout", async (req, res, next) => {
  try {
    const sid = req.cookies?.[SESSION_COOKIE_NAME];
    if (sid) {
      await pool.query("DELETE FROM sessions WHERE id = $1", [sid]);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/me — used by the client on first load to learn whether
// the current cookie still maps to a valid session, and what role it is.
// Returns 401 (and clears the cookie) if expired/missing.
router.get("/me", async (req, res, next) => {
  try {
    const sid = req.cookies?.[SESSION_COOKIE_NAME];
    if (!sid) return res.status(401).json({ error: "not authenticated" });
    const { rows } = await pool.query(
      `SELECT s.user_kind, s.counsellor_id,
              c.id AS c_id, c.name AS c_name, c.username AS c_username
       FROM sessions s
       LEFT JOIN counsellors c ON c.id = s.counsellor_id
       WHERE s.id = $1
         AND s.last_seen_at > NOW() - $2::interval`,
      [sid, `${SLIDING_EXPIRY_DAYS} days`]
    );
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "session expired" });
    }
    // Bump last_seen_at on /me too so a tab that just sits open keeps
    // its session alive without ever needing to mutate data.
    pool
      .query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [sid])
      .catch((e) => console.error("[auth] last_seen update failed:", e));

    const r = rows[0];
    if (r.user_kind === "admin") return res.json({ user_kind: "admin" });
    return res.json({
      user_kind: "counsellor",
      counsellor: { id: r.c_id, name: r.c_name, username: r.c_username },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
