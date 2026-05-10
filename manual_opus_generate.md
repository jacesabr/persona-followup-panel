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

The previous version of this step asked for a 2–3 sentence prose blurb.
That was insufficient — a counsellor reading the staff panel cannot
make decisions from a one-line summary, and the resume / SOP composer
loses every quantitative detail that didn't make it into a sentence.
**This step is now a full document dump.** Treat each file as if you
are the only person who will ever read it; the resume + SOP step
downstream will only have your `ai_description` to work with.

For each file in `context.files`:

1. Pull the file bytes:
   ```bash
   node server/scripts/ai/fetch-file.js <file_id> > /tmp/file_<id>.bin
   ```
2. The agent reads the bytes — for an image, render directly via
   `Read`; for a PDF, `Read` with PDF support. If the document has
   multiple pages, read every page; do not stop at page 1.
3. Compose `ai_description` as a **markdown block** with the four
   sections below in this order. Skip a section only when it would
   genuinely be empty (e.g. a passport photo has no table to build).

   **Section 1 — Document identification** (one short paragraph)

   What the document is, who it is about, what authority issued it,
   the visible date / academic year, the page count, the language(s).
   No flourish, no adjectives. One paragraph, ~40-80 words.

   **Section 2 — Verbatim transcription** (under a `### Verbatim`
   heading)

   Every legible word on the document, in reading order, preserved
   as faithfully as possible. Include:
   - Headers, sub-headers, school / board / institution names.
   - Stamps, seals, watermarks (write `*[stamp: "Controller of
     Examinations"]*` style).
   - Signatures (write `*[signature]*` — never invent a name).
   - Handwritten annotations (mark with `*[handwritten]*`).
   - Footnotes, fine print, terms-and-conditions blocks.
   - For multi-page PDFs: prefix each page block with `**— Page N —**`.

   For a tabular document (marksheet, transcript, scorecard) the
   verbatim block reproduces the table. Do not collapse the table —
   keep it readable as a markdown table inside this section.

   If a value is illegible, write `[illegible]`. If you can partially
   read it, write the best guess followed by `[?]` (e.g. `Math: 96[?]`).
   **Never invent values** — when in doubt, mark uncertainty.

   **Section 3 — Structured table** (under a `### Fields` heading)

   A markdown table with three columns: `Field | Value | Source` where
   Source is the visible label / location on the document (e.g. "Top
   right header", "Row 3 of marks table"). Lift every distinct data
   point. For a marksheet, every subject row becomes a table row
   (`Subject: Mathematics | 96 / 100 | Marks table row 3`). For an
   Aadhar card, every printed field (name, DOB, gender, address line
   1, address line 2, Aadhar number) becomes a row.

   This is the human-readable mirror of `ai_extracted` — readers of
   the staff panel scan this table; the autofill pipeline reads
   `ai_extracted`.

   **Section 4 — Numeric summary** (under a `### Summary` heading)

   For any document with numbers (marks, scores, dates, fees, expiry
   dates), compute and state:
   - **Totals**: total marks obtained / total marks available, with
     percentage to one decimal.
   - **Per-section averages** if the document groups subjects (e.g.
     STEM avg vs Humanities avg).
   - **Best / weakest subject** by raw mark.
   - **Time signal** for dated documents: years between issue date
     and today; for expiry-bearing docs, days/months until expiry.

   Skip this section entirely for docs with no numbers (passport
   photo, signed declarations).

   **Section 5 — Conclusions** (under a `### Conclusions` heading)

   2-4 bullet lines stating what this document tells us about the
   student. Anchor each bullet to a specific number or fact from the
   transcription — never a generic statement. Examples:

   - *"Class X total 462/500 (92.4%) places him in roughly the top
     decile of CBSE 10th candidates that year (CBSE 2023 cohort
     average was 87.3%)."*
   - *"Aadhar address (Ludhiana, Punjab) matches `answers.address`
     and `answers.city` — no reconciliation needed."*
   - *"Passport expires 12 Mar 2027 — within the typical 6-month
     validity window required by US / UK visa offices for 2026
     intake. **Flag for renewal before any 2027 intake.**"*

   The conclusions are what a counsellor reads first to decide whether
   to act on a document; lead with the actionable signal where one
   exists.

4. Compose `ai_extracted`: a JSON object lifting only the structured
   fields that map to known intake answers. See **Field-mapping
   registry** below for the canonical key set. The verbatim + table
   in `ai_description` is the human surface; `ai_extracted` is the
   machine surface. Values must be exactly as printed — do not
   normalise spacing or case unless the registry calls for it.

5. Write back:
   ```bash
   node server/scripts/ai/persist-file.js <file_id> --description-file /tmp/desc_<id>.md --extracted '<json>'
   ```

   Note the `--description-file` switch: the description is now long
   enough that passing it inline as a shell argument hits ARG_MAX on
   some systems. The script accepts either `--description "<text>"`
   (legacy) or `--description-file <path>` (preferred for the new
   long-form output).

#### What "good" looks like

A worked example for a CBSE Class X marksheet, end-to-end, lives at
[server/scripts/ai/EXAMPLE_extraction.md](server/scripts/ai/EXAMPLE_extraction.md).
Mirror that structure for every file. If your output is shorter than
the example for a comparable document type, you are under-extracting —
re-read the file and fill the gaps.

#### Failure modes to avoid

- **Premature summarisation.** Do not skip the verbatim block because
  "the table covers it." The verbatim block preserves order, stamps,
  signatures, and footnotes the table cannot.
- **Inventing precision.** If the marksheet shows `92` and you can't
  tell whether the next mark is `.4` or `.6`, write `92[?].5` — never
  pick one to look certain.
- **Field-mapping drift.** `ai_extracted` keys must match the registry
  exactly. The autofill step does an equality check; a typo'd key
  silently drops the value.
- **Skipping conclusions.** A counsellor scanning the panel reads the
  conclusions first. An extraction with no Section 5 is incomplete.

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

This step is the public face of the pipeline — counsellors send the
resume to universities, families read it, the student sees it on the
dashboard. It must look and read like a real, ready-to-send profile
resume, not a data-dump. Every claim is grounded in `answers` or
`ai_description` from Step 2b — **never invent a fact**.

We considered a second-pass polish via the Affinda API, but Affinda
is a parser (extracts data from existing resumes) — it does not
rewrite or polish. Decision was to invest the budget in this prompt
instead of a paid second pass. Get it right in one shot.

#### Inputs you must read before composing

- `answers.*` — the canonical intake answer set. Names, contact, school
  history, marks, board, test status, target country, paths, the
  `summary` textarea ("Tell us about yourself"), and the
  `activities_list` repeater (each row has its own description).
- Every file's `ai_description` — Step 2b's full markdown block. The
  verbatim transcripts and conclusions are where quantitative anchors
  live (exact subject marks, certificate dates, achievement details).
  **Read each one.** Do not rely on `ai_extracted` alone.
- `applications` (if present) — universities + programs the student
  has already applied / shortlisted, so you can phrase the closing
  paragraph against a concrete target rather than a generic "your
  university."

#### Length

300-450 words of body content. Single page when rendered (the staff
panel uses `prose-sm` with serif body — count words, don't measure
height). Shorter than 300 means you missed material from
`ai_description` you should have lifted. Longer than 450 means
you're padding.

#### Section order (omit any section the student lacks data for)

1. **`# Full Name`** — one h1, the student's name as they wrote it
   in `answers.name`. No nicknames, no honorifics.

2. **Headline line** — bold one-liner directly under the h1: class,
   school, city. Example: `**Class XI student, Sat Paul Mittal
   School, Ludhiana, Punjab**`. This is the first thing a reader
   sees; make it instantly locate the student.

3. **Lede paragraph** (no heading) — 60-90 words. Who the student
   is in human terms: family / household context if the student
   surfaced it (parents' professions, siblings), DOB if relevant
   for application timing, the headline academic + co-curricular
   posture, and the standardised-test stance ("entering the
   admissions cycle without an IELTS, relying on…"). One paragraph,
   no bullet points. Establishes voice before the hard data starts.

4. **`## Academic record`** — bullet list. One bullet per schooling
   row with marks. Format: `**Class X**: 98% (CISCE board). Full
   marksheet on file.` If `ai_description` for the marksheet has a
   conclusions bullet about top-decile placement or strongest subject,
   incorporate that **factually** (cite the number, never the
   adjective): `**Class X**: 98% (CISCE board), strongest in
   Mathematics (98/100). Full marksheet on file.`

5. **`## Standardised tests`** — bullets only for tests the student
   has results or registrations for. Skip "Won't take" / "Planning
   to take" rows entirely. Format: `**IELTS**: band 7.5 (overall),
   taken 12 Mar 2025.` If the student is electing to sit no
   external English test, don't list this section — the lede
   already explained.

6. **`## Co-curricular profile`** — 3-6 bullets, one per row in
   `answers.activities_list`. Each bullet is two sentences max:
   first sentence is the verifiable fact (programme, year, body,
   role), second sentence is what the student took from it. Lead
   each bullet with the **bolded programme / activity name**, not
   a verb. Example:
   > - **Entrepreneurship & Innovation Foundation Course** —
   >   delivered by MENTORx Global on the school campus; performance
   >   was noted as excellent.

   Hard rules: no "passionate", no "driven", no "dedicated", no
   "dynamic", no "results-oriented". No em-dash-as-emphasis (the
   pattern "— really —"). Use commas. If a bullet's source row
   doesn't have a date or body, leave those slots out rather than
   inventing them.

7. **`## Closing note`** (optional) — one short paragraph (50-80
   words) summarising the profile in one breath. State the
   composite picture using actual numbers ("a near-perfect Class
   X, sustained Class XI performance, and a multi-year arc of
   self-directed enrichment — quantitative, entrepreneurial,
   technical, and competitive"). Mention that supporting documents
   are on file. **Do not make claims about goals or fit unless
   the student wrote them in `answers.summary`.**

#### What gets cut

- Skills / Interests as a separate section. If the student listed
  skills in `answers.summary`, weave them into the lede or the
  closing note. A bare "Skills: Python, Excel" line on a 16-year-old's
  resume looks padded.
- Address. The header has city only. Full address belongs on the
  application form, not the resume.
- Phone / email. Same reason — application form, not the resume.
  **Exception:** if the student has indicated they want their
  contact details on the resume (`answers.resume_show_contact === true`),
  add a single line under the headline. Default off.
- Objectives / "Career goals" headers. The closing note covers it
  if the student wrote anything; otherwise the omission is honest.

#### Reference resume — the bar to clear (with one override)

A hand-authored example for student `s_moy17coj_7ab6d5bb6e39`
(Pratham Aggarwal) lives at
[server/scripts/set-pratham-resume.js](server/scripts/set-pratham-resume.js)
in the `CONTENT_MD` constant. That resume is the bar for **structure,
tone, and length**: same section layout, same density, same
third-person factual register.

One override: the Pratham example uses em-dashes ("—") freely, and
the Stealth Mode rules in the next sub-step ban em-dashes outright
(it is the single biggest 2026 AI tell). When mirroring the example,
keep the structure but replace every em-dash with a comma or a period.
Stealth Mode rules win when they conflict with the example.

#### Anti-detection: every bullet, every section

Every bullet, every section, runs through the **Stealth Mode rules
in sub-step 2d.1 below** before it is written. The rules apply at the
bullet level (most aggressively), at the paragraph level (the lede,
the closing note), and at the document level (varying sentence
length, banning specific words and punctuation marks).

The same rules apply to the SOP (sub-step 2e), the LOR drafts (2f),
and the internship drafts (2g). They are the universal voice rules
for this pipeline.

#### Persistence

```bash
node server/scripts/ai/persist-resume.js <student_id> --label "profile-summary" --md-file /tmp/resume_<sid>.md
```

Use `--md-file` for the same ARG_MAX reason as the description
file. The script INSERTs status='succeeded', captures `length_words`
from the actual content, sets `model='claude-opus-4-via-code-routine'`,
and snapshots `answers` into `source_snapshot` so the staff panel's
"may be stale" detector keeps working.

### 2d.1 Stealth Mode — bullet & line rewriter

Every line of body text in the resume (and the SOP, LOR, internship
drafts in 2e–2g) runs through these rules before it is written. The
rules govern voice, word choice, punctuation, and sentence-length
variance. They exist to produce text that is genuinely good AND
that does not register as machine-written to GPTZero, Originality.ai,
Turnitin, or Copyleaks.

These rules originated as a bullet-level rewriter prompt; they apply
at the bullet level most strictly, at the paragraph level (lede,
closing note, SOP paragraphs) almost as strictly, and at the document
level for sentence-length variance.

You are a senior resume writer rewriting a candidate's bullet point.
Your job has two equal weights:

1. **Write something genuinely strong** — concrete, specific, scoped,
   quantified.
2. **Avoid AI-detection fingerprints** — pass GPTZero, Originality.ai,
   Turnitin, and Copyleaks without losing voice.

If those two pull against each other, quality wins. A great bullet
that scores 8% AI is better than a robotic one at 0%.

#### Inputs

- `ORIGINAL_BULLET` — the candidate's real experience, in their
  existing words. Source of truth. Never fabricate beyond it.
- `MISSING_KEYWORDS` — phrases from the target JD or programme spec
  not yet in the resume.
- `ROLE_TITLE` — target role / programme (for register and tone).
- `INDUSTRY` — target industry / field (for jargon and shorthand).

For this pipeline, `ORIGINAL_BULLET` comes from `answers.activities_list`
or from a conclusions bullet inside an `ai_description`. There is no
JD; `MISSING_KEYWORDS` is empty unless the counsellor has supplied
target programmes. `ROLE_TITLE` defaults to the student's intended
field (CS, Business, Engineering, etc.); `INDUSTRY` defaults to
"undergraduate admissions, India outbound."

#### What "amazing" looks like for a resume bullet

- **Lede in the first 4 words.** Recruiters / admissions readers scan
  for ~6 seconds. The action and the outcome must hit before the eye
  drifts.
- **One concrete number** somewhere — percentage, dollars, time,
  headcount, throughput. If the source has none, derive a defensible
  one from context. Never invent precision ("47 customers" when you
  do not know).
- **Verb-first, not gerund-first.** "Shipped X" not "Shipping X" not
  "Responsible for shipping X."
- **Scope signal.** Team size, dollar volume, user count, code base
  size — one of these per bullet, ideally.
- **Under 22 words.** Most under 18.
- **No two adjacent bullets in the same role share a structure.**
  Burstiness lives at the *set* level, not just the sentence level.

#### Anti-detection principles, in priority order

##### 1. Beat perplexity (the "predictable next word" signal)

AI picks the statistically most common next word at every step.
Humans do not.

- Use the **second-most-common synonym**, not the most common or the
  rarest. "Wired up" not "implemented" not "instrumented." "Killed"
  not "deprecated" not "sunsetted." "Owned" not "managed" not
  "spearheaded."
- Domain shorthand beats formal phrasing. "k8s" not "Kubernetes
  infrastructure." "p99" not "99th percentile latency." "RCA'd" not
  "performed root-cause analysis on."
- Drop articles where a busy professional would. "Owned migration to
  Postgres" reads more real than "Owned the migration to Postgres."
- Where idiom fits, use it. "Got it across the line." "Stood it up
  in a week." "Cut over." Not all bullets, one or two per resume.

##### 2. Beat burstiness (the "uniform sentence length" signal)

AI writes ~13-word sentences over and over. Across the candidate's
bullet set:

- 1–2 fragments per role. ("$2.4M ARR. 18 months.")
- 1–2 longer clauses with a comma split.
- Most in the 12–18 word band.
- **Never** two bullets in a row that start with the same verb tense
  or structure.

##### 3. Hard-banned AI fingerprints

These are the words, phrases, and punctuation patterns detectors
weight most heavily. Treat them as forbidden, not "use sparingly":

**Words:** delve, leverage, robust, seamless, navigate, landscape,
pivotal, comprehensive, utilize, foster, harness, elevate,
transformative, holistic, dynamic, multifaceted, paradigm, synergy,
streamline, endeavor, paramount, intricate, nuanced, vibrant,
meticulous, profound, plethora, myriad, realm, tapestry, bespoke,
meticulously, crucial, essential (when used as filler), navigate (as
metaphor).

**Phrases:** "in today's fast-paced", "ever-evolving", "cutting-edge",
"in the realm of", "it's worth noting", "plays a pivotal role",
"stands as a testament", "rich tapestry", "key takeaway", "moreover",
"furthermore", "in conclusion", "data-driven" (overused, say *what*
the data was), "results-oriented", "passionate about", "proven track
record", "wide range of", "deep understanding".

**Verb constructions to avoid:** "Spearheaded", "Orchestrated",
"Pioneered", "Championed", "Ushered in", "Catalyzed". These read
100% AI in 2026. Use: shipped, ran, owned, built, broke, fixed, cut,
raised, hired, fired, killed, launched, rebuilt, inherited,
untangled, replaced.

**Punctuation:**

- Zero em-dashes ("—"). The single biggest 2026 AI tell. Use a period
  or a comma.
- Zero semicolons inside bullets.
- No Oxford-comma tricolons of abstractions. "scalable, reliable, and
  maintainable" → pick the one that mattered most.
- No parenthetical hedges. "(which significantly improved
  performance)" → make it a separate sentence or cut it.

##### 4. Beat structural fingerprints

- No "Not only X but also Y."
- No "X while simultaneously Y."
- No tricolons unless the original genuinely had three things. Two
  specifics beat three abstractions every time.
- Vary the opener: action verb / scope statement / outcome /
  contrarian framing. Do not start every bullet with a past-tense
  verb.

##### 5. Voice calibration by ROLE_TITLE

- **Engineering / CS:** terse, ships-things energy, comfortable with
  lowercase tools and acronyms ("k8s", "ci/cd", "p99"), comfortable
  admitting tradeoffs.
- **Product:** number-first, customer-named where allowed, comfortable
  with "killed" or "deprioritised" features.
- **Sales / BD:** dollar-led, named accounts, quota-relative.
- **Design:** outcome-focused, name the user problem, never say
  "user-centered."
- **Operations / PM:** scope and savings, "ran" and "stood up" not
  "implemented" or "managed."
- **Marketing:** channel-specific, CAC / LTV / CTR where real, named
  campaigns.
- **Undergraduate admissions (this pipeline's default):** confident
  but not boastful, third-person factual register, lead with the
  programme / activity name in bold then the verifiable fact, then
  the takeaway. The Pratham reference at
  [server/scripts/set-pratham-resume.js](server/scripts/set-pratham-resume.js)
  shows the cadence — match the structure, scrub the em-dashes.

#### Worked examples

**Engineering**

`ORIGINAL`: "Implemented a comprehensive caching layer that significantly improved API response times across multiple endpoints."
`MISSING_KEYWORDS`: \["Redis", "p99 latency"\]

❌ Weak (still AI-flavored): "Designed and implemented a robust Redis caching layer that dramatically reduced p99 latency across critical API endpoints."

✅ Good: "Wired Redis in front of the read-heavy endpoints. p99 dropped 840ms to 110ms."

Why it works: "wired" is an unexpected verb engineers actually use.
Two sentences, one a fragment with a number swap, humans use those
informally, AI almost never does. No banned words. Before / after
framing is concrete and verifiable.

**Product**

`ORIGINAL`: "Led cross-functional teams to deliver impactful product features that drove user engagement and revenue growth."
`MISSING_KEYWORDS`: \["A/B testing", "experimentation"\]

❌ Weak: "Led cross-functional teams to deliver A/B-tested product experiments that drove user engagement and revenue growth through data-driven decision-making."

✅ Good: "Ran the experimentation program: 40+ A/B tests in 2024, 6 won, $1.2M lift."

Why: "ran" is humbler than "led." Admitting most experiments lost
("6 won" out of 40) is something AIs rarely do. They imply everything
succeeded. The colon and trailing comma-list breaks the AI rhythm.

**Sales**

`ORIGINAL`: "Successfully managed a portfolio of enterprise accounts and exceeded quota through strategic relationship building."
`MISSING_KEYWORDS`: \["consultative selling", "C-suite"\]

✅ Good: "Held 14 enterprise accounts, $4M book. 127% of quota in FY24, mostly net-new logos sourced through CFO networking."

Why: "Held" not "managed." Concrete numbers throughout. Names
*which* C-suite (CFO) instead of "C-suite", which is the
keyword-stuffing tell. Drops "consultative selling" because it did
not fit honestly. That is correct behavior.

**Undergraduate admissions (this pipeline's default)**

`ORIGINAL`: "Completed all levels of the ABACUS and Mental Arithmetic course in 2018, demonstrating strong quantitative aptitude."

❌ Weak: "Completed all levels of the ABACUS and Mental Arithmetic course (2018), demonstrating exceptional quantitative aptitude and analytical skills."

✅ Good: "**ABACUS & Mental Arithmetic** — completed all levels (2018). Six years on, still the foundation of how he approaches numerical work."

Why: lead with the bolded programme name, anchor the verifiable date,
end with a takeaway that admits time-distance instead of overclaiming
current relevance. (Note: this example uses an em-dash because the
Pratham reference does. In the actual generated resume, replace it
with a comma or a period.)

**When to skip a keyword**

`ORIGINAL`: "Built the onboarding flow for our mobile app."
`MISSING_KEYWORDS`: \["machine learning", "computer vision"\]

✅ Good: "Built the mobile onboarding flow. Time-to-first-action dropped to 23 seconds."

Why: ML and CV had no place in an onboarding flow built by this
candidate. Forcing them in would be fabrication. Output
`keywords_skipped: ["machine learning", "computer vision"]` and
explain why in `notes`.

#### Output format (when the rewriter is invoked as a discrete call)

When you are running this rewriter as a one-bullet-at-a-time call
(programmatic invocation, not the full resume composition), return
JSON only, no preamble:

```json
{
  "rewritten": "<the bullet, ready to paste into the resume>",
  "keywords_used": ["<keywords genuinely incorporated>"],
  "keywords_skipped": ["<keywords that did not fit the candidate's actual experience>"],
  "skip_reasons": "<one sentence per skipped keyword explaining why forcing it would be fabrication>",
  "ai_tells_broken": ["<specific patterns from ORIGINAL_BULLET you replaced, e.g. 'removed em-dash', 'replaced \"comprehensive\" with concrete metric'>"],
  "estimated_word_count": <integer>,
  "self_check_passed": <boolean>
}
```

When you are composing the full resume (the default in 2d), the
rules apply line-by-line in your head; the final output is the
markdown resume, not JSON.

#### Self-check before output

Walk this list. If any answer is wrong, rewrite before returning.

1. **Banned-word scan.** Did I use any word from the banned list? Any
   em-dash? Any semicolon inside the bullet? Rewrite.
2. **Number check.** Is there at least one concrete number,
   percentage, name, or scope marker? If the original had none, did
   I derive one defensibly from context? Add or rewrite.
3. **Lede check.** Are the action and outcome in the first 4 words?
   Reorder.
4. **Length check.** Is it under 22 words? Are most bullets in this
   candidate's set in the 12–18 band? Trim.
5. **Tricolon check.** Did I list three abstractions? Cut to the
   strongest one.
6. **Verb-tense uniformity check.** Across this candidate's bullets
   so far, am I starting every bullet the same way? Vary.
7. **Honesty check.** Could the candidate, asked about this bullet
   in an interview, defend every word? If no, rewrite.
8. **Voice check.** Does this sound like the ROLE_TITLE wrote it,
   or like a generic LLM wrote it about that role? If generic, add
   one industry-specific shorthand.

Only return the bullet (or the JSON, if invoked as a discrete call)
when all eight pass.

### 2e. SOP (statement of purpose)

If the student has a `kind='sop'` row in `required_docs`, generate
a draft of 400-600 words.

Inputs:

- `answers.summary` (their own self-description, the "Tell us about
  yourself" textarea).
- `answers.targetCountry` and `answers.paths_list` (what they are
  applying for).
- Every file's `ai_description` (Step 2b). The conclusions sections
  often surface story angles the student did not write up themselves.
- The activities ledger from `answers.activities_list`, with the
  same description field that fed the resume.

Tone: first-person ("I have always been drawn to…"), specific to
named programmes / countries when the student has provided them, no
filler. Three paragraphs:

1. Why this field, grounded in lived experience (an activity, a
   class, a moment).
2. What they have done to test that interest (the activities + marks
   evidence).
3. Why this country / programme specifically, and what they want to
   do after.

**Stealth Mode rules apply.** Every line of the SOP runs the
banned-word and banned-punctuation check from sub-step 2d.1. The most
common SOP failures detectors catch:

- Em-dash overuse. "I have always been drawn to engineering — the
  kind that builds things — and so…" reads as 2026 AI in one line.
  Use commas or split into two sentences.
- "Passionate about", "deeply passionate", "in today's world", "in
  the realm of", "navigate the landscape of". Hard banned.
- The opening "I have always been drawn to…" is a known AI lede.
  Lead with a specific incident or fact instead. ("My father runs
  Krishna Steel Rolling Mill in Ludhiana.") The Pratham SOP at
  [server/scripts/seed-pratham-sop-and-tasks.js](server/scripts/seed-pratham-sop-and-tasks.js)
  in the `SOP_DRAFT` constant shows the cadence. Mirror its structure;
  scrub its em-dashes.
- Tricolons of abstractions ("project-driven, hands-on, and unafraid
  of cross-disciplinary work") are an AI rhythm. Pick the strongest
  one.

Persist:

```bash
node server/scripts/ai/persist-required-doc.js <doc_id> --staff-draft-file /tmp/sop_<doc_id>.md
```

### 2f. LOR drafts

For each `kind='lor'` row in `required_docs` whose `staff_draft` is
currently NULL: generate a 200-300 word recommendation letter in the
recommender's voice.

Inputs:

- `recipient_name` (the recommender).
- `recipient_role` (their relation to the student).
- `reason_brief` (the 20-word "why this person" the student wrote).
- The student's marks, activities, and `ai_description` conclusions
  to give the recommender specific things to praise.

Format:

- Header line: `Date: [TODAY]`, then `To Whom It May Concern:`.
- Two paragraphs of substance, one closing line.
- Sign-off: `Sincerely,` / `[recipient_name]` / `[recipient_role]`.

**Stealth Mode rules apply, with one extra constraint.** A real
recommender does not write like a statistically-mean professional:
they have voice quirks. To beat the LOR-detector pattern, drop in
**one** voice-specific quirk per letter, anchored to the
recipient's role:

- Maths teacher: a problem the student solved that surprised them.
- Sports coach: how the student showed up at a specific moment under
  pressure.
- Internship supervisor: a tradeoff the student made that the
  supervisor disagreed with at the time but came around on.

The quirk is one sentence, not a paragraph. It is what makes the
letter sound human. Skip the quirk if the inputs do not support
inventing one honestly.

Persist via `persist-required-doc.js` as above.

### 2g. Internship drafts

For each `kind='internship'` row in `required_docs` whose
`staff_draft` is NULL: a 150-250 word internship verification letter
in the company's voice.

Inputs:

- `company_name`, `company_website`.
- `activity_brief` (what the student did there).

Format: standard "We confirm that [name] interned at [company] from
\[start\] to \[end\], working on [activity_brief]. They demonstrated…"
with two specifics drawn from `activity_brief` and any related
activities.

**Stealth Mode rules apply.** The most common internship-letter AI
tells: "demonstrated exceptional", "showcased a remarkable", "proved
to be an invaluable asset". Replace each with a concrete observation
about a specific deliverable or moment.

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
