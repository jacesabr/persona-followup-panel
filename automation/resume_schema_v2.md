# Resume payload — schema v2

The canonical reference for the `content_json` payload the agent
authors, the renderer consumes, and the student / counsellor see as a
designed PDF-style document. Mirrors `lib/resumeSchema.js` —
that file is the runtime source of truth (the renderer normalises
through `normalizeResumeJson` before drawing). This doc exists so the
agent reading this folder cold has a complete picture without having
to hop through JSDoc.

## Schema version

```
CURRENT_RESUME_SCHEMA_VERSION = 2
```

`schema_version` is the only field whose absence causes a hard
fallback: if the renderer sees `schema_version > 2` it shows a
"newer schema, regenerate" banner instead of attempting to render.
Any payload you author MUST set `schema_version: 2`.

v1 payloads still render — `awards`, `publications`, and `gpa`
default to empty / "" if absent. But every NEW payload should be
written as v2 so awards and publications surface where they belong
instead of getting buried in `activities`.

## Top-level shape

```jsonc
{
  "schema_version": 2,                    // required, integer 2
  "name":             "string",           // student's full name as in answers.name. No nicknames.
  "headline":         "string",           // one line under the name. ≤ ~80 chars.
  "contact": {                            // optional. show=true → renders the line.
    "show":           false,
    "phone":          "",
    "email":          ""
  },
  "lede":             "string",           // 60–90 word opener. No bullets. Establishes voice before the data.
  "education":          [BulletItem, …],  // every Class X / XII / undergrad row with marks
  "standardized_tests": [BulletItem, …],  // IELTS / TOEFL / SAT / AP — break out sub-bands when known
  "awards":             [BulletItem, …],  // distinctions: Olympiad ranks, NTSE / KVPY, scholarships, debate cups. Quantify with denominators.
  "publications":       [BulletItem, …],  // published / accepted papers, op-eds, talks. Empty array if none — do not pad.
  "internships":        [BulletItem, …],  // company in label, what they did in body, dates in meta
  "volunteer":          [BulletItem, …],
  "activities":         [BulletItem, …],  // co-curricular profile: 3–6 bullets, one per activities_list row
  "skills":     ["string", …],            // inline strip at the bottom. ≤ ~10 entries.
  "languages":  ["string", …],            // e.g. ["English (native)", "Hindi (native)"]
  "closing_note":     "string"            // optional 50–80 word summary at the foot.
}
```

## BulletItem shape

```jsonc
{
  "label":  "string",   // bolded leading label. e.g. "Class X (CBSE, 2023)" or "School CS Club, President"
  "body":   "string",   // 1–3 sentences. The factual line(s). No em-dashes (banned by Stealth Mode).
  "meta":   "string",   // optional secondary line under body, rendered smaller. e.g. dates, institution.
  "gpa":    "string"    // optional inline chip on education entries. e.g. "92.4%", "9.4/10 CGPA", "4.0/4.0 GPA".
}
```

The renderer:
- bolds `label` and follows it with a period
- inserts an outlined uppercase chip for `gpa` if present (education's only place this matters)
- runs `body` inline after the label
- drops `meta` on its own line below in smaller stone-700 text
- skips any item whose `label` and `body` are both empty

## Render order (single column, top to bottom)

1. **Header** — name + headline + (optional) contact line
2. **Lede** — paragraph
3. **Education**
4. **Standardized tests**
5. **Awards & recognitions**
6. **Publications**
7. **Internships**
8. **Volunteer work**
9. **Co-curricular profile**
10. **Skills** (inline strip)
11. **Languages** (inline strip)
12. **Closing note** — paragraph at the foot

Any section whose array is empty is skipped — no empty heading, no
"none" placeholder.

## Visual language (so you can predict what the student will see)

- Body type: serif, base size, generous line-height
- Section headings: sans-serif, uppercase, tracking 0.22em, with a
  thin accent rule below
- Single column, max-width 768px (web) / single A4 page (print)
- Bullets use a leading bolded `label` + period before the body —
  intentionally no em-dashes (Stealth Mode)
- The `gpa` chip is small, uppercase, outlined; sits inline beside
  the education label
- `meta` (dates / institution) renders in stone-700, one line under
  the body

## Where the student / counsellor see it as a PDF

- The student dashboard ("Your resume" section) and the staff student-
  detail modal both render via `<ResumeTemplate payload={…} />`.
- Both surfaces include a **"Download PDF"** button that calls
  `window.print()`. The `.resume-print` scope in `src/index.css`
  hides every non-resume element on print so the browser's
  Save-as-PDF dialog yields a clean, single-page document with the
  same look as the screen render.
- This is why writing high-quality `content_json` matters more than
  worrying about a separate PDF generator: the on-screen render IS
  the PDF, byte-for-byte.

## Stealth Mode rules (apply to every body / lede / closing_note string)

These are mirrored from `server/generators/section.js`'s system prompt
and from Section 3c of `instructions_autofill_plus_generate.md`. Every
string the agent emits MUST satisfy them.

**Why this matters for our cohort.** Admissions offices in 2026
routinely run resumes and SOPs through detectors (GPTZero,
Originality.ai, Turnitin's AI bypasser detection added Aug 2025).
Detectors have a well-documented bias that flags non-native English
writers harder than native ones — our applicants are Indian
high-school students, non-native by default, so the bar for "doesn't
trigger" is HIGHER for us, not lower. Stealth Mode is not optional
polish; it is the floor below which the artifact is not shippable.

### Word-level rules

- **No em-dashes (`—`).** Single biggest 2026 AI tell. Use a period
  or a comma. Zero exceptions.
- **No semicolons inside bullets.**
- **No banned words:** delve, leverage, robust, seamless, navigate,
  landscape, pivotal, comprehensive, utilize, foster, harness,
  elevate, transformative, holistic, dynamic, multifaceted, paradigm,
  synergy, streamline, endeavor, paramount, intricate, nuanced,
  vibrant, meticulous, profound, plethora, myriad, realm, tapestry,
  bespoke, meticulously, crucial, essential (when filler), additionally,
  indeed.
- **No banned phrases:** "in today's fast-paced", "in today's digital
  age", "ever-evolving", "cutting-edge", "in the realm of", "it's
  worth noting", "it's important to note", "stands as a testament",
  "plays a pivotal role", "rich tapestry", "moreover", "furthermore",
  "in conclusion", "key takeaway", "data-driven", "results-oriented",
  "passionate about", "proven track record", "wide range of", "deep
  understanding", "revolutionize the way", "unlock the potential".
- **No banned verb-openers** on bullets: Spearheaded, Orchestrated,
  Pioneered, Championed, Ushered in, Catalyzed.
  Use instead: shipped, ran, owned, built, broke, fixed, cut, raised,
  launched, rebuilt, inherited, untangled, replaced.

### Structural rules (the parts detectors actually weight in 2026)

Word lists alone aren't enough. 2026 detectors score perplexity
(per-word predictability), burstiness (sentence-length variance),
discourse coherence patterns, and lexical diversity curves at the
paragraph and document level. The rules below address each of those
signals concretely.

- **Lede in the first 4 words.** Action and outcome must hit before
  the eye drifts. AI loves slow lead-ins ("As a student passionate
  about…"); humans cut to the verb.
- **One concrete number per bullet ideally** (percentage, dollars,
  time, headcount, marks-out-of-total). If the source has none,
  derive a defensible one. Never invent precision.
- **Sentence-length distribution, not just a cap.** Across a candidate's
  3–6 bullets in one section: at least one fragment (5–10 words, no
  main verb — "30+ active members."), at least one longer clause
  (20–25 words with a comma split), the rest in the 12–18 band. Two
  adjacent bullets in the same length bucket = rewrite one. AI
  defaults to ~13-word sentences over and over; humans don't.
- **Vary openers — never two adjacent bullets starting the same way.**
  Not just verb-tense; vary structure: action verb / scope noun /
  outcome / contrarian framing.
- **No transition stacking.** Never open two consecutive sentences
  (or two paragraph openers in a three-paragraph SOP) with
  Furthermore / Moreover / Additionally / Indeed / In addition. One
  of these in a single document is already a tell; back-to-back is a
  confession. Use a real connector keyed to the prior sentence
  ("Two of those won regionals", "What that taught him", "By Class
  XII") or no connector at all and trust the reader.
- **Vary register across sections (the "AI-print" rule).** A single
  consistent voice across the whole document is the strongest
  document-level AI fingerprint. The lede should read like a person
  observing out loud (slightly informal, present-tense). Bullets
  should be terse, fact-first, past-tense. The closing note should
  feel reflective. If the lede could be swapped with a bullet body
  and the doc still flows, you're flat — re-author until each section
  sounds like a different register.
- **Whole-document lexical diversity.** Don't reuse the same verb
  across two bullets in the same section. Don't reuse the same
  modifier ("strong", "active", "consistent", "competitive") across
  the document. Track what you've already used and reach for a
  synonym before reusing.
- **Past-tense, third-person factual register on bullets.** Confident,
  not boastful.

### The "1000 students" test (run on every bullet before dispatch)

Before saving any bullet, ask: *could 1000 other Indian Class XII
applicants copy-paste this exact line into their own resume?* If yes,
the bullet is generic — open the student's `ai_description` blocks,
find a specific only this student has (a course name, a project
outcome, an exact mark, a named teacher), and rebuild the bullet
around it. The whole point of running the pipeline against the full
verbatim per-document detail is to have those specifics on hand.
A bullet that survives the 1000-student test is the floor, not the
ceiling.

## Per-document granular detail

The agent has access to `intake_files.ai_description` (the long-form
markdown the agent itself wrote in step 3b — verbatim transcription,
per-subject marks tables, IELTS sub-bands, certificate detail). When
authoring resume bullets, **prefer per-document detail over typed-
answer aggregates**:

- Education `body` should call out the top 2–3 subjects by raw mark
  ("Mathematics 99, Science 98"), STEM vs Humanities split, or any
  honors / distinctions visible on the marksheet.
- Standardized-tests `body` should list IELTS Listening / Reading /
  Writing / Speaking sub-bands when the file shows them, in addition
  to the overall.
- Awards `body` should cite denominators when the source has them
  ("AIR 412 of 1.2M candidates").

## Sections that are out of scope for v2

Photograph, DOB, parents' names, religion, marital status, "Declaration",
signature blocks. These are Indian-CV defaults and are NEVER included —
they actively hurt foreign admissions reads. The plan call's prompt
strips them; do not re-introduce them in any field.

## Failure modes to avoid

- **Schema version mismatch**: forgetting `schema_version: 2` causes
  the renderer to assume v1 (still works, but new sections won't
  surface if you put them somewhere unexpected).
- **Missing `body`**: renderer skips items with no label AND no body.
  If you have only a label and no factual line, write the body.
- **GPA in body instead of `gpa` field**: still renders, just
  doesn't get the visual chip. Prefer the dedicated `gpa` field for
  education entries.
- **Em-dashes in any string**: the validator (`server/generators/validator.js`)
  doesn't catch these on the routine path because the routine bypasses
  the structured-LLM call. The agent is the only enforcer. Self-check
  every string before dispatch.

## Concrete example

See [`example_payloads/sample_resume_v2.json`](example_payloads/sample_resume_v2.json)
for a complete payload showing all sections in use, including a
`gpa` chip on Class X / XII, IELTS sub-bands, a quantified Olympiad
award, and a published-paper publications row.
