// Import the resume style corpus from disk into intake_examples.
//
// Reads every file in resume/example_resume/ that's a .md, .txt, or
// .docx (PDFs would need a parser too — defer until needed; convert
// to markdown manually for now). For each file, looks for a sidecar
// <basename>.meta.yaml; if absent, infers reasonable defaults.
//
// Idempotent: re-running with edits updates rows by `label`. Files
// removed from disk leave their DB rows in place (we never DELETE
// from the corpus automatically — that's an explicit `npm run wipe`
// or manual SQL action).
//
// Run:  npm run import-examples
//
// Requires DATABASE_URL (same as the server).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import mammoth from "mammoth";
import pool from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, "..", "..", "resume", "example_resume");

const SUPPORTED_EXTS = new Set([".md", ".markdown", ".txt", ".docx"]);

async function readExampleText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value.trim();
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function readSidecar(filePath) {
  const sidecar = filePath.replace(/\.[^.]+$/, ".meta.yaml");
  if (!fs.existsSync(sidecar)) return null;
  try {
    return yaml.load(fs.readFileSync(sidecar, "utf8"));
  } catch (e) {
    console.warn(`[import] ${path.basename(sidecar)}: yaml parse failed —`, e.message);
    return null;
  }
}

function inferDefaults(filePath, fullText) {
  const base = path.basename(filePath).replace(/\.[^.]+$/, "");
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  // Rough heuristic: ~250 words per page.
  const pages = Math.max(1, Math.round(wordCount / 250));
  return {
    label: base.replace(/[_-]/g, " "),
    length_pages: pages,
    length_words: wordCount,
    domain: null,
    style: null,
    voice_notes: null,
    notes: `Auto-imported from ${path.basename(filePath)}; no metadata sidecar present.`,
  };
}

async function upsertExample(meta, fullText, sourcePath) {
  const params = [
    meta.label,
    meta.length_pages || null,
    meta.length_words || null,
    meta.domain || null,
    meta.style || null,
    meta.voice_notes || null,
    fullText,
    sourcePath,
    meta.notes || null,
    true,
  ];
  // Match by label; insert if new, update if existing.
  const existing = await pool.query(
    "SELECT id FROM intake_examples WHERE label = $1",
    [meta.label]
  );
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await pool.query(
      `UPDATE intake_examples
          SET length_pages = $2, length_words = $3, domain = $4, style = $5,
              voice_notes = $6, full_text = $7, source_pdf_path = $8,
              notes = $9, active = $10, updated_at = NOW()
        WHERE id = $1`,
      [id, ...params.slice(1)]
    );
    return { id, action: "updated" };
  } else {
    const { rows } = await pool.query(
      `INSERT INTO intake_examples
         (label, length_pages, length_words, domain, style, voice_notes,
          full_text, source_pdf_path, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      params
    );
    return { id: rows[0].id, action: "inserted" };
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[import] DATABASE_URL not set.");
    process.exit(1);
  }
  if (!fs.existsSync(CORPUS_DIR)) {
    console.error(`[import] corpus dir missing: ${CORPUS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => !f.startsWith("."))
    .filter((f) => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    // Skip sidecar yamls themselves
    .filter((f) => !/\.meta\.ya?ml$/i.test(f));

  if (files.length === 0) {
    console.log("[import] no examples found in", CORPUS_DIR);
    process.exit(0);
  }

  console.log(`[import] found ${files.length} example file(s)`);

  let inserted = 0, updated = 0, skipped = 0;
  for (const fileName of files) {
    const filePath = path.join(CORPUS_DIR, fileName);
    try {
      const fullText = await readExampleText(filePath);
      if (!fullText || fullText.length < 100) {
        console.warn(`  SKIP ${fileName} — extracted text too short (${fullText.length} chars)`);
        skipped++;
        continue;
      }
      const sidecar = readSidecar(filePath);
      const defaults = inferDefaults(filePath, fullText);
      const meta = { ...defaults, ...(sidecar || {}) };
      const { action } = await upsertExample(meta, fullText, filePath);
      console.log(`  ${action === "inserted" ? "NEW " : "EDIT"} ${fileName}  →  ${meta.label} (${meta.length_pages}p)`);
      if (action === "inserted") inserted++; else updated++;
    } catch (e) {
      console.error(`  FAIL ${fileName} —`, e.message);
      skipped++;
    }
  }

  console.log(`[import] done: ${inserted} new, ${updated} updated, ${skipped} skipped`);
  await pool.end();
}

main().catch((e) => {
  console.error("[import] fatal:", e);
  process.exit(1);
});
