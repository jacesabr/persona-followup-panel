import { audit } from "./audit.js";

// Express middleware that auto-writes intake_audit_log rows on
// state-changing 2xx responses. Avoids bloating every handler with
// inline audit() calls — the wiring/adversarial audits flagged that
// leads/tasks/counsellors routes had ZERO audit coverage despite
// being in production for months. This closes the hole in one place.
//
// Usage: app.use("/api/leads", requireAuth, autoAudit("leads"), leadsRouter);
//
// What it captures:
//   - actor_kind / actor_id / ip / user_agent (via the audit() helper)
//   - target_table = the `table` arg (e.g. "leads", "tasks", "counsellors")
//   - target_id    = response body's `id` field (best-effort) or req.params.id
//   - action       = method-derived ("create" / "update" / "archive" /
//                    "unarchive" / "delete") with route-suffix overrides
//                    (e.g. POST :id/archive → "archive")
//   - diff         = req.body summary (max 4 KB, password keys redacted)
//
// Skips:
//   - GETs (read-only)
//   - 3xx / 4xx / 5xx responses (we only log on success)
//
// Misses by design:
//   - Background async jobs (generator) — audit() is called directly
//     from those workers; this middleware only sees HTTP.
export function autoAudit(table) {
  return function autoAuditMw(req, res, next) {
    if (req.method === "GET") return next();

    // Snapshot the request body BEFORE handing off to the route. The
    // adversarial-on-change agent caught this: handlers routinely
    // mutate req.body (e.g. delete req.body.password after hashing,
    // splice out role-elevation fields, etc.). If we read req.body
    // inside the patched res.json (which fires AFTER the handler),
    // the audit log records the post-sanitised version — which is
    // exactly what hides a privilege-escalation attempt. Snapshot
    // here, scrub here, store the scrubbed snapshot for later.
    const bodySnapshot = scrubBody(req.body);

    const origJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      try {
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          const action = inferAction(req);
          const targetId =
            (body && (body.id ?? body.lead_id ?? body.task_id ?? body.appointment_id)) ||
            req.params?.id ||
            req.params?.leadId ||
            req.params?.apptId ||
            // Self-actions (POST /me/change-password, etc) have no id
            // in body or params — fall back to the actor's own id so
            // the audit row ties to a real subject instead of NULL.
            req.user?.counsellorId ||
            req.user?.studentId ||
            null;
          // Don't await — fire-and-forget. audit() itself swallows errors.
          audit(req, {
            table,
            id: targetId,
            action,
            diff: bodySnapshot,
          });
        }
      } catch (e) {
        // Never let an audit hiccup break the response.
        console.error("[autoAudit] failed:", e);
      }
      return origJson(body);
    };

    next();
  };
}

function inferAction(req) {
  // Route-suffix overrides take priority — most explicit.
  const path = req.route?.path || req.path || "";
  if (/\/archive(?:\b|$|\/)/.test(path)) return "archive";
  if (/\/unarchive(?:\b|$|\/)/.test(path)) return "unarchive";
  if (/\/reset-password(?:\b|$|\/)/.test(path)) return "reset_password";
  if (/\/change-password(?:\b|$|\/)/.test(path)) return "change_password";
  // Method-default fallback.
  if (req.method === "POST") return "create";
  if (req.method === "PATCH" || req.method === "PUT") return "update";
  if (req.method === "DELETE") return "delete";
  return req.method.toLowerCase();
}

function scrubBody(body) {
  if (!body || typeof body !== "object") return null;
  const SENSITIVE = new Set(["password", "explicitPassword", "newPassword", "password_hash"]);
  const cloned = JSON.parse(
    JSON.stringify(body, (key, value) =>
      SENSITIVE.has(key) ? "[redacted]" : value
    )
  );
  // Cap diff payload size — no point storing a 2 MB JSONB blob just
  // because someone PUT a giant intake.
  const json = JSON.stringify(cloned);
  if (json.length > 4096) {
    return { _truncated: true, _bytes: json.length, _preview: json.slice(0, 4000) };
  }
  return cloned;
}
