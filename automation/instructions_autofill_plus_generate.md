# instructions_autofill_plus_generate.md

The master command for the AI artifact pipeline. The persona-followup
counsellor team triggers this **manually** when a new student is signed
up (with or without pre-uploaded documents). Jace receives a queued
request, opens the routine page, and clicks **Run now**.

This file is the runbook the agent (a Claude Code session running the
routine) reads cold. It contains every step, every prompt, every DB
write target, and the manual-fill request workflow.

There is **no scheduled cron**. Routine ID:
`trig_01BTTjNjGDpdGyywLqBTtk1a` — open at
https://claude.ai/code/routines/trig_01BTTjNjGDpdGyywLqBTtk1a and click
"Run now" whenever the request queue has pending entries (counsellor
clicks "Request manual fill" on the create-student form, which inserts
a row into `manual_ai_requests`).

The agent that runs this **is** the LLM (a Claude Max session in the
remote routine). There is no Gemini / Anthropic API call — the agent
reads context, authors text in its own head, and writes results back
via the `/api/admin/ai/dispatch` HTTP endpoint.

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

**Section 1 — Document identification** (one paragraph, 40–80 words)

What the document is, who it is about, what authority issued it, the
visible date / academic year, the page count, the language(s). No
flourish, no adjectives.

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

2–4 bullets stating what this document tells us about the student.
Anchor each bullet to a specific number or fact from the
transcription — never a generic statement. Examples:

- *"Class X total 462/500 (92.4%) places him in roughly the top decile
  of CBSE 10th candidates that year."*
- *"Aadhar address (Ludhiana, Punjab) matches `answers.address` and
  `answers.city` — no reconciliation needed."*
- *"Passport expires 12 Mar 2027 — within the 6-month validity window
  required by US/UK visa offices for 2026 intake. **Flag for renewal
  before any 2027 intake.**"*

Lead with the actionable signal where one exists.

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

#### Resume (JSON preferred, markdown fallback)

The frontend renders a structured `<ResumeTemplate>` from
`content_json`. Aim for that. Fall back to `content_md` only if
something blocks JSON construction.

JSON shape (see `lib/resumeSchema.js` for the canonical type):

```json
{
  "name": "Pratham Aggarwal",
  "headline": "Class 12 student, Ludhiana — applying CS undergrad UK/US",
  "lede": "Two-paragraph opener anchored to lived experience…",
  "education": [
    { "label": "Class X (CBSE, 2023)", "body": "Satpaul Mittal School. 462/500 (92.4%). …", "meta": "Ludhiana" }
  ],
  "standardized_tests": [
    { "label": "IELTS", "body": "Band 7.5 overall (Listening 8.5, Reading 7.0, Writing 7.0, Speaking 7.5). Taken Oct 2025." }
  ],
  "activities": [
    { "label": "School CS Club — President", "body": "30+ active members; built a Python tutoring track for Class 9–10 …" }
  ],
  "internships": [],
  "volunteer": [],
  "skills": ["Python", "SQL", "React", "public speaking"],
  "languages": ["English (native)", "Hindi (native)", "Punjabi (fluent)"],
  "closing_note": "Optional one-line sign-off."
}
```

Length target: **300–450 words across all visible text fields**.
Stealth Mode rules apply:
- No banned words: *passionate, dedicated, hardworking, ambitious, motivated, journey, leverage, foster, navigate, cultivate, embark, nurture, embraced, demonstrated, sought, curated, pivotal, transformative, holistic, robust, seamless*.
- No banned phrase patterns: *"deep dive", "in the realm of", "at the heart of", "speaks volumes", "in today's world"*.
- No banned verb-openers on bullets: *Spearheaded, Pioneered, Orchestrated, Navigated, Cultivated, Fostered, Leveraged, Demonstrated, Curated, Embarked*. Lead with concrete verbs (*Built, Wrote, Ran, Led, Won, Filed, Coded, Trained, Sold*).
- No em-dashes. No semicolons. No filler adjectives. Quantify
  whenever the data supports it. **Never invent achievements.**

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
"queued — will run within ~1 hour" indicator flips to "fill-in
complete" without a page reload.

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
   *"Request queued — dev will run the AI pipeline within ~1 hour
   when online. ETA: ~1 hour."*
4. The banner also offers a `mailto:` link with prefilled subject /
   body addressed to **jace100233260@gmail.com**, so the counsellor
   can optionally also send an email — server-side email isn't wired
   yet (see section B for setup).

The counsellor's UI polls the request status every minute. Once Jace
runs the routine and the dispatch resolves it, the banner flips to
*"Fill-in complete — open the student to view the new resume / SOP /
LOR drafts."*

---

## Section B — How Jace runs a manual fill (the actual flow)

When you (the dev) get a request:

1. **Open the routine page** — https://claude.ai/code/routines/trig_01BTTjNjGDpdGyywLqBTtk1a
2. Click **"Run now"**. The routine spawns a fresh Claude Max session
   in Anthropic Cloud, clones the repo, reads this file, and runs the
   pipeline above.
3. The agent processes up to 5 students (the
   `manual_ai_requests` queue + any `intake_phase='done'` /
   `ai_eligible_via_pre_upload=TRUE` student that's not yet been
   processed).
4. Watch the run stream on the routine page. Final summary lands at
   the bottom.
5. Verify in the staff panel: the affected students show new resumes,
   SOP drafts, LOR drafts; their files have `ai_description` /
   `ai_extracted` populated.

If the run fails partway, the unresolved students stay in the queue —
hit "Run now" again.

If you want to run a single specific student manually (skip the queue
gate), set `ai_artifacts_generated_at = NULL` for that student first,
then trigger the routine:

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
