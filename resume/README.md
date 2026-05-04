# Resume corpus

This folder holds the single style example that feeds the resume
generator's few-shot. Replacing the file changes the look of every
resume the system produces.

## `example_resume/`

Exactly one file lives here — `raghav internship legal copy.docx` —
plus its `.meta.yaml` sidecar. The import script reads the `.docx`
through `mammoth.convertToMarkdown` so headings, bold, and bullet
structure survive into the prompt.

To replace the example:

1. Drop a new `.md`, `.txt`, or `.docx` into this folder.
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
   `source_pdf_path` no longer exists on disk, so the few-shot only
   ever sees what's in this folder.

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
