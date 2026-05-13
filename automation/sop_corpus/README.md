# SOP corpus

The source of truth for how the AI pipeline writes Statements of
Purpose. Sibling of `automation/resume_corpus/`, with a different
contract: this folder is **read directly by the runbook agent**
during a dispatch run — it is NOT imported into the database.

When the agent reaches the "Author SOP" step in
`automation/instructions_autofill_plus_generate.md`, it MUST first
read every file in this folder. Voice, structure, paragraph balance,
word-count distribution, and signal-to-fluff ratio are all anchored
on these examples. The construction guidelines at the top of this
folder are the canonical structural rules; the examples in `examples/`
are how those rules play out on real students.

## Layout

| Path | What it is |
|---|---|
| `construction-guidelines.md` | The eight-section structure every SOP should follow (intro / academics / extracurriculars / career goals / why this course / why this university / why this country / future plans). **Read this first.** |
| `construction-guidelines.docx` | Original Word doc. Kept for reference; the .md is the canonical version the agent reads. |
| `examples/*.md` | Past student SOPs. Voice / pacing / paragraph balance reference. |
| `examples/*.docx` | Originals. |
| Re-converting .docx → .md | Run `node automation/scripts/convert-docx-to-md.mjs automation/sop_corpus` after dropping new examples. Idempotent (skips up-to-date .md). |

## How the agent uses this

Quoting the runbook (`Section 3c — Author SOP`):

> Before composing any sentence of the SOP, read
> `automation/sop_corpus/construction-guidelines.md` end-to-end, then
> skim every `examples/*.md`. The guidelines define the section
> structure and the equal-word-distribution rule (when the cap is
> tight, drop "Why this country" first). The examples ground voice
> and density — open with a concrete personal scene the way Karan's
> UCAS SOP does, anchor each paragraph in specific artefacts the way
> Lavanya's UTS SOP does, and close with a forward-looking line the
> way Lovish's Middlesex SOP does.

The agent never copies sentences. It borrows shape.

## Adding a new example

1. Drop the .docx into `examples/`.
2. Run `node automation/scripts/convert-docx-to-md.mjs automation/sop_corpus` to refresh the .md.
3. Commit both files (the .docx is the auditable source; the .md is
   what the agent reads).

## Sanitisation

These files contain real student names and personal context. They are
committed to the repo because the corpus IS the product spec — the
agent needs the lived detail to reproduce the voice. Do not redistribute
outside the project. If a student withdraws consent, delete both their
.docx and .md and re-run the converter.

## Why we don't import this into the DB

The resume corpus pushes into `intake_examples` because the resume
generator's section-by-section prompt loop pulls a few-shot anchor on
every call. SOP drafting happens once per student per dispatch and is
authored by the Claude Code agent in-context — so reading these files
at run time is cheaper and easier to audit than maintaining an
ingestion pipeline.

The same pattern will be used for LORs (`automation/lor_corpus/`)
when those examples land.
