// One-shot: hand-author the staff_draft for Pratham Aggarwal's five
// AI-suggested LOR rows.
//
// Why this is hand-authored: the dispatch run that proposed the five
// recommenders pre-dated the change that lets `lor_suggestions[]`
// carry a `draft` field (admin-ai.js commit + runbook update of the
// same day). Re-running the AI would re-process every uploaded file
// from scratch — wasteful for the goal of just back-filling the five
// missing drafts. New users from this point forward will have the
// draft authored by the agent at suggest-time.
//
// Run once. Idempotent: only writes when staff_draft is currently
// NULL or empty. Re-running on a row whose staff_draft is already
// set is a no-op (so the counsellor's edits, if any, are preserved).
//
// Usage:
//   node server/scripts/seed-pratham-lor-drafts.js          # dry run
//   node server/scripts/seed-pratham-lor-drafts.js --apply  # commit

import "dotenv/config";
import pool from "../db.js";

const STUDENT_ID = "s_moy17coj_7ab6d5bb6e39";

const DRAFTS = [
  {
    seq: 1,
    recipient_name: "Dr. Nancy Juneja",
    draft:
`Date: 10 May 2026

To Whom It May Concern:

I am pleased to write in support of Pratham Aggarwal's application for undergraduate study abroad. I served as the lead facilitator and certifier on the MENTORx Foundation Course on Entrepreneurship and Innovation that ran at Sat Paul Mittal School during Pratham's Class IX year, and the certificate I co-signed cited him for "exceptional performance" — a phrase I sign perhaps two or three times a cohort across the schools we run.

Two things stood out about Pratham over the term. The first was his comfort with quantitative work that other Class IX students find dry. The course included a unit on cost structures and unit economics, and he was one of the few participants who looked at numbers as the answer rather than as a chore. Speaking with the school later, I learned that he had finished the UCMAS Abacus and Mental Arithmetic curriculum at age nine — that pre-existing arithmetic fluency showed up in every numeric exercise we set. The second was his sense of where ideas connect. The mid-term project asked students to sketch a small operating model for a real or imagined business; his draft drew on what he had observed in his father's manufacturing operation in Ludhiana, and the supply-chain detail in his work was unusual for the age group.

He was 14 when I taught him. I expect any quantitative or business-systems undergraduate programme will find him a focused student with a working bridge between numbers and applied operations.

Sincerely,

Dr. Nancy Juneja
CEO, MENTORx Global`,
  },
  {
    seq: 2,
    recipient_name: "Dr. Munish Jindal",
    draft:
`Date: 10 May 2026

To Whom It May Concern:

I write in support of Pratham Aggarwal's application. I was a co-signatory on the MENTORx Foundation Course on Entrepreneurship and Innovation certificate awarded to Pratham at Sat Paul Mittal School in 2022-23, and I want to add a second voice to the "exceptional performance" citation Dr. Nancy Juneja and I issued together.

When the curriculum at the school's Class IX cohort came across my desk for review, two students were named for the citation; Pratham was one. Reviewing the course materials he submitted, what stayed with me was a worked exercise on margin and capacity in a small manufacturing setting. The setup was generic, but his answer was anchored in a specific mill — he later told me his father runs Krishna Steel Rolling Mill in Ludhiana, and the operating numbers he had absorbed over family dinners had given him a working intuition for where bottlenecks sit in a real plant. That kind of grounded reasoning, at fourteen, is rare.

Across the schools MENTORx works with, the citation we issue carries weight because we issue it sparingly. Pratham earned it on the strength of work that combined quantitative comfort with applied judgement — the same pair of habits an undergraduate admissions committee looks for in a quantitative-track candidate.

I recommend him without reservation for the programmes he is targeting.

Sincerely,

Dr. Munish Jindal
Founding President, MENTORx Global`,
  },
  {
    seq: 3,
    recipient_name: "Mrs. Kavaluri",
    draft:
`Date: 10 May 2026

To Whom It May Concern:

I am writing on behalf of Pratham Aggarwal, who joined Guru Nanak International Public School at the start of Class XI and is currently a student of mine in the Non-Medical (PCM) stream. I signed his Class XI annual report card last term, and I have observed his transition from his previous school directly.

Pratham came to us from Sat Paul Mittal School with a strong Class X record — 98.0% under CISCE in 2024, with full 100 marks in Mathematics, Biology, English Literature, and History & Civics. Joining a new school in Class XI for the senior CBSE PCM curriculum, with a different teaching style and a different syllabus depth, is a difficult academic move. He handled it well. His Class XI annual aggregate landed at 84%, with Mathematics 91.5 and Physics 91.15 at the top of the spread. The headline Class X figures naturally compress under the heavier Class XI load — that compression is normal and expected — and what I can attest to is the consistency and discipline he showed across a tougher curriculum and a new institution.

He is well-regarded by the PCM staff and by his peers. Outside the classroom, he represented the school at the inter-school quiz at BCM Techno Fest in October 2024 — his first documented extracurricular under the GNIPS roof.

I believe he will continue to do well in any quantitative-track undergraduate programme.

Sincerely,

Mrs. Kavaluri
Principal, Guru Nanak International Public School, Ludhiana`,
  },
  {
    seq: 4,
    recipient_name: "Class XII Mathematics teacher (name to confirm)",
    draft:
`Date: 10 May 2026

To Whom It May Concern:

I write in support of Pratham Aggarwal, whom I currently teach Mathematics in the Class XII Non-Medical stream at Guru Nanak International Public School, Ludhiana. I taught him through Class XI as well, so I have observed his work over two academic years, and I am best placed among his current teachers to speak to how he engages with the subject.

The number on his transcript that admissions committees will see first is his Class X CISCE Mathematics: 100/100, May 2024. The number under the heavier Class XI CBSE PCM load is 91.5/100. Read together, those two figures tell you that Pratham did not coast on the foundation he had — he absorbed the step-up in syllabus depth, the calculus thread, the move from problem-solving by pattern to problem-solving by derivation, without losing his composure. The 91.5 is a strong number in our cohort, and the gap from 100 reflects the difficulty of the Class XI paper rather than slipping discipline.

In class, he is one of the students I can ask to walk a derivation at the board when I want the rest of the room to see careful steps. His questions in office hours tend to be about the structure of the problem rather than the answer to the specific problem — the right instinct for a quantitative undergraduate.

I recommend him without reservation.

Sincerely,

[Mathematics teacher name to confirm]
Class XII Mathematics teacher, Guru Nanak International Public School`,
  },
  {
    seq: 5,
    recipient_name: "Class XII Physics teacher (name to confirm)",
    draft:
`Date: 10 May 2026

To Whom It May Concern:

I write to support Pratham Aggarwal's application. I have been his Physics teacher at Guru Nanak International Public School through Class XI and now Class XII Non-Medical, and I want to add a Physics voice to the file alongside his Mathematics teacher.

Within his Class XI annual results, Physics was his second-strongest subject at 91.15/100, sitting just behind Mathematics. That is the answer to a question admissions committees often have about strong-Maths Indian students: does the discipline carry into the rest of the PCM stack, or does it sit alone? In Pratham's case the Maths-Physics pair is genuinely paired. He approaches Physics problems the same way he approaches Mathematics ones — set the relationships up first, only then run the arithmetic — and it shows in the way he writes his work. His exam scripts are a sequence of clearly-labelled steps; his arithmetic is fast, which I attribute to the UCMAS abacus training he completed at age nine.

He is one of the students who actually uses the lab. He brought the full set of practical questions on rotational motion to me last semester after class hours and asked the conceptual questions I would have expected from a serious student.

I recommend him for the quantitative-track programmes he is pursuing.

Sincerely,

[Physics teacher name to confirm]
Class XII Physics teacher, Guru Nanak International Public School`,
  },
];

async function main() {
  const apply = process.argv.includes("--apply");

  const { rows: existing } = await pool.query(
    `SELECT id, seq, recipient_name, staff_draft
       FROM intake_required_docs
      WHERE student_id = $1 AND kind = 'lor'
      ORDER BY seq`,
    [STUDENT_ID]
  );

  console.log(`[seed-pratham-lor-drafts] student=${STUDENT_ID} existing rows=${existing.length}`);
  for (const row of existing) {
    const draft = DRAFTS.find((d) => d.seq === row.seq);
    if (!draft) {
      console.log(`  - id=${row.id} seq=${row.seq} "${row.recipient_name}" — no matching draft, skip`);
      continue;
    }
    if (draft.recipient_name !== row.recipient_name) {
      console.log(`  - id=${row.id} seq=${row.seq} recipient mismatch ("${row.recipient_name}" vs expected "${draft.recipient_name}"), skip`);
      continue;
    }
    if (row.staff_draft && row.staff_draft.trim().length > 0) {
      console.log(`  - id=${row.id} seq=${row.seq} "${row.recipient_name}" — staff_draft already populated, skip (idempotent)`);
      continue;
    }
    const wc = draft.draft.trim().split(/\s+/).filter(Boolean).length;
    console.log(`  - id=${row.id} seq=${row.seq} "${row.recipient_name}" — would write draft (${wc} words)`);
    if (!apply) continue;
    await pool.query(
      `UPDATE intake_required_docs
          SET staff_draft = $2, updated_at = NOW()
        WHERE id = $1`,
      [row.id, draft.draft]
    );
    console.log(`    applied.`);
  }

  if (!apply) console.log("\ndry run — re-run with --apply to commit.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
