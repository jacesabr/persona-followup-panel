/**
 * Daily backup runner.
 *
 * Dumps every public table from the prod Postgres into one
 * gzipped JSON object and uploads it to a Google Cloud Storage
 * bucket. Designed to be invoked by a Render Cron Job once a day,
 * but safe to run manually any time (e.g. before a risky import).
 *
 * Why JSON dumps and not pg_dump:
 *   - Render's basic_256mb plan doesn't include shell access for
 *     the Postgres instance, and Render Cron services don't ship
 *     postgresql-client by default. A pure-JS dump avoids the
 *     binary dependency entirely.
 *   - Restore = run migrate.js (idempotent), then INSERT each row
 *     from the JSON. Sequence values are preserved so generated
 *     ids continue cleanly. Code lives next to this script if a
 *     restore is ever needed.
 *
 * Restore sketch (intentionally not a one-button command — you
 * should think twice before running):
 *   1. Spin up a new (or wiped) Postgres
 *   2. Run migrate() to create the schema
 *   3. For each table: TRUNCATE + INSERT rows from the dump
 *   4. SELECT setval(seq_name, last_value) for every sequence
 *
 * Env vars expected:
 *   DATABASE_URL                — prod Postgres connection string
 *   GCS_BUCKET                  — e.g. "persona-followup-backups"
 *   GCS_SERVICE_ACCOUNT_KEY     — full JSON of the service account
 *                                 key, inlined as a single env var
 *                                 (Render lets you do this even
 *                                 with newlines escaped)
 *   BACKUP_PREFIX               — optional, defaults to ""
 */

import "dotenv/config";
import zlib from "node:zlib";
import { Storage } from "@google-cloud/storage";
import pool from "../db.js";

async function dumpAllTables() {
  const { rows: tables } = await pool.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);

  const dump = {
    snapshot_at: new Date().toISOString(),
    schema_note:
      "JSON snapshot. Restore = run migrate(), then INSERT rows + setval each sequence.",
    tables: {},
    sequences: {},
    counts: { tables: 0, rows: 0, sequences: 0 },
  };

  for (const { table_name } of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${JSON.stringify(table_name)}`);
    dump.tables[table_name] = rows;
    dump.counts.rows += rows.length;
  }
  dump.counts.tables = Object.keys(dump.tables).length;

  // Sequence current values so generated ids resume cleanly on
  // restore (avoids primary-key collisions if rows are inserted
  // before sequences are advanced).
  const { rows: seqRows } = await pool.query(`
    SELECT s.sequence_name, p.last_value
      FROM information_schema.sequences s
      JOIN pg_sequences p ON p.sequencename = s.sequence_name
     WHERE s.sequence_schema = 'public'
  `);
  for (const r of seqRows) dump.sequences[r.sequence_name] = String(r.last_value);
  dump.counts.sequences = Object.keys(dump.sequences).length;

  return dump;
}

function buildGcsClient() {
  const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("GCS_SERVICE_ACCOUNT_KEY not set");
  let credentials;
  try {
    credentials = JSON.parse(keyJson);
  } catch (e) {
    throw new Error("GCS_SERVICE_ACCOUNT_KEY is not valid JSON: " + e.message);
  }
  return new Storage({ credentials, projectId: credentials.project_id });
}

async function uploadToGcs(bucket, objectName, gzipBuffer) {
  const file = bucket.file(objectName);
  await file.save(gzipBuffer, {
    contentType: "application/gzip",
    metadata: {
      contentEncoding: "gzip",
      cacheControl: "no-cache",
    },
    resumable: false,
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set");
  }
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) throw new Error("GCS_BUCKET not set");

  const startedAt = Date.now();
  console.log("[backup] dumping tables…");
  const dump = await dumpAllTables();

  const json = JSON.stringify(dump);
  const gz = zlib.gzipSync(Buffer.from(json));

  // YYYY-MM-DD/HHMMSS path so the bucket browses chronologically.
  // Render Cron runs in UTC; we keep the timestamp in UTC for
  // consistency with the snapshot_at field.
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const prefix = process.env.BACKUP_PREFIX || "";
  const objectName = `${prefix ? prefix + "/" : ""}${day}/snapshot-${day}T${time}Z.json.gz`;

  console.log("[backup] uploading to gs://" + bucketName + "/" + objectName);
  const storage = buildGcsClient();
  const bucket = storage.bucket(bucketName);
  await uploadToGcs(bucket, objectName, gz);

  const elapsed = Date.now() - startedAt;
  console.log(
    `[backup] OK — ${dump.counts.tables} tables / ${dump.counts.rows} rows / ` +
      `${dump.counts.sequences} sequences / ` +
      `${(gz.length / 1024).toFixed(1)} kB gzip / ${elapsed} ms`
  );
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error("[backup] FAIL:", e?.message || e);
    pool.end().catch(() => {});
    process.exit(1);
  });
