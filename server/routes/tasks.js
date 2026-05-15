import express from "express";
import pool from "../db.js";
import { isValidYmd } from "../../lib/time.js";
import { adminUsernameSet } from "../admins.js";
import { getStorage } from "../storage.js";

const router = express.Router();

// Append-only R2 backup for every task mutation. Fire-and-forget —
// a storage hiccup must never block the API response.
async function backupTaskEvent(event, payload) {
  try {
    const storage = getStorage();
    const taskId = payload.id ?? payload.task_id ?? "unknown";
    const key = `tasks/${taskId}/${event}-${Date.now()}.json`;
    await storage.putBlob({
      key,
      body: Buffer.from(JSON.stringify({ event, payload, timestamp: new Date().toISOString() })),
      contentType: "application/json",
    });
  } catch (e) {
    console.error("[backup] task event failed:", e.message);
  }
}

function isString(v) {
  return typeof v === "string";
}

// Per-task ownership gate. Returns the task row on success, null on failure
// (caller should return immediately when null). 404 instead of 403 so
// a probe can't distinguish "not yours" from "doesn't exist".
//
// Access rules (counsellor session):
//   - listed in counsellor_task_assignees, OR
//   - supervises any of the assignees, OR
//   - owns the lead, OR
//   - is the creator.
// Admin always passes.
async function checkTaskAccess(req, res, taskId) {
  if (!/^\d+$/.test(String(taskId))) {
    res.status(400).json({ error: "invalid task id" });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT t.assignee_id, t.assignee_kind, t.assignee_admin_username,
            t.creator_id, t.creator_kind,
            l.counsellor_id AS lead_counsellor_id
     FROM counsellor_tasks t
     LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.id = $1`,
    [taskId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "task not found" });
    return null;
  }
  if (req.user?.kind === "admin") return rows[0];

  const me = req.user?.counsellorId;
  const t = rows[0];

  // Same-row checks first to avoid the junction lookup on the common case.
  if (t.lead_counsellor_id === me || t.creator_id === me) return t;

  // Junction-table check: am I an assignee, or do I supervise one?
  const { rows: ja } = await pool.query(
    `SELECT 1 FROM counsellor_task_assignees ja
      WHERE ja.task_id = $1
        AND (ja.counsellor_id = $2
             OR ja.counsellor_id IN (SELECT id FROM counsellors WHERE supervisor_id = $2))
      LIMIT 1`,
    [taskId, me]
  );
  if (ja.length > 0) return t;

  res.status(404).json({ error: "task not found" });
  return null;
}

// Normalize a single client-supplied assignee descriptor into the
// canonical { kind, counsellor_id, admin_username } shape we insert
// into counsellor_task_assignees. Returns { ok, error?, kind, counsellor_id, admin_username }.
function normalizeAssignee(a) {
  if (!a || typeof a !== "object") return { ok: false, error: "assignee must be an object" };
  const kind = a.kind;
  if (kind !== "counsellor" && kind !== "admin") {
    return { ok: false, error: "assignee.kind must be 'counsellor' or 'admin'" };
  }
  if (kind === "counsellor") {
    const cid = a.counsellor_id;
    if (!isString(cid) || cid.trim().length === 0 || cid.length > 50) {
      return { ok: false, error: "counsellor assignee needs a counsellor_id string up to 50 chars" };
    }
    return { ok: true, kind: "counsellor", counsellor_id: cid, admin_username: null };
  }
  // kind === 'admin'
  const u = a.admin_username;
  if (!isString(u) || u.trim().length === 0 || u.length > 100) {
    return { ok: false, error: "admin assignee needs an admin_username string" };
  }
  return { ok: true, kind: "admin", counsellor_id: null, admin_username: String(u).toLowerCase().trim() };
}

// Parse + validate the `assignees` array from a create/patch body. If
// the legacy single-assignee fields are passed instead, synthesize an
// array with one element so downstream insertion is uniform.
function parseAssigneesPayload(body) {
  if (Array.isArray(body.assignees) && body.assignees.length > 0) {
    const out = [];
    const seen = new Set();
    for (const raw of body.assignees) {
      const n = normalizeAssignee(raw);
      if (!n.ok) return { ok: false, error: n.error };
      // Dedupe on the wire — a buggy client double-adding the same
      // person would otherwise trip the UNIQUE INDEX with a 23505.
      const key = `${n.kind}|${n.counsellor_id || ""}|${n.admin_username || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    if (out.length === 0) return { ok: false, error: "assignees array must have at least one valid entry" };
    if (out.length > 10) return { ok: false, error: "max 10 assignees per task" };
    return { ok: true, assignees: out };
  }
  // Legacy single-assignee path.
  if (body.assignee_admin_username) {
    const n = normalizeAssignee({ kind: "admin", admin_username: body.assignee_admin_username });
    if (!n.ok) return { ok: false, error: n.error };
    return { ok: true, assignees: [n] };
  }
  if (body.assignee_id) {
    const n = normalizeAssignee({ kind: "counsellor", counsellor_id: body.assignee_id });
    if (!n.ok) return { ok: false, error: n.error };
    return { ok: true, assignees: [n] };
  }
  return { ok: true, assignees: [] };
}

// Joined SELECT reused after every mutation. Includes assignee_kind,
// assignee_admin_username, creator_admin_username and the latest
// comment's author_admin_username so the client can attribute a task /
// comment to a specific named admin (mirror groups put multiple admins
// in the same inbox — without this the UI flattens them all to "Admin").
//
// The `assignees` JSON aggregate carries the full multi-assignee list
// from counsellor_task_assignees. Legacy assignee_id /
// assignee_admin_username fields stay populated with the FIRST assignee
// for back-compat readers that haven't been updated yet.
const SELECT_JOINED = `
  SELECT t.*,
         l.name AS lead_name,
         l.archived AS student_archived,
         c.name AS assignee_name,
         la.scheduled_for AS appointment_scheduled_for,
         (SELECT COUNT(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count,
         lc.body       AS latest_comment_body,
         lc.created_at AS latest_comment_at,
         lc.author_kind AS latest_comment_author_kind,
         lc.author_name AS latest_comment_author_name,
         lc.author_admin_username AS latest_comment_author_admin_username,
         COALESCE(ja_agg.assignees, '[]'::json) AS assignees
  FROM counsellor_tasks t
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN counsellors c ON c.id = t.assignee_id
  LEFT JOIN lead_appointments la ON la.id = t.appointment_id
  LEFT JOIN LATERAL (
    SELECT tc.body, tc.created_at, tc.author_kind, tc.author_admin_username,
           ac.name AS author_name
    FROM task_comments tc
    LEFT JOIN counsellors ac ON ac.id = tc.author_counsellor_id
    WHERE tc.task_id = t.id
    ORDER BY tc.created_at DESC
    LIMIT 1
  ) lc ON TRUE
  LEFT JOIN LATERAL (
    SELECT json_agg(
      json_build_object(
        'kind', ja.assignee_kind,
        'counsellor_id', ja.counsellor_id,
        'admin_username', ja.admin_username,
        'name', CASE WHEN ja.assignee_kind = 'counsellor' THEN ja_c.name ELSE ja.admin_username END
      ) ORDER BY ja.id
    ) AS assignees
    FROM counsellor_task_assignees ja
    LEFT JOIN counsellors ja_c ON ja_c.id = ja.counsellor_id
    WHERE ja.task_id = t.id
  ) ja_agg ON TRUE
`;

// GET /api/tasks
// Admin: all tasks (counsellor-assigned + admin-assigned).
// Counsellor: tasks where they are the assignee, the lead owner, OR a
//   direct supervisor of the assignee — PLUS admin-assigned tasks they
//   themselves created.
router.get("/", async (req, res, next) => {
  try {
    const includeArchived = req.query.include_archived === "true";
    const conds = [];
    const params = [];
    if (!includeArchived) conds.push("t.archived = FALSE");
    if (req.user?.kind === "counsellor") {
      params.push(req.user.counsellorId);
      const i = `$${params.length}`;
      // Counsellor can see a task if ANY of:
      //   - they are listed as an assignee in counsellor_task_assignees
      //     (covers self-assigned + multi-assigned tasks)
      //   - they supervise an assignee
      //   - they own the lead the task is attached to
      //   - they created the task (covers tasks they raised for admins
      //     or for supervised counsellors)
      conds.push(`(
        EXISTS (
          SELECT 1 FROM counsellor_task_assignees ja
           WHERE ja.task_id = t.id
             AND (
               ja.counsellor_id = ${i}
               OR ja.counsellor_id IN (SELECT id FROM counsellors WHERE supervisor_id = ${i})
             )
        )
        OR l.counsellor_id = ${i}
        OR t.creator_id = ${i}
      )`);
    }
    if (req.query.appointment_id !== undefined) {
      const apptId = String(req.query.appointment_id);
      if (!/^\d+$/.test(apptId)) {
        return res.status(400).json({ error: "appointment_id must be a positive integer" });
      }
      params.push(apptId);
      conds.push(`t.appointment_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `${SELECT_JOINED} ${where}
       ORDER BY t.priority DESC, t.due_date ASC, t.id ASC`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks
// Multi-assignee. Body accepts either:
//   - `assignees`: [{kind: 'counsellor', counsellor_id}, {kind: 'admin', admin_username}, ...]
//   - OR the legacy single-assignee fields (`assignee_id` / `assignee_admin_username`)
//     which are synthesized into a 1-element assignees array.
//
// Permission scope per assignee:
//   admin session       — any counsellor + any named admin
//   counsellor session  — self + counsellors they supervise + own supervisor
//                         + any named admin
//
// Legacy columns (counsellor_tasks.assignee_id / assignee_kind /
// assignee_admin_username) are populated from the FIRST assignee so
// older readers (display columns, group-by keys) stay coherent until
// every call site reads the junction directly.
router.post("/", async (req, res, next) => {
  try {
    let { lead_id, student_name, text, due_date, priority, appointment_id } = req.body;

    if (
      (lead_id == null || lead_id === "") &&
      (student_name == null || student_name === "")
    ) {
      return res.status(400).json({ error: "lead_id or student_name is required" });
    }
    if (lead_id && (!isString(lead_id) || lead_id.length > 50)) {
      return res.status(400).json({ error: "lead_id must be a string up to 50 chars" });
    }
    if (student_name && (!isString(student_name) || student_name.length > 200)) {
      return res.status(400).json({ error: "student_name must be a string up to 200 chars" });
    }
    if (!isString(text) || text.trim().length < 1 || text.length > 1000) {
      return res.status(400).json({ error: "text must be 1–1000 chars" });
    }
    if (!isValidYmd(due_date)) {
      return res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" });
    }

    // Parse + dedupe assignees off the wire.
    const parsed = parseAssigneesPayload(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    let assignees = parsed.assignees;

    let creatorId = null;
    let creatorKind = "counsellor";
    let creatorAdminUsername = null;

    if (req.user?.kind === "counsellor") {
      creatorId = req.user.counsellorId;
      creatorKind = "counsellor";

      // Default to a self-only assignment if nothing was sent.
      if (assignees.length === 0) {
        assignees = [{ kind: "counsellor", counsellor_id: req.user.counsellorId, admin_username: null }];
      }

      // Validate each assignee is in the counsellor's permitted scope.
      for (const a of assignees) {
        if (a.kind === "admin") {
          if (!adminUsernameSet().has(a.admin_username)) {
            return res.status(400).json({ error: `unknown admin username: ${a.admin_username}` });
          }
        } else {
          if (a.counsellor_id !== req.user.counsellorId) {
            const allowed = await pool.query(
              `SELECT 1 FROM counsellors
                WHERE id = $1
                  AND (supervisor_id = $2
                       OR id = (SELECT supervisor_id FROM counsellors WHERE id = $2))`,
              [a.counsellor_id, req.user.counsellorId]
            );
            if (allowed.rows.length === 0) {
              return res.status(403).json({ error: "cannot assign tasks to one of the selected counsellors" });
            }
          }
        }
      }

      // Lead ownership check — lead must belong to the assigning counsellor.
      if (lead_id) {
        const own = await pool.query(
          "SELECT 1 FROM leads WHERE id = $1 AND counsellor_id = $2",
          [lead_id, req.user.counsellorId]
        );
        if (own.rows.length === 0) {
          return res.status(404).json({ error: "lead not found" });
        }
      }
    } else {
      // Admin creating a task. creator_admin_username records WHICH
      // named admin acted (mirror groups have multiple admins on the
      // same inbox — without this the UI flattens them all to "Admin").
      creatorKind = "admin";
      creatorId = null;
      creatorAdminUsername = req.user?.adminUsername || null;

      if (assignees.length === 0) {
        return res.status(400).json({ error: "at least one assignee is required" });
      }

      // Validate each admin assignee resolves; counsellor assignees are
      // validated below by FK on insert + an explicit existence check.
      for (const a of assignees) {
        if (a.kind === "admin" && !adminUsernameSet().has(a.admin_username)) {
          return res.status(400).json({ error: `unknown admin username: ${a.admin_username}` });
        }
      }

      if (lead_id) {
        const leadCheck = await pool.query("SELECT 1 FROM leads WHERE id = $1", [lead_id]);
        if (leadCheck.rows.length === 0) {
          return res.status(404).json({ error: "lead not found" });
        }
      }
    }

    // Validate counsellor assignees exist. Batch into one query so we
    // don't fan out N selects.
    const counsellorIds = assignees.filter((a) => a.kind === "counsellor").map((a) => a.counsellor_id);
    if (counsellorIds.length > 0) {
      const { rows: found } = await pool.query(
        `SELECT id FROM counsellors WHERE id = ANY($1::text[])`,
        [counsellorIds]
      );
      const foundSet = new Set(found.map((r) => r.id));
      const missing = counsellorIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        return res.status(404).json({ error: `assignee counsellor not found: ${missing.join(", ")}` });
      }
    }

    let cleanAppointmentId = null;
    if (appointment_id != null && appointment_id !== "") {
      const apptStr = String(appointment_id);
      if (!/^\d+$/.test(apptStr)) {
        return res.status(400).json({ error: "appointment_id must be a positive integer" });
      }
      const cleanLeadIdForAppt = lead_id || null;
      if (!cleanLeadIdForAppt) {
        return res.status(400).json({ error: "appointment_id requires a lead_id" });
      }
      const apptCheck = await pool.query(
        "SELECT 1 FROM lead_appointments WHERE id = $1 AND lead_id = $2",
        [apptStr, cleanLeadIdForAppt]
      );
      if (apptCheck.rows.length === 0) {
        return res.status(404).json({ error: "appointment not found for this lead" });
      }
      cleanAppointmentId = apptStr;
    }

    const cleanLeadId = lead_id || null;
    const cleanStudentName = student_name?.trim() || null;
    // Pick the first assignee for the legacy columns. The full set
    // goes into the junction table below.
    const primary = assignees[0];
    const legacyAssigneeId = primary.kind === "counsellor" ? primary.counsellor_id : null;
    const legacyAssigneeKind = primary.kind;
    const legacyAssigneeAdminUsername = primary.kind === "admin" ? primary.admin_username : null;

    const client = await pool.connect();
    let createdId;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO counsellor_tasks
           (lead_id, student_name, assignee_id, assignee_kind, assignee_admin_username,
            text, due_date, priority, appointment_id, creator_id, creator_kind,
            creator_admin_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          cleanLeadId, cleanStudentName, legacyAssigneeId, legacyAssigneeKind, legacyAssigneeAdminUsername,
          text.trim(), due_date, !!priority, cleanAppointmentId, creatorId, creatorKind,
          creatorAdminUsername,
        ]
      );
      createdId = rows[0].id;
      for (const a of assignees) {
        await client.query(
          `INSERT INTO counsellor_task_assignees (task_id, assignee_kind, counsellor_id, admin_username)
           VALUES ($1, $2, $3, $4)`,
          [createdId, a.kind, a.counsellor_id, a.admin_username]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const { rows: enriched } = await pool.query(
      `${SELECT_JOINED} WHERE t.id = $1`,
      [createdId]
    );
    backupTaskEvent("create", enriched[0]).catch(() => {});
    res.status(201).json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tasks/:id
// Admin: full edit. Counsellor: priority + completed toggles only.
// Supervisor counsellors have the same (limited) edit rights on tasks
// belonging to counsellors they supervise as on their own.
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const taskRow = await checkTaskAccess(req, res, id);
    if (!taskRow) return;

    // Permission tiers:
    //   admin — full edit (incl. reassign + lead-relink)
    //   counsellor who is an assignee — text / due_date / student_name +
    //     the priority/completed toggles. Assignee-edit was the user ask:
    //     "create an edit button, where the user can edit tasks assigned
    //     to them." Reassigning + relinking stays admin-only so a
    //     counsellor can't hand off their own work to bypass scope.
    //   counsellor who can SEE the task but isn't an assignee (lead
    //     owner, creator) — priority/completed only, same as before.
    const allowedAll = ["text", "due_date", "priority", "completed", "student_name", "assignee_id", "lead_id", "assignees"];
    const allowedCounsellorMinimal = ["priority", "completed"];
    const allowedCounsellorAssignee = ["text", "due_date", "student_name", "priority", "completed"];
    let allowed;
    if (req.user?.kind === "admin") {
      allowed = allowedAll;
    } else {
      // Is this counsellor in the task's assignees array?
      const ja = await pool.query(
        `SELECT 1 FROM counsellor_task_assignees
          WHERE task_id = $1 AND counsellor_id = $2 LIMIT 1`,
        [id, req.user.counsellorId]
      );
      allowed = ja.rows.length > 0 ? allowedCounsellorAssignee : allowedCounsellorMinimal;
    }
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (fields.length === 0) {
      return res.status(400).json({ error: "no valid fields to update" });
    }
    if (req.body.text !== undefined) {
      if (!isString(req.body.text) || req.body.text.trim().length < 1 || req.body.text.length > 1000) {
        return res.status(400).json({ error: "text must be 1–1000 chars" });
      }
    }
    if (req.body.due_date !== undefined && !isValidYmd(req.body.due_date)) {
      return res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" });
    }
    if (req.body.student_name && (!isString(req.body.student_name) || req.body.student_name.length > 200)) {
      return res.status(400).json({ error: "student_name must be a string up to 200 chars" });
    }
    if (req.body.assignee_id && (!isString(req.body.assignee_id) || req.body.assignee_id.length > 50)) {
      return res.status(400).json({ error: "assignee_id must be a string up to 50 chars" });
    }
    if (req.body.lead_id && (!isString(req.body.lead_id) || req.body.lead_id.length > 50)) {
      return res.status(400).json({ error: "lead_id must be a string up to 50 chars" });
    }

    // If the body carries an explicit `assignees` array (admin-only path),
    // replace the junction rows in a transaction with the legacy columns
    // synced to the new primary. Otherwise apply the normal column updates;
    // and when admin changes the legacy assignee_id, mirror that change
    // into the junction so the two views don't drift.
    const wantsAssigneeReplace = req.user?.kind === "admin"
      && (Array.isArray(req.body.assignees) || "assignee_id" in req.body);

    if (wantsAssigneeReplace) {
      let newAssignees;
      if (Array.isArray(req.body.assignees)) {
        const parsed = parseAssigneesPayload(req.body);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        if (parsed.assignees.length === 0) {
          return res.status(400).json({ error: "assignees cannot be empty on update" });
        }
        // Validate admin usernames + counsellor existence.
        for (const a of parsed.assignees) {
          if (a.kind === "admin" && !adminUsernameSet().has(a.admin_username)) {
            return res.status(400).json({ error: `unknown admin username: ${a.admin_username}` });
          }
        }
        const cids = parsed.assignees.filter((a) => a.kind === "counsellor").map((a) => a.counsellor_id);
        if (cids.length > 0) {
          const { rows: found } = await pool.query(
            `SELECT id FROM counsellors WHERE id = ANY($1::text[])`,
            [cids]
          );
          const foundSet = new Set(found.map((r) => r.id));
          const missing = cids.filter((cid) => !foundSet.has(cid));
          if (missing.length > 0) {
            return res.status(404).json({ error: `assignee counsellor not found: ${missing.join(", ")}` });
          }
        }
        newAssignees = parsed.assignees;
      } else {
        // Legacy single-assignee PATCH (just assignee_id changed). Synthesize.
        const v = req.body.assignee_id;
        if (v && typeof v === "string") {
          newAssignees = [{ kind: "counsellor", counsellor_id: v, admin_username: null }];
        } else {
          // assignee_id = null/empty → wipe all assignees too.
          newAssignees = [];
        }
      }

      // Drop assignees from the non-junction field list so we don't try
      // to SET it as a column (it isn't one).
      const cleanFields = fields.filter((f) => f !== "assignees");
      const set = cleanFields.length
        ? cleanFields.map((f, i) => `${f} = $${i + 2}`).join(", ")
        : null;
      const values = [id, ...cleanFields.map((f) => {
        const v = req.body[f];
        if (f === "text" && typeof v === "string") return v.trim();
        if (f === "student_name") return typeof v === "string" ? (v.trim() || null) : null;
        if (f === "assignee_id" || f === "lead_id") return v && v !== "" ? v : null;
        if (f === "priority" || f === "completed") return !!v;
        return v;
      })];

      // Sync legacy columns to the new primary assignee.
      const primary = newAssignees[0] || null;
      const primaryColumns = primary
        ? `assignee_id = $${values.length + 1}, assignee_kind = $${values.length + 2}, assignee_admin_username = $${values.length + 3}`
        : `assignee_id = NULL, assignee_kind = 'counsellor', assignee_admin_username = NULL`;
      const primaryParams = primary ? [
        primary.kind === "counsellor" ? primary.counsellor_id : null,
        primary.kind,
        primary.kind === "admin" ? primary.admin_username : null,
      ] : [];

      const updateSql = set
        ? `UPDATE counsellor_tasks SET ${set}, ${primaryColumns}, updated_at = NOW() WHERE id = $1 RETURNING id`
        : `UPDATE counsellor_tasks SET ${primaryColumns}, updated_at = NOW() WHERE id = $1 RETURNING id`;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: upd } = await client.query(updateSql, [...values, ...primaryParams]);
        if (upd.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "task not found" });
        }
        await client.query(`DELETE FROM counsellor_task_assignees WHERE task_id = $1`, [id]);
        for (const a of newAssignees) {
          await client.query(
            `INSERT INTO counsellor_task_assignees (task_id, assignee_kind, counsellor_id, admin_username)
             VALUES ($1, $2, $3, $4)`,
            [id, a.kind, a.counsellor_id, a.admin_username]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      const { rows: enriched } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
      return res.json(enriched[0]);
    }

    // No assignee change — straight column update.
    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [id, ...fields.map((f) => {
      const v = req.body[f];
      if (f === "text" && typeof v === "string") return v.trim();
      if (f === "student_name") return typeof v === "string" ? (v.trim() || null) : null;
      if (f === "assignee_id" || f === "lead_id") return v && v !== "" ? v : null;
      if (f === "priority" || f === "completed") return !!v;
      return v;
    })];

    const { rows } = await pool.query(
      `UPDATE counsellor_tasks SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: "task not found" });

    const { rows: enriched } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [rows[0].id]);
    backupTaskEvent("update", enriched[0]).catch(() => {});
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/:id/archive
// Counsellors cannot archive admin-assigned tasks (they don't own them enough
// to remove them from the admin's queue — they can only view them).
router.post("/:id/archive", async (req, res, next) => {
  try {
    const { id } = req.params;
    const taskRow = await checkTaskAccess(req, res, id);
    if (!taskRow) return;

    if (req.user?.kind === "counsellor" && taskRow.assignee_kind === "admin") {
      return res.status(403).json({ error: "cannot archive tasks assigned to admin" });
    }

    const { rows } = await pool.query(
      `UPDATE counsellor_tasks
       SET archived = TRUE, archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived = FALSE
       RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT archived FROM counsellor_tasks WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "task not found" });
      const { rows: current } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
      backupTaskEvent("archive", current[0]).catch(() => {});
      return res.json(current[0]);
    }
    const { rows: enriched } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
    backupTaskEvent("archive", enriched[0]).catch(() => {});
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/unarchive", async (req, res, next) => {
  try {
    const { id } = req.params;
    const taskRow = await checkTaskAccess(req, res, id);
    if (!taskRow) return;

    if (req.user?.kind === "counsellor" && taskRow.assignee_kind === "admin") {
      return res.status(403).json({ error: "cannot unarchive tasks assigned to admin" });
    }

    const { rows } = await pool.query(
      `UPDATE counsellor_tasks
       SET archived = FALSE, archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND archived = TRUE
       RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      const exists = await pool.query("SELECT archived FROM counsellor_tasks WHERE id = $1", [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: "task not found" });
      const { rows: current } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
      backupTaskEvent("unarchive", current[0]).catch(() => {});
      return res.json(current[0]);
    }
    const { rows: enriched } = await pool.query(`${SELECT_JOINED} WHERE t.id = $1`, [id]);
    backupTaskEvent("unarchive", enriched[0]).catch(() => {});
    res.json(enriched[0]);
  } catch (e) {
    next(e);
  }
});

// GET /api/tasks/:id/comments
router.get("/:id/comments", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;
    const { rows } = await pool.query(
      `SELECT tc.id, tc.task_id, tc.author_counsellor_id, tc.author_kind,
              tc.author_admin_username,
              tc.body, tc.created_at,
              c.name AS author_name
         FROM task_comments tc
    LEFT JOIN counsellors c ON c.id = tc.author_counsellor_id
        WHERE tc.task_id = $1
     ORDER BY tc.created_at ASC, tc.id ASC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/:id/comments — append-only by design.
router.post("/:id/comments", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;
    const { body } = req.body;
    if (!isString(body) || body.trim().length < 1 || body.length > 2000) {
      return res.status(400).json({ error: "body must be 1–2000 chars" });
    }
    const kind = req.user?.kind;
    const authorCounsellorId = kind === "counsellor" ? req.user.counsellorId : null;
    const authorAdminUsername = kind === "admin" ? (req.user?.adminUsername || null) : null;
    const { rows } = await pool.query(
      `INSERT INTO task_comments
         (task_id, author_counsellor_id, author_kind, author_admin_username, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, task_id, author_counsellor_id, author_kind,
                 author_admin_username, body, created_at`,
      [id, authorCounsellorId, kind, authorAdminUsername, body.trim()]
    );
    const enriched = await pool.query(
      `SELECT tc.id, tc.task_id, tc.author_counsellor_id, tc.author_kind,
              tc.author_admin_username,
              tc.body, tc.created_at,
              c.name AS author_name
         FROM task_comments tc
    LEFT JOIN counsellors c ON c.id = tc.author_counsellor_id
        WHERE tc.id = $1`,
      [rows[0].id]
    );
    backupTaskEvent("comment", { task_id: Number(id), comment: enriched.rows[0] }).catch(() => {});
    res.status(201).json(enriched.rows[0]);
  } catch (e) {
    next(e);
  }
});

// GET /api/tasks/:id/history — append-only edit/action history for a
// task, sourced from intake_audit_log. autoAudit("counsellor_tasks") at
// the mount logs every PATCH/POST/DELETE with actor + diff, so we just
// query that table. Joins the counsellor name for counsellor actors so
// the UI can render "Suhas updated" / "Himani archived" instead of an
// opaque id. Admin actors carry their username in actor_id directly.
// Anyone with task access can see the history; same rule as the task
// detail itself.
router.get("/:id/history", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await checkTaskAccess(req, res, id))) return;
    const { rows } = await pool.query(
      `SELECT a.id, a.occurred_at, a.actor_kind, a.actor_id, a.action, a.diff,
              c.name AS actor_counsellor_name
         FROM intake_audit_log a
    LEFT JOIN counsellors c ON c.id = a.actor_id AND a.actor_kind = 'counsellor'
        WHERE a.target_table = 'counsellor_tasks'
          AND a.target_id = $1
     ORDER BY a.occurred_at ASC, a.id ASC`,
      [String(id)]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

export default router;
