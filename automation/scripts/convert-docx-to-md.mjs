// Shared .docx → .md converter for SOP / LOR corpus folders.
//
//   node automation/scripts/convert-docx-to-md.mjs automation/sop_corpus
//   node automation/scripts/convert-docx-to-md.mjs automation/lor_corpus
//
// Resume corpus is intentionally EXCLUDED — it has its own DB
// importer (server/scripts/import-examples.js) which ingests .docx
// directly. Generating sibling .md there would create duplicate
// rows in intake_examples.
//
// Idempotent: walks the target tree, finds every .docx, writes a
// sibling .md via mammoth (already a project dep). Skips files where
// the sibling .md is newer than the source so re-runs are cheap.
//
// mammoth.convertToMarkdown preserves headings, bold, bullets — the
// corpus structure is part of the signal, so the raw extracted text
// would lose more than it saves.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetArg = process.argv[2];
if (!targetArg) {
  console.error(
    "usage: node automation/scripts/convert-docx-to-md.mjs <corpus-dir>\n" +
      "  e.g. automation/sop_corpus  or  automation/lor_corpus\n" +
      "  (resume_corpus has its own importer — do NOT point this script at it)"
  );
  process.exit(2);
}
const root = path.resolve(process.cwd(), targetArg);

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.toLowerCase().endsWith(".docx")) out.push(p);
  }
  return out;
}

async function isUpToDate(src, dst) {
  try {
    const [srcStat, dstStat] = await Promise.all([fs.stat(src), fs.stat(dst)]);
    return dstStat.mtimeMs >= srcStat.mtimeMs;
  } catch {
    return false;
  }
}

let wrote = 0, skipped = 0;
for (const src of await walk(root)) {
  const dst = src.replace(/\.docx$/i, ".md");
  if (await isUpToDate(src, dst)) {
    skipped++;
    continue;
  }
  const { value: md } = await mammoth.convertToMarkdown({ path: src });
  await fs.writeFile(dst, md, "utf8");
  wrote++;
  console.log("wrote", path.relative(root, dst));
}
console.log(`done — ${wrote} written, ${skipped} up-to-date`);
