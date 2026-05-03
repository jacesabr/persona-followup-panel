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

// Exported so the in-server admin route can run the same logic without
// shelling out to npm — useful when DB connections from outside the
// Render network drop mid-query (common; Render external Postgres is
// flaky on long-haul SSL handshakes).
export async function upsertExample(meta, fullText, sourcePath) {
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

// Walk the corpus directory, parse each example, upsert. Exported
// for the admin route. Returns a manifest the caller can render.
// Doesn't pool.end() — caller decides lifecycle.
export async function runImportFromCorpusDir(corpusDir) {
  if (!fs.existsSync(corpusDir)) {
    throw new Error(`corpus dir missing: ${corpusDir}`);
  }
  const files = fs
    .readdirSync(corpusDir)
    .filter((f) => !f.startsWith("."))
    .filter((f) => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .filter((f) => !/\.meta\.ya?ml$/i.test(f));

  const results = [];
  for (const fileName of files) {
    const filePath = path.join(corpusDir, fileName);
    try {
      const fullText = await readExampleText(filePath);
      if (!fullText || fullText.length < 100) {
        results.push({ file: fileName, action: "skipped", reason: "text too short" });
        continue;
      }
      const sidecar = readSidecar(filePath);
      const defaults = inferDefaults(filePath, fullText);
      const meta = { ...defaults, ...(sidecar || {}) };
      const { action, id } = await upsertExample(meta, fullText, filePath);
      results.push({
        file: fileName,
        action,
        id: String(id),
        label: meta.label,
        length_pages: meta.length_pages,
        word_count: fullText.split(/\s+/).filter(Boolean).length,
      });
    } catch (e) {
      results.push({ file: fileName, action: "error", reason: e.message });
    }
  }
  return { dir: corpusDir, results };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[import] DATABASE_URL not set.");
    process.exit(1);
  }
  const { results } = await runImportFromCorpusDir(CORPUS_DIR);
  let inserted = 0, updated = 0, skipped = 0;
  for (const r of results) {
    if (r.action === "inserted") {
      inserted++;
      console.log(`  NEW  ${r.file}  →  ${r.label} (${r.length_pages}p)`);
    } else if (r.action === "updated") {
      updated++;
      console.log(`  EDIT ${r.file}  →  ${r.label} (${r.length_pages}p)`);
    } else {
      skipped++;
      console.log(`  ${r.action.toUpperCase()} ${r.file} — ${r.reason || ""}`);
    }
  }
  console.log(`[import] done: ${inserted} new, ${updated} updated, ${skipped} skipped`);
  await pool.end();
}

// Only run main() when invoked directly (not when imported by the
// admin route). Detect via the URL of the entrypoint module.
import { fileURLToPath as _f } from "node:url";
if (process.argv[1] && process.argv[1] === _f(import.meta.url)) {
  main().catch((e) => {
    console.error("[import] fatal:", e);
    process.exit(1);
  });
}
