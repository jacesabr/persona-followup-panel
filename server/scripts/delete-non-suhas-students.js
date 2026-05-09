// Hardcoded one-shot. Deletes the two test students who pre-date the
// real onboarding flow, keeping ONLY Pratham Aggarwal (the student
// whom admin Suhas onboarded). Everything else stays untouched —
// counsellors, leads, audit log, examples, etc.
//
// Pre-flight gate:
//   - Backup file at backups/db-*-pre-student-cleanup.json must exist.
//   - Pratham's student_id must still resolve to exactly one row.
// Both abort the deletion if false. Run inside a single transaction
// so partial deletes can never leave a half-state.
//
// Foreign-key constraints today:
//   intake_files            RESTRICT  (delete first)
//   intake_resumes          RESTRICT  (delete first)
//   intake_consents         RESTRICT  (delete first)
//   intake_insights         RESTRICT  (delete first)
//   intake_applications     CASCADE   (auto)
//   intake_required_docs    CASCADE   (auto)
//   sessions                CASCADE   (auto)
//   intake_application_comments.author_student_id  SET NULL  (auto)
//
// R2 blobs are intentionally NOT deleted. The user's standing rule:
// keep backups even when explicitly told to delete, because a delete
// might be misinterpreted. The blobs become orphaned but recoverable
// from R2 + the JSON backup until manually pruned by a human.
//
// Usage: node server/scripts/delete-non-suhas-students.js

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const BACKUPS_DIR = path.join(ROOT, "backups");

const KEEP_ID = "s_moy17coj_7ab6d5bb6e39"; // Pratham Aggarwal
const DELETE_IDS = [
  "s_mov7ngny_8f3284ec3128", // Student One / student1 (May 7 test)
  "s_mowstau0_3f57c52d0a9c", // Krisha Madan / Krisha_Madan (May 8)
];

async function main() {
  // Pre-flight: backup must exist.
  const recent = fs.readdirSync(BACKUPS_DIR)
    .filter((f) => f.includes("pre-student-cleanup"))
    .sort()
    .reverse();
  if (recent.length === 0) {
    throw new Error(
      `No backup file matching *pre-student-cleanup*.json in ${BACKUPS_DIR}. ` +
      `Run: node server/scripts/backup-db.js --label pre-student-cleanup`
    );
  }
  console.log(`[delete] backup present: ${recent[0]}`);

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Pre-flight: confirm the keep-id resolves and the delete-ids are
  // exactly the rows we expect. Fail loud on anything unexpected.
  const all = await pool.query(
    `SELECT student_id, username, display_name FROM intake_students ORDER BY created_at`
  );
  console.log("[delete] current students:");
  for (const r of all.rows) {
    const tag = r.student_id === KEEP_ID ? "KEEP"
      : DELETE_IDS.includes(r.student_id) ? "DELETE"
      : "UNEXPECTED";
    console.log(`  ${tag.padEnd(10)} ${r.student_id}  ${r.username}  ${r.display_name}`);
    if (tag === "UNEXPECTED") {
      throw new Error(`Found a student not in keep/delete list: ${r.student_id}. ` +
        `Update the script's hardcoded lists before re-running.`);
    }
  }
  const keepRow = all.rows.find((r) => r.student_id === KEEP_ID);
  if (!keepRow) throw new Error(`KEEP_ID ${KEEP_ID} not present — refusing to proceed.`);
  for (const id of DELETE_IDS) {
    if (!all.rows.find((r) => r.student_id === id)) {
      throw new Error(`DELETE_ID ${id} not present — DB state has drifted from the script. Aborting.`);
    }
  }

  // Snapshot dependent counts before, so we can confirm the deletes
  // touched only what we expected.
  async function countDependents(ids) {
    const result = {};
    for (const t of [
      "intake_files",
      "intake_resumes",
      "intake_consents",
      "intake_insights",
      "intake_applications",
      "intake_required_docs",
      "sessions",
    ]) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM "${t}" WHERE student_id = ANY($1::text[])`,
        [ids]
      );
      result[t] = rows[0].n;
    }
    return result;
  }

  const beforeDelete = await countDependents(DELETE_IDS);
  const beforeKeep = await countDependents([KEEP_ID]);
  console.log("[delete] rows referencing DELETE_IDS before:", beforeDelete);
  console.log("[delete] rows referencing KEEP_ID  before:", beforeKeep);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // RESTRICT FKs first (must clear before deleting parent rows).
    const restrictTables = ["intake_files", "intake_resumes", "intake_consents", "intake_insights"];
    for (const t of restrictTables) {
      const r = await client.query(
        `DELETE FROM "${t}" WHERE student_id = ANY($1::text[]) RETURNING id`,
        [DELETE_IDS]
      );
      console.log(`[delete]   ${t}: ${r.rowCount} rows`);
    }

    // Parent. CASCADE rules clean up intake_applications,
    // intake_required_docs, sessions, and the
    // intake_application_comments.author_student_id pointers
    // (SET NULL) automatically.
    const parent = await client.query(
      `DELETE FROM intake_students WHERE student_id = ANY($1::text[]) RETURNING student_id, username`,
      [DELETE_IDS]
    );
    console.log(`[delete]   intake_students: ${parent.rowCount} rows`);
    for (const row of parent.rows) {
      console.log(`             - ${row.student_id} (${row.username})`);
    }

    if (parent.rowCount !== DELETE_IDS.length) {
      throw new Error(
        `Expected to delete ${DELETE_IDS.length} students, deleted ${parent.rowCount}. Rolling back.`
      );
    }

    // Belt-and-braces: KEEP_ID must still exist after the deletes.
    const keepStill = await client.query(
      `SELECT 1 FROM intake_students WHERE student_id = $1`,
      [KEEP_ID]
    );
    if (keepStill.rowCount !== 1) {
      throw new Error(`KEEP_ID disappeared inside the transaction — rolling back.`);
    }

    await client.query("COMMIT");
    console.log("[delete] COMMIT ok");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Post-conditions. KEEP_ID's dependent counts must equal the
  // pre-delete snapshot (we never touched its rows).
  const afterKeep = await countDependents([KEEP_ID]);
  for (const k of Object.keys(beforeKeep)) {
    if (beforeKeep[k] !== afterKeep[k]) {
      console.warn(`[delete] WARN: ${k} for KEEP_ID changed ${beforeKeep[k]} → ${afterKeep[k]}`);
    }
  }
  console.log("[delete] rows referencing KEEP_ID  after :", afterKeep);

  const afterStudents = await pool.query(
    `SELECT student_id, username, display_name FROM intake_students ORDER BY created_at`
  );
  console.log("[delete] students remaining:");
  for (const r of afterStudents.rows) {
    console.log(`  ${r.student_id}  ${r.username}  ${r.display_name}`);
  }

  await pool.end();
}

main()
  .then(() => { console.log("\n[delete] done."); process.exit(0); })
  .catch((e) => { console.error("[delete] FAIL:", e?.stack || e); process.exit(1); });
