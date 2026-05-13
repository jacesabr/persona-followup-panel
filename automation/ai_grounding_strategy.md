# AI grounding strategy — Resume, SOP, LOR

This document explains *how* the AI pipeline uses the three corpora
(`resume_corpus/`, `sop_corpus/`, `lor_corpus/`) to produce student
artefacts, *what technique* is at work, *why* this technique is the
right call at our scale, and *where* the corpus content lives. New
contributors should read this before changing the runbook or
re-architecting the pipeline.

---

## 1. The big picture

For each student in a dispatch run, the pipeline produces four kinds
of artefacts:

| Artefact | Corpus | Output target | Word budget |
|---|---|---|---|
| **Per-file AI description + extraction** | none — derived from the file itself | `intake_files.ai_description` + `ai_extracted` | 150–350 words |
| **Resume** | `automation/resume_corpus/` | `intake_resumes.content_json` (rendered by `<ResumeTemplate>`) | structured JSON, no word cap |
| **SOP** | `automation/sop_corpus/` | `intake_students.data.answers.sop_draft` | 400–500 words (sometimes lower per program cap) |
| **LOR drafts** | `automation/lor_corpus/` | `intake_required_docs.staff_draft` per kind='lor' row | 500–700 words each |

The agent that produces all four is a Claude Code session reading the
runbook (`automation/instructions_autofill_plus_generate.md`) end-to-
end. It runs locally on the dev's machine — terminal, desktop app, or
VS Code surface — triggered by a row appearing in `manual_ai_requests`.

---

## 2. The technique — *in-context few-shot prompting with the full
curated corpus*

We are **not** using vector RAG. We use **in-context grounding**: the
runbook agent reads every file in the relevant corpus *into its own
context window* before authoring the artefact. The agent's context
window is large enough (1M tokens on Opus 4.7) that 14 LOR examples
(~50 lines each = ~10k tokens total) plus the operator-written
construction guideline (~70 lines = ~2k tokens) plus the student's
intake JSON + per-doc extractions (~30k tokens) fit comfortably with
room to spare.

The technique is sometimes called *many-shot prompting* — the term
"few-shot" implies 1–5 examples, while "many-shot" covers regimes
where dozens of examples are fed in. Empirically (Anthropic, DeepMind,
2024 research on many-shot ICL) many-shot consistently outperforms
few-shot when the examples are high-quality and representative of the
target distribution. Our corpus is small enough to fit entirely *and*
representative because the operator curated it from their own past
work, so we get the best of both: every example earns its slot.

### How it differs from vector RAG

Vector RAG (Retrieval-Augmented Generation) is the right tool when:
- The corpus is too large to fit in context (≥ ~100 examples, ≥ ~50k
  tokens of content)
- Per-query relevance varies enough that fetching a relevant subset
  beats injecting the whole corpus
- The corpus updates frequently and re-indexing is cheaper than full
  context rebuild

For our cohort:
- Resume corpus: 1 active example
- SOP corpus: 1 guideline + 7 examples
- LOR corpus: 1 guideline + 14 examples
- Total corpus content across all three: ~25k tokens

Vector RAG would add a vector store, an embedding model, a chunking
strategy, an indexing job, a retriever, and a relevance score — to
fetch what we can already inject directly. That infrastructure earns
its keep at ~100+ examples per corpus. We are not there.

### What we DO use that resembles retrieval

Per-student grounding *is* retrieval — the runbook tells the agent
to read every active `intake_files` row for the one student in scope,
plus their `intake_students.data.answers` JSON. That's a per-student
filter against a per-student data partition. Not vector retrieval
(no embeddings), but it's the same conceptual move: "fetch only what
applies to this query." We can keep adding to a student's file pool
without growing the agent's context across other students.

---

## 3. The three layers that determine quality

Every artefact is shaped by three stacked layers. Each layer is a
distinct quality lever; weakening any one of them is what makes an
LLM-written artefact obvious.

### Layer 1 — System rules (Stealth Mode)

The runbook's "Stealth Mode" rules (no em-dashes, no banned words /
phrases / openers, no filler, plain language) sit at the top of the
prompt. They constrain *style at the token level* — they say what
shape sentences may NOT take. Without them, even a good corpus
produces "delve / leverage / robust / paradigm" prose that AI
detectors flag instantly.

**Quality lever:** these rules make the output sound *less* like LLM
output. They are negative constraints — easy to forget, devastating
when missed. Every artefact passes through them.

### Layer 2 — Construction guidelines (operator's spec)

Each corpus has a hand-written guideline:
- `resume_corpus/` — the resume schema spec (`resume_schema_v2.md`)
  declares the JSON sections and Stealth Mode rules for body strings.
- `sop_corpus/construction-guidelines.md` — the 8-section SOP
  structure, equal-word distribution rule, "drop why-this-country
  first when the cap is tight" carve-out.
- `lor_corpus/lor-guideline.md` — the 8-point teacher LOR structure
  (introduce self → academic characteristics → classroom participation
  → class project → research → academic activity → leadership →
  round-off).

**Quality lever:** these spec the *positive structure* the artefact
must hit. Without them, the agent imposes its own structure — usually
a generic five-paragraph essay or a chronological CV — which doesn't
match what admissions / counsellors expect for this cohort.

### Layer 3 — Examples (real past work)

The `examples/` subfolder of each corpus carries real student
artefacts. These do work the structure spec cannot: they show *what
each beat looks like as sentences*, *how much detail to put in a
classroom-participation paragraph vs. a project paragraph*, *what
voice a physics teacher uses vs. a marketing teacher*, *how to handle
research papers that exist vs. don't*.

**Quality lever:** examples calibrate density and voice. Two LORs
written from the same skeleton can sound radically different
depending on whether the agent has seen a physics-teacher example or
not. Cross-subject coverage in the LOR corpus exists for exactly this
reason — the agent matches register to recommender role by recognising
voice patterns across examples.

### Layer 4 — Per-student evidence

The student's own intake + uploaded-document extractions are the raw
material every artefact must be anchored in. The agent reads:
- `intake_students.data.answers` — the form responses
- Every `intake_files` row's `ai_description` — the agent reads its
  *own* prior-step extractions to surface marksheet subjects, IELTS
  sub-bands, signatory names on certificates, etc.
- `intake_required_docs` for LOR/internship rows the student filled

**Quality lever:** specificity. Every paragraph names a real artefact
("Mathematics 96/100", "ICPC Asia regional qualifier", "Mr. Munish
Jindal, MENTORx Foundation"). Without this, the artefact reads like
a horoscope — could apply to any student.

---

## 4. The cross-artefact divergence rule (LOR-specific)

Admissions read 2–4 LORs for the same student side-by-side. Even
with perfect single-letter quality, if two letters share opening
patterns, paragraph order, or rhythm, the application reads as
machine-generated. The runbook enforces deliberate divergence on
four axes:

1. **Voice** — physics-teacher vs. marketing-teacher vs. principal
2. **Evidence selection** — different subset of the same evidence pool
3. **Narrative arc** — A (academic-led) / B (project-led) /
   C (research-led) / D (leadership-led)
4. **Structure** — opening style, paragraph count, sentence rhythm

The corpus's cross-subject coverage is what makes this enforceable.
A 14-example LOR corpus that's all physics-teacher voice would not
teach the agent how to write a marketing-teacher LOR. We collect
across subjects on purpose.

---

## 5. Where the corpus content lives — *git, not R2*

The corpora are committed to the git repo. They are NOT mirrored to
Cloudflare R2 (our S3-compatible blob store). This is deliberate.

### Why git is the right store

| Property | Git | R2 |
|---|---|---|
| Auditable change history | Yes — every edit is a commit | No — last-write-wins |
| Reviewable via PR | Yes | No |
| Available to the agent at runtime | Yes — the agent clones the repo | Would require auth + fetch |
| Deploys with code | Yes — Render redeploys ship the corpus | Would need parallel sync |
| Survives R2 outage | Yes | No |
| Survives git/GitHub outage | No (R2 mirror would help here) | Yes |

R2 is the right store for **per-student blobs** — Aadhar scans,
marksheets, IELTS results, financial documents. There can be hundreds
of these per student and millions across all students. Storing them
in git would bloat the repo and lose the auth-gated download path
we already built.

The corpora are the opposite: ~25k tokens of shared reference content
that all students inherit from, that the operator hand-curates, and
that we want auditable diffs on. Git is the better fit.

### What about durability?

Two layers of redundancy already exist:
1. GitHub is the upstream remote — every commit on `main` lives there
2. Render auto-deploys from `main` and the build artefact bakes the
   corpus into the deployed instance

If we want a third layer, the cleanest path is a daily one-shot job
that uploads `automation/{resume,sop,lor}_corpus/` to R2 under a
`corpus/` prefix as a backup mirror. The cron infra already exists
(`persona-followup-daily-backup` cron on Render runs
`server/scripts/backup-to-r2.js`). We can extend that script if a
mirror feels worth the operational complexity — but it isn't load-
bearing. The agent reads from disk; the mirror would only matter if
git went down at the moment of an agent run.

### What about the database?

The database isn't a fit for shared reference content. The resume
corpus is loaded into `intake_examples` only because the resume
generator uses Gemini per-section calls with a `<STYLE_EXAMPLES>`
prompt block — that path needs the example as a queryable row at
runtime. SOP and LOR drafting happen inside the Claude Code agent
which reads files directly, so the DB hop adds no value.

---

## 6. Self-critique pass

The single quality lever we have NOT yet implemented but should: a
self-critique step. Before saving a draft, the agent should re-read
its own output against:
- the corpus guideline
- the Stealth Mode rules
- the divergence rule (for LORs)

…and revise once. Models perform measurably better with an explicit
critique pass for long-form generation. The runbook should formalise
this as a required step in `Section 3c`. Left as a future improvement.

---

## 7. Adding new artefact types

If a new artefact type comes up (e.g. essay supplements, scholarship
letters, motivation letters), follow this template:

1. Create `automation/<artefact>_corpus/`.
2. Put the operator's hand-written structure spec at the root
   (`<artefact>-guideline.md`).
3. Put real examples under `examples/`.
4. Add a `README.md` mirroring the existing ones.
5. Add a `_convert.mjs` (or use the shared one at
   `automation/scripts/convert-docx-to-md.mjs`) for .docx → .md.
6. Add a runbook section under `Section 3c` that opens with a
   BEFORE-WRITING gate naming the corpus files in read order.
7. Add a reference memory pointer so future Claude Code sessions
   know the corpus exists.

That's the whole pattern.

---

## TL;DR

- **Technique:** in-context many-shot prompting with the full curated
  corpus + per-student evidence. Not vector RAG (corpus is too small
  to justify the infra).
- **Quality stack:** Stealth Mode rules → operator-written structure
  spec → real-student examples → per-student evidence anchors.
- **Storage:** git is canonical. R2 is for per-student blobs only.
  Optional daily mirror to R2 is available via the existing backup
  cron if extra durability is wanted.
- **LOR divergence:** four-axis deliberate variation (voice / evidence
  subset / arc / structure) prevents the side-by-side-detection
  failure mode.
- **Next quality lever:** add an explicit self-critique pass to the
  runbook's drafting steps.
