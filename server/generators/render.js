// Render a structured resume (sections + validated bullets) as
// Markdown. Plain Markdown is the v1 output; PDF rendering via Typst
// arrives once we have the example resumes loaded and tuned styles.
// Keeping this pure (no I/O) so the generator orchestrator can compute
// it synchronously after the section calls return.

export function renderMarkdown({ studentName, sections, thesis, generatedAt }) {
  const lines = [];

  if (studentName) {
    lines.push(`# ${studentName}\n`);
  }

  for (const s of sections) {
    if (!s || !Array.isArray(s.bullets) || s.bullets.length === 0) continue;
    lines.push(`## ${s.heading || s.section}`);
    lines.push("");
    for (const b of s.bullets) {
      if (b.subheading || b.meta) {
        const head = b.subheading ? `**${b.subheading}**` : "";
        const meta = b.meta ? ` *(${b.meta})*` : "";
        if (head || meta) lines.push(`${head}${meta}`.trim());
      }
      lines.push(`- ${b.text}`);
    }
    lines.push("");
  }

  if (thesis || generatedAt) {
    lines.push("---");
    lines.push("");
    if (thesis) lines.push(`*Narrative thesis:* ${thesis}`);
    if (generatedAt) lines.push(`*Generated: ${generatedAt}*`);
  }

  return lines.join("\n");
}

// Build the per-bullet provenance manifest we surface to staff in the
// admin viewer. Each bullet's source_ids point back to claim ledger
// entries; we resolve them so the counsellor can see what every
// sentence was derived from.
export function renderProvenance({ sections, factsById }) {
  const manifest = [];
  for (const s of sections) {
    for (const b of s.bullets || []) {
      manifest.push({
        section: s.section,
        text: b.text,
        sources: (b.source_ids || []).map((id) => ({
          id,
          claim: factsById[id]?.claim || `(unknown id: ${id})`,
          source_id: factsById[id]?.source_id || null,
        })),
      });
    }
  }
  return manifest;
}
