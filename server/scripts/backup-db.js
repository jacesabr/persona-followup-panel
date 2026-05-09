// Full-database snapshot. Dumps every public table to a single JSON
// file, writes it to ./backups/ on the local machine, and uploads a
// duplicate to R2 under _backups/. Prints SHA-256 of the file so the
// integrity can be verified later. Use before destructive ops.
//
// NEVER delete the resulting backup files. They are the rollback path
// of last resort if a delete-script wipes more than intended.
//
// Usage: node server/scripts/backup-db.js [--label some-tag]

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getStorage } from "../storage.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const BACKUPS_DIR = path.join(ROOT, "backups");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const label = (arg("label") || "snapshot").replace(/[^a-zA-Z0-9._-]/g, "_");
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const tablesRes = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`
  );
  const tables = tablesRes.rows.map((r) => r.table_name);

  const dump = {
    snapshot_at: new Date().toISOString(),
    label,
    database_url_host: new URL(process.env.DATABASE_URL).host,
    tables: {},
  };

  for (const t of tables) {
    const r = await pool.query(`SELECT * FROM "${t}"`);
    dump.tables[t] = { row_count: r.rows.length, rows: r.rows };
    console.log(`[backup] ${t}: ${r.rows.length} rows`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `db-${ts}-${label}.json`;
  const localPath = path.join(BACKUPS_DIR, filename);
  // Pretty-print so a human can diff backups in version control
  // tooling. The size cost is ~30% over compact JSON, fine for an
  // intake-sized DB.
  fs.writeFileSync(localPath, JSON.stringify(dump, null, 2), "utf8");

  const bytes = fs.readFileSync(localPath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  // Upload to R2 under _backups/. Same bucket as student uploads but
  // a dedicated prefix so it never gets enumerated/listed by the
  // student-files route. Use the storage abstraction so the HEAD
  // verify in save() also confirms R2 has it.
  const store = await getStorage();
  if (store.name !== "s3") {
    console.warn(`[backup] WARNING: storage backend is ${store.name}, not s3 — backup is on local disk only.`);
  } else {
    // store.save() unlinks tmpPath after upload, so feed it a copy.
    const tmpForUpload = path.join(BACKUPS_DIR, `.upload-${ts}-${label}.json`);
    fs.copyFileSync(localPath, tmpForUpload);
    const saved = await store.save({
      tmpPath: tmpForUpload,
      scope: "_backups",
      originalName: filename,
      mimeType: "application/json",
    });
    console.log(`[backup] R2 PUT ok — key=${saved.key} size=${saved.size}B`);
  }

  await pool.end();

  console.log("\n[backup] DONE");
  console.log(`  local: ${localPath}`);
  console.log(`  bytes: ${bytes.length}`);
  console.log(`  sha256: ${sha256}`);
}

main().catch((e) => { console.error("[backup] FAIL:", e?.stack || e); process.exit(1); });
