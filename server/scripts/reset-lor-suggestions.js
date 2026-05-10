// One-shot: reset student_accepted_at to NULL on AI-suggested LOR rows
// that the prior migrate.js backfill incorrectly flipped to created_at.
//
// History: an earlier version of server/migrate.js ran a one-time
// backfill UPDATE on every deploy, setting student_accepted_at =
// created_at for every kind='lor' row where student_accepted_at IS
// NULL. That was correct for the rows that pre-dated the suggestions
// feature, but harmful for AI suggestions inserted later (which
// legitimately use NULL to mean "pending student review"). On every
// subsequent deploy the UPDATE silently re-stamped fresh suggestions
// as accepted. The backfill has been removed from migrate.js, but
// rows that were flipped during one of those re-runs need to be
// reverted by hand.
//
// The signature of an incorrectly-flipped row is
// `student_accepted_at = created_at` exactly: the migration UPDATE ran
// in one transaction so the timestamps line up, whereas a real student
// accept happens at a later moment. We use that as the heuristic to
// limit the reset to rows the migration touched.
//
// Usage:
//   node server/scripts/reset-lor-suggestions.js <student_id>           # dry run
//   node server/scripts/reset-lor-suggestions.js <student_id> --apply   # commit
//
// Run on Render via the SSH shell (npm start service) when the deploy
// containing the migrate.js fix is live.

import "dotenv/config";
import pool from "../db.js";

async function main() {
  const studentId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!studentId) {
    console.error("Usage: reset-lor-suggestions.js <student_id> [--apply]");
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, seq, recipient_name, student_accepted_at, created_at
       FROM intake_required_docs
      WHERE student_id = $1
        AND kind = 'lor'
        AND student_accepted_at IS NOT NULL
        AND student_accepted_at = created_at
      ORDER BY seq`,
    [studentId]
  );

  console.log(
    `[reset-lor-suggestions] student=${studentId} candidates=${rows.length} ` +
    `(rows where student_accepted_at = created_at, the migration-backfill signature)`
  );
  for (const r of rows) {
    console.log(`  - id=${r.id} seq=${r.seq} "${r.recipient_name || "(no name)"}"`);
  }

  if (rows.length === 0) {
    console.log("nothing to do.");
    await pool.end();
    return;
  }

  if (!apply) {
    console.log("\ndry run — re-run with --apply to commit.");
    await pool.end();
    return;
  }

  const { rowCount } = await pool.query(
    `UPDATE intake_required_docs
        SET student_accepted_at = NULL,
            updated_at = NOW()
      WHERE student_id = $1
        AND kind = 'lor'
        AND student_accepted_at IS NOT NULL
        AND student_accepted_at = created_at`,
    [studentId]
  );
  console.log(`reset ${rowCount} row(s) to student_accepted_at = NULL.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
