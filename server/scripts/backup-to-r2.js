/**
 * Daily backup runner.
 *
 * Dumps every public table from the prod Postgres into one
 * gzipped JSON object and uploads it to Cloudflare R2 (the same
 * bucket student files live in, under a `backups/` prefix).
 * Designed to be invoked by a Render Cron Job once a day, but
 * safe to run manually any time (e.g. before a risky import).
 *
 * Why JSON dumps and not pg_dump:
 *   - Render Cron services don't ship postgresql-client and we
 *     don't get shell access on basic_256mb to install it. A
 *     pure-JS dump avoids the binary dependency entirely.
 *   - Restore = run migrate.js (idempotent), then INSERT each row
 *     from the JSON. Sequence values are preserved so generated
 *     ids continue cleanly. Code lives next to this script if a
 *     restore is ever needed.
 *
 * Why R2 + same bucket as student files:
 *   - The S3 credentials we already have in env are scoped to this
 *     bucket; a separate backup bucket would need a separate
 *     account-level Cloudflare API token to create.
 *   - R2 is geo-redundant + has versioning when enabled. One
 *     bucket = one set of permissions to rotate, one place to
 *     monitor.
 *
 * Restore sketch (intentionally not a one-button command — you
 * should think twice before running):
 *   1. Spin up a new (or wiped) Postgres
 *   2. Run migrate() to create the schema
 *   3. For each table: TRUNCATE + INSERT rows from the dump
 *   4. SELECT setval(seq_name, last_value) for every sequence
 *
 * Env vars expected (already set on the web service):
 *   DATABASE_URL          prod Postgres connection string
 *   S3_BUCKET             e.g. "persona-intake-files"
 *   S3_ENDPOINT           e.g. "https://<account>.r2.cloudflarestorage.com"
 *   S3_REGION             "auto" for R2
 *   S3_FORCE_PATH_STYLE   "true" for R2
 *   S3_ACCESS_KEY_ID      R2 access key
 *   S3_SECRET_ACCESS_KEY  R2 secret
 *   BACKUP_PREFIX         optional, defaults to "backups"
 */

import "dotenv/config";
import zlib from "node:zlib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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
  // pg_sequences.last_value is NULL for never-advanced sequences; store
  // those as null rather than the string "null" so restore can detect.
  for (const r of seqRows) {
    dump.sequences[r.sequence_name] =
      r.last_value == null ? null : String(r.last_value);
  }
  dump.counts.sequences = Object.keys(dump.sequences).length;

  return dump;
}

function buildS3Client() {
  const required = ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
  for (const k of required) {
    if (!process.env[k]) throw new Error(`${k} not set`);
  }
  return new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

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
  const prefix = process.env.BACKUP_PREFIX || "backups";
  const objectKey = `${prefix}/${day}/snapshot-${day}T${time}Z.json.gz`;

  const bucket = process.env.S3_BUCKET;
  console.log(`[backup] uploading to s3://${bucket}/${objectKey}`);
  const s3 = buildS3Client();
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: gz,
    ContentType: "application/gzip",
    ContentEncoding: "gzip",
    CacheControl: "no-cache",
    Metadata: {
      "snapshot-at": dump.snapshot_at,
      "table-count": String(dump.counts.tables),
      "row-count": String(dump.counts.rows),
    },
  }));

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
