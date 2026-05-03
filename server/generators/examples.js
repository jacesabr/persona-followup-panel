// Style-corpus retrieval — pick 3-5 example resumes from intake_examples
// to few-shot the section calls. Per the audit research:
//   - Filter by metadata first (target length pages + domain).
//   - Random-sample within bucket so the model sees varied phrasing
//     across calls instead of memorising the same 3 every time.
//   - The exemplar block is large + reused — wrap with prompt caching
//     when we add Anthropic.
//
// Returns: { examples: [{ id, full_text, label }], example_ids: [...] }
//
// example_ids gets persisted on the intake_resumes row so we can audit
// exactly which exemplars informed any given resume.

import pool from "../db.js";

const TARGET_COUNT = 3;
const MAX_COUNT = 5;

export async function pickExamples({ length_pages, domain, limit = TARGET_COUNT }) {
  const cap = Math.min(MAX_COUNT, Math.max(1, limit));

  // Score: exact match on (length_pages, domain) > exact length only >
  // exact domain only > anything active. ORDER BY a synthetic priority,
  // then random within tier.
  const sql = `
    SELECT id, label, full_text, length_pages, domain, style, voice_notes,
      CASE
        WHEN length_pages = $1 AND ($2::text IS NULL OR domain = $2) THEN 3
        WHEN length_pages = $1                                       THEN 2
        WHEN $2::text IS NOT NULL AND domain = $2                    THEN 2
        ELSE 1
      END AS tier
    FROM intake_examples
    WHERE active = TRUE
    ORDER BY tier DESC, random()
    LIMIT $3
  `;
  const { rows } = await pool.query(sql, [length_pages || null, domain || null, cap]);
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
