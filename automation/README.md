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

If you are revising the resume output quality:

1. [`resume_schema_v2.md`](resume_schema_v2.md) — payload shape, render
   order, visual language, PDF export path, Stealth Mode rules.
2. [`example_payloads/sample_resume_v2.json`](example_payloads/sample_resume_v2.json)
   — a complete v2 payload showing every section in use.
3. [`resume_corpus/README.md`](resume_corpus/README.md) — the style
   anchor that feeds the section generator's few-shot.

## File index

| File | Purpose |
|---|---|
| `instructions_autofill_plus_generate.md` | The runbook. Step-by-step: log in, pull candidates, per-file long-form description, author resume / SOP / LOR / internship drafts, dispatch atomically. |
| `resume_schema_v2.md` | Canonical resume payload reference. What every field means, the render order, what the student sees, PDF export, Stealth Mode rules. |
| `example_payloads/sample_resume_v2.json` | Concrete v2 example payload. All sections filled in, GPA chips, IELTS sub-bands, quantified award. |
| `resume_corpus/README.md` | How the live style anchor in `intake_examples` is sourced + what the visual reference PDFs are for. |
| `resume_corpus/example_resume/` | Live style anchor (.docx + .meta.yaml) plus visual reference PDFs (not auto-imported). |
| `integration_plan.md` | **Historical / superseded.** Describes the dormant API-side generator path. Kept for reference only — the live path is the runbook above. |

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
   - A v2 resume JSON payload (per `resume_schema_v2.md`)
   - A 400–600 word SOP draft
   - LOR and internship drafts (one per `intake_required_docs` row
     whose `staff_draft` is NULL)
4. All writes for one student land atomically in one POST to
   `/api/admin/ai/dispatch`, which also stamps the matching
   `manual_ai_requests` row as processed.
5. The student dashboard renders the v2 payload via
   `<ResumeTemplate>` as a single-column print-ready document. The
   dashboard's "Download PDF" button calls `window.print()` and the
   `.resume-print` CSS scope hides everything else, so the browser's
   Save-as-PDF yields a clean one-page document with the same look
   as the screen render.
