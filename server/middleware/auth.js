import pool from "../db.js";
import { adminUsernameSet } from "../admins.js";

// Cookie name + sliding-expiry window. Both used by:
//   - the /api/auth route handlers (set on login, clear on logout)
//   - the requireAuth middleware (read on every protected request)
// Kept in this single file so a future change (e.g. doubling the
// expiry, or renaming the cookie) only touches one place.
export const SESSION_COOKIE_NAME = "persona_session";
export const SLIDING_EXPIRY_DAYS = 30;
const SLIDING_EXPIRY_MS = SLIDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

// requireAuth — looks up the session row for the cookie's UUID, rejects
// with 401 on missing / expired / unknown. Updates last_seen_at as a
// fire-and-forget so the sliding window keeps refreshing for active
// users. Sets req.user = { kind, counsellorId?, adminUsername?, studentId? }.
//
// Identity hardening (post-audit):
//   - admin sessions: admin_username must still be in the live admin set
//     (EXTRA_ADMINS edits propagate immediately; revoked admins lose
//     access even if their cookie hasn't expired).
//   - counsellor sessions: a stale session whose counsellor row was
//     deleted is rejected (LEFT JOIN c.id IS NULL).
export async function requireAuth(req, res, next) {
  try {
    const sid = req.cookies?.[SESSION_COOKIE_NAME];
    if (!sid) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "not authenticated" });
    }

    // Two-axis expiry: (a) sliding window via last_seen_at and (b) hard
    // upper bound via created_at + max_age_days. (b) means a leaked
    // cookie can't survive forever just by being kept warm — even a
    // continuously-active attacker hits the absolute wall.
    const { rows } = await pool.query(
      `SELECT s.id, s.user_kind, s.counsellor_id, s.student_id, s.admin_username,
              c.id AS c_exists,
              st.student_id AS st_exists
       FROM sessions s
       LEFT JOIN counsellors    c  ON c.id          = s.counsellor_id
       LEFT JOIN intake_students st ON st.student_id = s.student_id
       WHERE s.id = $1
         AND s.last_seen_at > NOW() - $2::interval
         AND s.created_at   > NOW() - (s.max_age_days::text || ' days')::interval`,
      [sid, `${SLIDING_EXPIRY_DAYS} days`]
    );
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "session expired or invalid" });
    }
    const r = rows[0];

    // Identity-still-valid checks. A row may exist but the underlying
    // identity has been revoked/deleted since the cookie was issued.
    if (r.user_kind === "admin") {
      if (!r.admin_username || !adminUsernameSet().has(r.admin_username)) {
        clearSessionCookie(res);
        return res.status(401).json({ error: "session no longer valid" });
      }
    } else if (r.user_kind === "counsellor") {
      if (!r.counsellor_id || !r.c_exists) {
        clearSessionCookie(res);
        return res.status(401).json({ error: "session no longer valid" });
      }
    } else if (r.user_kind === "student") {
      if (!r.student_id || !r.st_exists) {
        clearSessionCookie(res);
        return res.status(401).json({ error: "session no longer valid" });
      }
    }

    // Sliding window: bump last_seen_at without blocking the request.
    pool
      .query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [sid])
      .catch((e) => console.error("[auth] last_seen update failed:", e));

    // Re-issue the cookie with a fresh maxAge. Without this, the browser
    // drops the cookie 30 days after the *initial login* even if the user
    // is active — server thinks the session is fresh, browser disagrees.
    // Setting it on every protected request makes the 30-day window
    // genuinely sliding from the client's perspective too.
    setSessionCookie(res, sid);

    req.user = {
      kind: r.user_kind,
      counsellorId: r.counsellor_id,
      studentId: r.student_id,
      adminUsername: r.admin_username || null,
    };
    next();
  } catch (e) {
    next(e);
  }
}

// sameSite: "lax" — strict blocks the cookie on top-level cross-site
// navigation, so an emailed deep-link lands users on the login screen
// even when they're "logged in". Lax keeps the SPA experience working
// while still blocking cross-site form-POST CSRF (the only meaningful
// vector for a session cookie on a same-origin API).
export function setSessionCookie(res, sid) {
  res.cookie(SESSION_COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "lax",
    // secure=true means HTTPS-only — required in production. In dev (vite
    // proxy on http://localhost) we keep it false so the browser actually
    // stores the cookie.
    secure: process.env.NODE_ENV === "production",
    maxAge: SLIDING_EXPIRY_MS,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

// requireAdmin — gate routes that should be admin-only (creating /
// editing counsellor accounts, etc). Must be chained AFTER requireAuth
// so req.user is populated.
export function requireAdmin(req, res, next) {
  if (req.user?.kind !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }
  next();
}

// requireStaff — admin OR counsellor. Used by the routes that staff
// (either role) hit on a student's behalf, e.g. POST /api/students
// (sign a lead up as a student).
export function requireStaff(req, res, next) {
  const k = req.user?.kind;
  if (k !== "admin" && k !== "counsellor") {
    return res.status(403).json({ error: "staff only" });
  }
  next();
}

// requireStudent — gate the intake routes so only an authenticated
// student session can hit them. Populates req.user.studentId by the
// time it returns.
export function requireStudent(req, res, next) {
  if (req.user?.kind !== "student" || !req.user?.studentId) {
    return res.status(403).json({ error: "student only" });
  }
  next();
}
