// One-shot: wipe intake_required_docs rows so the LOR / Internship / NGO
// / Extracurricular / SOP slots come back to a clean empty state. The
// counsellor / admin then creates whichever slots actually apply from
// the staff UI ("+ Add" on the per-student page, or the Required
// Documents tab).
//
// Always backs up the deleted rows to a timestamped JSON file under
// ./backups/ before touching the table — destructive ops on persona
// data must be reversible (see CLAUDE memory: data persistence rule).
// R2 blobs referenced by final_file_id are NOT touched; only the
// pointer rows in Postgres go away. Uploaded files keep their place
// in intake_files via the superseded_at flow.
//
// Usage:
//   node server/scripts/wipe-required-docs.js --student <id>           # dry run
//   node server/scripts/wipe-required-docs.js --student <id> --apply   # commit
//   node server/scripts/wipe-required-docs.js --all                    # dry run, every student
//   node server/scripts/wipe-required-docs.js --all     --apply        # commit, every student
//
// Run from the Render web service shell (npm start) so it picks up the
// production DATABASE_URL, or set DATABASE_URL locally for a local DB.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const all   = args.includes("--all");
  const studentIdx = args.indexOf("--student");
  const studentId = studentIdx >= 0 ? args[studentIdx + 1] : null;

  if (!all && !studentId) {
    console.error("Usage: wipe-required-docs.js (--student <id> | --all) [--apply]");
    process.exit(1);
  }

  const whereSql = all ? "" : "WHERE student_id = $1";
  const params   = all ? []  : [studentId];

  const { rows } = await pool.query(
    `SELECT id, student_id, kind, seq, recipient_name, company_name,
            staff_draft IS NOT NULL    AS has_draft,
            final_file_id IS NOT NULL  AS has_file,
            requested_at IS NOT NULL   AS sent,
            approved_by_admin_at IS NOT NULL AS approved,
            created_at, updated_at,
            recipient_role, reason_brief, company_website, activity_brief,
            subject, instructions, target_words, staff_draft,
            final_file_id, requested_at, deadline_at, approved_by_admin_at,
            marked_done_at, student_accepted_at
       FROM intake_required_docs
       ${whereSql}
       ORDER BY student_id, kind, seq`,
    params
  );

  console.log(
    `[wipe-required-docs] scope=${all ? "ALL students" : `student=${studentId}`} ` +
    `candidates=${rows.length}`
  );
  for (const r of rows) {
    const flags = [
      r.has_draft && "draft",
      r.has_file  && "file",
      r.sent      && "sent",
      r.approved  && "approved",
    ].filter(Boolean).join(",") || "empty";
    const label = r.recipient_name || r.company_name || "";
    console.log(`  - student=${r.student_id} ${r.kind}#${r.seq} [${flags}] ${label}`);
  }

  if (rows.length === 0) {
    console.log("nothing to wipe.");
    await pool.end();
    return;
  }

  if (!apply) {
    console.log("\ndry run — re-run with --apply to commit.");
    await pool.end();
    return;
  }

  // Snapshot first. Lands in ./backups/ at repo root (one dir up from
  // server/scripts/), filename carries the scope + timestamp so multiple
  // runs don't clobber each other.
  const backupDir = path.resolve(__dirname, "..", "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scopeTag = all ? "all" : `student-${studentId}`;
  const backupPath = path.join(backupDir, `required-docs-wipe-${scopeTag}-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
  console.log(`backed up ${rows.length} row(s) -> ${backupPath}`);

  const { rowCount } = await pool.query(
    `DELETE FROM intake_required_docs ${whereSql}`,
    params
  );
  console.log(`deleted ${rowCount} row(s) from intake_required_docs.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
