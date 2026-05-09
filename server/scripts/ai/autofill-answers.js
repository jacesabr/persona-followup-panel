// Merge AI-extracted fields into intake_students.data.answers.
// Critical invariant: NEVER overwrite an existing answer. The agent
// supplies a JSON object of proposed key/value pairs; this script
// loads the current answers, merges only the keys whose current
// value is null/undefined/empty-string, and writes back atomically.
// Logs which keys it actually wrote (vs skipped because already set).
//
// Usage:
//   node server/scripts/ai/autofill-answers.js <student_id> '<json>'
//   ...where <json> is the proposed answers map, e.g.
//     '{"aadhar":"1234 5678 9012","marks10pct":92,"dob":"2007-08-12"}'

import "dotenv/config";
import pool from "../../db.js";

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  // File slots: an unsubmitted slot has status !== 'uploaded'. Don't
  // autofill into a partially-staged file slot.
  if (v && typeof v === "object" && "status" in v) {
    return v.status !== "uploaded";
  }
  return false;
}

async function main() {
  const studentId = process.argv[2];
  const proposedRaw = process.argv[3];
  if (!studentId || !proposedRaw) {
    console.error("Usage: autofill-answers.js <student_id> <json>");
    process.exit(1);
  }

  let proposed;
  try {
    proposed = JSON.parse(proposedRaw);
  } catch (e) {
    console.error("proposed must be valid JSON:", e.message);
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT data FROM intake_students WHERE student_id = $1 FOR UPDATE",
      [studentId]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      console.error(`student ${studentId} not found`);
      process.exit(1);
    }
    const data = rows[0].data || {};
    const answers = { ...(data.answers || {}) };

    const written = {};
    const skipped = {};
    for (const [k, v] of Object.entries(proposed)) {
      if (isEmpty(answers[k])) {
        answers[k] = v;
        written[k] = v;
      } else {
        skipped[k] = answers[k];
      }
    }

    if (Object.keys(written).length === 0) {
      await client.query("ROLLBACK");
      console.log("[autofill] nothing to write — all proposed keys already populated");
      return;
    }

    const newData = { ...data, answers };
    await client.query(
      "UPDATE intake_students SET data = $2, updated_at = NOW() WHERE student_id = $1",
      [studentId, newData]
    );

    await client.query(
      `INSERT INTO intake_audit_log (actor_kind, actor_id, target_table, target_id, action, diff, notes)
       VALUES ('system', NULL, 'intake_students', $1, 'ai_autofill', $2::jsonb, $3)`,
      [
        studentId,
        JSON.stringify({ written, skipped_already_set: Object.keys(skipped) }),
        `wrote ${Object.keys(written).length} keys; skipped ${Object.keys(skipped).length} (already populated)`,
      ]
    );

    await client.query("COMMIT");
    console.log(
      `[autofill] student=${studentId} wrote=${Object.keys(written).length} skipped=${Object.keys(skipped).length}`
    );
    for (const k of Object.keys(written)) console.log(`  + ${k}`);
    for (const k of Object.keys(skipped)) console.log(`  ~ ${k} (kept existing)`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((e) => {
  console.error("[autofill-answers] FAIL:", e?.message || e);
  process.exit(1);
});
