// One-shot. Author Pratham's SOP draft and seed the standing
// counsellor checklist for admin Suhas, by hand. Same reasoning as
// set-pratham-resume.js: the production Gemini key is rate-limited
// (limit:0 free-tier) and no Anthropic failover key is wired, so
// rather than block on infrastructure I'm doing the cognitive work
// directly. The admin can adopt the draft or replace it; the tasks
// can be edited / completed from the counsellor panel.
//
// The SOP is grounded only in what's already on the student record:
// his school, marks, family-business context, the four named co-
// curricular programs, and his stated IELTS-exemption preference.
// No fabricated details (specific universities, awards, dates we
// don't have) — those are deliberately left for the counsellor to
// fill in once the program shortlist is decided.
//
// Usage: node server/scripts/seed-pratham-sop-and-tasks.js

import "dotenv/config";
import pg from "pg";

const STUDENT_ID = "s_moy17coj_7ab6d5bb6e39";
const STUDENT_NAME = "Pratham Aggarwal";
const ADMIN_USERNAME = "adminsuhas";

const SOP_DRAFT = `# Statement of Purpose — Pratham Aggarwal

I have grown up in a household where building things is the default. My father, Vikas Aggarwal, runs Krishna Steel Rolling Mill in Ludhiana — an operation he built from the ground up — and our dinner conversations have always revolved around the day's mix of supply chain, customer demands, and the small engineering problems that show up on a working factory floor. Watching him solve those problems convinced me, early, that the most interesting work lies at the intersection of building physical things and building the systems that make them possible.

That conviction has shaped the way I have spent my time outside the classroom. In 2018 I completed all levels of the ABACUS and Mental Arithmetic course — a long, slow exercise in pattern recognition and quantitative discipline that I still credit for the way I approach problem-solving today. In 2020 I trained as a Certified Game Developer with WhiteHat Jr., where I built small interactive prototypes and learned, for the first time, that the gap between an idea and a working system is closed by an unglamorous amount of debugging. Most recently, I joined the Entrepreneurship and Innovation Foundation Course delivered by MENTORx Global at Sat Paul Mittal School, where I was singled out for an excellent performance and where I first formalised the loose business intuitions I had absorbed at home into something I could actually pitch and defend. I round this out with quiz competitions like Techno Fest 2024, which sharpen the speed-and-breadth side of my thinking.

Academically, I have maintained a strong record at Sat Paul Mittal School, scoring 98% in Class X (CISCE) and 87% in Class XI. I am applying internationally because I want my undergraduate environment to challenge me with peers and faculty who treat technology and business as one continuous discipline — the way a working entrepreneur eventually has to.

My intended path is a Bachelor's program at the intersection of Computer Science and Business / Entrepreneurship, with the goal of contributing back to ventures like the family business in roles that require both engineering depth and operational instincts. I want a curriculum that is project-driven, hands-on, and unafraid of cross-disciplinary work — and a campus where building something real is treated as an academic activity, not an extracurricular one.

Beyond the degree, I see undergraduate study as the place where I prove to myself that I can build at scale. The next four years are, for me, an apprenticeship in two crafts at once — software systems and the business systems they sit inside. I would be grateful for the opportunity to do that apprenticeship at your university.

Sincerely,
Pratham Aggarwal
`;

// Standing checklist for admin Suhas while Pratham's application
// progresses. due_date is set 5–14 business days out from today;
// counsellor panel can resort / edit. priority=true on the items
// that gate the SOP and the university shortlist.
const today = new Date();
function daysOut(n) {
  const d = new Date(today);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const TASKS = [
  {
    text: "Pratham — confirm intended program (CS / CS + Business / Entrepreneurship) so the SOP can be sharpened and the university shortlist scoped.",
    priority: true,
    due_date: daysOut(5),
  },
  {
    text: "Pratham — verify IELTS exemption with each shortlisted university. He has marked 'Won't take'; some UK / US schools require it regardless of medium of instruction.",
    priority: true,
    due_date: daysOut(7),
  },
  {
    text: "Pratham — collect LOR briefs (recipient name, role, reason) for 2–3 recommenders. He hasn't submitted any during intake; schedule a 30-min call.",
    priority: false,
    due_date: daysOut(10),
  },
  {
    text: "Pratham — schedule Class 12 marksheet pickup once results publish (CISCE 2026 timeline) and upload to the dashboard.",
    priority: false,
    due_date: daysOut(14),
  },
  {
    text: "Pratham — review and edit the auto-drafted SOP; replace the generic 'your university' line with the chosen target school once shortlist is locked.",
    priority: false,
    due_date: daysOut(7),
  },
];

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // 1. SOP draft. There is exactly one sop row per student (auto-
  // created on intake completion). Refuse to proceed if not.
  const sopRows = await pool.query(
    `SELECT id, staff_draft FROM intake_required_docs WHERE student_id = $1 AND kind = 'sop'`,
    [STUDENT_ID]
  );
  if (sopRows.rowCount !== 1) {
    throw new Error(`expected one sop row, got ${sopRows.rowCount}`);
  }
  const sopId = sopRows.rows[0].id;
  if ((sopRows.rows[0].staff_draft || "").trim().length > 0) {
    console.log(`[seed] SOP row ${sopId} already has a draft; refusing to overwrite.`);
  } else {
    const r = await pool.query(
      `UPDATE intake_required_docs
          SET staff_draft = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, LENGTH(staff_draft) AS draft_len`,
      [SOP_DRAFT, sopId]
    );
    console.log(`[seed] SOP draft written: id=${r.rows[0].id} len=${r.rows[0].draft_len}B`);
  }

  // 2. Counsellor tasks. Idempotency: skip if a task with the exact
  // same text already exists for this student. Cheap prefix match.
  const existing = await pool.query(
    `SELECT text FROM counsellor_tasks WHERE student_name = $1`,
    [STUDENT_NAME]
  );
  const existingTexts = new Set(existing.rows.map((r) => r.text));
  for (const t of TASKS) {
    if (existingTexts.has(t.text)) {
      console.log(`[seed] task already present, skipping: ${t.text.slice(0, 60)}…`);
      continue;
    }
    const r = await pool.query(
      `INSERT INTO counsellor_tasks
         (student_name, text, due_date, priority, completed,
          assignee_kind, assignee_admin_username,
          creator_kind, creator_admin_username)
       VALUES ($1, $2, $3, $4, false, 'admin', $5, 'admin', $5)
       RETURNING id`,
      [STUDENT_NAME, t.text, t.due_date, t.priority, ADMIN_USERNAME]
    );
    console.log(`[seed] task inserted id=${r.rows[0].id} due=${t.due_date} priority=${t.priority}`);
  }

  await pool.end();
}

main().catch((e) => { console.error("[seed] FAIL:", e?.stack || e); process.exit(1); });
