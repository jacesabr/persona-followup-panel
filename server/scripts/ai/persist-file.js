// Write the agent's per-file description + extracted fields back
// to intake_files. Both fields are nullable; the script overwrites
// whatever was there (so re-running picks up improved descriptions).
//
// Usage (description from a file is preferred — long verbatim
// transcriptions blow past ARG_MAX on some shells):
//   node server/scripts/ai/persist-file.js <file_id> --description-file <path> --extracted '<json>'
//   node server/scripts/ai/persist-file.js <file_id> --description "<text>" --extracted '<json>'  # legacy

import "dotenv/config";
import { readFileSync } from "node:fs";
import pool from "../../db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const fileId = process.argv[2];
  const descriptionInline = arg("description");
  const descriptionFile = arg("description-file");
  const extractedRaw = arg("extracted");

  let description = null;
  if (descriptionFile) {
    description = readFileSync(descriptionFile, "utf8");
  } else if (descriptionInline) {
    description = descriptionInline;
  }

  if (!fileId || !description) {
    console.error("Usage: persist-file.js <file_id> (--description-file <path> | --description <text>) [--extracted <json>]");
    process.exit(1);
  }

  let extracted = null;
  if (extractedRaw) {
    try {
      extracted = JSON.parse(extractedRaw);
    } catch (e) {
      console.error("--extracted must be valid JSON:", e.message);
      process.exit(1);
    }
  }

  const { rowCount } = await pool.query(
    `UPDATE intake_files
        SET ai_description = $2,
            ai_extracted   = $3
      WHERE id = $1`,
    [fileId, description, extracted ? JSON.stringify(extracted) : null]
  );
  if (rowCount === 0) {
    console.error(`file ${fileId} not found`);
    process.exit(1);
  }
  console.log(`[persist-file] file=${fileId} description=${description.length}c extracted=${extracted ? Object.keys(extracted).length + " keys" : "none"}`);
  await pool.end();
}

main().catch((e) => {
  console.error("[persist-file] FAIL:", e?.message || e);
  process.exit(1);
});
