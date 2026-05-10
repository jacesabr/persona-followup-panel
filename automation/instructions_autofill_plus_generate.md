# instructions_autofill_plus_generate.md

The master command for the AI artifact pipeline. The persona-followup
counsellor team triggers this **manually** when a new student is signed
up (with or without pre-uploaded documents). Jace receives a queued
request via email + the AI Queue tab on the admin panel, opens Claude
Code locally on this repo, and runs the script end-to-end.

This file is the runbook the agent (a Claude Code session) reads cold.
It contains every step, every prompt, every DB write target, and the
manual-fill request workflow.

There is **no scheduled cron and no remote routine.** The pipeline
runs locally from Claude Code on the dev's machine — terminal `claude`,
the desktop app, or VS Code Claude Code, whichever surface the dev is
in front of. Trigger when the request queue has pending entries
(counsellor clicks "Request manual AI fill" on the credentials modal,
which inserts a row into `manual_ai_requests`).

The agent that runs this **is** the LLM (a Claude Max session via
Claude Code). There is no Gemini / Anthropic API call — the agent
reads context, authors text in its own head, and writes results back
via the `/api/admin/ai/dispatch` HTTP endpoint on the deployed
persona-followup-panel service.

---

## Goal per run

For every student whose intake is finished (or whose counsellor
pre-uploaded starter docs) but who hasn't yet been through the
pipeline, generate:

1. **Per-file description + extraction** — a long-form markdown
   document for every active uploaded file (Aadhar, marksheets,
   passport, certificates, IELTS results, etc.). The description is
   the only context downstream artifacts have for that file, so
   it must be exhaustive (verbatim transcription + structured fields
   + numeric summary + conclusions). See **Section A** below.
2. **Autofill** — propose values for every empty intake-form answer
   that the file extractions provided. Server-side merge enforces
   no-overwrite, so it's safe to send keys that may already be set.
3. **Resume** — JSON-structured payload (preferred) or markdown
   (legacy fallback). Stealth Mode rules apply: no banned words /
   phrases / em-dashes, plain language, no fluff.
4. **SOP draft** — first-person, three paragraphs, ~400–600 words,
   anchored to the student's own activities and answers.
5. **LOR drafts** — one per `kind='lor'` row in `intake_required_docs`
   whose `staff_draft` is NULL. Recommender voice, 200–300 words.
6. **Internship drafts** — one per `kind='internship'` row whose
   `staff_draft` is NULL. Company voice, 150–250 words.

All writes land in one atomic POST to `/api/admin/ai/dispatch` per
student. The endpoint stamps
`intake_students.ai_artifacts_generated_at = NOW()` on commit so the
candidate query never resurfaces this student.

---

## Preconditions

- Routine running in Anthropic Cloud, repo cloned to its sandbox.
- Deployed prod API at `https://persona-followup-panel.onrender.com`
  is the agent's interface — no DB credentials needed.
- Admin login: username `admin123`, password `admin123` (both fields
  the same string; see `EXTRA_ADMINS` env var on Render for the named
  admins jace100233260 actually uses).
- **Cap: 5 students per run.** Hard.

---

## Step 1 — Log in (admin)

```bash
curl -s -c /tmp/cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"username":"admin123","password":"admin123"}' \
  https://persona-followup-panel.onrender.com/api/auth/login
```

The `Set-Cookie: persona_session=<uuid>` is captured into
`/tmp/cookies.txt`. Use `-b /tmp/cookies.txt` on every subsequent
request.

If login fails: stop, print the error, exit 0.

---

## Step 2 — Pull candidates (cap 5)

```bash
curl -s -b /tmp/cookies.txt 'https://persona-followup-panel.onrender.com/api/admin/ai/pending?limit=5'
```

Returns:
```json
{ "candidates": [
  { "student_id": "s_…", "display_name": "…", "files_count": N, "source_kind": "intake_done" | "pre_upload", … }
]}
```

Two cohorts qualify:
- **`intake_done`** — student finished filling their own intake form
  and uploaded their own docs. Standard path.
- **`pre_upload`** — counsellor signed the student up via
  `/api/students/with-docs` and pre-attached starter documents
  (`ai_eligible_via_pre_upload = TRUE`). The intake form is still
  `intake` (the student hasn't logged in yet) — we still want the
  pipeline to read uploaded docs, autofill the form, and draft the
  resume so the student lands on a pre-filled flow.

If the array is empty: print `[ai-pipeline] no candidates` and exit 0.

Also pull the open manual-fill request queue for context:

```bash
curl -s -b /tmp/cookies.txt 'https://persona-followup-panel.onrender.com/api/admin/ai/manual-requests?status=pending'
```

A counsellor-initiated request has a row here; processing the matched
candidate above is what resolves it (the dispatch endpoint stamps the
matching `manual_ai_requests.processed_at`).

---

## Step 3 — For each candidate, in order

Process one student at a time. If one fails, log the error and
continue with the next.

### 3a. Load full context

```bash
curl -s -b /tmp/cookies.txt https://persona-followup-panel.onrender.com/api/students/<student_id>
curl -s -b /tmp/cookies.txt https://persona-followup-panel.onrender.com/api/required-docs/student/<student_id>
curl -s -b /tmp/cookies.txt https://persona-followup-panel.onrender.com/api/applications/student/<student_id>
```

You now have:
- `student.data.answers` — the intake form values
- `files[]` — every active upload (`superseded_at IS NULL`)
- `required_docs[]` — LOR / Internship / SOP rows
- `applications[]` — the student's school applications

### 3b. Per active file: download + describe (long form)

The previous version of this step asked for a 2–3 sentence prose
blurb. **That is not enough.** A counsellor reading the staff panel
cannot make decisions from a one-line summary; the resume + SOP
composer downstream loses every quantitative detail that didn't
make it into a sentence. Treat each file as if you are the only
person who will ever read it.

For each active file:

```bash
curl -s -b /tmp/cookies.txt -o /tmp/file_<id>.bin \
  https://persona-followup-panel.onrender.com/api/students/<student_id>/files/<file.id>
```

Use the Read tool on `/tmp/file_<id>.bin` (works for images and PDFs
— for multi-page PDFs, read every page; do not stop at page 1).

Compose `ai_description` as a markdown block with the five sections
below in this order. Skip a section only when it would genuinely be
empty.

**Section 1 — Narrative** (no heading; opens the document)

Two layers, in this order. No other sub-headings.

**First: a single paragraph framing the student.** ~40–60 words.
Same opening shape on every file the student has, because every file
benefits from the reader being grounded in who this person is before
they look at the document.

The paragraph names the student, their school + city, their current
class / year, their stream or programme of study, and one anchoring
fact about their direction (target country, intended field) IF the
intake answers carry it. Lift the student details from this file's
visible content where present and from the broader student record
otherwise. If a piece of identity is unknown, leave it out — do not
guess.

Example opener for a marksheet:
> *"Pratham Aggarwal is a Class XI Non-Medical student at Guru Nanak
> International Public School, Ludhiana, applying for CS undergrad
> programmes in the UK and US."*

**Then: layered detail that shapes the narrative for outbound
artifacts.** This is the part that does the real work — the resume,
SOP, and LOR composers read this to ground their bullets. The amount
of detail and the shape depend on what the document actually carries:

- **Academic documents** (marksheets, transcripts, scorecards):
  headline number first (overall %, GPA, band), then strongest 2–3
  subjects with raw marks, weakest with raw marks, trend across
  years if visible, comparison to other files on the same student
  (e.g. "Class XI Maths 84 vs Class X Maths 99 — 15-point drop").
  Anchor every claim to a number on the source.
- **Identity documents** (Aadhar, passport, PAN): the fields
  downstream cares about — name variants, DOB, address, expiry.
  Flag conflicts with `answers.*` here AND in Section 5.
- **Certificates / completion letters**: what was earned, issuing
  body, programme content, cohort size or rank if visible, how it
  connects to the student's stated direction.
- **Recommendation letters / supporting prose**: the recommender's
  specific claims summarised, plus the 1–2 strongest sentences
  quoted verbatim so the SOP / LOR composer can lift them.
- **Photos, signed declarations, single-purpose pages**: the opening
  student paragraph is enough; skip the layered detail.

Total Section 1 length: 150–350 words depending on how much the
document actually carries. A passport bio page is short; a Class XII
predicted-marks transcript is long.

**Section 2 — Verbatim transcription** (under a `### Verbatim`
heading)

Every legible word on the document, in reading order, preserved as
faithfully as possible. Include:
- Headers, sub-headers, school / board / institution names.
- Stamps, seals, watermarks (write `*[stamp: "Controller of
  Examinations"]*` style).
- Signatures (write `*[signature]*` — never invent a name).
- Handwritten annotations (mark with `*[handwritten]*`).
- Footnotes, fine print, terms-and-conditions blocks.
- For multi-page PDFs: prefix each page block with `**— Page N —**`.

For tabular documents (marksheets, transcripts, scorecards) reproduce
the table as a markdown table inside this section. Do not collapse it.

If a value is illegible: `[illegible]`. If you can partially read it:
best guess + `[?]` (e.g. `Math: 96[?]`). **Never invent values** —
when in doubt, mark uncertainty.

**Section 3 — Structured table** (under a `### Fields` heading)

A markdown table with three columns: `Field | Value | Source` where
Source is the visible label / location on the document (e.g. "Top
right header", "Row 3 of marks table"). Lift every distinct data
point. Every subject row becomes a table row. Every Aadhar field
(name, DOB, gender, address line 1, etc.) becomes a row.

This is the human-readable mirror of `ai_extracted` — staff readers
scan this table; the autofill pipeline reads `ai_extracted`.

**Section 4 — Numeric summary** (under a `### Summary` heading)

For documents with numbers (marks, scores, dates, fees, expiry
dates):
- **Totals**: total obtained / total available, percentage to one
  decimal.
- **Per-section averages** if the document groups subjects (STEM avg
  vs Humanities avg).
- **Best / weakest subject** by raw mark.
- **Time signal** for dated documents: years between issue and
  today; for expiry-bearing docs, days/months until expiry.

Skip entirely for docs with no numbers (passport photo, signed
declarations).

**Section 5 — Conclusions** (under a `### Conclusions` heading)

2–5 bullets stating what this document tells us about the student.
Anchor each bullet to a specific number or fact from the
transcription — never a generic statement. Where the document
supports a downstream artifact, say so explicitly so the SOP / LOR
composer can lift the angle.

Each bullet should fit one of these shapes:

- **Narrative signal** — a fact that supports a story the SOP / LOR
  can build around. *"Maths 99 + Physics 96 + CS 95 vs English 78
  supports the quantitative-track SOP angle."*
- **Reconciliation flag** — a discrepancy with `answers.*` that
  needs human attention. *"Aadhar DOB 14 Mar 2008 disagrees with
  `answers.dob` (15 Mar 2008); flag for counsellor."*
- **Operational fact** — actionable timing or validity. *"Passport
  expires 12 Mar 2027; within the 6-month window for 2026 intake,
  flag for renewal before any 2027 intake."*
- **LOR-source flag** — when the document names someone who could
  plausibly write a recommendation (subject teacher whose
  signature appears, mentor on a certificate, internship
  supervisor). *"Marksheet signed by Controller of Examinations,
  Mrs Anjali Verma — not a likely LOR source."* OR *"Entrepreneurship
  course completion certificate names mentor 'Rajiv Mehta, MENTORx
  Global' — strong LOR candidate; surface as a suggestion."*
- **Cross-doc comparison** — when this file's content meaningfully
  agrees / disagrees with another file already on the student.
  *"Class XI Maths 84 vs Class X Maths 99 — 15-point drop; SOP
  should not lean on 'consistently strong in Maths' framing."*

Lead with the actionable signal where one exists. The LOR-source
flag matters: those names feed a separate suggestion list the
counsellor uses to nudge the student.

**Then: compose `ai_extracted`**

A JSON object lifting only the structured fields that map to known
intake answers. Field-mapping registry:

| Document type   | Extracted keys → intake-answer keys |
|---              |---|
| Aadhar card     | `name`, `dob`, `aadhar` (12-digit, formatted `XXXX XXXX XXXX`), `address_*` |
| Passport        | `name`, `dob`, `passport`, `passportExpiry` (ISO date) |
| Marksheet (10)  | `marks10pct`, `school10Name` if visible |
| Marksheet (11)  | `marks11pct` |
| Marksheet (12)  | `marks12pct`, `marks12predicted` |
| IELTS result    | `ielts_score` (overall band, 0.5 step), `ielts_status='Already taken'` |
| TOEFL result    | `toefl_score`, `toefl_booked=true` |
| SAT/ACT result  | `sat_score`, `sat_booked=true` |
| Photo / Other   | nothing extractable; description only |

If a document's content disagrees with an existing intake answer,
**do not overwrite**. The dispatch endpoint enforces this server-side
anyway, but flag the conflict in `summary_notes` so a human can
reconcile.

If you can't read a file at all (corrupted, password-protected,
unsupported format), set `description = "(unable to read this file)"`,
skip `extracted`, and continue. Don't crash.

Collect all `{ file_id, description, extracted }` into an array.
Don't dispatch yet.

### 3c. Author resume + SOP + LORs + internships (in your head)

**Use the per-document detail you wrote in Section 3b.** The
`ai_description` blocks you just composed contain per-subject marks
rows, IELTS Listening/Reading/Writing/Speaking sub-bands, certificate
names, transcript course detail, and recommender annotations. The
typed intake answers collapse those into aggregates (`marks10pct=88`,
`ielts_score=7.5`). The resume / SOP / LOR drafts MUST thread the
granular figures wherever they support a bullet:

- Resume *standardized_tests* entry should list the four IELTS sub-
  bands when visible on the file, not just the overall.
- Resume *education* entries should call out top-3 subjects by raw
  marks, STEM vs Humanities split, or any honors / distinctions
  visible on the marksheet — the typed `marks12pct` does not carry
  any of that.
- SOP body paragraphs that argue "I am strong in quantitative
  reasoning" must back it with the specific marksheet figures
  ("Mathematics 96/100, Physics 94/100"), not the aggregate.
- LOR drafts referencing a recommender's class should cite the
  course / project name verbatim from the marksheet or transcript.

If a piece of granular detail conflicts with the typed intake answer,
trust the document and flag the conflict in `summary_notes`. Never
invent a number that is not in either source.

#### Resume (JSON preferred, markdown fallback)

The frontend renders a structured `<ResumeTemplate>` from
`content_json`. Aim for that. Fall back to `content_md` only if
something blocks JSON construction.

JSON shape — see `automation/resume_schema_v2.md` for the full
canonical reference (every field, render order, visual language, PDF
export path, Stealth Mode rules) and
`automation/example_payloads/sample_resume_v2.json` for a complete
filled-out example. Quick shape (currently schema_version 2):

```json
{
  "schema_version": 2,
  "name": "Pratham Aggarwal",
  "headline": "Class 12 student, Ludhiana, applying CS undergrad UK/US",
  "lede": "Two-paragraph opener anchored to lived experience…",
  "education": [
    { "label": "Class X (CBSE, 2023)", "body": "Satpaul Mittal School. 462/500. Top three: Maths 99, Science 98, Social 96.", "meta": "Ludhiana", "gpa": "92.4%" }
  ],
  "standardized_tests": [
    { "label": "IELTS", "body": "Band 7.5 overall. Listening 8.5, Reading 7.0, Writing 7.0, Speaking 7.5. Taken Oct 2025." }
  ],
  "awards": [
    { "label": "AIR 412, NTSE Stage II", "body": "Top 0.03% across 1.2M candidates.", "meta": "2024" }
  ],
  "publications": [],
  "activities": [
    { "label": "School CS Club, President", "body": "30+ active members. Built a Python tutoring track for Class 9 and 10." }
  ],
  "internships": [],
  "volunteer": [],
  "skills": ["Python", "SQL", "React", "public speaking"],
  "languages": ["English (native)", "Hindi (native)", "Punjabi (fluent)"],
  "closing_note": "Optional one-line sign-off."
}
```

Section rules:
- `education` items SHOULD carry `gpa` when the marksheet shows one
  (use the document's own scale: "92.4%", "9.4/10 CGPA", "4.0/4.0 GPA").
- `awards` is the home for distinctions that previously got buried in
  activities — Olympiad ranks, NTSE / KVPY, scholarships, debate cups.
  Quantify with denominators when the source has them.
- `publications` covers any published / accepted paper, op-ed, or talk.
  Empty array if none — do not pad.
- Stealth Mode applies to every body string in every section.

Length target: **300–450 words across all visible text fields**.
Stealth Mode rules apply — the canonical, fully-fleshed-out version
lives in [`automation/resume_schema_v2.md`](resume_schema_v2.md)
under "Stealth Mode rules." Quick reference, with the additions
that came out of the May 2026 audit:

**Word-level**
- No em-dashes. No semicolons. No filler adjectives. Quantify
  whenever the data supports it. **Never invent achievements.**
- No banned words: *passionate, dedicated, hardworking, ambitious,
  motivated, journey, leverage, foster, navigate, cultivate, embark,
  nurture, embraced, demonstrated, sought, curated, pivotal,
  transformative, holistic, robust, seamless, crucial,
  essential (filler), additionally, indeed*.
- No banned phrase patterns: *"deep dive", "in the realm of",
  "at the heart of", "speaks volumes", "in today's world",
  "in today's digital age", "it's important to note", "stands as a
  testament", "key takeaway", "revolutionize the way",
  "unlock the potential"*.
- No banned verb-openers on bullets: *Spearheaded, Pioneered,
  Orchestrated, Navigated, Cultivated, Fostered, Leveraged,
  Demonstrated, Curated, Embarked*. Lead with concrete verbs
  (*Built, Wrote, Ran, Led, Won, Filed, Coded, Trained, Sold*).

**Structural** (the parts detectors actually weight)
- **No transition stacking.** Never open two consecutive sentences
  (or two paragraph openers in a 3-paragraph SOP) with Furthermore /
  Moreover / Additionally / Indeed / In addition. Even one in a
  single document is a tell.
- **Vary register across sections.** Lede sounds like observing out
  loud, bullets terse fact-first past-tense, closing reflective. If
  the lede could be swapped with a bullet body and the doc still
  flows, re-author — that's the AI-print.
- **Sentence-length distribution.** Across the 3–6 bullets in any one
  section: at least one fragment (5–10 words), at least one longer
  clause (20–25 words with a comma split), the rest 12–18. AI
  defaults to ~13-word sentences over and over.
- **Whole-document lexical diversity.** No verb reused across two
  bullets in the same section. No modifier reused across the doc.
- **The "1000 students" test.** Before saving any bullet, ask: could
  1000 other Indian Class XII applicants copy-paste this exact line?
  If yes, find a specific from the student's `ai_description` blocks
  and rebuild around it. Detectors flag generic phrasing harder for
  non-native writers — that's our cohort, so the bar is higher.

#### SOP draft (~400–600 words, first-person, three paragraphs)

1. Why this field, grounded in lived experience (an activity, a
   class, a moment).
2. What they've done to test that interest (the activities + marks
   evidence).
3. Why this country / program specifically, and what they want to
   do after.

Same Stealth Mode banned-word / banned-phrase rules. Same
no-em-dash / no-semicolon / no-filler rules. Specific to named
programs and countries when the student supplied them in
`answers.paths_list` and `answers.targetCountry`.

**Voice continuity.** The SOP's opening sentence and the resume's
`lede` field should mirror the framing of the student-snapshot
paragraph at the top of every file's `ai_description` (Section 3b).
Same identity, same stream, same target country, same anchoring
direction fact. The rest of the SOP / resume body deepens that
framing with the layered specifics from each file's analysis
paragraph. This keeps voice consistent across every artifact a
counsellor or admissions reader will see together.

#### LOR drafts

For each `kind='lor'` row in `required_docs` whose `staff_draft` is
NULL: 200–300 words in the recommender's voice. Inputs:
- `recipient_name` (the recommender)
- `recipient_role` (their relation to the student)
- `reason_brief` (the 20-word "why this person" the student wrote)
- The student's marks / activities / story for specifics.

Format:
- Header: `Date: [TODAY]`, `To Whom It May Concern:`
- Two substance paragraphs, one closing line.
- Sign-off: `Sincerely,` / `[recipient_name]` / `[recipient_role]`.

Same Stealth Mode rules in the recommender's voice.

#### Internship drafts

For each `kind='internship'` row whose `staff_draft` is NULL: 150–250
words in the company's voice. Standard verification format. Use
`company_name`, `activity_brief`. Two specifics drawn from
`activity_brief` and any related activities.

#### LOR suggestions (NEW)

In addition to drafting the existing LOR rows above, propose
**additional recommenders** the student should consider asking for
a letter — drawn from the activity / internship leaders that surface
in the intake answers and the file extractions.

Source pool, in priority order:

1. **`answers.activities_list[*].leader_name`** — every activity row
   the student listed has a leader_name field; that person ran the
   programme / club / course the activity references.
2. **`answers.internships_list[*].supervisor_name`** if present, OR
   the company contact named in the internship verification letter
   (visible in the related file's `ai_description`).
3. **Recommender-style names lifted from file content** — Section 5
   LOR-source flags from `ai_description` rows (e.g. mentor names
   on completion certificates, course leads named on transcripts).
   Skip controllers of examinations, principals you have never
   interacted with, and pure administrative signatures.

For each candidate, emit one suggestion object:

```json
{
  "recipient_name": "Rajiv Mehta",
  "recipient_role": "Entrepreneurship & Innovation course mentor, MENTORx Global",
  "reason_brief": "Led 8-week course where student was singled out for excellent performance"
}
```

Rules:

- `recipient_name` must be a real name visible in the answers OR a
  file extraction. **Do not invent.** If the source has only a role
  ("Class XII Maths teacher") and no name, skip.
- `recipient_role` should describe the relationship to the student
  in ~10 words — what programme / class / project connected them.
- `reason_brief` is the same 20-word constraint as student-typed LOR
  briefs. Anchor to the specific accomplishment that this person
  witnessed.
- **Cap at 5 suggestions per student.** More than 5 is noise; the
  student picks 2–3 to actually pursue.
- **Do not duplicate** recipients the student already entered as
  kind='lor' rows during intake (server-side dedup catches this on
  recipient_name match anyway, but skip locally to keep the
  payload tight).

The dispatch endpoint inserts each suggestion as a kind='lor' row
with `student_accepted_at = NULL`. The student sees them on their
dashboard as cards with a check (accept) or X (delete) action.
Accepted suggestions enter the existing draft → request → received
lifecycle; the counsellor drafts the actual LOR text afterwards.

#### Autofill answers

Merge every `extracted` object into a single proposed answer-set.
Only include keys that map to known intake fields (see registry
above). The dispatch endpoint enforces no-overwrite; safe to send
keys that may already be set — they'll be skipped server-side.

### 3d. Dispatch (atomic write)

```bash
curl -s -b /tmp/cookies.txt -X POST -H 'Content-Type: application/json' \
  --data @/tmp/dispatch_<student_id>.json \
  https://persona-followup-panel.onrender.com/api/admin/ai/dispatch
```

Body shape:

```json
{
  "student_id": "s_…",
  "file_descriptions": [
    { "file_id": 24, "description": "<full Section 1–5 markdown>", "extracted": { "aadhar": "…", "name": "…" } }
  ],
  "autofill_answers": { "aadhar": "1234 5678 9012", "marks10pct": 92 },
  "resume_json": { "name": "…", "headline": "…", "lede": "…", … },
  "resume_md": null,
  "sop_draft": "I have always been drawn to…",
  "lor_drafts": [ { "doc_id": 31, "draft": "…" } ],
  "internship_drafts": [ { "doc_id": 33, "draft": "…" } ],
  "lor_suggestions": [
    { "recipient_name": "Rajiv Mehta", "recipient_role": "Entrepreneurship course mentor, MENTORx Global", "reason_brief": "Led 8-week course where student was singled out for excellent performance" }
  ],
  "summary_notes": "free-form notes for the audit row (e.g. conflicts you flagged)"
}
```

Write to `/tmp/dispatch_<student_id>.json` first to dodge shell
quoting hell. The endpoint returns a `summary` object with the count
of writes per category.

On HTTP 4xx/5xx: log the error, **do not** mark the student done,
continue with the next candidate.

### 3e. Resolve any matching manual_ai_requests row

The dispatch endpoint stamps `manual_ai_requests.processed_at` for
the most recent unresolved row matching this student_id and sets
`processed_by_admin_username` from the cookie's admin identity.
Counsellors poll this status from the create-student banner so the
"queued — dev has been notified to run the automation script from
Claude Code" indicator flips to "fill-in complete" without a page
reload.

---

## Step 4 — Final summary

Print at end:

```
[ai-pipeline] processed: N students
  files described: ...
  answers autofilled: ...
  resumes inserted: ...
  SOP drafts: ...
  LOR drafts: ...
  internship drafts: ...
  manual requests resolved: ...
  skipped (with reason): student_id — reason
```

---

## Section A — Manual-fill request workflow (counsellor side)

**On the counsellor's "Sign up a new student" form**, after they
submit, a button appears: **"Request manual AI fill"**. Clicking it:

1. POSTs to `/api/admin/ai/request-manual-fill` with
   `{ student_id, notes? }`.
2. Server inserts a row into `manual_ai_requests` and returns OK.
3. The button collapses to a status banner:
   *"Request queued — dev has been notified to run the automation
   script from Claude Code."*
4. The banner also offers a `mailto:` link with prefilled subject /
   body addressed to **jace100233260@gmail.com**, so the counsellor
   can optionally also send an email — server-side email isn't wired,
   the mailto bridge is the notification path.

The counsellor's UI polls the request status every minute. Once the
dev runs the script and the dispatch resolves it, the banner flips to
*"Fill-in complete — open the student to view the new resume / SOP /
LOR drafts."*

---

## Section B — How Jace runs a manual fill (the actual flow)

The pipeline runs **locally from Claude Code on the dev's machine**.
There is no scheduled cron and no cloud routine. When you (the dev)
get a request:

1. Open Claude Code locally on the `persona-followup-panel` repo
   (terminal `claude`, the desktop app, or a VS Code session — any
   Claude Code surface works, since the script is just curl + Read
   tool calls).
2. Tell Claude: *"Follow `automation/instructions_autofill_plus_generate.md`
   end-to-end."* The session reads this file, logs in as admin via
   `/api/auth/login`, walks Step 1 → Step 4, and processes up to 5
   students (the `manual_ai_requests` queue + any
   `intake_phase='done'` / `ai_eligible_via_pre_upload=TRUE` student
   that's not yet been processed).
3. Watch the run inline. The final summary block lands at the end.
4. Verify in the staff panel: the affected students show new resumes,
   SOP drafts, LOR drafts; their files have `ai_description` /
   `ai_extracted` populated; their `manual_ai_requests` row(s) flip to
   `processed_at = NOW()` and the counsellor banner shows "complete".

If the run fails partway, the unresolved students stay in the queue —
re-run the script. The dispatch endpoint is idempotent: file
descriptions overwrite (re-runs improve), answers no-overwrite, drafts
no-overwrite unless `force=true`.

If you want to run a single specific student manually (skip the queue
gate), set `ai_artifacts_generated_at = NULL` for that student first,
then re-run:

```sql
UPDATE intake_students SET ai_artifacts_generated_at = NULL WHERE student_id = '<id>';
```

---

## Section C — Schema reference (what the pipeline touches)

Tables the agent reads:
- `intake_students` — `data.answers`, `intake_phase`, `is_archived`, `ai_eligible_via_pre_upload`, `ai_artifacts_generated_at`
- `intake_files` — every active upload's metadata + bytes
- `intake_required_docs` — LOR/internship/SOP rows; `staff_draft` is the write target
- `intake_applications` — context only
- `manual_ai_requests` — pending queue

Tables the agent writes (via the `/dispatch` endpoint, all atomic):
- `intake_files.ai_description`, `ai_extracted`
- `intake_students.data.answers` (no-overwrite merge), `ai_artifacts_generated_at`
- `intake_resumes` — INSERT one row per run
- `intake_required_docs.staff_draft` (no-overwrite unless `force=true`)
- `manual_ai_requests.processed_at`, `processed_by_admin_username`
- `intake_audit_log` — one row per dispatch summarising what was written

The Render web service is the only thing that talks to Postgres
directly; the agent talks to the web service over HTTP.
