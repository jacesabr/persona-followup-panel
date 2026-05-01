import pool from "./db.js";

// Idempotent schema. ALTER ... IF [NOT] EXISTS / IF EXISTS lets the same
// SQL bring a fresh DB up AND advance an older DB without separate
// migration files. Drops at the bottom remove legacy tables/columns from
// the WhatsApp/email/transcript era.
const SQL = `
CREATE TABLE IF NOT EXISTS counsellors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp TEXT,
  email TEXT,
  username TEXT,
  password TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_counsellors_username ON counsellors(username) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  email TEXT,
  purpose TEXT,
  service_date TIMESTAMPTZ,
  counsellor_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL,
  counsellor_name TEXT,
  status TEXT NOT NULL DEFAULT 'unassigned',
  inquiry_date DATE DEFAULT CURRENT_DATE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_service_date ON leads(service_date);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_active ON leads(service_date) WHERE archived = FALSE;

CREATE TABLE IF NOT EXISTS lead_appointments (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_appointments_scheduled ON lead_appointments(lead_id, scheduled_for);

CREATE TABLE IF NOT EXISTS counsellor_tasks (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  student_name TEXT,
  assignee_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  due_date DATE NOT NULL,
  priority BOOLEAN NOT NULL DEFAULT FALSE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_due ON counsellor_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_lead ON counsellor_tasks(lead_id);
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_assignee ON counsellor_tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_active ON counsellor_tasks(due_date) WHERE archived = FALSE;

-- Cookie-backed sessions. user_kind 'admin' has no counsellor row;
-- 'counsellor' rows reference counsellors.id and cascade on delete.
-- Sliding 30-day expiry: middleware updates last_seen_at on each
-- authenticated request and rejects rows older than 30 days.
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_kind TEXT NOT NULL CHECK (user_kind IN ('admin', 'counsellor')),
  counsellor_id TEXT REFERENCES counsellors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);

-- One-time wipe of demo data accumulated during the trial-mode era.
-- Marker table makes this idempotent: it runs exactly once (first boot
-- after this migration ships), then the IF NOT EXISTS short-circuits
-- forever. Real client data added afterwards is safe.
DO $persona_wipe$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = '_persona_post_demo_wipe'
  ) THEN
    CREATE TABLE _persona_post_demo_wipe (done_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    TRUNCATE TABLE sessions, counsellor_tasks, lead_appointments, leads, counsellors RESTART IDENTITY CASCADE;
    INSERT INTO _persona_post_demo_wipe DEFAULT VALUES;
    RAISE NOTICE 'persona: wiped demo data (one-shot, marker inserted)';
  END IF;
END
$persona_wipe$;

-- Legacy cleanup: drop tables and columns from the WhatsApp/email/
-- transcript era. Safe on fresh DBs (IF EXISTS) and on upgraded ones.
DROP TABLE IF EXISTS lead_activity CASCADE;
DROP TABLE IF EXISTS lead_actionables CASCADE;
ALTER TABLE leads DROP COLUMN IF EXISTS transcript;
ALTER TABLE leads DROP COLUMN IF EXISTS notes;
ALTER TABLE leads DROP COLUMN IF EXISTS reminder_sent;
`;

export async function migrate() {
  await pool.query(SQL);
  console.log("[migrate] schema ready");
}
