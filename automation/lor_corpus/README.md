# LOR corpus

Source of truth for how the AI pipeline writes Letters of Recommendation.
Sibling of `automation/sop_corpus/` and `automation/resume_corpus/`.
Same contract as the SOP corpus: this folder is **read directly by the
runbook agent** during a dispatch run — it is NOT imported into the
database.

When the agent reaches the "Draft LORs" step in
`automation/instructions_autofill_plus_generate.md`, it MUST first read
every file in this folder. Voice (teacher-in-third-person), structure,
opening pattern, evidence density, and the eight-point spine all come
from these examples + the canonical handwritten guideline.

## Layout

| Path | What it is |
|---|---|
| `lor-guideline.md` | Transcript of the operator's handwritten 8-point structure (introduce self → academic characteristics → classroom participation → class project → research paper → academic activity → leadership → round-off). **Read this first.** |
| `lor-guideline.pdf` | The handwritten original. Kept for human reference. |
| `examples/*.md` | 14 real teacher LORs across subjects (Physics, Maths, Business Studies, Economics, Political Science, Psychology, Geography, Marketing, IP, Interior, ISH hospitality). |
| `examples/*.docx` | Word originals. |
| Re-converting .docx → .md | Run `node automation/scripts/convert-docx-to-md.mjs automation/lor_corpus` after dropping new examples. Idempotent (skips up-to-date .md). |

## How the agent uses this

Quoting the runbook (`Section 3c — LOR drafts`):

> Before drafting any LOR in a dispatch run, read
> `automation/lor_corpus/lor-guideline.md` and every `examples/*.md`.
> The guideline defines the eight beats every letter hits; the
> examples show what each beat looks like in real teacher voice across
> subjects (Physics, Maths, BSt, Eco, PolSc, Psych, Geo, Marketing,
> IP, Interior, hospitality). Cross-subject coverage exists in the
> corpus so the agent can match register to recommender role —
> physics teacher's voice is not the same as a marketing teacher's
> voice. Never copy a sentence; borrow the shape.

The rules already in the runbook (200-300 words, voice inference per
role, narrative arcs A/B/C/D, evidence subset divergence between
siblings) apply *underneath* the corpus structure.

## Adding a new example

1. Drop the .docx into `examples/`.
2. Run `node automation/scripts/convert-docx-to-md.mjs automation/lor_corpus` to refresh the .md.
3. Commit both files.

## Sanitisation

These files carry real student names + real teacher voice. They are
committed to the repo because the corpus IS the product spec — the
agent needs the lived detail to reproduce the voice. Do not redistribute
outside the project. If a student or teacher withdraws consent, delete
both their .docx and .md and re-run the converter.

## Why this isn't on R2 or in the DB

See `automation/ai_grounding_strategy.md` for the full reasoning. Short
version: 14 examples + 1 guideline fit comfortably in an agent's
context window. Few-shot prompting with the full curated corpus is
strictly simpler than vector-RAG at this size, and the agent already
runs locally with repo access. R2 makes sense for high-volume
per-student blobs (Aadhar scans, marksheets); shared reference content
lives in git where it's auditable and ships with the deploy.
