// One-shot: strip placeholder "Not taking" / "Planning to take" / etc.
// rows from a resume's standardized_tests array.
//
// Why this script exists: the AI runbook says "any section whose array
// is empty is skipped — no empty heading, no 'none' placeholder." A
// pre-fix run of the agent ignored that rule for IELTS / TOEFL / SAT
// when the student hadn't taken the exam, emitting rows like
//   { "label": "IELTS", "body": "Not taking. Medium of instruction…" }
// instead of an empty array. The runbook now explicitly forbids those
// placeholder rows; this script cleans up any resume that already
// landed with one before the prompt was tightened.
//
// Detection: a row is a placeholder if its `body` matches one of the
// known not-taken phrases (case-insensitive). We're conservative —
// we only drop rows whose body STARTS with one of those phrases, so
// a legitimate row that mentions "not yet taken" inside a longer
// narrative isn't dropped.
//
// Usage:
//   node server/scripts/strip-placeholder-test-rows.js <student_id>          # dry run
//   node server/scripts/strip-placeholder-test-rows.js <student_id> --apply  # commit

import "dotenv/config";
import pool from "../db.js";

const PLACEHOLDER_PATTERNS = [
  /^not taking\b/i,
  /^not yet taken\b/i,
  /^haven['’]?t taken\b/i,
  /^planning to take\b/i,
  /^plan(s|ning)? to take\b/i,
  /^will take\b/i,
  /^to be (taken|booked|scheduled)\b/i,
  /^n[/.]?a\b/i,
  /^none\b/i,
];

function isPlaceholder(body) {
  if (typeof body !== "string") return false;
  const trimmed = body.trim();
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

async function main() {
  const studentId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!studentId) {
    console.error("Usage: strip-placeholder-test-rows.js <student_id> [--apply]");
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, content_json
       FROM intake_resumes
      WHERE student_id = $1 AND status = 'succeeded'
      ORDER BY created_at DESC`,
    [studentId]
  );

  for (const r of rows) {
    const cj = r.content_json;
    if (!cj || typeof cj !== "object") continue;
    const tests = Array.isArray(cj.standardized_tests) ? cj.standardized_tests : [];
    const kept = tests.filter((t) => !isPlaceholder(t?.body));
    const dropped = tests.length - kept.length;
    console.log(
      `[strip-placeholder] resume_id=${r.id} standardized_tests: ${tests.length} -> ${kept.length} (dropping ${dropped})`
    );
    for (const t of tests) {
      const placeholder = isPlaceholder(t?.body);
      console.log(`    ${placeholder ? "DROP" : "keep"}: "${t?.label || ""}" — "${(t?.body || "").slice(0, 80)}"`);
    }
    if (dropped === 0) continue;
    if (!apply) continue;

    const next = { ...cj, standardized_tests: kept };
    await pool.query(
      `UPDATE intake_resumes
          SET content_json = $2::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [r.id, JSON.stringify(next)]
    );
    console.log(`    applied to resume ${r.id}.`);
  }

  if (!apply) console.log("\ndry run — re-run with --apply to commit.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
