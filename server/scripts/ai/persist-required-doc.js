// Write the agent's draft into intake_required_docs.staff_draft
// for one specific row (LOR / internship / SOP). Only writes when
// the existing staff_draft is NULL or empty — never clobbers a
// counsellor's edit. Re-running for the same row is a no-op (the
// row stays with whatever staff_draft is already there).
//
// Usage:
//   node server/scripts/ai/persist-required-doc.js <doc_id> --staff-draft <text>
//   node server/scripts/ai/persist-required-doc.js <doc_id> --staff-draft-file <path>
//   ...add --force to overwrite an existing draft (use sparingly).

import "dotenv/config";
import fs from "node:fs";
import pool from "../../db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const docId = process.argv[2];
  const inline = arg("staff-draft");
  const fileArg = arg("staff-draft-file");
  const force = flag("force");

  if (!docId || (!inline && !fileArg)) {
    console.error("Usage: persist-required-doc.js <doc_id> (--staff-draft <text> | --staff-draft-file <path>) [--force]");
    process.exit(1);
  }

  const draft = fileArg ? fs.readFileSync(fileArg, "utf8") : inline;

  const { rows } = await pool.query(
    "SELECT id, kind, seq, student_id, staff_draft FROM intake_required_docs WHERE id = $1",
    [docId]
  );
  if (rows.length === 0) {
    console.error(`required-doc ${docId} not found`);
    process.exit(1);
  }
  const doc = rows[0];

  const existingFilled = doc.staff_draft && doc.staff_draft.trim().length > 0;
  if (existingFilled && !force) {
    console.log(`[persist-required-doc] doc=${docId} kind=${doc.kind} seq=${doc.seq} — staff_draft already set, skipping (use --force to override)`);
    await pool.end();
    return;
  }

  await pool.query(
    "UPDATE intake_required_docs SET staff_draft = $2, updated_at = NOW() WHERE id = $1",
    [docId, draft]
  );

  await pool.query(
    `INSERT INTO intake_audit_log (actor_kind, actor_id, target_table, target_id, action, diff)
     VALUES ('system', NULL, 'intake_required_docs', $1, 'ai_drafted', $2::jsonb)`,
    [docId, JSON.stringify({ kind: doc.kind, seq: doc.seq, student_id: doc.student_id, length_chars: draft.length, overwrote: existingFilled && force })]
  );

  console.log(`[persist-required-doc] doc=${docId} kind=${doc.kind} seq=${doc.seq} chars=${draft.length}${force && existingFilled ? " (overwrote)" : ""}`);
  await pool.end();
}

main().catch((e) => {
  console.error("[persist-required-doc] FAIL:", e?.message || e);
  process.exit(1);
});
