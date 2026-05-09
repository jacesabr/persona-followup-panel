// Pull one file's bytes out of R2 (or the local-disk fallback) and
// write them to stdout. The Claude Code routine pipes this to a
// /tmp/file_<id>.bin so the agent's Read tool can render it.
//
// Usage:
//   node server/scripts/ai/fetch-file.js <file_id> > /tmp/file_<id>.bin
//
// Stderr carries the metadata header so the caller can sniff
// mime-type without parsing the bytes:
//   STDERR: { id, original_name, mime_type, size }

import "dotenv/config";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pool from "../../db.js";
import { getStorage } from "../../storage.js";

async function main() {
  const fileId = process.argv[2];
  if (!fileId) {
    console.error("Usage: fetch-file.js <file_id>");
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, student_id, field_id, original_name, mime_type, size,
            storage_path, superseded_at
       FROM intake_files
      WHERE id = $1`,
    [fileId]
  );
  const file = rows[0];
  if (!file) {
    console.error(`file ${fileId} not found`);
    process.exit(1);
  }
  if (file.superseded_at) {
    console.error(`file ${fileId} is superseded`);
    process.exit(1);
  }

  console.error(JSON.stringify({
    id: file.id,
    original_name: file.original_name,
    mime_type: file.mime_type,
    size: file.size,
  }));

  const storage = await getStorage();
  const stream = await storage.openReadStream({ key: file.storage_path });
  const nodeStream = stream instanceof Readable ? stream : Readable.from(stream);
  await pipeline(nodeStream, process.stdout);
  await pool.end();
}

main().catch((e) => {
  console.error("[fetch-file] FAIL:", e?.message || e);
  process.exit(1);
});
