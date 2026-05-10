// One-shot script — writes Pratham's resume as structured content_json
// onto intake_resumes row id=6, superseding the old content_md draft.
//
// All data is grounded in uploaded documents (Aadhaar, Class X marksheet,
// Class XI report card, UCMAS certificate, MENTORx certificate,
// WhiteHat Jr certificate, BCM Techno Fest certificate).
//
// Usage: node server/scripts/set-pratham-resume.js

import "dotenv/config";
import pg from "pg";

const RESUME_ID = 6;
const STUDENT_ID = "s_moy17coj_7ab6d5bb6e39";

const CONTENT_JSON = {
  schema_version: 2,
  name: "Pratham Aggarwal",
  headline: "Class XI Non-Medical (PCM) · Guru Nanak International Public School, Ludhiana",
  contact: { show: false, phone: "", email: "" },
  lede: "98.0% in ICSE Class X with four perfect 100s. In Class XI PCM at GNIPS, Ludhiana, with a sustained record across abacus, entrepreneurship, and game development from age nine.",
  education: [
    {
      label: "Class X — CISCE (ICSE)",
      gpa: "98.0%",
      body: "Four perfect 100s: English Literature, Mathematics, Biology, History & Civics. STEM avg 99.5 (Maths 100, Physics 99, Chemistry 99, Biology 100); Humanities avg 98.0.",
      meta: "Sat Paul Mittal School, Ludhiana · May 2024 · 588 / 600",
    },
    {
      label: "Class XI — Non-Medical (PCM)",
      gpa: "84%",
      body: "Mathematics 91.5 and Physics 91.15 lead; Chemistry 82.25, English 82.15. Promoted to Class XII.",
      meta: "Guru Nanak International Public School, Ludhiana · Session 2024-25",
    },
  ],
  standardized_tests: [],
  awards: [
    {
      label: "MENTORx Exceptional Performance — Entrepreneurship & Innovation",
      body: "Awarded the 'exceptional performance' distinction (the certificate's own wording) at the campus programme delivered by MENTORx Global at Sat Paul Mittal School.",
      meta: "MENTORx Global · Sat Paul Mittal School · 2022-23",
    },
    {
      label: "UCMAS Certificate of Graduation — All 10 Levels",
      body: "Completed the full Abacus and Mental Arithmetic curriculum. Most enrolees exit at levels 3-4; completing all ten is uncommon and marks an early commitment to quantitative discipline.",
      meta: "UCMAS India, Vadodara · 6 May 2018",
    },
  ],
  activities: [
    {
      label: "WhiteHat Jr — Certified Game Developer",
      body: "Completed hands-on game-development and UI/UX training at age 11-12; certified for exceptional skills and project outcomes by Founder Karan Bajaj.",
      meta: "WhiteHat Jr · 2020",
    },
    {
      label: "BCM Techno Fest — Inter-school Quiz",
      body: "Represented GNIPS at BCM School's annual inter-school festival within months of transferring, competing in the Quiz event against school-wide entries.",
      meta: "BCM School, Ludhiana · 14-15 October 2024",
    },
  ],
  internships: [],
  volunteer: [],
  publications: [],
  skills: [],
  languages: ["English", "Hindi", "Punjabi"],
  closing_note: "",
};

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

  // Word count across all visible text fields.
  const allText = [
    CONTENT_JSON.name, CONTENT_JSON.headline, CONTENT_JSON.lede,
    ...CONTENT_JSON.education.flatMap((x) => [x.label, x.body, x.meta, x.gpa]),
    ...CONTENT_JSON.awards.flatMap((x) => [x.label, x.body, x.meta]),
    ...CONTENT_JSON.activities.flatMap((x) => [x.label, x.body, x.meta]),
    ...(CONTENT_JSON.languages || []),
  ].join(" ");
  const wc = allText.trim().split(/\s+/).filter(Boolean).length;
  console.log(`[resume] content_json: ~${wc} words`);

  const snapshot = {
    handwritten_by: "claude-sonnet-4-6",
    handwritten_at: new Date().toISOString(),
    format: "content_json",
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
            content_json = $1::jsonb,
            content_md = NULL,
            error = NULL,
            length_words = $2,
            label = 'profile-summary (v2)',
            source_snapshot = $3::jsonb,
            updated_at = NOW()
      WHERE id = $4 AND student_id = $5
      RETURNING id, status, length_words`,
    [JSON.stringify(CONTENT_JSON), wc, JSON.stringify(snapshot), RESUME_ID, STUDENT_ID]
  );
  if (r.rowCount !== 1) {
    throw new Error(`UPDATE matched ${r.rowCount} rows — refusing to proceed.`);
  }
  console.log("[resume] updated:", r.rows[0]);
  await pool.end();
}

main().catch((e) => { console.error("[resume] FAIL:", e?.stack || e); process.exit(1); });
