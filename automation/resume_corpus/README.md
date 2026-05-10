# Resume corpus

This folder is the source of truth for the resume style anchor that
feeds the generator's few-shot prompt. It also holds visual reference
PDFs that are NOT imported, but exist so the dev can eyeball the
target voice / density / layout when revising the live anchor.

## What's actually wired into generation

The importer (`server/scripts/import-examples.js`) only ingests files
with extensions `.md`, `.markdown`, `.txt`, or `.docx`. PDFs are
ignored intentionally — the .docx path runs through `mammoth.convertToMarkdown`
so headings, bold, and bullets survive into the prompt; PDFs would
need an extra parser that isn't wired and would yield messier text.

Currently live in `intake_examples`:

| File | Sidecar | Used as |
|---|---|---|
| `example_resume/raghav internship legal copy.docx` | `.meta.yaml` | Single style anchor for every section call |

## Visual references (not auto-imported)

These PDFs sit in `example_resume/` for the dev to open + study when
adjusting voice or section ratios. They are NOT picked up by the
importer.

- `Anhad resume .pdf`
- `Kyra resume .pdf`
- `Taanish resume  finl.pdf`

If you want one of these to start informing generation, convert it
to `.docx` (or extract to `.md`) and add a sidecar — see "Replacing
the anchor" below.

## Replacing the anchor

1. Drop a new `.md`, `.txt`, or `.docx` into `example_resume/`.
2. Add a sidecar `<basename>.meta.yaml`:
   ```yaml
   label:        "Short label shown in admin"
   length_pages: 1
   length_words: 300
   voice_notes: |
     One or two sentences of guidance for the LLM.
   ```
3. Delete the previous file + its sidecar.
4. Run `npm run import-examples` (or hit the admin import button).
   The script upserts the new row and deactivates any row whose
   `source_pdf_path` no longer exists on disk, so the generator only
   sees what's currently in this folder.

## What lives in `intake_examples` (the table) vs here

- **This folder** = source of truth, version-controlled. Edit here,
  re-run the import script.
- **`intake_examples` table** = what the running generator reads.
  Mirrors this folder; never edit directly.

## Sanitization checklist (before importing real-student examples)

- [ ] Recommender names redacted
- [ ] University rank / acceptance details generalised
- [ ] Personal addresses / phone numbers removed
- [ ] If real student, get explicit consent OR replace identifying
      details with synthetic equivalents

## How the anchor flows into the resume

The generator's per-section call (`server/generators/section.js`) pulls
the active example via `pickExamples()`, hands its `full_text` to the
LLM under a `<STYLE_EXAMPLES>` block, and instructs the model to borrow
voice but never content. Stealth Mode rules in `section.js` and in
`automation/instructions_autofill_plus_generate.md` apply on top.

The rendered resume the student / counsellor sees is NOT the
markdown / docx itself — it's a structured `ResumeJson` payload (see
`automation/resume_schema_v2.md`) the agent authors, which the React
`<ResumeTemplate>` renders as a print-ready single-column document.
