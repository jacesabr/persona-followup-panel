// Style-corpus retrieval. The corpus has a single active row (the
// Raghav internship example), so this just returns it. The previous
// implementation tier-scored on (length_pages, domain) and random-
// sampled across the bucket — both meaningless when N=1.
//
// Returns: { examples: [{ id, full_text, label, ... }], example_ids: [...] }
//
// example_ids gets persisted on the intake_resumes row so we can
// audit which exemplar informed any given resume.

import pool from "../db.js";

export class NoCorpusError extends Error {
  constructor() {
    super(
      "Resume style corpus is empty. An admin must run `npm run import-examples` (or hit POST /api/students/admin/import-examples) before any resume can be generated."
    );
    this.code = "NO_CORPUS";
  }
}

export async function pickExamples() {
  const { rows } = await pool.query(
    `SELECT id, label, full_text, length_pages, domain, style, voice_notes
       FROM intake_examples
      WHERE active = TRUE
      ORDER BY id ASC
      LIMIT 1`
  );
  if (rows.length === 0) throw new NoCorpusError();
  return {
    examples: rows.map((r) => ({
      id: r.id,
      label: r.label,
      full_text: r.full_text,
      length_pages: r.length_pages,
      domain: r.domain,
      style: r.style,
      voice_notes: r.voice_notes,
    })),
    example_ids: rows.map((r) => r.id),
  };
}

// Cheap pre-flight check used by the phase transition: if the corpus
// is empty the auto-fire would just fail. Surface a clear error
// upstream instead of inserting a 'pending' row that's destined to
// flip to 'failed' a few seconds later.
export async function corpusHasExample() {
  const { rows } = await pool.query(
    `SELECT 1 FROM intake_examples WHERE active = TRUE LIMIT 1`
  );
  return rows.length > 0;
}
