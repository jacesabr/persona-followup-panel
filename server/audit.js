import pool from "./db.js";

// Append-only write to intake_audit_log. Fire-and-forget — caller
// awaits only when ordering matters (test fixtures); the common path
// just logs and moves on so a slow/failing audit doesn't block user
// requests. Failures go to stderr and stay there.
//
// Required: target_table + action.
// Optional: actor info (kind, id, ip, ua), target_id, diff, notes.
//
// `req` is the Express request — convenient way to populate actor +
// ip/ua in one shot. Pass `null` (or leave undefined) for system-
// initiated events (boot sweepers, cron jobs, migrations).
export function audit(req, { table, id = null, action, diff = null, notes = null }) {
  const actor = pickActor(req);
  return pool
    .query(
      `INSERT INTO intake_audit_log
         (actor_kind, actor_id, ip, user_agent, target_table, target_id, action, diff, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        actor.kind,
        actor.id,
        actor.ip,
        actor.ua,
        table,
        id != null ? String(id) : null,
        action,
        diff ? JSON.stringify(diff) : null,
        notes,
      ]
    )
    .catch((e) => {
      // Audit failures must not block business logic. Log loud + carry on.
      console.error("[audit] write failed:", e.message, { table, action });
    });
}

function pickActor(req) {
  if (!req) return { kind: "system", id: null, ip: null, ua: null };
  const u = req.user || {};
  const ip = (req.headers?.["x-forwarded-for"] || req.ip || "")
    .toString()
    .split(",")[0]
    .trim() || null;
  const ua = (req.headers?.["user-agent"] || "").toString().slice(0, 500) || null;
  if (u.kind === "admin") return { kind: "admin", id: null, ip, ua };
  if (u.kind === "counsellor") return { kind: "counsellor", id: u.counsellorId || null, ip, ua };
  if (u.kind === "student") return { kind: "student", id: u.studentId || null, ip, ua };
  return { kind: "anonymous", id: null, ip, ua };
}
