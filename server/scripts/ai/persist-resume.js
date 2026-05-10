// INSERT a Claude-authored resume into intake_resumes as a
// succeeded row. The student's dashboard polls intake_resumes and
// will surface the structured payload (or markdown fallback)
// immediately.
//
// Two output modes:
//
//   1. STRUCTURED (preferred — feeds <ResumeTemplate> on the frontend):
//        node server/scripts/ai/persist-resume.js <student_id> \
//          --label "profile-summary" \
//          --json-file /tmp/resume_<sid>.json
//
//   2. LEGACY MARKDOWN (back-compat for any caller still on the old
//      content_md path):
//        node server/scripts/ai/persist-resume.js <student_id> \
//          --label "profile-summary" \
//          --md-file /tmp/resume_<sid>.md
//        node server/scripts/ai/persist-resume.js <student_id> \
//          --label "profile-summary" \
//          --md "<inline content>"
//
// --md-file / --json-file are preferred over inline values; the
// description, even more so the JSON structure, can hit ARG_MAX on
// some shells when passed as a single argument.

import "dotenv/config";
import fs from "node:fs";
import pool from "../../db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

function countWords(text) {
  if (!text || typeof text !== "string") return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Approximate word count for a structured payload — sums all visible
// text fields (lede, bullet labels + bodies + meta, closing_note,
// inline strips). The number lands in length_words for the staff
// "may be stale" detector + the dashboard size-warning banner.
function countWordsInJson(payload) {
  if (!payload || typeof payload !== "object") return 0;
  const buckets = [];
  buckets.push(payload.name || "", payload.headline || "", payload.lede || "", payload.closing_note || "");
  for (const arr of [payload.education, payload.standardized_tests, payload.activities, payload.internships, payload.volunteer]) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      buckets.push(it?.label || "", it?.body || "", it?.meta || "");
    }
  }
  if (Array.isArray(payload.skills)) buckets.push(...payload.skills);
  if (Array.isArray(payload.languages)) buckets.push(...payload.languages);
  return countWords(buckets.join(" "));
}

async function main() {
  const studentId = process.argv[2];
  const label = arg("label") || "auto-summary";
  const mdFile = arg("md-file");
  const mdInline = arg("md");
  const jsonFile = arg("json-file");

  if (!studentId || (!mdFile && !mdInline && !jsonFile)) {
    console.error("Usage: persist-resume.js <student_id> --label <text> (--json-file <path> | --md-file <path> | --md <inline>)");
    process.exit(1);
  }

  let contentJson = null;
  let contentMd = null;
  let wordCount = 0;

  if (jsonFile) {
    const raw = fs.readFileSync(jsonFile, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`[persist-resume] FAIL: --json-file is not valid JSON: ${e.message}`);
      process.exit(1);
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string") {
      console.error("[persist-resume] FAIL: JSON payload must be an object with at least a `name` string field. See lib/resumeSchema.js for the full shape.");
      process.exit(1);
    }
    contentJson = parsed;
    wordCount = countWordsInJson(parsed);
  } else {
    contentMd = mdFile ? fs.readFileSync(mdFile, "utf8") : mdInline;
    wordCount = countWords(contentMd);
  }

  const { rows } = await pool.query(
    `INSERT INTO intake_resumes
       (student_id, label, length_words, status, content_md, content_json, model)
     VALUES ($1, $2, $3, 'succeeded', $4, $5, 'claude-opus-via-code-routine')
     RETURNING id`,
    [studentId, label, wordCount, contentMd, contentJson]
  );

  const resumeId = rows[0].id;
  await pool.query(
    `INSERT INTO intake_audit_log (actor_kind, actor_id, target_table, target_id, action, diff)
     VALUES ('system', NULL, 'intake_resumes', $1, 'ai_generated', $2::jsonb)`,
    [String(resumeId), JSON.stringify({ student_id: studentId, label, length_words: wordCount, format: contentJson ? "json" : "markdown" })]
  );

  console.log(`[persist-resume] student=${studentId} resume_id=${resumeId} words=${wordCount} format=${contentJson ? "json" : "markdown"}`);
  await pool.end();
}

main().catch((e) => {
  console.error("[persist-resume] FAIL:", e?.message || e);
  process.exit(1);
});
