// One-shot data migration: bump students who already pass the new
// intake gate (chapters 1–7 only, after the schema split) over to
// phase=done so they don't have to click through ThankYouScreen on
// next login. Runs the same atomic transition the PUT /me/intake/phase
// route does — UPDATE + seedRequiredDocsForStudent +
// seedApplicationsForStudent + auto-fire one 300-word resume — but
// without an HTTP user, so no audit row.
//
// Usage:
//   DRY-RUN: node server/scripts/bump-finished-students.js
//   APPLY:   node server/scripts/bump-finished-students.js --apply
//   FORCE:   node server/scripts/bump-finished-students.js --apply --force
//
// --force bypasses validateIntakeRequired, transitioning every student
// with intake_phase != 'done'. Use only on one-off cleanup of a test
// dataset where partial answers should still land on the panel.
//
// Requires DATABASE_URL pointing at the target DB (prod or local).

import "dotenv/config";
import pool from "../db.js";
import { validateIntakeRequired } from "../../lib/intakeSchema.js";
import { seedRequiredDocsForStudent } from "../routes/required-docs.js";
import { seedApplicationsForStudent } from "../routes/applications.js";
import { executeResume } from "../generators/run.js";
import { corpusHasExample } from "../generators/examples.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const tag = `${apply ? "APPLY" : "DRY-RUN"}${force ? " (FORCE)" : ""}`;
  console.log(`[bump] ${tag} — DATABASE_URL host=${(process.env.DATABASE_URL || "").split("@")[1]?.split("/")[0] || "?"}`);

  const { rows: candidates } = await pool.query(
    `SELECT student_id, username, display_name, intake_phase, data
       FROM intake_students
      WHERE COALESCE(intake_phase, 'intake') <> 'done'
      ORDER BY updated_at DESC`
  );
  console.log(`[bump] ${candidates.length} student(s) with phase != 'done'`);

  // Resume auto-fire needs the style corpus loaded. If it's empty, the
  // generator throws NoCorpusError and the row sits at 'failed'. Skip
  // the resume insert in that case so the staff side doesn't get a red
  // failure on every bumped student — they can hit "regenerate" once
  // the corpus is in.
  const corpusOk = await corpusHasExample();
  if (!corpusOk) {
    console.log("[bump] corpus has no example — will skip resume kick-off (counsellor can regenerate later)");
  }

  let bumped = 0;
  let invalidSkipped = 0;
  let raceSkipped = 0;
  let failed = 0;

  for (const stu of candidates) {
    const answers = (stu.data && stu.data.answers) || {};
    const who = `${stu.student_id} (${stu.display_name || stu.username || "?"})`;
    if (!force) {
      const { ok, missing } = validateIntakeRequired(answers);
      if (!ok) {
        const first = missing[0]?.label || "?";
        console.log(`[bump] SKIP  ${who} — ${missing.length} required field(s) missing (first: ${first})`);
        invalidSkipped++;
        continue;
      }
    }
    console.log(`[bump] CAND  ${who}${force ? " (forced)" : ""}`);
    if (!apply) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Re-read under FOR UPDATE so a real student session that flipped
      // phase between the SELECT above and now wins the race.
      const cur = await client.query(
        `SELECT intake_phase FROM intake_students WHERE student_id = $1 FOR UPDATE`,
        [stu.student_id]
      );
      const currentPhase = cur.rows[0]?.intake_phase || "intake";
      if (currentPhase === "done") {
        await client.query("ROLLBACK");
        console.log(`[bump]   ${stu.student_id}: already done, skipping`);
        raceSkipped++;
        continue;
      }
      await client.query(
        `UPDATE intake_students
            SET intake_phase   = 'done',
                intake_complete = TRUE,
                updated_at     = NOW()
          WHERE student_id = $1`,
        [stu.student_id]
      );
      await seedRequiredDocsForStudent(client, stu.student_id, answers);
      await seedApplicationsForStudent(client, stu.student_id, answers);

      let resumeId = null;
      if (corpusOk) {
        const ins = await client.query(
          `INSERT INTO intake_resumes
             (student_id, label, length_pages, length_words, style, domain, status)
           VALUES ($1, 'auto-summary', NULL, 300, NULL, NULL, 'pending')
           RETURNING id`,
          [stu.student_id]
        );
        resumeId = ins.rows[0].id;
      }
      await client.query("COMMIT");
      console.log(`[bump]   ${stu.student_id}: phase=done, resumeId=${resumeId || "(skipped)"}`);

      // Fire-and-forget resume gen after commit so a generator crash
      // can't roll back the phase flip.
      if (resumeId) {
        executeResume({
          resumeId,
          spec: { label: "auto-summary", length_words: 300 },
        }).catch((e) =>
          console.error(`[bump]   ${stu.student_id}: resume gen failed:`, e?.message || e)
        );
      }
      bumped++;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[bump]   ${stu.student_id}: ABORTED`, e?.message || e);
      failed++;
    } finally {
      client.release();
    }
  }

  console.log("[bump] —");
  console.log(`[bump] bumped:          ${bumped}`);
  console.log(`[bump] invalid-skipped: ${invalidSkipped}`);
  console.log(`[bump] race-skipped:    ${raceSkipped}`);
  console.log(`[bump] failed:          ${failed}`);
  console.log("[bump] —");

  // Give resume fire-and-forgets ~2s to start before tearing down the
  // pool (executeResume opens its own clients off the same pool).
  if (apply && bumped > 0) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  await pool.end();
}

main().catch((e) => {
  console.error("[bump] fatal:", e);
  process.exit(1);
});
