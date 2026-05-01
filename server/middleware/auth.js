import pool from "../db.js";

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
// users. Sets req.user = { kind, counsellorId? } for downstream handlers.
export async function requireAuth(req, res, next) {
  try {
    const sid = req.cookies?.[SESSION_COOKIE_NAME];
    if (!sid) return res.status(401).json({ error: "not authenticated" });

    const { rows } = await pool.query(
      `SELECT id, user_kind, counsellor_id
       FROM sessions
       WHERE id = $1
         AND last_seen_at > NOW() - $2::interval`,
      [sid, `${SLIDING_EXPIRY_DAYS} days`]
    );
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "session expired or invalid" });
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
      kind: rows[0].user_kind,
      counsellorId: rows[0].counsellor_id,
    };
    next();
  } catch (e) {
    next(e);
  }
}

export function setSessionCookie(res, sid) {
  res.cookie(SESSION_COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "strict",
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
    sameSite: "strict",
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
