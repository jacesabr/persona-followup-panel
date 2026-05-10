// One-shot cleanup: delete duplicate resume rows so each student has
// exactly one finished resume. Matches the new admin-ai dispatch
// behaviour (which UPSERTs a single row per student going forward),
// but covers historical state where prior dispatches stacked rows.
//
// Default: keep the most-recently-CREATED row per student that is not
// pending/running, delete the rest. Pass --student=<id> to scope to
// one student. Pass --keep=<id> to override which row survives for
// that one student (only valid alongside --student).
// Pass --dry-run (default) to print the plan without deleting.
// Pass --apply to actually delete.
//
// Run with:
//   node server/scripts/dedupe-resumes.js                  # dry, all students
//   node server/scripts/dedupe-resumes.js --apply          # delete, all students
//   node server/scripts/dedupe-resumes.js --student=s_xxx --keep=9 --apply

import "dotenv/config";
import pool from "../db.js";

function parseArgs() {
  const args = { dryRun: true, student: null, keep: null };
  for (const a of process.argv.slice(2)) {
    if (a === "--apply")        args.dryRun = false;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--student=")) args.student = a.slice("--student=".length);
    else if (a.startsWith("--keep="))    args.keep    = Number(a.slice("--keep=".length));
  }
  if (args.keep && !args.student) {
    console.error("--keep requires --student");
    process.exit(1);
  }
  return args;
}

async function main() {
  const { dryRun, student, keep } = parseArgs();
  const scope = student ? `student=${student}` : "all students";
  console.log(`[dedupe-resumes] mode=${dryRun ? "DRY RUN" : "APPLY"}, scope=${scope}${keep ? `, keep=${keep}` : ""}`);

  const studentClause = student ? "AND r.student_id = $1" : "";
  const params        = student ? [student] : [];

  // Find every student with > 1 finished resume (or all in --student mode).
  const { rows: groups } = await pool.query(
    `SELECT r.student_id,
            s.display_name,
            COUNT(*)::int                                  AS total,
            ARRAY_AGG(r.id ORDER BY r.created_at DESC)     AS ids_by_created_desc
       FROM intake_resumes r
       JOIN intake_students s ON s.student_id = r.student_id
      WHERE r.status NOT IN ('pending','running')
        ${studentClause}
      GROUP BY r.student_id, s.display_name
      HAVING COUNT(*) > 1
      ORDER BY s.display_name`,
    params
  );

  if (groups.length === 0) {
    console.log("[dedupe-resumes] no duplicates. done.");
    await pool.end();
    return;
  }

  let totalToDelete = 0;
  for (const g of groups) {
    // pg can return integer arrays as JS strings depending on the
    // column type (int4 → numbers, int8 → strings). Coerce both
    // sides to Number for the filter so identity comparison works
    // either way.
    const allIds    = g.ids_by_created_desc.map((id) => Number(id));
    const surviveId = (student && keep) ? Number(keep) : allIds[0];
    const deleteIds = allIds.filter((id) => id !== surviveId);
    if (deleteIds.length === allIds.length) {
      throw new Error(`refusing to delete every row for ${g.student_id} (surviveId ${surviveId} not in ${JSON.stringify(allIds)})`);
    }
    totalToDelete += deleteIds.length;
    console.log(`  ${g.display_name} (${g.student_id}): keep=${surviveId}, delete=[${deleteIds.join(", ")}]`);

    if (!dryRun && deleteIds.length > 0) {
      const res = await pool.query(
        `DELETE FROM intake_resumes
           WHERE student_id = $1
             AND id = ANY($2::int[])
             AND status NOT IN ('pending','running')
           RETURNING id`,
        [g.student_id, deleteIds]
      );
      console.log(`    deleted ids: [${res.rows.map((r) => r.id).join(", ")}]`);
    }
  }

  console.log(`[dedupe-resumes] ${dryRun ? "would delete" : "deleted"} ${totalToDelete} row(s).`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
