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
      // Visible to a counsellor when:
      //   - the application is explicitly assigned to them (a.counsellor_id), OR
      //   - the linked student is assigned to them (s.counsellor_id), OR
      //   - the row is shared inventory: no app-level owner AND no student
      //     owner (covers both legacy unlinked free-text rows AND fresh
      //     student-submitted pending apps where admin hasn't assigned a
      //     counsellor to the student yet).
      where = ` WHERE (a.counsellor_id = $1
                       OR (a.counsellor_id IS NULL AND s.counsellor_id = $1)
                       OR (a.counsellor_id IS NULL AND s.counsellor_id IS NULL))`;
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

// GET /api/applications/student/:student_id — staff-only.
// Same row shape as GET /, scoped to a single student. Used by the
// admin / counsellor "view student" surface so it doesn't have to
// fetch the firm-wide list and filter client-side. Counsellor scope
// follows the same rule as GET /: explicit a.counsellor_id, inherited
// student counsellor, or shared inventory (both NULL).
router.get("/student/:student_id", requireStaff, async (req, res, next) => {
  try {
    const sid = req.params.student_id;
    if (!sid) return res.status(400).json({ error: "student_id required" });

    // Authorisation: admin sees any student; counsellor sees only
    // their own. Mirror the existing /api/students/:id check —
    // there's no point letting a counsellor pull this student's
    // applications if they can't view the student record itself.
    if (req.user.kind === "counsellor") {
      const own = await pool.query(
        `SELECT counsellor_id FROM intake_students WHERE student_id = $1`,
        [sid]
      );
      // 404 not 403 to avoid disclosing the student exists.
      if (own.rows.length === 0 || own.rows[0].counsellor_id !== req.user.counsellorId) {
        return res.status(404).json({ error: "student not found" });
      }
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
         LEFT JOIN intake_students s ON s.student_id = a.student_id
         LEFT JOIN counsellors c ON c.id = a.counsellor_id
        WHERE a.student_id = $1
        ORDER BY a.updated_at DESC`,
      [sid]
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
// applications. Status tab on the dashboard renders this; the student
// sees status + deadline + requirements but not staff-only `notes`.
router.get("/me", requireStudent, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.country, a.university, a.program,
              a.deadline, a.requirements, a.status, a.pending,
              a.created_at, a.updated_at
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

// POST /api/applications/me — student creates an application against
// their own account. Always lands in `pending=true` so it shows up in
// the staff "pending review" queue. Student-side has no archive/delete
// path by design — once submitted, the row is the staff's to triage.
router.post("/me", requireStudent, express.json(), async (req, res, next) => {
  try {
    const { country, university, program, requirements } = req.body || {};
    if (!isString(university) || !university.trim()) {
      return res.status(400).json({ error: "university is required" });
    }
    const { rows } = await pool.query(
      `INSERT INTO intake_applications
         (student_id, country, university, program, requirements, status, pending)
       VALUES ($1, $2, $3, $4, $5, 'active', TRUE)
       RETURNING id, country, university, program, deadline, requirements,
                 status, pending, created_at, updated_at`,
      [
        req.user.studentId,
        isString(country) && country.trim() ? country.trim() : null,
        university.trim(),
        isString(program) && program.trim() ? program.trim() : null,
        isString(requirements) && requirements.trim() ? requirements.trim() : null,
      ]
    );
    const row = rows[0];
    audit(req, {
      table: "intake_applications",
      id: String(row.id),
      action: "student_create",
      diff: {
        student_id: req.user.studentId,
        university: row.university,
        program: row.program,
      },
    });
    res.status(201).json({ ...row, id: String(row.id) });
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
  // No app-level assignment: scope by student. Unassigned students
  // (s.counsellor_id IS NULL) AND linked-student rows are shared
  // inventory until admin assigns the student — same model as the
  // listing query above.
  if (!row.student_counsellor_id) return true;
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

// ============================================================
// Application comments — append-only thread per (student × school).
// Two-way: student, assigned counsellor, and admin all read + write.
// Same access rules as the parent application: staff scope mirrors
// list-visibility; student scope is "rows on my own student_id".
// ============================================================
const MAX_COMMENT_BODY = 4000;

function shapeComment(r) {
  return {
    id: String(r.id),
    application_id: String(r.application_id),
    author_kind: r.author_kind,
    author_counsellor_id: r.author_counsellor_id,
    author_admin_username: r.author_admin_username,
    author_student_id: r.author_student_id,
    author_name: r.author_name,
    body: r.body,
    created_at: r.created_at,
  };
}

// Joined SELECT used by both staff and student GETs so the wire shape
// matches regardless of who's asking. counsellors.name and
// intake_students.display_name resolve to a friendly display name; admin
// authors fall back to author_admin_username.
const COMMENT_SELECT = `
  SELECT ac.id, ac.application_id, ac.author_kind,
         ac.author_counsellor_id, ac.author_admin_username, ac.author_student_id,
         COALESCE(c.name, st.display_name, st.username, ac.author_admin_username) AS author_name,
         ac.body, ac.created_at
    FROM intake_application_comments ac
    LEFT JOIN counsellors    c  ON c.id = ac.author_counsellor_id
    LEFT JOIN intake_students st ON st.student_id = ac.author_student_id`;

router.get("/:id/comments", requireStaff, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return reject404(res);
    if (!isVisibleTo(own, req.user)) return reject404(res);
    const { rows } = await pool.query(
      `${COMMENT_SELECT} WHERE ac.application_id = $1 ORDER BY ac.created_at ASC`,
      [Number(req.params.id)]
    );
    res.json(rows.map(shapeComment));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/comments", requireStaff, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const own = await loadOwnership(pool, Number(req.params.id));
    if (!own) return reject404(res);
    if (!isVisibleTo(own, req.user)) return reject404(res);
    const body = isString(req.body?.body) ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "body is required" });
    if (body.length > MAX_COMMENT_BODY) {
      return res.status(400).json({ error: `body too long (max ${MAX_COMMENT_BODY})` });
    }
    const isAdmin = req.user.kind === "admin";
    const insert = await pool.query(
      `INSERT INTO intake_application_comments
         (application_id, author_kind, author_counsellor_id, author_admin_username, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        Number(req.params.id),
        isAdmin ? "admin" : "counsellor",
        isAdmin ? null : req.user.counsellorId,
        isAdmin ? (req.user.adminUsername || null) : null,
        body,
      ]
    );
    const { rows } = await pool.query(
      `${COMMENT_SELECT} WHERE ac.id = $1`,
      [insert.rows[0].id]
    );
    audit(req, {
      table: "intake_application_comments",
      id: String(insert.rows[0].id),
      action: "create",
      diff: { application_id: Number(req.params.id) },
    });
    res.status(201).json(shapeComment(rows[0]));
  } catch (e) {
    next(e);
  }
});

// Student equivalents — only operate on rows the student owns.
async function loadStudentApp(client, appId, studentId) {
  const { rows } = await client.query(
    `SELECT id FROM intake_applications WHERE id = $1 AND student_id = $2`,
    [appId, studentId]
  );
  return rows[0] || null;
}

router.get("/me/:id/comments", requireStudent, async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const app = await loadStudentApp(pool, Number(req.params.id), req.user.studentId);
    if (!app) return reject404(res);
    const { rows } = await pool.query(
      `${COMMENT_SELECT} WHERE ac.application_id = $1 ORDER BY ac.created_at ASC`,
      [Number(req.params.id)]
    );
    res.json(rows.map(shapeComment));
  } catch (e) {
    next(e);
  }
});

router.post("/me/:id/comments", requireStudent, express.json(), async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const app = await loadStudentApp(pool, Number(req.params.id), req.user.studentId);
    if (!app) return reject404(res);
    const body = isString(req.body?.body) ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "body is required" });
    if (body.length > MAX_COMMENT_BODY) {
      return res.status(400).json({ error: `body too long (max ${MAX_COMMENT_BODY})` });
    }
    const insert = await pool.query(
      `INSERT INTO intake_application_comments
         (application_id, author_kind, author_student_id, body)
       VALUES ($1, 'student', $2, $3)
       RETURNING id`,
      [Number(req.params.id), req.user.studentId, body]
    );
    const { rows } = await pool.query(
      `${COMMENT_SELECT} WHERE ac.id = $1`,
      [insert.rows[0].id]
    );
    audit(req, {
      table: "intake_application_comments",
      id: String(insert.rows[0].id),
      action: "student_create",
      diff: { application_id: Number(req.params.id) },
    });
    res.status(201).json(shapeComment(rows[0]));
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
    // archived=FALSE filter so a previously-archived application
    // (e.g. cancelled last cycle) doesn't block re-application this
    // cycle — same rule the xlsx import's partial unique index uses.
    const exists = await client.query(
      `SELECT 1 FROM intake_applications
        WHERE student_id = $1
          AND university = $2
          AND program IS NOT DISTINCT FROM $3
          AND archived = FALSE
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
