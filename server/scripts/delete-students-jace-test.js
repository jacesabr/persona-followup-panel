import "dotenv/config";
import pool from "../db.js";

// One-shot: hard-delete the 'Jace' (s_mor13mgq_a2b8a772d58f) and
// 'Test Student' (s_mor44u2l_8be78cc933c2) accounts. The intake_*
// tables use RESTRICT for the student_id FK on resumes/files/insights/
// consents, so those rows are deleted first; intake_students delete
// then cascades applications, required_docs, application_comments,
// and sessions. intake_audit_log isn't FK'd and is left intact.
const TARGETS = ["s_mor13mgq_a2b8a772d58f", "s_mor44u2l_8be78cc933c2"];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[delete] DATABASE_URL not set.");
    process.exit(1);
  }
  console.log("[delete] target DB:", process.env.DATABASE_URL.replace(/:[^@/]+@/, ":***@"));
  console.log("[delete] student_ids:", TARGETS.join(", "));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query(
      `SELECT student_id, username, display_name FROM intake_students WHERE student_id = ANY($1)`,
      [TARGETS]
    );
    if (before.rowCount !== TARGETS.length) {
      throw new Error(`expected ${TARGETS.length} student rows, found ${before.rowCount}`);
    }
    console.log("[delete] pre-check rows:", before.rows);

    const r1 = await client.query(`DELETE FROM intake_resumes  WHERE student_id = ANY($1)`, [TARGETS]);
    const r2 = await client.query(`DELETE FROM intake_files    WHERE student_id = ANY($1)`, [TARGETS]);
    const r3 = await client.query(`DELETE FROM intake_insights WHERE student_id = ANY($1)`, [TARGETS]);
    const r4 = await client.query(`DELETE FROM intake_consents WHERE student_id = ANY($1)`, [TARGETS]);
    const r5 = await client.query(`DELETE FROM intake_students WHERE student_id = ANY($1)`, [TARGETS]);

    console.log(
      `[delete] resumes=${r1.rowCount} files=${r2.rowCount} insights=${r3.rowCount} consents=${r4.rowCount} students=${r5.rowCount}`
    );

    await client.query("COMMIT");
    console.log("[delete] committed.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[delete] failed, rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
