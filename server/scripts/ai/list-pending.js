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
  const { rows } = await pool.query(
    `
    SELECT s.student_id,
           s.display_name,
           s.username,
           s.intake_phase,
           s.intake_complete,
           s.updated_at,
           c.name AS counsellor_name,
           (SELECT COUNT(*) FROM intake_files f
              WHERE f.student_id = s.student_id AND f.superseded_at IS NULL) AS files_count
      FROM intake_students s
      LEFT JOIN counsellors c ON c.id = s.counsellor_id
     WHERE s.intake_phase = 'done'
       AND s.is_archived = FALSE
       AND s.ai_artifacts_generated_at IS NULL
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
