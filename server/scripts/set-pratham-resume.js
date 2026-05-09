// One-shot. The user instructed me (Claude Opus 4.7) to author
// Pratham's profile resume by hand instead of calling the LLM
// generators (Gemini quota was exhausted, no Anthropic key wired).
// Writes the markdown straight onto intake_resumes row id=6 and
// flips status to 'succeeded'. Also takes a fresh snapshot of the
// student's current data into source_snapshot so the staleness
// detector on the admin panel reflects what this draft was based on.
//
// The content is grounded only in what's already on the student
// record — no fabricated grades, awards, or quotes. Every claim
// can be verified against intake_students.data.answers and the
// uploaded files in R2.
//
// Usage: node server/scripts/set-pratham-resume.js

import "dotenv/config";
import pg from "pg";

const RESUME_ID = 6;
const STUDENT_ID = "s_moy17coj_7ab6d5bb6e39";

const CONTENT_MD = `# Pratham Aggarwal

**Class XI student, Satpaul Mittal School, Ludhiana, Punjab**

Pratham Aggarwal (DOB 1 June 2008) is a Class XI student at Satpaul Mittal School in Ludhiana, the elder son of Vikas Aggarwal — proprietor of Krishna Steel Rolling Mill — and Pooja Aggarwal. He is preparing for undergraduate applications and has elected to enter the admissions cycle without an IELTS, relying on the international scope of his school curriculum and his English-medium academic record.

## Academic record

- **Class X**: 98% (CISCE board). Full marksheet on file.
- **Class XI**: 87% in the most recent reporting period; report card on file.

## Co-curricular profile

Pratham has built a sustained record of skill-development engagements outside the classroom:

- **ABACUS & Mental Arithmetic** — completed all levels of the certified course (6 May 2018), an early signal of his comfort with quantitative reasoning.
- **Entrepreneurship & Innovation Foundation Course** — delivered by MENTORx Global on the school campus; Pratham's performance was noted as excellent.
- **WhiteHat Jr Certified Game Developer (2020)** — hands-on training in game design and UI/UX, with project submissions completed.
- **Techno Fest 2024 — Inter-school Quiz Competition** — competitive participation that reinforced his analytical and general-awareness habits.

## Closing note

The combination of a near-perfect Class X, sustained Class XI performance, and a multi-year arc of self-directed enrichment — quantitative, entrepreneurial, technical, and competitive — gives Pratham a compact but well-rounded portfolio for undergraduate review. ID proof, marksheets, activity certificates, and a recent passport-style photograph are uploaded and linked on the intake panel.
`;

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const sCheck = await pool.query(
    `SELECT data, updated_at FROM intake_students WHERE student_id = $1`,
    [STUDENT_ID]
  );
  if (sCheck.rows.length !== 1) {
    throw new Error(`expected one student row for ${STUDENT_ID}, got ${sCheck.rows.length}`);
  }
  const studentData = sCheck.rows[0].data;
  const studentUpdatedAt = sCheck.rows[0].updated_at;

  // Word count for the column. Same algorithm the validator uses:
  // collapse whitespace, count non-empty tokens.
  const wc = CONTENT_MD.trim().split(/\s+/).filter(Boolean).length;
  console.log(`[resume] handwritten content_md: ${CONTENT_MD.length}B, ~${wc} words`);

  // Snapshot the student's answers + the actual_words alongside the
  // resume row, so the admin panel's "may be stale" detector can
  // compare against future student edits.
  const snapshot = {
    handwritten_by: "claude-opus-4-7-1m",
    handwritten_at: new Date().toISOString(),
    actual_words: wc,
    target_words: 300,
    student_updated_at: studentUpdatedAt instanceof Date
      ? studentUpdatedAt.toISOString()
      : String(studentUpdatedAt),
    answers: (studentData && studentData.answers) || {},
  };

  const r = await pool.query(
    `UPDATE intake_resumes
        SET status = 'succeeded',
            content_md = $1,
            error = NULL,
            length_words = $2,
            label = 'profile-summary (handwritten)',
            source_snapshot = $3::jsonb,
            updated_at = NOW()
      WHERE id = $4 AND student_id = $5
      RETURNING id, status, length_words, LENGTH(content_md) AS content_len`,
    [CONTENT_MD, wc, JSON.stringify(snapshot), RESUME_ID, STUDENT_ID]
  );
  if (r.rowCount !== 1) {
    throw new Error(`UPDATE matched ${r.rowCount} rows — refusing to proceed.`);
  }
  console.log("[resume] updated:", r.rows[0]);
  await pool.end();
}

main().catch((e) => { console.error("[resume] FAIL:", e?.stack || e); process.exit(1); });
