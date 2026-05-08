import express from "express";
import pool from "../db.js";
import { requireStaff, requireStudent } from "../middleware/auth.js";
import { audit } from "../audit.js";

const router = express.Router();

const isString = (v) => typeof v === "string";
const isPositiveInt = (s) => /^[1-9][0-9]*$/.test(String(s));

// Canonical status keys the UI surfaces. Free-form on the wire so the
// xlsx import can preserve unusual values, but new manual edits should
// pick from this set. Kept in sync with the colour map in
// ApplicationsPanel.jsx.
const KNOWN_STATUSES = new Set([
  "active",
  "submitted",
  "offer",
  "ongoing",
  "on_hold",
  "cancelled",
]);

// GET /api/applications — returns { pending, active, archived } for the
// caller's scope. Single round-trip so the panel can render all three
// sections without coordinating fetches.
router.get("/", requireStaff, async (req, res, next) => {
  try {
    const params = [];
    if (req.user.kind === "counsellor") {
      params.push(req.user.counsellorId);
    }
    // Scoping for counsellors. The application has TWO possible
    // counsellor sources:
    //   - a.counsellor_id (explicit per-app assignment, new feature)
    //   - s.counsellor_id (inherited from the linked student)
    // a.counsellor_id wins when set. Legacy unlinked+unassigned rows
    // (xlsx-transition era) stay visible to all counsellors as shared
    // inventory until someone claims them.
    let leftJoin = `LEFT JOIN intake_students s ON s.student_id = a.student_id
         LEFT JOIN counsellors c ON c.id = a.counsellor_id`;
    let where = "";
    if (req.user.kind === "counsellor") {
      where = ` WHERE (COALESCE(a.counsellor_id, s.counsellor_id) = $1
                       OR (a.counsellor_id IS NULL AND a.student_id IS NULL))`;
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.student_id, a.country, a.university, a.program,
              a.deadline, a.requirements, a.notes, a.status,
              a.pending, a.archived, a.archived_at,
              a.created_at, a.updated_at,
              a.counsellor_id,
              c.name         AS counsellor_name,
              COALESCE(s.display_name, a.student_name) AS student_name,
              s.username     AS student_username
         FROM intake_applications a
         ${leftJoin}${where}
        ORDER BY a.updated_at DESC`,
      params
    );
    const out = { pending: [], active: [], archived: [] };
    for (const r of rows) {
      const row = { ...r, id: String(r.id) };
      if (row.archived) out.archived.push(row);
      else if (row.pending) out.pending.push(row);
      else out.active.push(row);
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// POST /api/applications — counsellor manually adds a row. Body must
// supply EITHER student_id (linked to an intake_students row) OR
// student_name (free-text — the firm is mid-transition from the legacy
// xlsx, so applications often pre-date the student account). Both is
// allowed; student_name then becomes a display cache.
router.post("/", requireStaff, express.json(), async (req, res, next) => {
  try {
    const {
      student_id,
      student_name,
      country,
      university,
      program,
      deadline,
      requirements,
      notes,
      status,
      pending,
    } = req.body || {};
    const sid = isString(student_id) && student_id ? student_id : null;
    const sname = isString(student_name) ? student_name.trim() : "";
    if (!sid && !sname) {
      return res.status(400).json({ error: "student_id or student_name is required" });
    }
    if (!isString(university) || !university.trim()) {
      return res.status(400).json({ error: "university is required" });
    }
    if (sid) {
      // Linked path: counsellor can only attach to their own students.
      const own = await pool.query(
        `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
        [sid]
      );
      if (own.rows.length === 0) {
        return res.status(404).json({ error: "student not found" });
      }
      if (
        req.user.kind === "counsellor" &&
        own.rows[0].counsellor_id !== req.user.counsellorId
      ) {
        return res.status(403).json({ error: "not your student" });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO intake_applications
         (student_id, student_name, country, university, program, deadline,
          requirements, notes, status, pending)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, student_id, student_name, country, university, program,
                 deadline, requirements, notes, status, pending,
                 archived, archived_at, created_at, updated_at`,
      [
        sid,
        sname || null,
        country || null,
        university.trim(),
        program || null,
        deadline || null,
        requirements || null,
        notes || null,
        status || "active",
        pending === true,
      ]
    );
    const row = rows[0];
    audit(req, {
      table: "intake_applications",
      id: String(row.id),
      action: "create",
      diff: {
        student_id: sid,
        student_name: sname || null,
        university: row.university,
        status: row.status,
      },
    });
    res.status(201).json({ ...row, id: String(row.id) });
  } catch (e) {
    next(e);
  }
});

// GET /api/applications/me — student reads their own non-archived
// applications (read-only; status + deadline visible, notes hidden).
router.get("/me", requireStudent, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.country, a.university, a.program,
              a.deadline, a.status, a.pending, a.created_at, a.updated_at
         FROM intake_applications a
        WHERE a.student_id = $1
          AND a.archived  = FALSE
        ORDER BY a.updated_at DESC`,
      [req.user.studentId]
    );
    res.json(rows.map((r) => ({ ...r, id: String(r.id) })));
  } catch (e) {
    next(e);
  }
});

// Unified ownership check: returns the row's app-level + student-level
// counsellor_id. 404 covers both "missing" and "exists but not yours"
// so a counsellor can't probe ID space. Unlinked rows (student_id IS
// NULL) AND no app-level assignment are visible to all staff — shared
// transition-period inventory until someone claims them.
async function loadOwnership(client, id) {
  const { rows } = await client.query(
    `SELECT a.id, a.student_id,
            a.counsellor_id AS app_counsellor_id,
            s.counsellor_id AS student_counsellor_id
       FROM intake_applications a
       LEFT JOIN intake_students s ON s.student_id = a.student_id
      WHERE a.id = $1`,
    [id]
  );
  return rows[0] || null;
}
function reject404(res) { return res.status(404).json({ error: "not found" }); }
// Visibility rule (mirrors the list scope query):
//   - non-counsellor (admin) sees everything
//   - explicit a.counsellor_id wins when set
//   - else fall back to student-inherited owner
//   - unclaimed rows (no app counsellor AND no linked student) are
//     shared transition inventory
function isVisibleTo(row, user) {
  if (user.kind !== "counsellor") return true;
  if (row.app_counsellor_id) return row.app_counsellor_id === user.counsellorId;
  if (!row.student_id) return true;
  return row.student_counsellor_id === user.counsellorId;
}

// PATCH /api/applications/:id — partial update. Any subset of
// {student_name, country, university, program, deadline, requirements,
// notes, status} can be sent.
router.patch("/:id", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return reject404(res);
    if (!isVisibleTo(own, req.user)) return reject404(res);

    const allowed = [
      "student_name",
      "country",
      "university",
      "program",
      "deadline",
      "requirements",
      "notes",
      "status",
    ];
    const sets = [];
    const params = [];
    // student_id — link/unlink intake account. intake_students.student_id
    // is TEXT (e.g. "s_abc_xyz"), so this accepts a non-empty string or
    // null. The earlier int-validator silently rejected every real ID.
    // When linking, a counsellor can only attach to their own students.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "student_id")) {
      const sid = req.body.student_id;
      if (sid !== null && (typeof sid !== "string" || sid.trim().length === 0 || sid.length > 100)) {
        return res.status(400).json({ error: "invalid student_id" });
      }
      if (sid !== null) {
        const own = await pool.query(
          `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
          [sid]
        );
        if (own.rows.length === 0) {
          return res.status(404).json({ error: "student not found" });
        }
        if (
          req.user.kind === "counsellor" &&
          own.rows[0].counsellor_id !== req.user.counsellorId
        ) {
          return res.status(403).json({ error: "not your student" });
        }
      }
      params.push(sid);
      sets.push(`student_id = $${params.length}`);
    }
    // counsellor_id — assign application owner. TEXT (counsellors.id) or null.
    // Counsellors may only assign themselves or a counsellor they supervise.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "counsellor_id")) {
      const cid = req.body.counsellor_id;
      if (cid !== null && typeof cid !== "string") {
        return res.status(400).json({ error: "invalid counsellor_id" });
      }
      if (req.user.kind === "counsellor" && cid !== null && cid !== req.user.counsellorId) {
        const { rows: supervised } = await pool.query(
          `SELECT 1 FROM counsellors WHERE id = $1 AND supervisor_id = $2`,
          [cid, req.user.counsellorId]
        );
        if (supervised.length === 0) {
          return res.status(403).json({ error: "You can only assign yourself or a counsellor you supervise" });
        }
      }
      params.push(cid);
      sets.push(`counsellor_id = $${params.length}`);
    }
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        const v = req.body[key];
        if (key === "university" && (!isString(v) || !v.trim())) {
          return res.status(400).json({ error: "university cannot be empty" });
        }
        if (key === "status" && (!isString(v) || !v.trim())) {
          return res.status(400).json({ error: "status cannot be empty" });
        }
        params.push(v === "" ? null : v);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }
    params.push(Number(req.params.id));
    const { rows } = await pool.query(
      `UPDATE intake_applications
          SET ${sets.join(", ")}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING id, student_id, student_name, country, university, program,
                  deadline, requirements, notes, status, pending,
                  archived, archived_at, created_at, updated_at`,
      params
    );
    const row = rows[0];
    audit(req, {
      table: "intake_applications",
      id: String(row.id),
      action: "update",
      diff: req.body,
    });
    res.json({ ...row, id: String(row.id) });
  } catch (e) {
    next(e);
  }
});

// POST /api/applications/:id/promote — flip pending=false. Optionally
// accepts the same fields as PATCH so the counsellor can fill in
// deadline/requirements at the moment they push it into active.
router.post("/:id/promote", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return reject404(res);
    if (!isVisibleTo(own, req.user)) return reject404(res);

    // Optional: take an extras payload (deadline, requirements, etc.)
    // and apply it in the same UPDATE so promote-and-edit is atomic.
    const allowed = ["country", "program", "deadline", "requirements", "notes", "status"];
    const sets = ["pending = FALSE", "updated_at = NOW()"];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        params.push(req.body[key] === "" ? null : req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    params.push(Number(req.params.id));
    const { rows } = await pool.query(
      `UPDATE intake_applications
          SET ${sets.join(", ")}
        WHERE id = $${params.length}
        RETURNING id`,
      params
    );
    audit(req, {
      table: "intake_applications",
      id: String(rows[0].id),
      action: "promote",
      diff: req.body,
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/applications/:id/archive — soft-remove from the active table.
router.post("/:id/archive", requireStaff, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return reject404(res);
    if (!isVisibleTo(own, req.user)) return reject404(res);
    await pool.query(
      `UPDATE intake_applications
          SET archived = TRUE, archived_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [Number(req.params.id)]
    );
    audit(req, {
      table: "intake_applications",
      id: req.params.id,
      action: "archive",
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/unarchive", requireStaff, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return reject404(res);
    if (!isVisibleTo(own, req.user)) return reject404(res);
    await pool.query(
      `UPDATE intake_applications
          SET archived = FALSE, archived_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [Number(req.params.id)]
    );
    audit(req, {
      table: "intake_applications",
      id: req.params.id,
      action: "unarchive",
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;

export { KNOWN_STATUSES };

// Idempotent seeder for the destination tab in the student dashboard.
// Reads `paths_list` out of `data.answers` and inserts one
// intake_applications row per (university, program) pair that doesn't
// already exist for the student. Re-runs cheaply on every post-done
// PUT /me/record so the staff Applications tab stays in sync as the
// student fills the dashboard tab.
//
// Idempotency uses an existence check rather than a unique index
// because (a) no such constraint exists today and adding one mid-flight
// risks rejecting legitimate counsellor-created duplicates already in
// production, (b) the path list is short (≤10 rows). Exact match on
// trim + IS NOT DISTINCT FROM lets nullable program coexist with the
// trimmed-empty-string-→-null normalisation done on the way in.
export async function seedApplicationsForStudent(client, studentId, answers) {
  const paths = Array.isArray(answers?.paths_list) ? answers.paths_list : [];
  for (const p of paths) {
    if (!p || typeof p !== "object") continue;
    const uni = (p.university || "").trim();
    if (!uni) continue;
    const country = (p.country || "").trim() || null;
    const program = (p.program || "").trim() || null;
    const exists = await client.query(
      `SELECT 1 FROM intake_applications
        WHERE student_id = $1
          AND university = $2
          AND program IS NOT DISTINCT FROM $3
        LIMIT 1`,
      [studentId, uni, program]
    );
    if (exists.rows.length > 0) continue;
    await client.query(
      `INSERT INTO intake_applications
         (student_id, country, university, program, status, pending)
       VALUES ($1, $2, $3, $4, 'active', TRUE)`,
      [studentId, country, uni, program]
    );
  }
}
