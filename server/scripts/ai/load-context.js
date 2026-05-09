// Load every artifact relevant to one student into a single JSON
// blob. The Claude Code routine reads this stdout, then feeds the
// pieces into its prompt-construction logic.
//
// Usage:
//   node server/scripts/ai/load-context.js <student_id>

import "dotenv/config";
import pool from "../../db.js";

async function main() {
  const studentId = process.argv[2];
  if (!studentId) {
    console.error("Usage: load-context.js <student_id>");
    process.exit(1);
  }

  const [studentRes, filesRes, docsRes, appsRes] = await Promise.all([
    pool.query(
      `SELECT s.student_id, s.username, s.display_name,
              s.data, s.intake_phase, s.intake_complete,
              s.lead_id, s.counsellor_id, s.created_at, s.updated_at,
              s.ai_artifacts_generated_at,
              c.name AS counsellor_name
         FROM intake_students s
         LEFT JOIN counsellors c ON c.id = s.counsellor_id
        WHERE s.student_id = $1`,
      [studentId]
    ),
    pool.query(
      `SELECT id, field_id, row_index, original_name, mime_type, size,
              ai_description, ai_extracted, created_at
         FROM intake_files
        WHERE student_id = $1 AND superseded_at IS NULL
        ORDER BY id`,
      [studentId]
    ),
    pool.query(
      `SELECT id, kind, seq,
              recipient_name, recipient_role, reason_brief,
              company_name, company_website, activity_brief,
              staff_draft, marked_done_at, approved_by_admin_at,
              requested_at, deadline_at, final_file_id
         FROM intake_required_docs
        WHERE student_id = $1
        ORDER BY kind, seq`,
      [studentId]
    ),
    pool.query(
      `SELECT id, country, university, program, status, deadline,
              pending, archived, requirements, notes
         FROM intake_applications
        WHERE student_id = $1
        ORDER BY id`,
      [studentId]
    ),
  ]);

  const student = studentRes.rows[0];
  if (!student) {
    console.error(`student ${studentId} not found`);
    process.exit(1);
  }

  const data = student.data || {};
  const ctx = {
    student: {
      student_id: student.student_id,
      username: student.username,
      display_name: student.display_name,
      counsellor_name: student.counsellor_name,
      intake_phase: student.intake_phase,
      intake_complete: student.intake_complete,
      ai_artifacts_generated_at: student.ai_artifacts_generated_at,
      created_at: student.created_at,
      updated_at: student.updated_at,
    },
    answers: data.answers || {},
    files: filesRes.rows,
    required_docs: docsRes.rows,
    applications: appsRes.rows,
  };

  process.stdout.write(JSON.stringify(ctx, null, 2) + "\n");
  await pool.end();
}

main().catch((e) => {
  console.error("[load-context] FAIL:", e?.message || e);
  process.exit(1);
});
