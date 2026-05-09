// Stamp ai_artifacts_generated_at = NOW() for one student so the
// candidate query stops surfacing them. Writes one audit row
// summarising what was generated (counts only — the substantive
// audit rows for each artifact were written by their respective
// persist-* scripts).
//
// Usage:
//   node server/scripts/ai/mark-done.js <student_id> --summary '<json>'
//
// --summary is optional; if provided, must be JSON. Recommended
// shape:
//   { "files_described": 8, "answers_autofilled": 4,
//     "resume": true, "sop": "drafted", "lors": 2, "internships": 1 }

import "dotenv/config";
import pool from "../../db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const studentId = process.argv[2];
  if (!studentId) {
    console.error("Usage: mark-done.js <student_id> [--summary <json>]");
    process.exit(1);
  }

  let summary = null;
  const summaryRaw = arg("summary");
  if (summaryRaw) {
    try {
      summary = JSON.parse(summaryRaw);
    } catch (e) {
      console.error("--summary must be valid JSON:", e.message);
      process.exit(1);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      "UPDATE intake_students SET ai_artifacts_generated_at = NOW(), updated_at = NOW() WHERE student_id = $1 AND ai_artifacts_generated_at IS NULL",
      [studentId]
    );
    if (rowCount === 0) {
      // Student either doesn't exist or was already marked. Verify
      // which to give the caller a useful error vs. a no-op.
      const { rows } = await client.query(
        "SELECT ai_artifacts_generated_at FROM intake_students WHERE student_id = $1",
        [studentId]
      );
      await client.query("ROLLBACK");
      if (rows.length === 0) {
        console.error(`student ${studentId} not found`);
        process.exit(1);
      }
      console.log(`[mark-done] student=${studentId} already marked at ${rows[0].ai_artifacts_generated_at} (no-op)`);
      return;
    }
    await client.query(
      `INSERT INTO intake_audit_log (actor_kind, actor_id, target_table, target_id, action, diff)
       VALUES ('system', NULL, 'intake_students', $1, 'ai_artifacts_generated', $2::jsonb)`,
      [studentId, summary ? JSON.stringify(summary) : "{}"]
    );
    await client.query("COMMIT");
    console.log(`[mark-done] student=${studentId} OK`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((e) => {
  console.error("[mark-done] FAIL:", e?.message || e);
  process.exit(1);
});
