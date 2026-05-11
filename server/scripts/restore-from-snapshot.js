/**
 * One-shot restore of a backup-to-r2.js JSON snapshot into the DB
 * pointed at by DATABASE_URL. Intentionally a sketch-and-confirm tool:
 * the snapshot is small enough (~hundreds of rows) that per-row INSERTs
 * are fine and the log makes it obvious what landed.
 *
 * Usage:
 *   DATABASE_URL=<target> node server/scripts/restore-from-snapshot.js \
 *     backups/snapshot-2026-05-10.json [--force]
 *
 * Refuses to run if the target already has any rows in a snapshot table
 * unless --force is passed (prevents accidental clobber of a live DB).
 *
 * FK handling: Render's managed Postgres doesn't grant superuser to
 * the app role, so we can't SET session_replication_role = replica.
 * Instead we DROP every FK constraint on public.* before inserting,
 * then re-add them at the end from the definitions captured up front.
 * Slower than a session-wide disable, but works with table-owner perms.
 *
 * JSONB / JSON columns get re-stringified — the snapshot stores them
 * as parsed objects, the pg driver wants strings or it double-escapes.
 */

import "dotenv/config";
import fs from "node:fs";
import pg from "pg";
import { migrate } from "../migrate.js";

const { Pool } = pg;

const snapPath = process.argv[2];
const force = process.argv.includes("--force");
if (!snapPath) {
  console.error("usage: node server/scripts/restore-from-snapshot.js <snapshot.json> [--force]");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(2);
}

const url = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: url,
  ssl: url.includes("render.com") ? { rejectUnauthorized: false } : false,
});

async function main() {
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  console.log(`[restore] snapshot: ${snapPath}`);
  console.log(`[restore] snapshot_at: ${snap.snapshot_at}`);
  console.log(`[restore] target host: ${new URL(url).host}`);
  console.log(
    `[restore] snapshot has ${snap.counts.tables} tables / ${snap.counts.rows} rows / ${snap.counts.sequences} sequences`
  );

  // Pull in the canonical schema first. migrate.js uses its own pool
  // (server/db.js), which reads DATABASE_URL the same way we do.
  await migrate();

  const client = await pool.connect();
  try {
    // Build the set of tables that actually exist on the target so we
    // can skip legacy snapshot tables (e.g. _persona_post_demo_wipe)
    // that the live schema has since dropped.
    const { rows: existing } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    );
    const present = new Set(existing.map((r) => r.table_name));
    const skipped = Object.keys(snap.tables).filter((t) => !present.has(t));
    if (skipped.length) {
      console.log(`[restore] skipping tables not in target schema: ${skipped.join(", ")}`);
    }

    // Pre-flight: refuse if target already has data, unless --force.
    if (!force) {
      for (const [table, rows] of Object.entries(snap.tables)) {
        if (!present.has(table)) continue;
        if (rows.length === 0) continue;
        const { rows: r } = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${JSON.stringify(table)}`
        );
        if (r[0].n > 0) {
          throw new Error(
            `target table "${table}" already has ${r[0].n} rows — pass --force to truncate and overwrite`
          );
        }
      }
    }

    // Capture every FK on the public schema, then drop them so INSERTs
    // can land in any order. We re-create them from these definitions
    // after the data is in.
    const { rows: fks } = await client.query(`
      SELECT conname,
             conrelid::regclass::text AS table_name,
             pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'f' AND n.nspname = 'public'
    `);
    console.log(`[restore] dropping ${fks.length} FK constraints (will re-add)`);

    await client.query("BEGIN");
    for (const fk of fks) {
      await client.query(
        `ALTER TABLE ${fk.table_name} DROP CONSTRAINT ${JSON.stringify(fk.conname)}`
      );
    }

    for (const [table, rows] of Object.entries(snap.tables)) {
      if (!present.has(table)) {
        console.log(`[restore]   ${table.padEnd(28)} ${rows.length} rows (table absent from target — skipped)`);
        continue;
      }
      if (force) {
        await client.query(`TRUNCATE TABLE ${JSON.stringify(table)} CASCADE`);
      }
      if (rows.length === 0) {
        console.log(`[restore]   ${table.padEnd(28)} 0 rows (skip)`);
        continue;
      }
      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => JSON.stringify(c)).join(",");
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
      const sql = `INSERT INTO ${JSON.stringify(table)} (${colList}) VALUES (${placeholders})`;
      for (const row of rows) {
        const vals = cols.map((c) => {
          const v = row[c];
          // jsonb / json: snapshot has parsed object; pg wants string.
          if (
            v !== null &&
            typeof v === "object" &&
            !(v instanceof Date) &&
            !Buffer.isBuffer(v)
          ) {
            return JSON.stringify(v);
          }
          return v;
        });
        await client.query(sql, vals);
      }
      console.log(`[restore]   ${table.padEnd(28)} ${rows.length} rows`);
    }

    // Sequences with a non-numeric value (the backup script stores
    // "null" when last_value is NULL — i.e. the sequence was never
    // advanced). Those tables had 0 rows, so leave the sequence at
    // its fresh default (1, is_called=false).
    let seqApplied = 0;
    let seqSkipped = 0;
    for (const [seq, lastValue] of Object.entries(snap.sequences)) {
      if (lastValue == null || !/^\d+$/.test(String(lastValue))) {
        seqSkipped++;
        continue;
      }
      await client.query(`SELECT setval($1, $2)`, [seq, lastValue]);
      seqApplied++;
    }
    console.log(
      `[restore]   sequences: ${seqApplied} restored, ${seqSkipped} skipped (never advanced)`
    );

    // Re-add the FKs from the definitions captured before the inserts.
    for (const fk of fks) {
      await client.query(
        `ALTER TABLE ${fk.table_name} ADD CONSTRAINT ${JSON.stringify(fk.conname)} ${fk.def}`
      );
    }
    console.log(`[restore]   FKs restored: ${fks.length}`);

    await client.query("COMMIT");
    console.log("[restore] OK");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error("[restore] FAIL:", e?.message || e);
    pool.end().catch(() => {});
    process.exit(1);
  });
