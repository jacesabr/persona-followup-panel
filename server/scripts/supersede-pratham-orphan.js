// One-shot. The reupload-pratham.js script supersedes legacy local-
// disk file rows by matching on (student_id, field_id, row_index) —
// but row id=23 was inserted with field_id="proof" and row_index=NULL
// (the schema's earlier repeater convention). The new uploads use
// field_id="activities_list[3].proof" + row_index=3, so the supersede
// query missed it. Today the row appears in /api/students/me/files
// for Pratham and 410s on click because the bytes are gone from the
// wiped local disk. Mark it superseded so the student's documents
// list stops showing a duplicate broken Techno Fest entry.
//
// Verifies preconditions before writing:
//   - the new row (id=31, field_id="activities_list[3].proof") is
//     active and points at an R2 key.
//   - id=23 is currently active and on a /opt/render/... path.
//
// Usage: node server/scripts/supersede-pratham-orphan.js

import "dotenv/config";
import pg from "pg";

const STUDENT_ID = "s_moy17coj_7ab6d5bb6e39";
const ORPHAN_ID = 23;
const REPLACEMENT_ID = 31;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const orphan = await pool.query(
  `SELECT id, field_id, row_index, storage_path, superseded_at
     FROM intake_files
    WHERE id = $1 AND student_id = $2`,
  [ORPHAN_ID, STUDENT_ID]
);
if (orphan.rows.length !== 1) throw new Error(`orphan row id=${ORPHAN_ID} not found for ${STUDENT_ID}`);
const o = orphan.rows[0];
console.log(`[supersede] orphan: id=${o.id} field=${o.field_id} key=${o.storage_path} superseded_at=${o.superseded_at}`);
if (o.superseded_at) {
  console.log("[supersede] already superseded; nothing to do.");
  await pool.end();
  process.exit(0);
}
if (!o.storage_path.startsWith("/opt/render/")) {
  throw new Error(`refusing to supersede: orphan storage_path doesn't look legacy (${o.storage_path})`);
}

const replacement = await pool.query(
  `SELECT id, field_id, storage_path, superseded_at
     FROM intake_files
    WHERE id = $1 AND student_id = $2`,
  [REPLACEMENT_ID, STUDENT_ID]
);
if (replacement.rows.length !== 1) throw new Error(`replacement row id=${REPLACEMENT_ID} not found`);
const rep = replacement.rows[0];
if (rep.superseded_at) throw new Error(`replacement row id=${REPLACEMENT_ID} is already superseded`);
if (rep.storage_path.startsWith("/opt/render/")) {
  throw new Error(`replacement row id=${REPLACEMENT_ID} still points at local disk (${rep.storage_path}) — refusing.`);
}
console.log(`[supersede] replacement: id=${rep.id} field=${rep.field_id} key=${rep.storage_path}`);

const r = await pool.query(
  `UPDATE intake_files SET superseded_at = NOW()
     WHERE id = $1 AND student_id = $2 AND superseded_at IS NULL
     RETURNING id, superseded_at`,
  [ORPHAN_ID, STUDENT_ID]
);
if (r.rowCount !== 1) throw new Error(`UPDATE matched ${r.rowCount} rows; expected 1`);
console.log(`[supersede] superseded id=${r.rows[0].id} at ${r.rows[0].superseded_at}`);

await pool.end();
