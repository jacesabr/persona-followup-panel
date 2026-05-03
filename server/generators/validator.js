// Citation validator. The single most important hallucination guard
// in the pipeline (per the audit research): bullets that cite fact
// ids not in the claim ledger get DROPPED before they reach the
// rendered resume. Bullets surviving validation are guaranteed
// traceable back to a Plan-call ledger entry.
//
// Returns { passed, rejected, warnings } per section. We don't throw
// — the orchestrator records rejection counts on the resume row so
// the counsellor can spot model drift after the fact.

export function validateSectionBullets({ bullets, factsById }) {
  const passed = [];
  const rejected = [];
  const warnings = [];

  for (const b of bullets || []) {
    const ids = Array.isArray(b.source_ids) ? b.source_ids : [];
    if (ids.length === 0) {
      rejected.push({ bullet: b, reason: "no source_ids" });
      continue;
    }
    const unknown = ids.filter((id) => !factsById[id]);
    if (unknown.length > 0) {
      rejected.push({
        bullet: b,
        reason: `unknown source_ids: ${unknown.join(", ")}`,
      });
      continue;
    }

    // Soft check: do the cited claims plausibly support the bullet text?
    // We do a cheap proper-noun check — if the bullet introduces a
    // capitalized multi-word phrase that doesn't appear in any cited
    // claim, flag (but don't reject — admissions resumes restate names
    // / concepts in different ways).
    const drift = detectProperNounDrift(b.text, ids.map((id) => factsById[id]?.claim || ""));
    if (drift.length > 0) {
      warnings.push({
        bullet: b,
        reason: `possible proper-noun drift: ${drift.slice(0, 3).join(", ")}`,
      });
    }

    passed.push(b);
  }
  return { passed, rejected, warnings };
}

// Cheap proper-noun drift detector. Looks for capitalized 2+ word phrases
// in `text` that don't appear (case-insensitive substring) in any cited
// claim. Yields phrases worth eyeballing — false positives common,
// admin reviewing resume should glance.
function detectProperNounDrift(text, citedClaims) {
  const drift = [];
  const haystack = citedClaims.join(" \n ").toLowerCase();
  // Grab sequences of TitleCase words. Skip line-leading capitals.
  const re = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})/g;
  for (const m of text.matchAll(re)) {
    const phrase = m[1];
    if (phrase.length < 4) continue;
    if (!haystack.includes(phrase.toLowerCase())) {
      drift.push(phrase);
    }
  }
  return drift;
}
