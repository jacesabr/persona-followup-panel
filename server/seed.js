import pool from "./db.js";

const COUNSELLORS = [
  { id: "c1", name: "Anita Verma", whatsapp: "919811001001", email: "anita@persona.in" },
  { id: "c2", name: "Rajiv Mehta", whatsapp: "919811001002", email: "rajiv@persona.in" },
  { id: "c3", name: "Priya Singh", whatsapp: "919811001003", email: "priya@persona.in" },
  { id: "c4", name: "Amit Kapoor", whatsapp: "919811001004", email: "amit@persona.in" },
  { id: "c5", name: "Neha Sharma", whatsapp: "919811001005", email: "neha@persona.in" },
];

// Seed dates are computed relative to whenever the server first seeds, so
// the demo always shows leads with sensible relative timing (some upcoming,
// some recent past) regardless of when the env was provisioned.
function relDate(daysFromNow, hoursIst = 10) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  // Anchor in IST for readability (counsellors are in India). Convert to
  // an explicit +05:30 ISO so Postgres TIMESTAMPTZ stores the correct UTC.
  const pad = (n) => String(n).padStart(2, "0");
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${datePart}T${pad(hoursIst)}:00:00+05:30`;
}
function relInquiry(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Sample appointment history for the demo leads. Mix of past + upcoming,
// with some past notes filled in and one left empty to demo the
// "fill in details after the session" workflow. The upcoming row matches
// each lead's service_date so the calendar's green tile maps to a real
// row (instead of the synthetic fallback that legacy data uses).
const APPOINTMENTS = [
  // Simran Bhatia — STK aptitude test prep journey
  {
    lead_id: "L001",
    days_offset: -14,
    hour: 10,
    notes:
      "Initial assessment. Strong analytical skills, weaker on verbal reasoning. Target: 720+ on STK. Sent practice set 1 by email.",
  },
  {
    lead_id: "L001",
    days_offset: -7,
    hour: 10,
    notes: null, // session happened, counsellor hasn't logged it yet
  },
  {
    lead_id: "L001",
    days_offset: 7,
    hour: 10,
    notes: null, // upcoming, matches existing service_date
  },
  // Aarav Khanna — career counselling
  {
    lead_id: "L002",
    days_offset: -10,
    hour: 15,
    notes:
      "Career interest survey results. Top three: Economics, CS, Public Policy. Walked through pros and cons of each track for someone with strong math + writing.",
  },
  {
    lead_id: "L002",
    days_offset: 2,
    hour: 15,
    notes: null, // upcoming, matches existing service_date
  },
];

const LEADS = [
  {
    id: "L001", name: "Simran Bhatia", contact: "919811001711", email: "simran.bhatia@example.com",
    purpose: "STK aptitude test", service_date: relDate(7, 10),
    counsellor_id: "c1", status: "scheduled", inquiry_date: relInquiry(7),
    notes: "Class 12 student, parents called first. Specifically asked for aptitude testing.",
  },
  {
    id: "L002", name: "Aarav Khanna", contact: "919811002831", email: "aarav.k@example.com",
    purpose: "Career counselling session", service_date: relDate(2, 15),
    counsellor_id: "c2", status: "scheduled", inquiry_date: relInquiry(5),
    notes: "Heard about us from a friend. Confused between engineering and economics tracks.",
  },
  {
    id: "L003", name: "Pooja Malhotra", contact: "919811003942", email: "pooja.m@example.com",
    purpose: "SOP review", service_date: relDate(1, 11),
    counsellor_id: "c3", status: "scheduled", inquiry_date: relInquiry(8),
    notes: "Already has SOP draft for Cornell. Wants a 1-hour review session.",
  },
  {
    id: "L004", name: "Vivaan Sethi", contact: "919811004102", email: "vivaan.sethi@example.com",
    purpose: "University shortlisting", service_date: relDate(4, 16),
    counsellor_id: null, status: "unassigned", inquiry_date: relInquiry(4),
    notes: "Class 11, just exploring. Parents not yet involved.",
  },
];

// Idempotent — runs every startup. Ensures the "Jace (test)" counsellor
// exists so the Fill-test-data button on the form has a valid target.
export async function ensureTestCounsellor() {
  await pool.query(
    `INSERT INTO counsellors (id, name, whatsapp, email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, whatsapp = EXCLUDED.whatsapp, email = EXCLUDED.email`,
    ["ctest", "Jace (test)", "917973744625", "jace100233260@gmail.com"]
  );
}

export async function seedLeads() {
  for (const l of LEADS) {
    await pool.query(
      `INSERT INTO leads (id, name, contact, email, purpose, service_date, counsellor_id, status, inquiry_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [l.id, l.name, l.contact, l.email, l.purpose, l.service_date, l.counsellor_id, l.status, l.inquiry_date, l.notes]
    );
    await pool.query(
      "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
      [l.id, "inquiry", "Initial inquiry received."]
    );
    if (l.counsellor_id) {
      const counsellor = COUNSELLORS.find((c) => c.id === l.counsellor_id);
      await pool.query(
        "INSERT INTO lead_activity (lead_id, type, text) VALUES ($1, $2, $3)",
        [l.id, "assignment", `Assigned to ${counsellor.name}.`]
      );
    }
  }

  // Sample appointment history. Inserted unconditionally on seed (deletes
  // cascade from leads, so a reset wipes these too).
  for (const a of APPOINTMENTS) {
    await pool.query(
      "INSERT INTO lead_appointments (lead_id, scheduled_for, notes) VALUES ($1, $2, $3)",
      [a.lead_id, relDate(a.days_offset, a.hour), a.notes]
    );
  }
}

// Backfill appointments for an existing DB that already has the seed leads
// but no lead_appointments rows (the table was added in a later migration).
// Idempotent — skips when any appointment row already exists, so it's safe
// to call on every startup.
export async function seedAppointmentsIfEmpty() {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM lead_appointments"
  );
  if (rows[0].n > 0) {
    console.log("[seed] appointments exist, skipping");
    return;
  }
  // Only seed appointments for leads that actually exist (the seed leads
  // may have been deleted via reset; only backfill what's there).
  const { rows: existing } = await pool.query(
    "SELECT id FROM leads WHERE id = ANY($1)",
    [APPOINTMENTS.map((a) => a.lead_id)]
  );
  const existingIds = new Set(existing.map((r) => r.id));
  let inserted = 0;
  for (const a of APPOINTMENTS) {
    if (!existingIds.has(a.lead_id)) continue;
    await pool.query(
      "INSERT INTO lead_appointments (lead_id, scheduled_for, notes) VALUES ($1, $2, $3)",
      [a.lead_id, relDate(a.days_offset, a.hour), a.notes]
    );
    inserted++;
  }
  if (inserted > 0) console.log(`[seed] inserted ${inserted} sample appointments`);
}

export async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM counsellors");
  if (rows[0].n > 0) {
    console.log("[seed] data exists, skipping");
    return;
  }

  for (const c of COUNSELLORS) {
    await pool.query(
      "INSERT INTO counsellors (id, name, whatsapp, email) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
      [c.id, c.name, c.whatsapp, c.email]
    );
  }

  await seedLeads();

  console.log("[seed] inserted counsellors and leads");
}
