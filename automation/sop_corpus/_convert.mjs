// One-shot: convert every .docx under automation/sop_corpus/ into a
// sibling .md so the runbook agent (and humans grepping the repo) can
// read them without docx tooling. Run with `node automation/sop_corpus/_convert.mjs`.
//
// Uses mammoth (already a project dep, see package.json) for fidelity:
// headings, bold, bullets survive into the markdown — better than a
// plain-text dump because the corpus's structure is part of the signal.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.toLowerCase().endsWith(".docx")) out.push(p);
  }
  return out;
}

for (const src of await walk(__dirname)) {
  const dst = src.replace(/\.docx$/i, ".md");
  const { value: md } = await mammoth.convertToMarkdown({ path: src });
  await fs.writeFile(dst, md, "utf8");
  console.log("wrote", path.relative(__dirname, dst));
}
