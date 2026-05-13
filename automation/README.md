# automation/

Everything the dev (and the Claude Code session the dev opens locally
on this repo) needs to run the AI artifact pipeline by hand. This
folder is the source of truth for the workflow — there is no scheduled
cron, no remote routine, no API-side LLM call in the live path.

## Where to start

If you are a Claude Code agent reading this folder cold to run the
pipeline:

1. Open [`instructions_autofill_plus_generate.md`](instructions_autofill_plus_generate.md)
   and follow it top to bottom. It is the runbook.
2. Skim [`ai_grounding_strategy.md`](ai_grounding_strategy.md) once so
   you understand *why* the corpus folders matter and how each
   artefact's quality is built up in layers.

If you are revising artefact quality:

| If you want to change… | Read |
|---|---|
| Resume content / layout | [`resume_schema_v2.md`](resume_schema_v2.md) → [`example_payloads/sample_resume_v2.json`](example_payloads/sample_resume_v2.json) → [`resume_corpus/README.md`](resume_corpus/README.md) |
| SOP voice / structure | [`sop_corpus/construction-guidelines.md`](sop_corpus/construction-guidelines.md) → [`sop_corpus/examples/`](sop_corpus/examples/) → runbook `Section 3c` |
| LOR voice / structure | [`lor_corpus/lor-guideline.md`](lor_corpus/lor-guideline.md) → [`lor_corpus/examples/`](lor_corpus/examples/) → runbook `Section 3c` |
| The AI grounding technique itself | [`ai_grounding_strategy.md`](ai_grounding_strategy.md) |

## File index

| Path | Purpose |
|---|---|
| `instructions_autofill_plus_generate.md` | The runbook. Step-by-step: log in, pull candidates, per-file long-form description, author resume / SOP / LOR / internship drafts, dispatch atomically. |
| `ai_grounding_strategy.md` | Explains the AI technique (in-context many-shot, not vector RAG), the quality-layer stack, and where corpus content lives + why. Read once. |
| `resume_schema_v2.md` | Canonical resume payload reference. What every field means, render order, PDF export, Stealth Mode rules. |
| `example_payloads/sample_resume_v2.json` | Concrete v2 example payload. All sections filled in. |
| `resume_corpus/` | Resume style anchor — loaded into the `intake_examples` table via `npm run import-examples`. See its README. |
| `sop_corpus/` | SOP construction guidelines + 7 past student examples. Read at runtime by the agent. |
| `lor_corpus/` | LOR 8-point structure + 14 past teacher LORs across subjects. Read at runtime by the agent. |
| `scripts/convert-docx-to-md.mjs` | Shared converter that turns .docx files into sibling .md so the runbook agent can read them via the Read tool. Run as `node automation/scripts/convert-docx-to-md.mjs automation/{sop,lor}_corpus`. Idempotent. |

## Mental model: how a resume gets to the student

1. Counsellor signs the student up (with or without starter docs) on
   the create-student form. If they want fill-in service they click
   **"Request manual AI fill"**, which inserts a `manual_ai_requests`
   row and opens a prefilled mailto so the dev sees the request.
2. Dev opens this repo locally in Claude Code, points the session at
   `instructions_autofill_plus_generate.md`, and runs the loop.
3. The agent pulls up to 5 candidates, reads each uploaded file in
   depth (verbatim transcription + structured fields + numeric
   summary + conclusions, written into `intake_files.ai_description`
   and `ai_extracted`), then authors per-student:
   - Autofilled intake answers (no-overwrite merged server-side)
   - A v2 resume JSON payload (per `resume_schema_v2.md`, grounded
     in `resume_corpus/`)
   - A 400–500 word SOP draft (grounded in `sop_corpus/`)
   - LOR drafts (one per `intake_required_docs` row whose
     `staff_draft` is NULL, grounded in `lor_corpus/`)
4. All writes for one student land atomically in one POST to
   `/api/admin/ai/dispatch`, which also stamps the matching
   `manual_ai_requests` row as processed.
5. The student dashboard and the staff student-detail modal render
   each artefact for review.

## A note on file organisation

Every artefact type follows the same pattern:

```
automation/<artefact>_corpus/
├── README.md
├── <artefact>-guideline.{md,docx,pdf}   ← operator-written structural spec
└── examples/
    ├── <student-1>.docx                  ← real past work
    └── <student-1>.md                    ← mammoth-converted, what the agent reads
```

If you add a new artefact type (e.g. scholarship letters, motivation
letters), follow this template. The bottom of
`ai_grounding_strategy.md` has the full checklist.
