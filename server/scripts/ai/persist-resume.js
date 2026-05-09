// INSERT a Claude-authored resume into intake_resumes as a
// succeeded row. The student's dashboard polls intake_resumes and
// will surface the markdown immediately.
//
// Usage:
//   node server/scripts/ai/persist-resume.js <student_id> --label <text> --md-file <path>
//   node server/scripts/ai/persist-resume.js <student_id> --label <text> --md "<content>"
//
// --md-file is preferred when the resume contains shell metacharacters.

import "dotenv/config";
import fs from "node:fs";
import pool from "../../db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const studentId = process.argv[2];
  const label = arg("label") || "auto-summary";
  const mdFile = arg("md-file");
  const mdInline = arg("md");

  if (!studentId || (!mdFile && !mdInline)) {
    console.error("Usage: persist-resume.js <student_id> --label <text> (--md <content> | --md-file <path>)");
    process.exit(1);
  }

  const md = mdFile ? fs.readFileSync(mdFile, "utf8") : mdInline;
  const wordCount = md.trim().split(/\s+/).length;

  const { rows } = await pool.query(
    `INSERT INTO intake_resumes
       (student_id, label, length_words, status, content_md, model)
     VALUES ($1, $2, $3, 'succeeded', $4, 'claude-opus-via-code-routine')
     RETURNING id`,
    [studentId, label, wordCount, md]
  );

  const resumeId = rows[0].id;
  await pool.query(
    `INSERT INTO intake_audit_log (actor_kind, actor_id, target_table, target_id, action, diff)
     VALUES ('system', NULL, 'intake_resumes', $1, 'ai_generated', $2::jsonb)`,
    [String(resumeId), JSON.stringify({ student_id: studentId, label, length_words: wordCount })]
  );

  console.log(`[persist-resume] student=${studentId} resume_id=${resumeId} words=${wordCount}`);
  await pool.end();
}

main().catch((e) => {
  console.error("[persist-resume] FAIL:", e?.message || e);
  process.exit(1);
});
