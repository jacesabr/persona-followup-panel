// List students who haven't been through the AI artifacts pipeline yet.
// Output: JSON array, one row per student, ordered oldest-update first
// (so the longest-waiting student gets processed first).
//
// Used by manual_opus_generate.md step 1.
//
// Usage:
//   node server/scripts/ai/list-pending.js [--limit N]

import "dotenv/config";
import pool from "../../db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const limit = parseInt(arg("limit") || "5", 10);
  // Two cohorts hit the pipeline:
  //   1. intake_phase='done' — the canonical case: a student finished
  //      filling their own intake form and uploaded their own docs.
  //   2. ai_eligible_via_pre_upload=TRUE — counsellor signed the
  //      student up via /api/students/with-docs and pre-attached
  //      starter documents. The intake form is still 'intake' (the
  //      student hasn't logged in yet) but we want the AI to read the
  //      uploaded docs, autofill the form, and draft the resume now
  //      so the student lands on a pre-filled flow.
  // Both gate on ai_artifacts_generated_at IS NULL so a row never gets
  // processed twice. source_kind is purely informational, surfaced in
  // the staff-side audit log so we can tell apart "student-driven"
  // from "pre-uploaded" runs in retro.
  const { rows } = await pool.query(
    `
    SELECT s.student_id,
           s.display_name,
           s.username,
           s.intake_phase,
           s.intake_complete,
           s.ai_eligible_via_pre_upload,
           CASE
             WHEN s.intake_phase = 'done' THEN 'intake_done'
             WHEN s.ai_eligible_via_pre_upload = TRUE THEN 'pre_upload'
             ELSE 'unknown'
           END AS source_kind,
           s.updated_at,
           c.name AS counsellor_name,
           (SELECT COUNT(*) FROM intake_files f
              WHERE f.student_id = s.student_id AND f.superseded_at IS NULL) AS files_count
      FROM intake_students s
      LEFT JOIN counsellors c ON c.id = s.counsellor_id
     WHERE s.is_archived = FALSE
       AND s.ai_artifacts_generated_at IS NULL
       AND (s.intake_phase = 'done' OR s.ai_eligible_via_pre_upload = TRUE)
     ORDER BY s.updated_at ASC
     LIMIT $1
    `,
    [limit]
  );
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  await pool.end();
}

main().catch((e) => {
  console.error("[list-pending] FAIL:", e?.message || e);
  process.exit(1);
});
