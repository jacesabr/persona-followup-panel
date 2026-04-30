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
// Returns a YYYY-MM-DD string offset from today (DATE column, no time).
function relYmd(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Sample appointment history. Each lead gets a multi-session arc: a couple
// of detailed past sessions (notes filled in), a couple of past sessions
// with empty notes (so the "Session Missed: No Session Notes Created"
// warning has somewhere to render), and one upcoming row matching the
// lead's service_date.
const APPOINTMENTS = [
  // ── Simran Bhatia (L001) — STK aptitude test prep journey ────────────
  { lead_id: "L001", days_offset: -28, hour: 10,
    notes: "Intake call with parents. Class 12 board exams in March; aptitude test target window: late February. Recommended weekly cadence." },
  { lead_id: "L001", days_offset: -21, hour: 10,
    notes: "Diagnostic assessment. 690 baseline. Strongest: data analysis + math. Weakest: verbal reasoning passages. Sent practice set 1." },
  { lead_id: "L001", days_offset: -14, hour: 10,
    notes: "Reviewed practice set 1 — improved to 715. Walked through 4 types of inference questions. Homework: 50 verbal questions per day." },
  { lead_id: "L001", days_offset: -7, hour: 10,
    notes: null }, // empty — counsellor forgot to log
  { lead_id: "L001", days_offset: -3, hour: 10,
    notes: null }, // empty — recent session, notes pending
  { lead_id: "L001", days_offset: 7, hour: 10,
    notes: null }, // upcoming, matches existing service_date

  // ── Aarav Khanna (L002) — career counselling ────────────────────────
  { lead_id: "L002", days_offset: -25, hour: 15,
    notes: "First counselling session. Confused between engineering and economics. Parents lean engineering; student lean policy/economics. Suggested values exercise before next session." },
  { lead_id: "L002", days_offset: -18, hour: 15,
    notes: "Values exercise debrief. Top values: autonomy, intellectual rigor, social impact. Recommended exploring economics + public policy programs." },
  { lead_id: "L002", days_offset: -11, hour: 15,
    notes: "Career interest survey results. Top three: Economics, CS, Public Policy. Walked through pros/cons of each track for someone with strong math + writing." },
  { lead_id: "L002", days_offset: -4, hour: 15,
    notes: null }, // empty
  { lead_id: "L002", days_offset: 2, hour: 15,
    notes: null }, // upcoming

  // ── Pooja Malhotra (L003) — SOP review for Cornell ───────────────────
  { lead_id: "L003", days_offset: -20, hour: 11,
    notes: "Initial SOP review for Cornell MEng. Thesis is buried in paragraph 3 — needs to lead with it. Discussed faculty fit: Lipson, Davis, Sengupta." },
  { lead_id: "L003", days_offset: -13, hour: 11,
    notes: "Second draft review. Strong opening now, but the projects section reads as a resume dump. Suggested narrative arc framed around one defining project." },
  { lead_id: "L003", days_offset: -6, hour: 11,
    notes: null }, // empty — past, no notes
  { lead_id: "L003", days_offset: 1, hour: 11,
    notes: null }, // upcoming

  // ── Vivaan Sethi (L004) — university shortlisting ────────────────────
  { lead_id: "L004", days_offset: -15, hour: 16,
    notes: "Family discovery call. Class 11, exploring. Parents want STEM; student curious about design + engineering hybrids. Suggested looking at programs like Olin and IIT Madras IDDD." },
  { lead_id: "L004", days_offset: -8, hour: 16,
    notes: null }, // empty
  { lead_id: "L004", days_offset: -2, hour: 16,
    notes: "Walked through five candidate schools. Student liked Olin and Manipal IIIT. Sent comparison sheet by email; will revisit after parents review." },
  { lead_id: "L004", days_offset: 4, hour: 16,
    notes: null }, // upcoming
];

// Sample counsellor tasks across the seed leads. Mix of dates spanning
// past-due (overdue), today, this week, and a couple priority-pinned
// items so the priority toggle has visible effect out of the box.
const TASKS = [
  { lead_id: "L001", days_offset: -2, text: "Send STK practice set 2 by email", priority: false },
  { lead_id: "L001", days_offset: 1,  text: "Mock test review call",             priority: true  },
  { lead_id: "L002", days_offset: 0,  text: "Share Economics vs CS comparison doc", priority: false },
  { lead_id: "L002", days_offset: 4,  text: "Confirm parents' availability for next session", priority: false },
  { lead_id: "L003", days_offset: -1, text: "Mark up SOP draft, return with comments", priority: true  },
  { lead_id: "L003", days_offset: 3,  text: "Compile Cornell faculty interest list", priority: false },
  { lead_id: "L004", days_offset: 5,  text: "Send university shortlist questionnaire", priority: false },
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

  // Sample counsellor tasks. Same cascade story.
  for (const t of TASKS) {
    await pool.query(
      "INSERT INTO counsellor_tasks (lead_id, text, due_date, priority) VALUES ($1, $2, $3, $4)",
      [t.lead_id, t.text, relYmd(t.days_offset), t.priority]
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

// Generic 4-session arc applied to any active lead that has zero
// appointment rows. Mix of past-with-notes, a missed past, and one
// upcoming so the History popup, calendar tile colors, and the
// "Session Missed" warning all have something to render even for leads
// the user creates manually.
//
// NOTE: this is demo behavior. Before going to real production, remove
// the call site in server/index.js (or gate it behind an env flag) so
// new real leads don't auto-grow a fake history.
const GENERIC_HISTORY = [
  {
    days_offset: -30,
    hour: 11,
    notes:
      "Initial consultation. Walked through goals, expectations, and timeline. Sent the intro packet by email; student to read before next session.",
  },
  {
    days_offset: -14,
    hour: 11,
    notes: null, // missed — counsellor didn't log notes
  },
  {
    days_offset: -7,
    hour: 11,
    notes:
      "Follow-up session. Reviewed progress against the milestones we set, refined the next two weeks of action items, and clarified one open question on application strategy.",
  },
  { days_offset: 5, hour: 11, notes: null }, // upcoming
];

// Idempotent per-lead: fills only leads with exactly zero appointments,
// so it never duplicates and never runs against a lead that already has
// real or earlier-seeded history.
export async function backfillLeadsWithDemoHistory() {
  const { rows } = await pool.query(`
    SELECT l.id, l.service_date FROM leads l
    LEFT JOIN lead_appointments a ON a.lead_id = l.id
    WHERE l.archived = FALSE
    GROUP BY l.id, l.service_date
    HAVING COUNT(a.id) = 0
  `);
  if (rows.length === 0) return;

  let inserted = 0;
  for (const lead of rows) {
    for (const a of GENERIC_HISTORY) {
      await pool.query(
        "INSERT INTO lead_appointments (lead_id, scheduled_for, notes) VALUES ($1, $2, $3)",
        [lead.id, relDate(a.days_offset, a.hour), a.notes]
      );
      inserted++;
    }
    // If the lead doesn't yet have an upcoming meeting on the sheet,
    // mirror the generic future appt onto leads.service_date so the
    // "Next follow" cell + green calendar tile both light up.
    if (!lead.service_date) {
      const futureAppt = GENERIC_HISTORY.find((a) => a.days_offset > 0);
      if (futureAppt) {
        await pool.query(
          `UPDATE leads
           SET service_date = $2, reminder_sent = FALSE, updated_at = NOW()
           WHERE id = $1`,
          [lead.id, relDate(futureAppt.days_offset, futureAppt.hour)]
        );
      }
    }
  }
  console.log(
    `[seed] backfilled ${inserted} demo appointments across ${rows.length} leads`
  );
}

// Same idempotent backfill story for counsellor_tasks — added in a later
// migration than the leads table, so existing DBs need a one-time seed.
export async function seedTasksIfEmpty() {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM counsellor_tasks"
  );
  if (rows[0].n > 0) {
    console.log("[seed] tasks exist, skipping");
    return;
  }
  const { rows: existing } = await pool.query(
    "SELECT id FROM leads WHERE id = ANY($1)",
    [TASKS.map((t) => t.lead_id)]
  );
  const existingIds = new Set(existing.map((r) => r.id));
  let inserted = 0;
  for (const t of TASKS) {
    if (!existingIds.has(t.lead_id)) continue;
    await pool.query(
      "INSERT INTO counsellor_tasks (lead_id, text, due_date, priority) VALUES ($1, $2, $3, $4)",
      [t.lead_id, t.text, relYmd(t.days_offset), t.priority]
    );
    inserted++;
  }
  if (inserted > 0) console.log(`[seed] inserted ${inserted} sample tasks`);
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
