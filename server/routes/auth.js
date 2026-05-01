import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import pool from "../db.js";
import { COUNSELLOR_PUBLIC_COLUMNS } from "./counsellors.js";
import { hashPassword, isHashed, verifyHashed } from "../../lib/password.js";
import {
  SESSION_COOKIE_NAME,
  SLIDING_EXPIRY_DAYS,
  setSessionCookie,
  clearSessionCookie,
} from "../middleware/auth.js";

// Constant-time string compare. Used for the admin password check below
// so a timing attack can't leak whether the typed prefix matches.
function safeStrEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const router = express.Router();

// Admin credentials live in env vars only — server refuses to start
// (server/index.js) when ADMIN_USERNAME / ADMIN_PASSWORD are unset, so
// reading them once at module load is safe. Rotate by changing env +
// restarting; nothing in source.
const ADMIN_USER = process.env.ADMIN_USERNAME.toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

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
    if (u.toLowerCase() === ADMIN_USER && safeStrEqual(password, ADMIN_PASS)) {
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
    if (!row) {
      return res.status(401).json({ error: "Incorrect username or password" });
    }
    // New rows store scrypt hashes. Legacy rows pre-dating the hash
    // migration still hold plaintext; accept those once and upgrade in
    // place so the DB drains down to all-hashes over time. Both paths
    // use constant-time compare to avoid leaking match info via timing.
    let ok = false;
    if (isHashed(row.password)) {
      ok = verifyHashed(password, row.password);
    } else if (typeof row.password === "string") {
      ok = safeStrEqual(password, row.password);
      if (ok) {
        try {
          await pool.query(
            "UPDATE counsellors SET password = $1 WHERE id = $2",
            [hashPassword(password), row.id]
          );
        } catch (e) {
          console.error("[auth] password upgrade failed:", e);
          // Don't block login on the upgrade failure; the next login retries.
        }
      }
    }
    if (!ok) {
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

    // Refresh the cookie maxAge alongside the row's last_seen so a tab
    // that just polls /me keeps its browser-side cookie alive too —
    // matches the sliding-window behaviour that requireAuth provides
    // for protected routes.
    setSessionCookie(res, sid);

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
