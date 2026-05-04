import "dotenv/config";
import pool from "./db.js";

// One-shot wipe — drops every row from the data tables. Schema (managed
// by migrate.js) is left intact. Run BEFORE going live with a real
// client to clear any demo data left from trial mode:
//
//   npm run wipe
//
// Refuses to run unless ALLOW_WIPE=1 is set so a stray invocation in
// CI/dev never nukes a real prod DB. CASCADE handles the FKs:
// counsellor_tasks + lead_appointments cascade off leads, sessions
// cascade off counsellors. Intake tables: intake_resumes →
// intake_files → intake_students; intake_consents/intake_audit_log →
// standalone. RESTRICT FKs on intake_* mean we must list them all so
// CASCADE can chain.
async function main() {
  if (process.env.ALLOW_WIPE !== "1") {
    console.error(
      "[wipe] refusing — set ALLOW_WIPE=1 to confirm. This deletes ALL data."
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("[wipe] DATABASE_URL not set.");
    process.exit(1);
  }

  console.log("[wipe] target:", process.env.DATABASE_URL.replace(/:[^@/]+@/, ":***@"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // TRUNCATE … CASCADE in one shot. Order doesn't matter with CASCADE
    // but listing every table makes intent explicit.
    await client.query(
      `TRUNCATE TABLE
         intake_audit_log,
         intake_consents,
         intake_resumes,
         intake_insights,
         intake_files,
         intake_students,
         intake_examples,
         sessions,
         counsellor_tasks,
         lead_appointments,
         leads,
         counsellors
       RESTART IDENTITY CASCADE`
    );
    await client.query("COMMIT");
    console.log("[wipe] done — all data tables truncated.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[wipe] failed:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
