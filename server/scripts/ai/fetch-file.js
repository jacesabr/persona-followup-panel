// Pull one file's bytes out of R2 (or the local-disk fallback) and
// write them to a destination file path. The Claude Code routine then
// reads the destination with the agent's Read tool to render the doc.
//
// Usage:
//   node server/scripts/ai/fetch-file.js <file_id> <dest_path>
//
// We write directly to the destination path with fs.createWriteStream
// rather than piping through process.stdout. Earlier versions used
// stdout redirection (`> /tmp/file.bin`), which silently corrupted
// every binary download whenever any module in the import graph did
// a console.log at boot — the log text got prepended to the bytes and
// downstream image/PDF readers rejected the file with "could not
// process image". Writing to a real file path keeps stdout free for
// status output and makes that corruption impossible.
//
// Stderr carries the metadata header so the caller can sniff
// mime-type without parsing the bytes:
//   STDERR: { id, original_name, mime_type, size }

import "dotenv/config";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pool from "../../db.js";
import { getStorage } from "../../storage.js";

async function main() {
  const fileId = process.argv[2];
  const destPath = process.argv[3];
  if (!fileId || !destPath) {
    console.error("Usage: fetch-file.js <file_id> <dest_path>");
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
  const stream = await storage.openReadStream(file.storage_path);
  const nodeStream = stream instanceof Readable ? stream : Readable.from(stream);
  const out = fs.createWriteStream(destPath);
  await pipeline(nodeStream, out);
  // Sanity-check: the bytes we just wrote should start with a real
  // file magic, not text. If they don't, something upstream poisoned
  // the stream and we want the caller to see it loudly instead of
  // discovering it later as a "could not process image" 400.
  const head = await fs.promises.open(destPath, "r");
  try {
    const buf = Buffer.alloc(8);
    await head.read(buf, 0, 8, 0);
    if (buf[0] === 0x5b /* '[' */ || buf[0] === 0x7b /* '{' */) {
      const peek = buf.toString("utf8");
      throw new Error(
        `[fetch-file] destination starts with ASCII (${JSON.stringify(peek)}) — ` +
        `expected binary. Some imported module is writing to the wrong stream.`
      );
    }
  } finally {
    await head.close();
  }
  await pool.end();
}

main().catch((e) => {
  console.error("[fetch-file] FAIL:", e?.message || e);
  process.exit(1);
});
