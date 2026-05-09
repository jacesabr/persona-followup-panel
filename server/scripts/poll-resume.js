// One-off poller for the resume regeneration triggered manually.
// Loops every 4s on intake_resumes.id and prints status transitions
// until the row reaches a terminal state. Uses the same DATABASE_URL
// the production server reads.
//
// Usage: node server/scripts/poll-resume.js <resume_id>

import "dotenv/config";
import pg from "pg";

const id = Number(process.argv[2]);
if (!Number.isFinite(id) || id <= 0) {
  console.error("usage: node server/scripts/poll-resume.js <resume_id>");
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let last = null;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const { rows } = await pool.query(
    `SELECT status, LENGTH(content_md) AS n, error FROM intake_resumes WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) { console.error(`no resume id=${id}`); process.exit(1); }
  const r = rows[0];
  if (r.status !== last) {
    console.log(`status=${r.status} content_len=${r.n || 0} err=${(r.error || "").slice(0, 200)}`);
    last = r.status;
  }
  if (r.status === "succeeded" || r.status === "failed") break;
  await new Promise((res) => setTimeout(res, 4000));
}
await pool.end();
