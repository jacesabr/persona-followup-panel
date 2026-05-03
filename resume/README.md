# Resume corpus + generation assets

This folder holds the **style corpus** that feeds the resume generator's
RAG layer, plus any future templates / Typst styles when we render to
PDF. Anything sensitive (real student names, recommender names, etc.)
should be sanitized before going live.

## `example_resume/`

Drop human-written example resumes here. Markdown, PDF, or DOCX.
Recommended naming: `<domain>_<length>_<note>.<ext>`, e.g.
`cs_1page_riya.md`, `liberal_arts_2page_anon.pdf`.

For each example, optionally drop a sidecar `.meta.yaml` with the same
basename so the import script (coming in the resume-gen push) can map
each file to a row in `intake_examples`. Template:

```yaml
label:        "CS undergrad — 1 page"
length_pages: 1
length_words: 250
domain:       cs            # cs | engineering | business | liberal_arts | medicine | law | mixed
style:        formal_compact  # formal_compact | narrative | bullet_heavy | minimalist | creative
voice_notes: |
  Past-tense verbs, numbers everywhere, no soft skills, no objective.
notes: |
  Anything else worth knowing.
```

The import script will read each file + sidecar and INSERT a row into
`intake_examples` (full_text + metadata). The retrieval layer then
filters by `(domain, length_pages)` at generation time and few-shots
the LLM with 3-5 randomly-sampled examples per section call.

## What lives in `intake_examples` (the table) vs here (this folder)

- **This folder** = source of truth for the corpus, version-controlled
  in git. Edit here, re-run the import script to push to DB.
- **`intake_examples` table** = what the running generator reads.
  Mirrors this folder; never edit directly.

## Sanitization checklist (before importing real-student examples)

- [ ] Recommender names redacted
- [ ] University rank / acceptance details generalised
- [ ] Personal addresses / phone numbers removed
- [ ] If real student, get explicit consent OR replace identifying
      details with synthetic equivalents
