// One-shot recovery: re-upload Pratham Aggarwal's intake files from
// ~/Desktop/suhas/ into R2, write new intake_files rows that point at
// the R2 keys, supersede the dead local-disk rows, and rewrite each
// file slot in intake_students.data.answers so the UI follows the new
// IDs. Idempotent at the row level via the active partial index, but
// running it twice would create N+1 superseded rows — only run again
// after deleting the new rows.
//
// Usage: node server/scripts/reupload-pratham.js
//
// Hardcoded for one student because the original local-disk wipe only
// affected this account; the storage cutover (STORAGE_BACKEND=s3) is
// already live so future uploads land in R2 the normal way.

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { getStorage } from "../storage.js";

const STUDENT_ID = "s_moy17coj_7ab6d5bb6e39";
const SOURCE_DIR = "C:/Users/E Logitech/Desktop/suhas";

// Map: filename → { fieldId, rowIndex }. row_index is null for
// non-repeater fields and 0..N for activities_list[] proof slots.
// Field IDs taken from the live intake schema (lib/intakeSchema.js).
const FILE_MAP = [
  { name: "EAadhaar_0656230130147520251104125354_05122025195259 (2)_page-0001 (1).jpg (1).jpeg",
    fieldId: "aadharFile", rowIndex: null, mime: "image/jpeg" },
  { name: "Photo.jpg (1) (1).jpeg",
    fieldId: "photoFile", rowIndex: null, mime: "image/jpeg" },
  { name: "cisce.org-SSCER-248115896 (1).pdf",
    fieldId: "marks10sheet", rowIndex: null, mime: "application/pdf" },
  { name: "Class 11 Report card (1).pdf",
    fieldId: "marks11sheet", rowIndex: null, mime: "application/pdf" },
  { name: "Abacus Graduation (1).pdf",
    fieldId: "activities_list[0].proof", rowIndex: 0, mime: "application/pdf",
    answersPath: ["activities_list", 0, "proof"] },
  { name: "Entrepreneurship program (1).pdf",
    fieldId: "activities_list[1].proof", rowIndex: 1, mime: "application/pdf",
    answersPath: ["activities_list", 1, "proof"] },
  { name: "Game developer (1).pdf",
    fieldId: "activities_list[2].proof", rowIndex: 2, mime: "application/pdf",
    answersPath: ["activities_list", 2, "proof"] },
  { name: "Techno Fest (1).pdf",
    fieldId: "activities_list[3].proof", rowIndex: 3, mime: "application/pdf",
    answersPath: ["activities_list", 3, "proof"] },
];

async function main() {
  if ((process.env.STORAGE_BACKEND || "local").toLowerCase() !== "s3") {
    throw new Error("STORAGE_BACKEND must be s3 (set the R2 vars in .env first).");
  }
  const store = await getStorage();
  if (store.name !== "s3") throw new Error(`expected s3 backend, got ${store.name}`);

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const cur = await pool.query(
    `SELECT data FROM intake_students WHERE student_id = $1`,
    [STUDENT_ID]
  );
  if (cur.rows.length === 0) throw new Error(`student ${STUDENT_ID} not found`);
  const data = cur.rows[0].data || {};
  const answers = (data && typeof data === "object" && data.answers) || {};

  // Idempotency guard: refuse to run if every active intake_files row
  // for this student already lives in R2 (storage_path doesn't start
  // with the legacy /opt/render/... local-disk prefix). Re-running
  // when everything is already in R2 would create N more orphan blobs
  // for no gain — supersede saves the DB but the R2 cost grows.
  const active = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE storage_path LIKE '/opt/render/%')::int AS legacy,
            COUNT(*)::int AS total
       FROM intake_files
      WHERE student_id = $1 AND superseded_at IS NULL`,
    [STUDENT_ID]
  );
  const { legacy, total } = active.rows[0];
  if (total > 0 && legacy === 0) {
    console.log(
      `[reupload] all ${total} active intake_files row(s) already point at R2 keys; nothing to do.`
    );
    await pool.end();
    return;
  }
  console.log(`[reupload] ${legacy} legacy / ${total} active row(s) — proceeding.`);

  const updates = [];

  for (const f of FILE_MAP) {
    const src = path.join(SOURCE_DIR, f.name);
    if (!fs.existsSync(src)) {
      throw new Error(`missing source file: ${src}`);
    }
    // Copy to a tmp path because storage.save() unlinks tmpPath after
    // a successful PUT (mirrors the multer flow). Don't want to delete
    // the originals on Desktop.
    const tmpPath = path.join(os.tmpdir(), `reupload-${crypto.randomBytes(6).toString("hex")}-${path.basename(src)}`);
    fs.copyFileSync(src, tmpPath);

    const saved = await store.save({
      tmpPath,
      scope: STUDENT_ID,
      originalName: f.name,
      mimeType: f.mime,
    });
    console.log(`[reupload] R2 PUT ok — ${f.fieldId} → ${saved.key} (${saved.size}B)`);

    // DB write: supersede any active row for this (student, field, row)
    // and insert the new pointer in one tx — same pattern as the live
    // /me/upload route, minus the multer/sharp pre-processing.
    const client = await pool.connect();
    let newRow;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE intake_files
            SET superseded_at = NOW()
          WHERE student_id = $1 AND field_id = $2
            AND ((row_index IS NULL AND $3::int IS NULL) OR row_index = $3)
            AND superseded_at IS NULL`,
        [STUDENT_ID, f.fieldId, f.rowIndex]
      );
      const ins = await client.query(
        `INSERT INTO intake_files
           (student_id, field_id, row_index, original_name, storage_path, size, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, created_at`,
        [STUDENT_ID, f.fieldId, f.rowIndex, f.name, saved.key, saved.size, f.mime]
      );
      newRow = ins.rows[0];
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Orphan the R2 blob since the DB row didn't land.
      await store.deleteIfExists(saved.key).catch(() => {});
      client.release();
      throw e;
    }
    client.release();
    console.log(`[reupload] DB INSERT ok — file_id=${newRow.id}`);

    // Build the new file-slot blob the frontend stores in answers.<fieldId>.
    const slot = {
      name: f.name,
      size: saved.size,
      type: f.mime,
      error: null,
      fileId: String(newRow.id),
      status: "uploaded",
      uploadedAt: newRow.created_at.toISOString(),
      uploadedUrl: `/api/students/me/files/${newRow.id}`,
      lastModified: Date.now(),
    };
    updates.push({ field: f.fieldId, path: f.answersPath || [f.fieldId], slot });
  }

  // Apply slot updates to the answers tree. Nested paths (activities_list[i].proof)
  // need a walk so we don't blow away sibling fields on the same row.
  const newAnswers = JSON.parse(JSON.stringify(answers));
  for (const u of updates) {
    let cursor = newAnswers;
    for (let i = 0; i < u.path.length - 1; i++) {
      const seg = u.path[i];
      if (cursor[seg] == null) {
        cursor[seg] = typeof u.path[i + 1] === "number" ? [] : {};
      }
      cursor = cursor[seg];
    }
    cursor[u.path[u.path.length - 1]] = u.slot;
  }
  const newData = { ...data, answers: newAnswers };

  await pool.query(
    `UPDATE intake_students SET data = $1, updated_at = NOW() WHERE student_id = $2`,
    [newData, STUDENT_ID]
  );
  console.log(`[reupload] data.answers rewritten for ${STUDENT_ID}`);

  // Sanity: list every active file row for the student so the operator
  // sees the new IDs and bytes-in-R2 confirmation in one place.
  const after = await pool.query(
    `SELECT id, field_id, row_index, original_name, storage_path, size
       FROM intake_files
      WHERE student_id = $1 AND superseded_at IS NULL
      ORDER BY field_id, row_index NULLS FIRST, id`,
    [STUDENT_ID]
  );
  console.log("\n[reupload] active rows after:");
  for (const r of after.rows) {
    const exists = await store.exists(r.storage_path);
    console.log(
      `  id=${r.id} field=${r.field_id}${r.row_index != null ? `[${r.row_index}]` : ""} ` +
      `size=${r.size}B key=${r.storage_path} R2-exists=${exists}`
    );
  }

  await pool.end();
}

main()
  .then(() => { console.log("\n[reupload] done."); process.exit(0); })
  .catch((e) => { console.error("[reupload] FAIL:", e?.stack || e); process.exit(1); });
