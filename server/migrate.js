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

-- ============================================================
-- STUDENT INTAKE TABLES (merged in from persona-intake repo).
-- All additive, all CREATE/ALTER … IF NOT EXISTS, all FKs
-- ON DELETE RESTRICT so nothing cascades silently. The intake
-- pipeline writes here; the admin panel reads.
-- ============================================================

CREATE TABLE IF NOT EXISTS intake_students (
  id              BIGSERIAL PRIMARY KEY,
  student_id      TEXT NOT NULL UNIQUE,
  intake_complete BOOLEAN NOT NULL DEFAULT FALSE,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_students_updated  ON intake_students(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_students_complete ON intake_students(intake_complete);

-- Per-student account credentials + provenance (lead origin + creating counsellor).
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS username       TEXT;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS password_hash  TEXT;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS lead_id        TEXT REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS counsellor_id  TEXT REFERENCES counsellors(id) ON DELETE SET NULL;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS display_name   TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_students_username ON intake_students(LOWER(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_students_lead       ON intake_students(lead_id);
CREATE INDEX IF NOT EXISTS idx_intake_students_counsellor ON intake_students(counsellor_id);

CREATE TABLE IF NOT EXISTS intake_files (
  id            BIGSERIAL PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES intake_students(student_id) ON DELETE RESTRICT,
  field_id      TEXT NOT NULL,
  row_index     INT,
  original_name TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  size          BIGINT NOT NULL,
  mime_type     TEXT NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_files_student ON intake_files(student_id);
CREATE INDEX IF NOT EXISTS idx_intake_files_active
  ON intake_files(student_id, field_id, row_index) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS intake_extractions (
  id              BIGSERIAL PRIMARY KEY,
  file_id         BIGINT NOT NULL REFERENCES intake_files(id) ON DELETE RESTRICT,
  student_id      TEXT NOT NULL REFERENCES intake_students(student_id) ON DELETE RESTRICT,
  extractor       TEXT NOT NULL,
  model           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  data            JSONB,
  confirmed_data  JSONB,
  confirmed_at    TIMESTAMPTZ,
  error           TEXT,
  cost_cents      INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_extractions_file    ON intake_extractions(file_id);
CREATE INDEX IF NOT EXISTS idx_intake_extractions_student ON intake_extractions(student_id);
CREATE INDEX IF NOT EXISTS idx_intake_extractions_status  ON intake_extractions(status);

CREATE TABLE IF NOT EXISTS intake_insights (
  id              BIGSERIAL PRIMARY KEY,
  student_id      TEXT NOT NULL REFERENCES intake_students(student_id) ON DELETE RESTRICT,
  model           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  data            JSONB,
  source_snapshot JSONB,
  cost_cents      INT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_insights_student ON intake_insights(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intake_examples (
  id              BIGSERIAL PRIMARY KEY,
  label           TEXT NOT NULL,
  length_pages    INT,
  length_words    INT,
  domain          TEXT,
  style           TEXT,
  voice_notes     TEXT,
  full_text       TEXT NOT NULL,
  source_pdf_path TEXT,
  notes           TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_examples_active
  ON intake_examples(domain, length_pages) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS intake_resumes (
  id              BIGSERIAL PRIMARY KEY,
  student_id      TEXT NOT NULL REFERENCES intake_students(student_id) ON DELETE RESTRICT,
  label           TEXT,
  length_pages    INT,
  length_words    INT,
  style           TEXT,
  domain          TEXT,
  example_ids     BIGINT[],
  insights_id     BIGINT REFERENCES intake_insights(id) ON DELETE SET NULL,
  source_snapshot JSONB,
  model           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  content_md      TEXT,
  content_html    TEXT,
  pdf_file_id     BIGINT REFERENCES intake_files(id) ON DELETE SET NULL,
  cost_cents      INT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_resumes_student ON intake_resumes(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_resumes_active  ON intake_resumes(student_id, status);

-- Sessions: extend to allow user_kind='student' + carry student_id.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS student_id TEXT REFERENCES intake_students(student_id) ON DELETE CASCADE;
DO $reauth_sessions$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_user_kind_check'
       OR (conrelid = 'sessions'::regclass AND contype = 'c')
  ) THEN
    ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_kind_check;
  END IF;
END
$reauth_sessions$;
ALTER TABLE sessions ADD CONSTRAINT sessions_user_kind_check
  CHECK (user_kind IN ('admin', 'counsellor', 'student'));
`;

export async function migrate() {
  await pool.query(SQL);
  console.log("[migrate] schema ready");
}
