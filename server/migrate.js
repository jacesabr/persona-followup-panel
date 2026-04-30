import pool from "./db.js";

const SQL = `
CREATE TABLE IF NOT EXISTS counsellors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp TEXT,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  email TEXT,
  purpose TEXT,
  service_date TIMESTAMPTZ,
  counsellor_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'unassigned',
  inquiry_date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  reminder_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_activity (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  channel TEXT,
  recipient TEXT,
  kind TEXT,
  text TEXT,
  ts TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_service_date ON leads(service_date);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_lead_activity_lead_id ON lead_activity(lead_id);

-- Twilio status callback support: provider_sid links our row to Twilio's
-- Message SID so the webhook can update the same row over its lifecycle.
ALTER TABLE lead_activity ADD COLUMN IF NOT EXISTS provider_sid TEXT;
ALTER TABLE lead_activity ADD COLUMN IF NOT EXISTS error_code TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_activity_provider_sid ON lead_activity(provider_sid);

-- Staff workflow: full transcript captured per lead (latest wins) and a
-- separate table of actionables so each row can be ticked / annotated
-- independently. lead_activity continues to capture the *when* (viewed,
-- call_logged, transcript_attached); these store the *what*.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS transcript TEXT;

CREATE TABLE IF NOT EXISTS lead_actionables (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  completed_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_actionables_lead_id ON lead_actionables(lead_id);

-- Archive support: admin-only soft-delete. Archived rows stay in the DB
-- (so the activity log + actionables remain readable) but disappear from the
-- main admin table behind a collapsed "Archived" section. Counsellors don't
-- see archived leads in their staff dashboard.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
-- Partial index: active queries scan only non-archived rows, which is the
-- 99% case once the archive grows. Bool indexes are fine but the partial
-- form keeps the index small even with thousands of archived leads.
CREATE INDEX IF NOT EXISTS idx_leads_active ON leads(service_date) WHERE archived = FALSE;

-- Free-text counsellor name for the simple panel. The simple flow lets
-- counsellors type any name without needing a row in the counsellors
-- table (no whatsapp/email required). Display falls back: counsellor_id
-- (FK lookup) wins when set, otherwise counsellor_name renders as-is.
-- Admin/staff flows still use counsellor_id for notification routing.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS counsellor_name TEXT;

-- Per-lead appointment history. Each row is one scheduled meeting; the
-- simple panel inserts here on every reschedule so the calendar can render
-- past dates (yellow) and the upcoming one (green) without losing context.
-- leads.service_date stays as the denormalized "current upcoming" so the
-- cron reminder + admin/staff legacy code keep working unchanged.
CREATE TABLE IF NOT EXISTS lead_appointments (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Composite index covers both (lead_id) and (lead_id, scheduled_for) lookups
-- since lead_id is the leftmost column. No separate lead_id-only index needed.
CREATE INDEX IF NOT EXISTS idx_lead_appointments_scheduled ON lead_appointments(lead_id, scheduled_for);

-- Counsellor task list — separate from per-lead actionables. The simple
-- panel shows a flat list of "tasks for students" grouped or sorted by
-- due date / student. priority=TRUE pins a task to the top regardless of
-- date so urgent items can jump the queue without rewriting their date.
CREATE TABLE IF NOT EXISTS counsellor_tasks (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  due_date DATE NOT NULL,
  priority BOOLEAN NOT NULL DEFAULT FALSE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_due ON counsellor_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_lead ON counsellor_tasks(lead_id);

-- Tasks support the same soft-delete pattern as leads: archived rows stay
-- in the DB (so history is recoverable) but disappear from the main list
-- behind a collapsed "Archived" section.
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_active ON counsellor_tasks(due_date) WHERE archived = FALSE;

-- Free-text student name for tasks created via the simple panel where the
-- counsellor types a name without picking from an existing lead. Mirrors
-- the leads.counsellor_name pattern: lead_id (FK) wins for display when
-- set, otherwise student_name renders as-is. lead_id therefore must be
-- nullable for these free-text tasks.
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS student_name TEXT;
ALTER TABLE counsellor_tasks ALTER COLUMN lead_id DROP NOT NULL;

-- Per-counsellor login credentials (trial-mode plaintext; not for real
-- production deployment). UNIQUE username so logins resolve unambiguously.
-- Both columns nullable during migration so existing rows survive; the
-- seed backfills them with id-based defaults (c1/c1, c2/c2, ...) before
-- the login flow goes live.
ALTER TABLE counsellors ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE counsellors ADD COLUMN IF NOT EXISTS password TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_counsellors_username ON counsellors(username) WHERE username IS NOT NULL;

-- Task assignee — who's responsible for doing the task. Independent from
-- the lead's counsellor (admin can assign Pooja-related tasks to either
-- counsellor X or Y). ON DELETE SET NULL so deleting a counsellor leaves
-- their tasks orphaned (visible as "unassigned") rather than vanishing.
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS assignee_id TEXT
  REFERENCES counsellors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_assignee ON counsellor_tasks(assignee_id);

-- Backfill assignee_id from the linked lead's counsellor_id so existing
-- seed tasks have an assignee out of the box.
UPDATE counsellor_tasks t
SET assignee_id = l.counsellor_id
FROM leads l
WHERE t.lead_id = l.id
  AND t.assignee_id IS NULL
  AND l.counsellor_id IS NOT NULL;
`;

export async function migrate() {
  await pool.query(SQL);
  console.log("[migrate] schema ready");
}
