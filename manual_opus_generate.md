# manual_opus_generate.md

The master command. A scheduled Claude Code routine runs this every
hour. For each student whose intake is finished but who has never
been through the AI pipeline, this generates: per-file descriptions,
autofilled answers from those files, a resume, an SOP draft, LOR and
internship drafts. Then it stamps `intake_students.ai_artifacts_generated_at`
so the same student is never processed twice. Most runs are no-ops
(no unprocessed students), so hourly cadence is cheap and gives a new
student their artifacts within ~60 min of finishing intake.

The agent that runs this **is** the LLM (your Claude Max session).
There is no Gemini / Anthropic API call — the agent reads context,
authors text in its own head, and writes results back via SQL.

---

## Preconditions

- Run from the project root with the prod `DATABASE_URL` available
  (it's in `.env`; the same one Render uses).
- The schema must include columns added in commit `<see latest>`:
  `intake_students.ai_artifacts_generated_at`,
  `intake_files.ai_description`, `intake_files.ai_extracted`.
  Verify with `SELECT 1 FROM information_schema.columns WHERE column_name='ai_artifacts_generated_at'`.
- R2 storage credentials must be in env so the agent can pull file
  bytes for vision passes.
- Cap: process **at most 5 students per run** so a single hourly
  invocation can't blow through Claude Max quota or timeout. Subsequent
  runs pick up the rest. With hourly cadence, a fresh batch of 50
  students gets through in ~10 hours.

---

## Step 1 — Find candidates

```bash
node server/scripts/ai/list-pending.js
```

Outputs a JSON array of student summaries:
```json
[
  {
    "student_id": "s_moy17coj_7ab6d5bb6e39",
    "display_name": "Pratham Aggarwal",
    "intake_phase": "done",
    "files_count": 8,
    "intake_complete": true
  },
  ...
]
```

Selection criteria (mirrored in the SQL inside `list-pending.js`):
- `intake_phase = 'done'`
- `is_archived = FALSE`
- `ai_artifacts_generated_at IS NULL`

If the array is empty, exit cleanly: nothing to do.

---

## Step 2 — Per-student loop

Process students one at a time so a single failure can't poison
the others. For each student:

### 2a. Load full context

```bash
node server/scripts/ai/load-context.js <student_id> > /tmp/ctx.json
```

`/tmp/ctx.json` looks like:
```json
{
  "student": { "student_id": "...", "display_name": "...", "data": {...}, "intake_phase": "done" },
  "answers": { "name": "...", "email": "...", "marks10pct": 92, ... },
  "files": [
    { "id": 24, "field_id": "aadharFile", "original_name": "...", "mime_type": "image/jpeg", "size": 278077 },
    ...
  ],
  "required_docs": [
    { "id": 30, "kind": "sop", "seq": 1, "staff_draft": null, ... },
    { "id": 31, "kind": "lor",  "seq": 1, "recipient_name": "Mr. ...", "recipient_role": "...", "reason_brief": "...", "staff_draft": null, ... },
    ...
  ],
  "applications": [ ... ]
}
```

### 2b. Per-file description + extraction (vision pass)

For each file in `context.files`:

1. Pull the file bytes:
   ```bash
   node server/scripts/ai/fetch-file.js <file_id> > /tmp/file_<id>.bin
   ```
2. The agent reads the bytes — for an image, it can render directly
   via the `Read` tool; for a PDF, the agent uses `Read` with PDF
   support.
3. Compose:
   - `ai_description`: a clear 2–3 sentence prose description of what
     the document is, what it shows, who it's about. Use plain
     English, not jargon. Examples:
     - *"Aadhar card (front side) for Pratham Aggarwal, DOB 12 Aug 2007, address in Ludhiana, Aadhar number 1234 5678 9012."*
     - *"CBSE 10th-grade marksheet for Pratham Aggarwal, total 462/500 (92.4%). Subjects: English 95, Hindi 88, Math 96, Science 94, Social Science 89."*
     - *"Passport photo. Plain white background, head-and-shoulders framing. Suitable for visa / university applications."*
   - `ai_extracted`: a JSON object lifting any structured fields from
     the document — only fields that map to known intake answers.
     See **Field-mapping registry** below for the canonical key set.
4. Write back:
   ```bash
   node server/scripts/ai/persist-file.js <file_id> --description "<text>" --extracted '<json>'
   ```

### 2c. Autofill missing intake answers

After all files are described:

1. Merge every `ai_extracted` blob into a single proposed answer-set.
2. For each proposed key, **only** write to `intake_students.data.answers`
   if the answer is currently empty (`null`, `""`, or missing). Never
   overwrite a counsellor or student edit.
3. Persist:
   ```bash
   node server/scripts/ai/autofill-answers.js <student_id> '<json>'
   ```
4. Audit log entry: action `ai_autofill`, diff payload listing which
   keys were written and from which file.

### 2d. Resume

Compose a 250–350 word, single-page resume in **markdown**.
Sections, in order, omitting any that are empty after autofill:

1. Header line: full name, city, email, phone (one line each, plain).
2. Education: each schooling row with school name, board, percentage.
3. Standardized tests: only sit-for-results lines (IELTS band, SAT,
   AP). Skip "Won't take" / "Planning to take" rows.
4. Activities & achievements: 4–6 bullets, lifted from
   `answers.activities_list`. Use the description, trim filler, lead
   with the active verb. **Do not invent achievements.**
5. Skills / Interests: only if explicitly mentioned in `answers.summary`
   (the "Tell us about yourself" textarea).

Tone: factual, third-person ("Pratham led…"), zero adjectives like
"passionate" / "dedicated". Quantify wherever the data supports it.

Persist as a succeeded `intake_resumes` row:
```bash
node server/scripts/ai/persist-resume.js <student_id> --label "auto-summary" --md "<contents>"
```

The script INSERTs status='succeeded', `length_words=350`,
`model='claude-opus-4-via-code-routine'`.

### 2e. SOP (statement of purpose)

If the student has a `kind='sop'` row in `required_docs`, generate
a draft (~400–600 words). Inputs:
- `answers.summary` (their own self-description)
- `answers.targetCountry` and `answers.paths_list` (what they're
  applying for)
- Activities, marks, story angle inferable from the data.

Tone: first-person ("I have always been drawn to…"), specific to
named programs / countries when the student has provided them, no
filler. Three paragraphs:
1. Why this field, grounded in lived experience (an activity, a
   class, a moment).
2. What they've done to test that interest (the activities + marks
   evidence).
3. Why this country / program specifically, and what they want to
   do after.

Persist:
```bash
node server/scripts/ai/persist-required-doc.js <doc_id> --staff-draft "<contents>"
```

### 2f. LOR drafts

For each `kind='lor'` row in `required_docs` whose `staff_draft`
is currently NULL: generate a 200–300 word recommendation letter
in the recommender's voice. Inputs:
- `recipient_name` (the recommender)
- `recipient_role` (their relation to the student)
- `reason_brief` (the 20-word "why this person" the student wrote)
- The student's marks / activities / story to give the recommender
  specific things to praise.

Format:
- Header line: `Date: [TODAY]`, then `To Whom It May Concern:`.
- Two paragraphs of substance, one closing line.
- Sign-off: `Sincerely,` / `[recipient_name]` / `[recipient_role]`.

Persist via `persist-required-doc.js` as above.

### 2g. Internship drafts

For each `kind='internship'` row in `required_docs` whose
`staff_draft` is NULL: a 150–250 word internship verification letter
in the company's voice. Inputs:
- `company_name`, `company_website`
- `activity_brief` (what the student did there)

Format: standard "We confirm that [name] interned at [company] from
… to …, working on [activity_brief]. They demonstrated …" with two
specifics drawn from `activity_brief` and any related activities.

Persist via `persist-required-doc.js`.

### 2h. Stamp complete

```bash
node server/scripts/ai/mark-done.js <student_id>
```

Sets `ai_artifacts_generated_at = NOW()` and writes one
`intake_audit_log` row with action `ai_artifacts_generated`,
diff = `{ "files_described": N, "answers_autofilled": M, "resume": true, "sop": "drafted"|"skipped", "lors": N, "internships": M }`.

---

## Field-mapping registry — `ai_extracted` keys

| Document type | Extracted keys → intake-answer keys |
|---|---|
| Aadhar card | `name`, `dob`, `aadhar` (12-digit, formatted `XXXX XXXX XXXX`), `address_*` |
| Passport | `name`, `dob`, `passport`, `passportExpiry` (ISO date) |
| Marksheet (10) | `marks10pct`, plus `school10Name` if visible |
| Marksheet (11) | `marks11pct` |
| Marksheet (12) | `marks12pct`, `marks12predicted` |
| IELTS result | `ielts_score` (overall band, 0.5 step), `ielts_status='Already taken'` |
| TOEFL result | `toefl_score`, `toefl_booked=true` |
| SAT/ACT result | `sat_score`, `sat_booked=true` |
| Photo | nothing extractable |
| Other | nothing extractable; description only |

If a document's content disagrees with an existing intake answer,
**do not overwrite**. Add a note to `intake_audit_log` instead so
a human can reconcile.

---

## Failure handling

- If any helper script returns non-zero, log the student_id + the
  error to stderr and skip that student. Do **not** mark
  `ai_artifacts_generated_at` so the next hourly pass retries.
- If the agent runs out of context, finish the student in flight
  before exiting. Half-finished students stay unmarked.
- If a vision call fails for one specific file, write
  `ai_description = '(unable to read this file)'` and continue —
  the file's not blocking the resume.

---

## Phase 2 (planned, not yet built)

Counsellor "upload starter docs before student is created" flow.
Today the AI pipeline only sees students whose intake is `done`.
For brand-new accounts that the counsellor manually creates with
documents on hand, the proposal is:

- New UI: in `StudentsAdmin.jsx`'s create-student modal, a
  "Starter documents" multi-upload slot.
- New endpoint: `POST /api/students/with-docs` that creates the
  student row and attaches the uploaded files in one transaction.
- The student row lands with `intake_phase = 'intake'` (not `'done'`),
  so the standard candidate query doesn't pick it up. Need a
  separate flag `ai_eligible_via_pre_upload BOOLEAN` so the routine
  treats pre-uploaded students the same as done-phase students.
- Same pipeline runs on the next hourly tick.

Track this as a separate change. The current pipeline is independent
and ships standalone.

---

## Manual run (for testing / one-shot)

```bash
# 1. Find a candidate
node server/scripts/ai/list-pending.js

# 2. Load their full context
node server/scripts/ai/load-context.js <student_id> > /tmp/ctx.json

# 3. Walk steps 2b-2h yourself, calling the persist-* scripts as
#    you compose each artifact. The agent (you, the LLM) is what
#    authors the resume / SOP / LOR text — there is no orchestrator
#    script because orchestration is the model's job.
```

To force a re-run on a student that's already been marked done:
```bash
psql "$DATABASE_URL" -c "UPDATE intake_students SET ai_artifacts_generated_at = NULL WHERE student_id = '<id>';"
```
