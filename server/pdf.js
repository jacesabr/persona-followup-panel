// Resume HTML generator — produces a standalone, self-contained HTML
// document suitable for browser print → Save as PDF.
//
// Design:
//   - EB Garamond (Google Fonts) for body text
//   - Inter (Google Fonts) for headings, labels, meta
//   - Single-column, A4-proportioned layout
//   - Section headings: small-caps uppercase with a ruled underline
//   - Bullet items: bold label, body text, meta in smaller sans
//   - GPA pills: outlined chip on the label line
//
// On page load, document.fonts.ready fires window.print() so the user
// gets the Save as PDF dialog immediately without clicking Print.
//
// Font loading is async; window.print() is deferred until the fonts
// promise resolves so Google Fonts appear in the saved PDF rather than
// falling back to system serif.

// normalizeResumeJson: safe defaults for every field; keeps the HTML
// template free of undefined/null checks.
function normalize(raw) {
  const j = raw || {};
  const arr = (v) => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        label: x.label || "",
        body: x.body || "",
        meta: x.meta || "",
        gpa: x.gpa || "",
      }))
      .filter((x) => x.label || x.body);
  };
  const strs = (v) =>
    Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()) : [];
  return {
    name: j.name || "",
    headline: j.headline || "",
    contact: j.contact && typeof j.contact === "object" ? j.contact : {},
    lede: j.lede || "",
    education: arr(j.education),
    standardized_tests: arr(j.standardized_tests),
    awards: arr(j.awards),
    activities: arr(j.activities),
    internships: arr(j.internships),
    volunteer: arr(j.volunteer),
    publications: arr(j.publications),
    skills: strs(j.skills),
    languages: strs(j.languages),
    closing_note: j.closing_note || "",
  };
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderItems(items) {
  if (!items || items.length === 0) return "";
  return items
    .map((it) => {
      const gpa = it.gpa
        ? `<span class="gpa-pill">${esc(it.gpa)}</span>`
        : "";
      const labelLine = it.label
        ? `<div class="item-header"><span class="item-label">${esc(it.label)}</span>${gpa}</div>`
        : "";
      const sep = it.label && it.body ? " " : "";
      const bodyLine = it.body
        ? `<div class="item-body">${esc(it.label ? sep : "") + esc(it.body)}</div>`
        : "";
      const metaLine = it.meta
        ? `<div class="item-meta">${esc(it.meta)}</div>`
        : "";
      return `<div class="item">${labelLine}${bodyLine}${metaLine}</div>`;
    })
    .join("\n");
}

function renderSection(title, items) {
  if (!items || items.length === 0) return "";
  return `
  <section class="section">
    <h2 class="section-title">${esc(title)}</h2>
    ${renderItems(items)}
  </section>`;
}

function renderStrip(title, values) {
  if (!values || values.length === 0) return "";
  return `
  <section class="section strip-section">
    <h2 class="section-title">${esc(title)}</h2>
    <p class="strip-values">${values.map(esc).join(" &middot; ")}</p>
  </section>`;
}

export function generateResumeHtml(payload, studentName) {
  const d = normalize(payload);
  const name = d.name || studentName || "Resume";
  const title = esc(name) + " — Resume";

  const contactLine =
    d.contact.show && (d.contact.phone || d.contact.email)
      ? `<p class="contact-line">${[d.contact.phone, d.contact.email]
          .filter(Boolean)
          .map(esc)
          .join(" &middot; ")}</p>`
      : "";

  const ledeBlock = d.lede
    ? `<p class="lede">${esc(d.lede)}</p>`
    : "";

  const sections = [
    renderSection("Education", d.education),
    renderSection("Standardized Tests", d.standardized_tests),
    renderSection("Awards &amp; Recognitions", d.awards),
    renderSection("Publications", d.publications),
    renderSection("Internships", d.internships),
    renderSection("Volunteer Work", d.volunteer),
    renderSection("Co-curricular Profile", d.activities),
    renderStrip("Skills", d.skills),
    renderStrip("Languages", d.languages),
  ]
    .filter(Boolean)
    .join("\n");

  const closingBlock = d.closing_note
    ? `<p class="closing">${esc(d.closing_note)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --serif: 'EB Garamond', Georgia, 'Times New Roman', serif;
  --sans:  'Inter', system-ui, Arial, sans-serif;
  --ink:   #141414;
  --mid:   #3a3a3a;
  --muted: #5c5c5c;
  --rule:  #888;
  --light: #e2e2e2;
}

body {
  font-family: var(--serif);
  font-size: 12pt;
  line-height: 1.55;
  color: var(--ink);
  background: #f0ede8;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ── Page card ── */
.page {
  background: #fff;
  max-width: 780px;
  margin: 36px auto;
  padding: 60px 68px;
  box-shadow: 0 6px 32px rgba(0,0,0,0.10), 0 1px 4px rgba(0,0,0,0.06);
}

/* ── Header ── */
.header {
  border-bottom: 2px solid var(--ink);
  padding-bottom: 18px;
  margin-bottom: 26px;
}
.name {
  font-family: var(--sans);
  font-size: 22pt;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  line-height: 1.1;
  color: var(--ink);
}
.headline {
  margin-top: 7px;
  font-family: var(--serif);
  font-size: 11.5pt;
  color: var(--mid);
  line-height: 1.4;
}
.contact-line {
  margin-top: 5px;
  font-family: var(--sans);
  font-size: 9pt;
  color: var(--muted);
  letter-spacing: 0.02em;
}

/* ── Lede ── */
.lede {
  font-size: 11.5pt;
  line-height: 1.65;
  color: var(--ink);
  margin-bottom: 26px;
}

/* ── Sections ── */
.section {
  margin-bottom: 22px;
}
.strip-section { margin-bottom: 18px; }

.section-title {
  font-family: var(--sans);
  font-size: 7.5pt;
  font-weight: 600;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--ink);
  padding-bottom: 4px;
  border-bottom: 1.5px solid var(--rule);
  margin-bottom: 13px;
}

/* ── Items ── */
.item { margin-bottom: 13px; }
.item:last-child { margin-bottom: 0; }

.item-header {
  display: flex;
  align-items: baseline;
  gap: 9px;
  flex-wrap: wrap;
}
.item-label {
  font-family: var(--serif);
  font-size: 12pt;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.4;
}
.gpa-pill {
  display: inline-block;
  font-family: var(--sans);
  font-size: 8pt;
  font-weight: 600;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  border: 1.2px solid var(--mid);
  padding: 1px 6px;
  color: var(--mid);
  vertical-align: middle;
  white-space: nowrap;
}
.item-body {
  font-family: var(--serif);
  font-size: 11.5pt;
  line-height: 1.55;
  color: var(--ink);
  margin-top: 3px;
}
.item-meta {
  font-family: var(--sans);
  font-size: 9.5pt;
  color: var(--muted);
  margin-top: 3px;
  line-height: 1.3;
}

/* ── Inline strips ── */
.strip-values {
  font-family: var(--serif);
  font-size: 11.5pt;
  color: var(--ink);
}

/* ── Closing note ── */
.closing {
  border-top: 1px solid var(--light);
  padding-top: 18px;
  margin-top: 6px;
  font-size: 11.5pt;
  line-height: 1.65;
  color: var(--mid);
}

/* ── Print ── */
@media print {
  body { background: none; }
  .page {
    max-width: 100%;
    margin: 0;
    padding: 16mm 20mm;
    box-shadow: none;
  }
}

@page {
  size: A4;
  margin: 0;
}
</style>
<script>
// Defer print until fonts load so Google Fonts appear in the saved PDF.
document.fonts.ready.then(function() { window.print(); });
</script>
</head>
<body>
<div class="page">
  <header class="header">
    <div class="name">${esc(name)}</div>
    ${d.headline ? `<p class="headline">${esc(d.headline)}</p>` : ""}
    ${contactLine}
  </header>

  ${ledeBlock}

  ${sections}

  ${closingBlock}
</div>
</body>
</html>`;
}
