import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import pool from "../db.js";
import { COUNSELLOR_PUBLIC_COLUMNS } from "./counsellors.js";
import { hashPassword, isHashed, verifyHashed } from "../../lib/password.js";
import { audit } from "../audit.js";

// Static dummy scrypt hash used to equalize timing on the no-such-user
// path. We always run a verifyHashed (~50ms) before responding 401, so
// "username doesn't exist" and "username exists, wrong password" take
// indistinguishable wall-clock time. The hash is for the literal string
// "dummy" — irrelevant; only the hash math matters.
const DUMMY_HASH = hashPassword("dummy_password_for_timing_equalization");
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

// Student login path — tried after the counsellor lookup misses on the
// typed username. intake_students stores password_hash via the same
// scrypt scheme as counsellors. Returns { matched, respond } so the
// caller can decide whether to fall through to a 401.
async function tryStudentLogin(username, password, res) {
  const { rows } = await pool.query(
    `SELECT student_id, username, password_hash, display_name, intake_complete
       FROM intake_students
      WHERE LOWER(username) = LOWER($1)
        AND username IS NOT NULL
      LIMIT 1`,
    [username]
  );
  const s = rows[0];
  if (!s || !s.password_hash) return { matched: false };

  const ok = verifyHashed(password, s.password_hash);
  if (!ok) {
    // Username exists but password wrong — return as "matched" so the
    // outer handler responds 401 (instead of falling through and
    // possibly leaking that the username matched something).
    return {
      matched: true,
      respond: () =>
        res.status(401).json({ error: "Incorrect username or password" }),
    };
  }

  const sid = randomUUID();
  await pool.query(
    "INSERT INTO sessions (id, user_kind, student_id) VALUES ($1, 'student', $2)",
    [sid, s.student_id]
  );
  setSessionCookie(res, sid);
  audit({ user: { kind: "student", studentId: s.student_id } }, {
    table: "sessions", id: sid, action: "login", notes: `student:${s.username}`
  });
  return {
    matched: true,
    respond: () =>
      res.json({
        user_kind: "student",
        student: {
          student_id: s.student_id,
          username: s.username,
          display_name: s.display_name,
          intake_complete: !!s.intake_complete,
        },
      }),
  };
}

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
      audit({ ip: req.ip, headers: req.headers, user: { kind: "admin" } }, {
        table: "sessions", id: sid, action: "login", notes: "admin"
      });
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
      // Try student path before failing.
      const studentResult = await tryStudentLogin(u, password, res);
      if (studentResult.matched) return studentResult.respond();
      // No counsellor and no student — burn one scrypt verify so the
      // timing matches the wrong-password path, defeating username
      // enumeration via response-time observation.
      verifyHashed(password, DUMMY_HASH);
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
    audit({ ip: req.ip, headers: req.headers, user: { kind: "counsellor", counsellorId: row.id } }, {
      table: "sessions", id: sid, action: "login", notes: `counsellor:${row.username}`
    });
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
      audit(req, { table: "sessions", id: sid, action: "logout" });
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
      `SELECT s.user_kind, s.counsellor_id, s.student_id,
              c.id AS c_id, c.name AS c_name, c.username AS c_username,
              st.username AS s_username, st.display_name AS s_display_name,
              st.intake_complete AS s_intake_complete
       FROM sessions s
       LEFT JOIN counsellors c     ON c.id          = s.counsellor_id
       LEFT JOIN intake_students st ON st.student_id = s.student_id
       WHERE s.id = $1
         AND s.last_seen_at > NOW() - $2::interval
         AND s.created_at   > NOW() - (s.max_age_days::text || ' days')::interval`,
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
    if (r.user_kind === "student") {
      return res.json({
        user_kind: "student",
        student: {
          student_id: r.student_id,
          username: r.s_username,
          display_name: r.s_display_name,
          intake_complete: !!r.s_intake_complete,
        },
      });
    }
    return res.json({
      user_kind: "counsellor",
      counsellor: { id: r.c_id, name: r.c_name, username: r.c_username },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
