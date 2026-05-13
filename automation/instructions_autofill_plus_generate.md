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
4. **SOP draft** — first-person, three paragraphs, **max 500 words**
   (aim for 400–500), anchored to the student's own activities and
   answers.
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
- Deployed prod API at `https://persona-y9pt.onrender.com`
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
  https://persona-y9pt.onrender.com/api/auth/login
```

The `Set-Cookie: persona_session=<uuid>` is captured into
`/tmp/cookies.txt`. Use `-b /tmp/cookies.txt` on every subsequent
request.

If login fails: stop, print the error, exit 0.

---

## Step 2 — Pull candidates (cap 5)

```bash
curl -s -b /tmp/cookies.txt 'https://persona-y9pt.onrender.com/api/admin/ai/pending?limit=5'
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
curl -s -b /tmp/cookies.txt 'https://persona-y9pt.onrender.com/api/admin/ai/manual-requests?status=pending'
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
curl -s -b /tmp/cookies.txt https://persona-y9pt.onrender.com/api/students/<student_id>
curl -s -b /tmp/cookies.txt https://persona-y9pt.onrender.com/api/required-docs/student/<student_id>
curl -s -b /tmp/cookies.txt https://persona-y9pt.onrender.com/api/applications/student/<student_id>
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
  https://persona-y9pt.onrender.com/api/students/<student_id>/files/<file.id>
```

Use the Read tool on `/tmp/file_<id>.bin` (works for images and PDFs
— for multi-page PDFs, read every page; do not stop at page 1).

Compose `ai_description` as a markdown block with the five sections
below in this order. Skip a section only when it would genuinely be
empty.

#### Skip rules — when NOT to emit `ai_description` (or to emit a stripped form)

**General principle:** if the frontend doesn't display analysis for a
field, the pipeline must not generate it. The per-doc slide
([`ExtractionStep`](../src/StudentDashboard.jsx)) and the student-facing
preview ([`DocumentPreview`](../src/StudentDashboard.jsx)) check
`field_id` against carve-out sets — picture-only slots hide the
AI-analysis block entirely; ID-doc slots show only the fields table.
Generating prose the UI hides wastes tokens, clutters the audit row,
and creates orphaned data that later UI changes will not be able to
expose without re-running the pipeline. **When you add a new field
that is "just data" (a picture, a single fact, an autofill-only key),
update both the frontend carve-out set AND the matching rule below in
the same change.**

**Rule 1 — Picture-only slots: emit nothing.**

Field ids in this set: `photoFile`, and any future passport-photo /
applicant-headshot upload slot that exists only to capture an image
for the application packet (no transcribable data, no autofill keys,
no LOR / SOP / narrative signal).

For these files, omit the `description` field on the dispatch
payload entirely — do not author bullets, a verbatim block, a fields
table, a summary, or conclusions. Send only `{ file_id, extracted: {} }`
if you must include the row at all, or skip it. The frontend
`isPhotoOnlyField(field_id)` check (`PHOTO_ONLY_FIELD_IDS` in
[`src/StudentDashboard.jsx`](../src/StudentDashboard.jsx)) hides any
AI-analysis block on these slides regardless of stored content, so
this is purely about not generating waste.

**Rule 2 — ID documents: fields table only.**

Field ids / document types in this set: Aadhaar (`aadharFile`),
passport bio + address pages, PAN card, voter ID, driving licence,
and any other government-issued identity card.

For pure identity documents, emit ONLY:
- **Section 1 — Fields table**, with one row per legible field.

Skip Sections 2, 3, 4, and 5 entirely. A counsellor reading an
Aadhaar slide does not benefit from a narrative summary, a verbatim
block, a numeric summary, or a Conclusions section — those repeat
what the table already says and clutter the per-doc slide.

The `ai_extracted` JSON is still composed as usual (that drives
autofill). Field-vs-intake mismatches are handled by the dispatch
endpoint's no-overwrite rule; do not add a Conclusions flag for them.

**Everything below (Sections 1–5) applies only to non-skip-rule
documents** — marksheets, certificates, transcripts, internship
letters, test-score reports, and anything else where narrative
context, a verbatim transcription, or downstream-narrative signals
carry value.

Section order is fixed: Fields → Narrative → Verbatim → Summary →
Conclusions. The structured table comes first so a counsellor opening
a per-doc slide sees the transcribed data immediately, not a wall of
prose. Slower-reading sections (verbatim transcription, numeric
summary, downstream-signal conclusions) sit underneath. ID docs stop
after Section 1; picture-only slots emit no `ai_description` at all.

**Section 1 — Fields table** (under a `### Fields` heading)

The structured key-value transcription of every legible data point on
the document. A markdown table with three columns: `Field | Value |
Source` where Source is the visible label / location on the document
(e.g. "Top right header", "Row 3 of marks table"). Lift every distinct
data point. Every subject row on a marksheet becomes a table row.
Every Aadhaar field (name, DOB, gender, address line 1, etc.) becomes
a row.

**Always render this section first** in `ai_description` — the
counsellor scans this table before reading any prose.

This is the human-readable mirror of `ai_extracted` — staff readers
scan this table; the autofill pipeline reads `ai_extracted`.

**Section 2 — Narrative** (no heading; opens the prose below the
fields table)

**Format: bullet points, one logical fact per bullet. 5–10 bullets max.**
A counsellor must get the full picture in 5–10 seconds. Each bullet is
one distinct piece of information. Bold the label or the key value.

**Rules:**
- One fact per bullet — do not combine unrelated facts on the same line.
- Use sub-bullets for lists of the same type (e.g. multiple signatories,
  multiple subject scores that belong together, items in a set).
- Do NOT open with a student bio — never write "Pratham Aggarwal is a
  Class XI student…" — that repeats on every file and adds zero value.
- Start the first bullet with the document type and key context.
- Do NOT put cross-doc flags or SOP cautions in the bullets — those
  belong in Conclusions only.
- Never use pipeline-meta language: "maps to intake form", "autofill",
  "narrative value", "downstream artifacts", "surfaces", "establishes".

**Good example — marksheet:**
```
- CISCE/ICSE Class X · Sat Paul Mittal School, Ludhiana · May 2024
- **Overall**: 98.0% (588/600) · PASS
- **Four perfect 100s**:
  - English Literature, Mathematics, Biology, History & Civics
- **STEM avg**: 99.5 (Maths 100, Physics 99, Chemistry 99, Bio 100)
- **Humanities avg**: 98.0 (English 99, Punjabi 96, HCG 99)
- **Lowest**: Physical Education 95 (distinction band)
```

**Good example — certificate with signatories:**
```
- MENTORx Foundation Course on Entrepreneurship and Innovation
- Conducted at Sat Paul Mittal School · Class IX (~2022-23)
- **Award**: "exceptional performance" — certificate's own wording, quotable verbatim
- **Signatories** — both strong LOR candidates:
  - Dr. Nancy Juneja, CEO, MENTORx Global
  - Dr. Munish Jindal, Founding President, MENTORx Global
```

The amount of detail per bullet depends on what the document carries:

- **Academic documents** (marksheets, transcripts, scorecards):
  Headline number first (overall %, GPA, band), then strongest 2–3
  subjects with raw marks and the weakest, trend across years if
  visible, comparison to other files on the same student (e.g.
  "Class XI Maths 84 vs Class X Maths 99 — 15-point drop"). Anchor
  every claim to a number on the source. Name the school/board if
  visible — maps to `schoolName`.

- **Aadhaar card / passport / PAN card / any other ID document**:
  Fields-table-only output per the *ID-document carve-out* above.
  Drop Sections 2, 3, 4, 5. The autofill keys still map as in the
  `ai_extracted` registry below (Aadhaar → `name` / `dob` / `phone`
  / `aadhar` / address components / `father_name` from C/O; passport
  → `name` / `dob` / `passport` / `passportExpiry`; PAN → `pan`).
  Field-vs-intake mismatches surface through the dispatch endpoint's
  no-overwrite logic; do not author Conclusions flags for them.

- **Admit card (`admitCardFile`)**: Exam authority + session in the
  first bullet (e.g. "JEE Main 2026 — Jan session"), then candidate
  name + roll / application number, exam date + reporting time, exam
  center with full address, and any standout instructions printed on
  the card (allowed materials, document-check requirements). Fields
  table carries the structured values; bullets give the counsellor the
  context they need to brief the student. If the printed candidate
  name disagrees with `name`, flag in Conclusions; never overwrite via
  autofill. The student may have typed free-form context into
  `admitCardNotes` — surface it as one bullet under the others
  prefixed `**Student notes**:`.

- **Internship / experience letter**: Employer name, supervisor name,
  period, role, and the 1–2 specific contributions described. No intake
  autofill fields — describe in narrative and flag supervisor as a LOR
  candidate.

- **Recommendation letters / supporting prose**: The recommender's
  specific claims summarised, plus the 1–2 strongest sentences quoted
  verbatim so the SOP / LOR composer can lift them.

- **Student photo / headshot (`photoFile`)**: covered by Skip Rule 1
  at the top of this section — emit nothing for `description`. Do
  not duplicate guidance here.

- **Signed declarations, administrative forms, single-purpose pages**:
  The opening student paragraph is enough. Skip layered detail. Note any
  named signatories if they are plausible LOR sources.

Total Section 2 length: 150–350 words depending on how much the
document actually carries. A Class XII predicted-marks transcript is
long; an activity certificate is short. ID documents (Aadhaar /
passport / PAN / similar) skip Section 2 entirely — see the carve-out
above.

**Section 3 — Verbatim transcription** (under a `### Verbatim`
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
- **Cross-doc comparison** — when this file's content meaningfully
  agrees / disagrees with another file already on the student.
  *"Class XI Maths 84 vs Class X Maths 99 — 15-point drop; SOP
  should not lean on 'consistently strong in Maths' framing."*

Lead with the actionable signal where one exists.

**Section 6 — Named people** (under a `### Named People` heading) —
MANDATORY for every document with any signatory, recommender, or
named individual. SKIPPED only for documents where named individuals
are categorically irrelevant (Aadhaar / PAN / passport bio /
photoFile).

The LOR / SOP / resume drafting steps downstream rely on this section
to know who the student actually has a relationship with. A missing
or sloppy Named-people section means the agent will fall back to
people who happen to have signed a one-time external certificate,
which is exactly the LOR failure mode we want to prevent.

Output a markdown table with this exact column set:

| Name | Role / title | Association with student | Subjects / topics observed | LOR plausibility |
|---|---|---|---|---|
| Mr. Rajiv Mehta | Course mentor, MENTORx Global | 8-week Class IX Foundation Course (2022-23) at Sat Paul Mittal | Entrepreneurship & Innovation cohort work | Weak — single short course, no continued contact |
| Mrs Anjali Verma | Controller of Examinations, CISCE | Board signatory only | None | Skip — board officer, no teaching relationship |

Rules for filling the table:

- **Name**: full name + honorific exactly as printed on the document.
  If only a surname is legible from a signature, capture surname only
  and flag in the LOR-plausibility cell that the first name needs
  confirmation. If the signature is illegible or the document is
  expected to carry a name but doesn't have one printed, emit a row
  with `[name not legible]` or `[name not on document]` in the Name
  column — do not skip the row, the absence is itself important
  signal.
- **Role / title**: their position relative to the student (subject
  teacher, class teacher, Vice Principal, Principal, mentor on a
  course, supervisor on an internship, project lead, etc.). Use the
  document's own wording.
- **Association with student**: how long, in what capacity, on what
  programme / class / project, with which dates if visible. A one-time
  certificate signatory has a very different value from a two-year
  classroom teacher and the LOR step needs to be able to tell.
- **Subjects / topics observed**: the specific things this person
  watched the student do — *"Class XI Mathematics, 91.5 annual"*,
  *"rotational-dynamics practical, 29/30"*, *"Class IX cohort pitch
  project, signed off as 'exceptional performance'"*. Anchor to a
  number or a specific topic from the same document where possible.
- **LOR plausibility**: one of *strong* / *moderate* / *weak* / *skip*,
  followed by a one-line reason. The downstream LOR composer will
  filter by this column.

A worked example for a Class XI / XII CBSE progress report
(no subject-teacher names are printed in this report format —
this is the case the agent must recognise and alert on):

| Name | Role / title | Association with student | Subjects / topics observed | LOR plausibility |
|---|---|---|---|---|
| Mr. Kanalvi *(first name not legible)* | Principal | Class XI + XII at Guru Nanak International, signed every term remark | Whole-student record, not subject-specific | Strong — sustained two-year sign-off; confirm first name with student |
| Mr. Bhullon *(first name not legible)* | Vice Principal | Same period as above; co-signed every progress block | Whole-student record | Moderate — administrative role, may be acceptable as second school voice; confirm first name |
| [name not on document] | Class Teacher | Two-year Class XI + XII period, signature only | Whole-student record | Strong potential — counsellor must collect name directly from student |
| [name not on document] | Class XII Mathematics teacher | Two-year period (Class XI + XII Maths) | Mathematics 91.5 / 100 Class XI annual | Strong potential — counsellor must collect name directly from student |
| [name not on document] | Class XII Physics teacher | Two-year period | Physics 91.15 / 100 Class XI annual, practicals 29/30 | Strong potential — counsellor must collect name directly from student |

Note the pattern: even when the document does NOT print the subject
teachers' names, the agent must enumerate the EXPECTED named roles
(Class XII Mathematics teacher, Class XII Physics teacher, Class
Teacher) with `[name not on document]` so the dispatch's
`summary_notes` field can flag this to the counsellor explicitly.

**Alert in `summary_notes`.** After processing all of a student's
files, the agent MUST compile a `Names-needed` block in
`summary_notes` listing every row from any Section 6 where the Name
column is `[name not legible]` or `[name not on document]`. Format:

```
Names-needed (counsellor must collect from student / school):
- Class XII Mathematics teacher (Guru Nanak International) — strong LOR candidate
- Class XII Physics teacher (Guru Nanak International) — strong LOR candidate
- Class Teacher 2024–26 (Guru Nanak International) — strong LOR candidate
- First name of Principal "Kanalvi" — confirm spelling and honorific
- First name of Vice Principal "Bhullon" — confirm spelling and honorific
```

This block surfaces directly on the audit row the counsellor reviews
on the AI Queue panel. A run that produces LOR drafts without this
list, when the underlying documents had absent or partial names, is
a failed run — re-do that step before dispatching.

**Then: compose `ai_extracted`**

A JSON object lifting only the structured fields that map to known
intake answers. This is the canonical field registry — emit every key
that has a readable value on the document. The dispatch endpoint
enforces no-overwrite, so it's safe to send keys that may already be
set; they will be skipped server-side.

| Document type | Extracted keys → intake-answer keys |
|---|---|
| **Aadhaar card** | `name` (exact as printed), `dob` (ISO YYYY-MM-DD), `phone` (+91 prefix + 10 digits), `aadhar` (XXXX XXXX XXXX), `address_street` (house + street), `address_area` (VTC or locality), `address_city` (district), `address_state`, `address_pin` (6-digit), `father_name` (C/O field — only if a personal name, skip if org) |
| **Passport** | `name`, `dob` (ISO YYYY-MM-DD), `passport` (alphanumeric), `passportExpiry` (ISO YYYY-MM-DD) |
| **PAN card** | `pan` (10-char alphanumeric, e.g. ABCDE1234F) |
| **Marksheet — Class 10** | `marks10pct` (number, one decimal), `schoolName` (if school name appears on the marksheet) |
| **Marksheet — Class 11** | `marks11pct` (number, one decimal) |
| **Marksheet — Class 12** | `marks12pct` (actual %, number), `marks12predicted` (predicted score as text, e.g. "92% predicted") |
| **Admit card (board / entrance exam)** | Nothing to a known intake key — capture the exam name + session, candidate name, roll / application number, exam date, exam center, and any reporting / instruction notes in the Fields table. If the printed name disagrees with `name`, flag in `summary_notes`; never overwrite. |
| **ITR (Income Tax Return)** — `fin_itr_*` | Nothing autofills into general intake. Capture: assessment year, PAN, filer name, filing status (original / revised), gross total income, total taxable income, total tax paid, refund or demand, ITR form type (ITR-1/2/3/4). |
| **Salary slip** — `fin_income_*_slips` | Month + year, employer name, employee ID, designation, gross / net pay, statutory deductions (PF, ESI, TDS), bank account masked digits. |
| **Employment letter** — `fin_income_*_empLetter` | Employer name + address, employee name, designation, date of joining, current CTC, letter date, signatory + designation. |
| **Form 16** — `fin_income_*_form16` | Assessment year, employer name + TAN, employee PAN, gross salary, total deductions under Chapter VI-A, total taxable income, tax deducted. |
| **Business registration / GST / balance sheets** — `fin_business_*` | Legal entity name, registration number (Udyam / CIN / partnership deed #), GSTIN, state of registration, date of incorporation. Balance sheets: financial year, total revenue, net profit, total assets, total liabilities, auditor (CA) name + membership #. |
| **Parent KYC (PAN / Aadhaar)** — `fin_kyc_*` | Use the existing Aadhaar / PAN extraction rules. Map nothing to intake `father_*` / `mother_*` fields automatically (parent records are filled by the student / counsellor) — but flag a mismatch with existing `father_aadhar` / `mother_aadhar` in `summary_notes`. |
| **Loan sanction / disbursal letter** — `fin_loan_*` | Lender name + branch, borrower name, sanctioned amount, loan account #, disbursal schedule, ROI, tenure, sanction date. |
| **CA net worth statement** — `fin_networth_*` | Person name, CA name + membership #, statement date, total assets (broken into immovable / movable), total liabilities, net worth figure. |
| **Sponsor affidavit** — `fin_affidavit_*` | Sponsor name, relationship to student, declared amount of financial support, stamp paper value + state, notary name + date, witness signatures (if any). |
| **Bank statement / FD copies / balance certificate** — `fin_banking_*` | Bank + branch name, account holder, account number (masked), statement period, closing balance, average balance, currency. FD copies: certificate #, principal, rate, maturity date, joint holders. Balance certificate: date issued, signatory + designation. |
| **UG transcript / consolidated marks** | `cgpa` (as text matching the card's own scale, e.g. "8.5 / 10"), `uniName` (if visible) |
| **IELTS result** | `ielts_score` (overall band, one decimal, e.g. "7.5"), `ielts_status` = "Already taken" |
| **TOEFL result** | `toefl_score` (total score as text), `toefl_booked` = true |
| **SAT result** | `sat_score` (total as text, e.g. "1480"), `sat_booked` = true |
| **ACT result** | `sat_score` (composite as text), `sat_booked` = true |
| **GRE / GMAT** | Nothing to a known intake key — describe in narrative only |
| **Activity certificate** | Nothing extractable — describe and flag named mentor as LOR candidate |
| **Internship / experience letter** | Nothing extractable — describe and flag supervisor as LOR candidate |
| **Passport photo / headshot** | Nothing extractable |
| **Signed declarations / admin forms** | Nothing extractable unless school name or address appears |
| **Any unrecognised document** | Nothing extractable — describe what you see; do not guess a category |

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

**Empty-section discipline (HARD RULE).** The renderer skips any
section whose array is empty — no heading, no "none" placeholder.
Use that. Never emit a row that says "Not taking", "Planning to
take", "Not yet taken", "Will take", "N/A", "TBD", or any other
absence-marker prose. Those are negative facts; resumes only
carry positive specifics.

This applies to every section, but in practice it bites hardest on
`standardized_tests` because students often have no IELTS / TOEFL /
SAT yet. The correct emit when a student has not taken any
standardized test is:

```json
"standardized_tests": []
```

NOT:

```json
"standardized_tests": [
  { "label": "IELTS", "body": "Not taking. Medium of instruction English…" }
]
```

If a row would be a net negative — describing what the student has
NOT done, or padding with generic sentences — drop it. The same
goes for `internships`, `volunteer`, `publications`, etc. An empty
array is a feature; it tells the renderer to skip the section.

**Per-section sanity pass before emit (HARD RULE).** Before
serialising the resume, walk every populated section and ask three
questions per row:

1. *Is this row a positive, specific fact?* If the body starts with
   "not", "no", "haven't", "won't", or describes an absence, the row
   is wrong shape — either rewrite it as a positive fact lifted from
   the file extractions, or drop it.
2. *Does this row pad the section?* If keeping it would only fill
   space without adding admissions value, drop it. A section with
   three strong rows beats one with three strong + two weak.
3. *Could 1000 other Indian Class XII applicants paste this exact
   line into their own resume?* If yes, anchor the body to a specific
   from the student's `ai_description` blocks (file names, dates,
   per-subject marks, signatory names) or drop it.

If you find yourself adding a row to "fill out" a section, that is
the signal to leave the section empty instead. Resumes are graded
on signal density, not section count.

Length target: **300–450 words across all visible text fields, and
the rendered resume MUST fit on a single A4 page** in every one of
the three PDF templates (`EditorialClassic`, `ModernConfident`,
`ConfidentBold`). One page is a hard rule for undergrad applicants —
this cohort. Two-page resumes get cut at admissions intake.

The PDF templates are tuned so a payload in the 300-450-word band
fits on one page. If your draft exceeds 450 words across visible
text, the renderer will overflow regardless of template choice;
trim at source before dispatch. The likely overflow culprits:

- `lede` longer than ~60 words. Trim to two short sentences (~40-50
  words) that name the identity, the anchoring direction fact, and
  the one specific everyone needs to know up front.
- `body` strings that read as paragraphs. Each item body in
  `education` / `awards` / `activities` / etc. should be 25-40 words,
  fact-dense. If a single body needs more than 40 words, split into
  two items if the source supports it, or compress.
- `closing_note` set when it doesn't add unique signal. Empty string
  is the right answer most of the time — the closing block is
  optional, not a slot you need to fill.

You can confirm a payload is in band by summing `headline` + `lede`
+ every `label`/`body`/`meta`/`gpa` across `education`,
`standardized_tests`, `awards`, `publications`, `activities`,
`internships`, `volunteer` + `skills` (1 word each) + `languages`
(1 word each) + `closing_note`. Aim for the upper-300s; that's the
comfort zone with the current template geometry.

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

#### SOP draft (max 500 words, first-person, three paragraphs)

**BEFORE WRITING ANY SENTENCE — read the SOP corpus.** The runbook
agent MUST read these files in order, every dispatch run, before
composing the SOP:

1. `automation/sop_corpus/construction-guidelines.md` — the eight-
   section structural spec the operator hand-edited. It defines the
   section order (origin of passion → academic background → ECs &
   exposure → career goals → why this course → why this university →
   why this country → future plans) and the equal-word-distribution
   rule. When the word cap is tight (≤ 500), drop "Why this country"
   first per the explicit instruction at the bottom of that file.
2. `automation/sop_corpus/examples/*.md` — seven past student SOPs.
   Skim every one. Use them to calibrate voice, density, and how
   abstract claims get grounded in specific named artefacts
   (programmes, books, internships, papers).

The corpus is the canonical spec for SOP shape and voice. The rules
below sit *underneath* it — apply them inside the structure the
corpus dictates. Never copy a sentence; borrow the shape.

**Length.** Aim for 400–500 words. **Hard cap: 500 words.** Anything
above gets cut server-side or by the counsellor at review. When the
target university supplies a smaller cap (UCAS short answers, common-
app supplements), honour their cap instead and use the construction
guidelines' "trim country" carve-out plus shrink the other sections
proportionally so every retained beat stays balanced.

**Structure (driven by `construction-guidelines.md`).** Use the eight
sections as the skeleton. At 500 words, that's ~60 words per section
on average; aim for equal distribution rather than dumping word
budget into the opener. The examples in `examples/` show this
distribution playing out — Karan's UCAS short answers in particular
demonstrate how each block carries its own evidence anchor.

**Anchoring discipline.** Every paragraph names a specific artefact:
a named course, a named book, a named programme, a named research
paper, a named internship, or a quantified outcome. Generic claims
("I am passionate about X") read as machine output. The Karan UCAS
example anchors on "The Personal MBA / Start with Why → Stacked Up
Burgers → Master's Union Start-Up Week → IJRAR-published paper" —
that's the density to match.

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

**BEFORE WRITING ANY SENTENCE — read the LOR corpus.** Same gate as
the SOP step. The runbook agent MUST read these files in order, every
dispatch run, before composing the first LOR sentence:

1. `automation/lor_corpus/lor-guideline.md` — the operator's
   hand-written 8-point structure (introduce self + association →
   academic characteristics → classroom participation → class project
   → research paper → academic activity → leadership → round-off).
   Every LOR hits these eight beats. Order can flex (see *Narrative
   arc* below) but every beat must land.
2. `automation/lor_corpus/examples/*.md` — 14 real teacher LORs
   spanning Physics, Maths, Business Studies, Economics, Political
   Science, Psychology, Geography, Marketing, IP, Interior, ISH
   hospitality. The cross-subject coverage exists so the agent can
   match register to recommender role — physics-teacher voice is not
   marketing-teacher voice. Skim every example; use them as voice +
   density anchors. **Never copy a sentence.**

The corpus is the canonical spec. The rules below sit *underneath* it
— apply them inside the structure the corpus dictates.

For every `kind='lor'` row in `required_docs` whose `staff_draft` is
NULL — student-typed AND every LOR suggestion you propose below —
generate a **500–700 word** recommendation letter and write it to
`staff_draft` (suggestions: via the `draft` field on the suggestion
object; existing rows: by setting their `staff_draft`).

**Core principle — admissions read these side by side.** A student
typically gets 2–4 LORs for the same application. If two letters share
opening patterns, paragraph order, vocabulary, or rhythm, it reads as
machine-generated and damages the application. Every LOR you draft in
the same dispatch run for the same student MUST deliberately diverge
from its siblings on four axes:

1. **Voice** — each recommender has a distinct writing persona inferred
   from their role (see *Voice inference* below).
2. **Evidence selection** — each letter draws from a *different subset*
   of the evidence pool. Same anecdote in two letters is a fail.
3. **Narrative arc** — pick ONE arc per letter (A / B / C / D below).
   Sibling letters must use different arcs.
4. **Structural variation** — opening style, paragraph count, sentence
   rhythm, and which beats run heavy.

**Recipient pool — sourced from the Named-people register, not invented**

The LOR recipients (and the recipients of any LOR suggestions you
emit) MUST be drawn from the cross-document Named-people register
you compiled in Section 6 of Section 3b. Filter to rows with LOR
plausibility *strong* or *moderate*. Prefer recipients who appear
across multiple documents or who have a sustained-association
signal (two-year subject teacher, principal across the senior
years) over one-off external-programme signatories.

If a strong-association role exists in the register but the name
cell is `[name not legible]` or `[name not on document]` (typical
case: Class XII Mathematics teacher whose name does not print on
CBSE reports), draft the LOR anyway with `recipient_name` set to
a bracketed role placeholder (e.g. `[Class XII Mathematics Teacher]`)
and ensure the row appears in the `summary_notes` Names-needed
alert. The counsellor will fill the actual name before sending.
Body text MUST be written in first person without self-reference by
name so the placeholder only needs to be replaced in the signature
block.

NEVER pull LOR recipients from external one-time-course
signatories (course mentors, workshop leads, certificate
co-signatories) when sustained-association school staff are
available in the register. Universities read multiple LORs side by
side and a letter from a person who saw the student for eight
weeks two years ago carries less weight than one from the subject
teacher who taught them for two senior years.

**Other inputs available**
- `recipient_name`, `recipient_role`, `reason_brief` (from the row or
  from your suggestion object).
- Student: `answers.full_name`, current `grade`, `targetCountry` /
  `paths_list` if known.
- The evidence pool from intake + file extractions:
  - **Strong subject topics** — derived from `answers.subjects_list` and
    marksheet `ai_description` rows (Section 5 → topics + grades).
  - **Classroom participation anecdotes** — `ai_description` body of
    the school-life / activities sections.
  - **Projects** — `answers.projects_list`, plus project-doc extractions.
  - **Research papers** — `answers.research_list` if non-empty.
  - **Other academic activities** — `answers.activities_list` filtered to
    academic ones (olympiad, fair, club).
  - **Leadership incidents + peer dynamics** — `answers.activities_list`
    leadership rows, plus the school-life narrative in extractions.

  Treat each pool as oversupply — pick a *subset* per letter, not the
  whole list. If a pool is empty, OMIT the matching beat rather than
  invent one.

**Voice inference (no stored teacher profile)**
Pick the voice from `recipient_role` before drafting; keep it consistent
end-to-end:
- Principal / HOD / titled administrator → *formal-academic*,
  long-flowing sentences, credentials-first opening.
- Class teacher / subject teacher → *warm-mentor*, mixed rhythm,
  anecdote-first or thesis-first opening.
- Project mentor / external programme lead → *narrative-storyteller*,
  scene-set opening, expansive paragraphs.
- Course instructor (online / short programme) → *crisp-analytical*,
  short-direct sentences, thesis-first opening.

**Output structure — required components, flexible order**

Fixed positions:
- **Opening must be first.** The recommender introduces themselves
  (name, designation, duration of association, subject), then signals
  their thesis about the student in one line.
- **Round-off must be last.** Summary recommendation + signature block.

Flexible middle — pick ONE narrative arc per letter, and it must differ
from every sibling LOR in this dispatch run:
- **Arc A — Academic-led:** topics → participation → project →
  research → other activity → leadership. (Safest default.)
- **Arc B — Project-led:** open on the class project as the anchor
  story; weave topics and participation around it; close on character.
- **Arc C — Character-led:** open with a leadership / peer anecdote,
  then show how that character shows up academically.
- **Arc D — Integrated:** merge academic and character evidence into
  3–4 thematic paragraphs (e.g. "intellectual curiosity", "rigor under
  pressure", "influence on peers") rather than separate sections.

**The 8 required content beats** (all must be present in some form,
regardless of arc):
1. Recommender self-introduction (name, designation, duration, subject,
   thesis line on the student).
2. Academic profile in the subject — 2–4 specific topics drawn from
   the evidence pool. Each sibling letter picks a *different subset*.
3. Classroom participation & concept clarity — one anecdote. Different
   anecdote per sibling letter.
4. ONE class project, foregrounded. Different project per sibling
   where possible.
5. Research paper — if non-empty. Different sibling letters emphasise
   different angles (methodology / results / independence).
6. ONE other academic activity. Different pick per sibling.
7. Leadership & peer position — one incident + one peer observation.
   Different incident per sibling.
8. Round-off — summary + program fit (if `targetCountry` / program
   known) + signature block.

**Section weighting.** Each letter has **1–2 heavy beats** (full
paragraph with detail) and the rest lighter (a few sentences or
folded into another beat). Heavy beats MUST differ across siblings:
e.g. LOR #1 heavy on the class project + research, LOR #2 heavy on
leadership + classroom participation, LOR #3 heavy on Arc-D thematic
pair. Mirrors how real teachers write — they emphasise what they
personally witnessed most.

**Format**
- Header line: `Date: [TODAY]`
- Salutation: `To Whom It May Concern,` — or, if `targetCountry` plus
  a program / university is known, `To the Admissions Committee,
  <program>,`
- Body, 500–700 words. **Vary length across sibling LORs by ≥80 words;
  never hit the same word count twice for the same student.**
- Sign-off block:
  ```
  Sincerely,

  [recipient_name]
  [recipient_role]
  ```

**Style rules**
- UK / Indian English. Warm but professional.
- Specificity over adjectives — every paragraph carries at least one
  concrete fact (topic name, project title, incident detail, score,
  date). Strip vague praise unless it's earned in the same sentence.
- Lock pronouns from the student's gendered context (`answers.gender`
  or inferred). Do not drift.
- All Stealth Mode rules above still apply *in the recommender's voice*
  — no em-dashes, no semicolons, no banned words / phrases, no
  transition stacking, sentence-length variance, no "1000 students"
  generic lines.

**Anti-template checklist — run before writing `staff_draft`.** For
every new LOR draft, compare against every sibling LOR you've already
authored in this dispatch run. Fail any check → regenerate that section
and re-check. Loop until clean:

- [ ] Opening sentence structurally differs from every sibling (not
      another "I am writing to recommend…" / "It is my pleasure…" /
      "I have known [student] for…").
- [ ] Thesis line in the opening uses different adjectives and a
      different frame.
- [ ] Closing sentence is different.
- [ ] No shared phrases longer than 4 words (other than the student's
      name, subject names, project titles).
- [ ] Narrative arc differs (A / B / C / D).
- [ ] Heavy-weighted beats differ.
- [ ] Different anecdotes drawn from the evidence pool. No two letters
      tell the same classroom story, leadership story, or peer story.
- [ ] Topic overlap from the subject pool ≤ 1; 2+ shared topics is a fail.
- [ ] Word count differs by ≥ 80 words from every sibling.
- [ ] Sentence rhythm differs (average sentence length and variance).
- [ ] No repeated transitional phrases across sibling openings or
      paragraph starters.

**LOR-specific banned phrases** (in addition to the general Stealth
Mode list above):
- "It is with great pleasure that I recommend…"
- "Without hesitation"
- "In my X years of teaching…"
- "Top X% of students I have ever taught" (unless explicitly evidenced)
- "A rare combination of [X] and [Y]"
- "Stands head and shoulders above peers"
- "Exemplifies the qualities of…"
- Strings of three adjectives separated by commas
  ("bright, hardworking, and dedicated")
- Generic closers like "I am confident she will be an asset to your
  program"

**No hallucination.** If the pool lacks evidence for a beat (no
research paper on file, no leadership incident captured), OMIT the
beat rather than invent one. Better a 520-word letter that skips
research than a 650-word letter with a fabricated paper.

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

For each candidate, emit one suggestion object — including a
ready-to-print `draft` so the counsellor doesn't re-author from
scratch when the student accepts:

```json
{
  "recipient_name": "Rajiv Mehta",
  "recipient_role": "Entrepreneurship & Innovation course mentor, MENTORx Global",
  "reason_brief": "Led 8-week course where student was singled out for excellent performance",
  "draft": "Date: [TODAY]\n\nTo Whom It May Concern,\n\n[500–700 word letter following the LOR drafts spec above: chosen arc (A/B/C/D) that differs from sibling LORs, voice inferred from recipient_role, all 8 required beats present, 1–2 heavy beats grounded in the specific programme / class / project that connected this recommender to the student, verbatim figures or quotes pulled from the file extractions, anti-template checklist clean, banned-phrase scan clean]\n\nSincerely,\n\nRajiv Mehta\nEntrepreneurship & Innovation course mentor, MENTORx Global"
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
- **`draft` is required.** Follow the full *LOR drafts* spec above
  — 500–700 words, voice inferred from `recipient_role`, one of arcs
  A / B / C / D chosen to diverge from sibling LORs in this dispatch,
  all 8 beats present, anti-template checklist clean, banned-phrase
  scan clean. The suggestion's `draft` is written verbatim to
  `staff_draft` on insert, so the counsellor opens the
  Required-documents slide to a finished letter, not a blank textarea.
- **Cap at 5 suggestions per student.** More than 5 is noise; the
  student picks 2–3 to actually pursue.
- **Do not duplicate** recipients the student already entered as
  kind='lor' rows during intake (server-side dedup catches this on
  recipient_name match anyway, but skip locally to keep the
  payload tight).

The dispatch endpoint inserts each suggestion as a kind='lor' row
with `student_accepted_at = NULL` and the supplied `draft` written
to `staff_draft`. The student sees the row on their dashboard as a
card with a check (accept) or X (delete) action. Accepted
suggestions enter the existing request → received lifecycle with
the draft already in place; the counsellor only edits the
boilerplate / final-touches before sending.

#### Autofill answers

Merge every `extracted` object into a single proposed answer-set.
Only include keys that map to known intake fields (see registry
above). The dispatch endpoint enforces no-overwrite; safe to send
keys that may already be set — they'll be skipped server-side.

**Provenance — what the staff side sees.** Every key the dispatch
actually writes (i.e. wasn't already set) is appended to
`data.autofilled_keys` (deduped union with prior runs). On the staff
slide-by-slide review (Students tab → student modal), each AI-written
intake field shows an `AI AUTOFILLED` chip next to its label so the
counsellor can tell at a glance what came from the document vs what
the student typed. **Implication for you:** be conservative about
which keys you send — only send a key when the document genuinely
supports the value, since wrongly autofilled keys will be visibly
attributed to the AI for the rest of the student's lifecycle.

### 3c2. Pre-dispatch self-audit (MANDATORY before 3d)

Before writing the dispatch JSON to disk, run these checks against
every student-facing string you authored: every body string in the
resume (`headline`, `lede`, `closing_note`, every `body`/`label`/`meta`
in education / standardized_tests / awards / publications / activities
/ internships / volunteer), the `sop_draft`, every `draft` in
`lor_drafts` / `internship_drafts` / `lor_suggestions`. Skip
`file_descriptions[*].description` — those are internal-facing staff
notes where verbatim transcription is the point. The audit:

1. **Em-dash / semicolon scan (HARD).** `grep -E "—|;"` returns zero
   matches in every string above. If a sentence breaks with one of
   these, restructure into two sentences or use a comma.
2. **Banned-word scan (HARD).** Case-insensitive grep for the words
   under "Stealth Mode rules" above: `passionate`, `dedicated`,
   `hardworking`, `ambitious`, `motivated`, `journey`, `leverage`,
   `foster`, `navigate`, `cultivate`, `embark`, `nurture`, `embraced`,
   `demonstrated`, `sought`, `curated`, `pivotal`, `transformative`,
   `holistic`, `robust`, `seamless`, `additionally`, `indeed`. Zero
   matches.
3. **Banned bullet-opener scan (HARD).** For every line that starts a
   sentence or bullet body, the first word is not one of
   `Spearheaded`, `Pioneered`, `Orchestrated`, `Navigated`,
   `Cultivated`, `Fostered`, `Leveraged`, `Demonstrated`, `Curated`,
   `Embarked`. Use the concrete verbs (`Built`, `Wrote`, `Ran`, `Led`,
   `Won`, `Filed`, `Coded`, `Trained`, `Sold`).
4. **No file-name reference (HARD).** Resume / SOP / LOR text must
   never quote a raw uploaded filename (e.g.
   `"EAadhaar_065623…page-0001 (1).jpg.jpeg"` or
   `"cisce.org-SSCER-248115896 (1).pdf"`). System-uploaded files
   carry portal-generated names that read as junk. Reference the
   document by what it IS ("Class X ICSE marksheet", "Aadhaar
   identity letter"), not by its uploaded filename. The slide UI
   ([`src/StudentsAdmin.jsx`](../src/StudentsAdmin.jsx) `docNameFor()`)
   does the same on its side; treat it as a parallel discipline.
5. **Word-count check (a proxy for the 1-page resume rule).** SOP
   400-500 words, hard cap 500. Each LOR / LOR-suggestion draft
   200-300 words. Each Internship draft 150-250 words. Resume
   aggregate across visible-text fields 300-450 words AND the
   rendered PDF MUST fit on a single A4 page in every one of the
   three templates — overflow past one page is a hard failure for
   undergrad applicants and means the lede or longest item bodies
   need trimming at source before dispatch.
6. **Voice continuity check.** Read the SOP first sentence and the
   resume `lede` one after the other. Same identity (Class XII
   student, Ludhiana, quantitative bias, etc.), same anchoring
   direction fact. If they read as two unrelated openings, re-author
   one to match the other.

If any check fails, fix the offending strings locally and re-run the
audit. Do NOT dispatch a draft with known violations.

### 3d. Dispatch (atomic write)

```bash
curl -s -b /tmp/cookies.txt -X POST -H 'Content-Type: application/json' \
  --data @/tmp/dispatch_<student_id>.json \
  https://persona-y9pt.onrender.com/api/admin/ai/dispatch
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
    {
      "recipient_name": "Rajiv Mehta",
      "recipient_role": "Entrepreneurship course mentor, MENTORx Global",
      "reason_brief": "Led 8-week course where student was singled out for excellent performance",
      "draft": "Date: [TODAY]\n\nTo Whom It May Concern:\n\n[200–300 words in the recommender's voice…]\n\nSincerely,\nRajiv Mehta\nEntrepreneurship course mentor, MENTORx Global"
    }
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
4. Verify in the staff panel by opening the student modal and walking
   the slide-by-slide review (Prev / Next at the top). The slide
   sequence is:
   - **Page slides**, one per intake page that has at least one
     answered field. Three shapes depending on uploads:
     - *No uploads*: single slide with the typed form fields.
     - *One upload*: single combined slide — form fields on top,
       document + AI analysis below.
     - *Multiple uploads*: a `· summary` slide first (form fields
       only, with file-slot rows hidden because the per-doc slides
       carry the actual file content), then one `· document N/M`
       slide per file showing just the PDF + AI analysis.
     Fields you autofilled show a small `AI AUTOFILLED` chip next
     to their label on the page / summary slide.
   - **AI-generated resumes** — preview cards. The PDF picker lets
     you flip between the three styles; all three render the same
     `content_json` payload.
   - **AI suggestions** (NEW) — read-only preview of the
     `lor_suggestions` rows you sent (cards titled with recipient +
     reason, eyebrow "Pending student review") and the AI-drafted
     SOP (full text, eyebrow "Awaiting admin approval"). Empty state
     when nothing applies.
   - **Required documents** — staff workflow surface where the
     counsellor edits LOR / Internship `staff_draft`s and admin
     approves the SOP. This is where the suggestions accepted by
     the student land for actual drafting + sending.

   Confirm: every student you processed has populated `ai_description`
   / `ai_extracted` on their files, a resume row, an SOP draft, LOR
   drafts on every accepted recipient, and any LOR suggestions you
   sent showing on the AI-suggestions slide. Their
   `manual_ai_requests` row(s) flip to `processed_at = NOW()` and the
   counsellor banner shows "complete".

If the run fails partway, the unresolved students stay in the queue —
re-run the script. The dispatch endpoint is idempotent:
- **File descriptions** overwrite — re-runs are how you improve them.
- **Autofill answers** are no-overwrite per key (already-set values
  are skipped server-side).
- **Resume** UPSERTs — re-runs overwrite the latest finished resume in
  place rather than stacking new rows. Older duplicate finished rows
  are deleted in the same transaction. There is no longer a "may be
  stale" fan-out to clean up by hand. Pending / running rows are not
  touched, so an in-flight generation isn't yanked out from under
  itself.
- **LOR suggestions** dedupe on lowercased `recipient_name` — sending
  the same name twice is safe; the second one is a no-op.
- **SOP / LOR / Internship `staff_draft`** is no-overwrite unless the
  request body sets `force=true`.

If you want to run a single specific student manually (skip the queue
gate), set `ai_artifacts_generated_at = NULL` for that student first,
then re-run:

```sql
UPDATE intake_students SET ai_artifacts_generated_at = NULL WHERE student_id = '<id>';
```

---

## Section C — Complete intake answer key reference

Every intake answer the autofill pipeline can write is listed here.
When composing `autofill_answers` in the dispatch body, use these
exact key strings. The dispatch endpoint ignores unknown keys.

**Personal — basics (page: p_basics)**
- `name` — full name as on legal documents
- `email` — student's personal email
- `phone` — mobile number, +91 prefix, e.g. "+91 9876212600"
- `bloodGroup` — optional

**Personal — address (page: p_address)**
- `address_street` — house number + street name
- `address_area` — locality / area / VTC / colony
- `address_city` — city name (for Aadhaar: use the District field)
- `address_state` — state name, e.g. "Punjab"
- `address_pin` — 6-digit PIN code as a string

**Personal — Aadhaar (page: p_aadhar)**
- `aadhar` — 12-digit number formatted `XXXX XXXX XXXX`

**Personal — PAN (page: p_pan, optional)**
- `pan` — 10-char PAN number

**Schooling (page: p_school)**
- `schoolName` — school name as on marksheet / school letter
- `schoolEmail` — school email if visible
- `schoolAddress_street`, `schoolAddress_area`, `schoolAddress_city`,
  `schoolAddress_state`, `schoolAddress_pin` — from school documents

**Schooling — university (page: p_uni, optional)**
- `uniName`, `uniEmail`, `uniAddress`

**Academics (page: p_marks10)**
- `marks10pct` — Class 10 overall percentage as a number, e.g. 92.4

**Academics (page: p_marks11)**
- `marks11pct` — Class 11 overall percentage as a number

**Academics (page: p_marks12, optional)**
- `marks12pct` — Class 12 percentage as a number
- `marks12predicted` — predicted score as text, e.g. "92% predicted"

**Academics — UG (page: p_cgpa, optional)**
- `cgpa` — CGPA as text, e.g. "8.5 / 10" or "3.9 / 4.0"

**Passport (page: p_passport_scans, optional)**
- `passport` — passport number
- `passportExpiry` — expiry date ISO YYYY-MM-DD
- `dob` — date of birth ISO YYYY-MM-DD

**Tests — IELTS (page: p_ielts)**
- `ielts_status` — "Already taken" | "Planning to take" | "Won't take"
- `ielts_score` — overall band, e.g. "7.5" (only when "Already taken")
- `ielts_planned_date` — ISO date (only when "Planning to take")
- `ielts_bookingNum` — booking number (optional)

**Tests — other (page: p_tests, optional)**
- `toefl_booked` — boolean
- `toefl_score` — total score as text
- `sat_booked` — boolean (true for both SAT and ACT)
- `sat_score` — total score as text
- `ap_booked` — boolean
- `ap_score` — per-subject scores as text

**Family — father (page: p_father)**
- `father_name`, `father_dob` (ISO), `father_education`,
  `father_institution`, `father_aadhar` (XXXX XXXX XXXX),
  `father_occupation`, `father_position`, `father_phone`,
  `father_email`, `father_org`

**Family — mother (page: p_mother)**
- `mother_name`, `mother_dob` (ISO), `mother_education`,
  `mother_institution`, `mother_aadhar` (XXXX XXXX XXXX),
  `mother_occupation`, `mother_position`, `mother_phone`,
  `mother_email`, `mother_org`

**Destination (panel tab)**
- `targetCountry` — must match an option from the COUNTRIES list in
  intakeSchema.js (India, UK, USA, Canada, Australia, etc.)

**Keys the pipeline must never write:**
- Any file-slot key (`aadharFile`, `photoFile`, `marks10sheet`, etc.) —
  file references are managed by the upload system, not the AI dispatch.
- Any key not in this list — the dispatch drops unknowns anyway, but
  don't pad the payload.

---

## Section D — DB schema reference (what the pipeline touches)

Tables the agent reads:
- `intake_students` — `data.answers`, `intake_phase`, `is_archived`, `ai_eligible_via_pre_upload`, `ai_artifacts_generated_at`
- `intake_files` — every active upload's metadata + bytes. Files whose `field_id` starts with `fin_` belong to the student's financial dossier (see below) and follow the per-doc-type extraction rules in Section 3b's table — but no key in those extractions ever maps to `data.answers`; the pipeline writes `ai_description` + `ai_extracted` for those rows like any other file, and stops.
- `intake_financial_dossier` — read for context only (one jsonb row per student, holding the structured metadata behind the Financial documents tab: people lists, toggles, travel trips, bank manager contact). The pipeline never writes here — it's owned by the student via PUT /api/students/me/financial.
- `intake_required_docs` — LOR/internship/SOP rows; `staff_draft` is the write target
- `intake_applications` — context only
- `manual_ai_requests` — pending queue

Tables the agent writes (via the `/dispatch` endpoint, all atomic):
- `intake_files.ai_description`, `ai_extracted`
- `intake_students.data.answers` (no-overwrite merge), `data.autofilled_keys`
  (deduped union — provenance set the staff slide review reads to badge
  AI-written fields), `ai_artifacts_generated_at`
- `intake_resumes` — **UPSERT** (one row per student). Re-runs overwrite
  the latest finished row in place; older duplicate finished rows are
  deleted in the same transaction. Pending / running rows are left
  alone. Stable id means `/api/students/<sid>/resumes/<rid>/print`
  links survive re-runs.
- `intake_required_docs` — server INSERTs new kind='lor' rows from
  `lor_suggestions` (with `student_accepted_at = NULL`) and writes
  `staff_draft` on existing rows (no-overwrite unless `force=true`).
- `manual_ai_requests.processed_at`, `processed_by_admin_username`
- `intake_audit_log` — one row per dispatch summarising what was written
  (includes `written_keys` so an agent re-running this student can see
  which fields the prior run autofilled)

The Render web service is the only thing that talks to Postgres
directly; the agent talks to the web service over HTTP.
