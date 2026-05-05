// Seed an idempotent test student with username "student" and password
// "student". Mirrors the admin-only POST /api/students path, minus the
// HTTP layer — useful for local/dev environments and for demo logins.
//
// "student" is whitelisted by design (see students.js comment near the
// STUDENT_WEAK_PASSWORDS denylist: it's 7 chars and not in the list, so
// it's the canonical explicit-test-account value).
//
// Run:  npm run seed-student
//
// Requires DATABASE_URL (same as the server).

import "dotenv/config";
import crypto from "node:crypto";
import pool from "../db.js";
import { hashPassword } from "../../lib/password.js";

const USERNAME = "student";
const PASSWORD = "student";
const DISPLAY_NAME = "Test Student";

async function main() {
  const password_hash = hashPassword(PASSWORD);

  // Look up an existing row by case-insensitive username (matches the
  // login path's lookup). If it exists, refresh the credentials so a
  // re-run guarantees a known-working "student / student" pair even if
  // someone rotated the password since the last seed.
  const existing = await pool.query(
    `SELECT student_id FROM intake_students
      WHERE LOWER(username) = LOWER($1) LIMIT 1`,
    [USERNAME]
  );

  if (existing.rows.length > 0) {
    const sid = existing.rows[0].student_id;
    // Re-seed wipes the student's intake answers + phase so the form
    // re-opens at the welcome screen for a clean test run. Generated
    // resumes are dropped too. Uploaded files have ON DELETE RESTRICT
    // (so a re-seed can't break referential integrity) — we mark the
    // active ones superseded so the form-side "already-uploaded" UI
    // doesn't pre-fill stale slots.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE intake_students
            SET password_hash    = $1,
                password_plain   = $2,
                is_archived      = FALSE,
                archived_at      = NULL,
                archived_reason  = NULL,
                ielts_archived_at = NULL,
                data             = '{}'::jsonb,
                intake_phase     = 'intake',
                intake_complete  = FALSE,
                updated_at       = NOW()
          WHERE student_id = $3`,
        [password_hash, PASSWORD, sid]
      );
      await client.query(
        `UPDATE intake_files SET superseded_at = NOW()
          WHERE student_id = $1 AND superseded_at IS NULL`,
        [sid]
      );
      await client.query(`DELETE FROM intake_resumes WHERE student_id = $1`, [sid]);
      await client.query(`DELETE FROM intake_insights WHERE student_id = $1`, [sid]);
      // Drop any active session cookies so the next login lands on a
      // clean welcome screen instead of resuming the old form.
      await client.query(`DELETE FROM sessions WHERE student_id = $1`, [sid]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    console.log(`[seed-student] reset existing student ${sid} (username="${USERNAME}", password="${PASSWORD}") — intake wiped, ready for a fresh run`);
    return;
  }

  const studentId = `s_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  await pool.query(
    `INSERT INTO intake_students
       (student_id, username, password_hash, password_plain, display_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [studentId, USERNAME, password_hash, PASSWORD, DISPLAY_NAME]
  );
  console.log(`[seed-student] created student ${studentId} (username="${USERNAME}", password="${PASSWORD}")`);
}

main()
  .catch((e) => {
    console.error("[seed-student] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
