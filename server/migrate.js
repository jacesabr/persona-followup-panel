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
-- Plaintext copy stored alongside the scrypt hash so admin (and the
-- counsellor themselves) can see the password on the panel — explicit
-- product call by the operator. Tradeoff acknowledged: anyone with admin
-- session OR DB read can see all passwords. Hash stays the source of
-- truth for login.
ALTER TABLE counsellors ADD COLUMN IF NOT EXISTS password_plain TEXT;
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
-- Optional link from a task back to the appointment it was created in.
-- ON DELETE SET NULL so deleting the appointment row doesn't cascade
-- and silently nuke the followup tasks it produced — they just lose
-- the badge.
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS appointment_id BIGINT
  REFERENCES lead_appointments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_counsellor_tasks_appointment ON counsellor_tasks(appointment_id);

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
--
-- This block runs BEFORE the intake_* tables exist (on a brand-new DB)
-- because Postgres processes statements in order. On already-migrated
-- DBs the marker short-circuits, so the FK from intake_students.counsellor_id
-- never gets evaluated against the truncate. Safe.
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
-- Plaintext counterpart to password_hash — see counsellors.password_plain
-- for the same product-call rationale + tradeoff.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS password_plain TEXT;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS lead_id        TEXT REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS counsellor_id  TEXT REFERENCES counsellors(id) ON DELETE SET NULL;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS display_name   TEXT;
-- Soft-delete + retention. is_archived is a tombstone — row stays so files
-- and FKs don't dangle, but the student can no longer log in and the staff
-- UI hides them by default. scheduled_deletion_at is honoured by an offline
-- job (not yet implemented) per DPDP retention rules.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS is_archived          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS archived_at          TIMESTAMPTZ;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS archived_reason      TEXT;
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;
-- Schema version of the JSONB intake form data this row was filled against.
-- The resume generator + admin views can branch on this when we evolve fields.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS schema_version INT NOT NULL DEFAULT 1;
-- Pipeline phase: explicit state machine for the student-facing flow.
--   'intake' — filling the general form. Uploads and the doc-derived
--              values typed from each upload (marks %, scores, passport
--              #, etc.) live on the same page, side-by-side.
--   'done'   — finished; one 300-word resume queued; lands on dashboard.
-- Replaces the prior derived-from-counts phase resolver. NULL legacy
-- rows are coerced to 'intake' on read (back-compat for pre-migration
-- accounts). The earlier 'doc_review' state has been folded into
-- 'intake'; any rows still flagged 'doc_review' are reset below so they
-- re-enter the merged flow.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS intake_phase TEXT;
UPDATE intake_students SET intake_phase = 'intake' WHERE intake_phase = 'doc_review';
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'intake_students_phase_check'
  ) THEN
    ALTER TABLE intake_students DROP CONSTRAINT intake_students_phase_check;
  END IF;
  ALTER TABLE intake_students
    ADD CONSTRAINT intake_students_phase_check
    CHECK (intake_phase IS NULL OR intake_phase IN ('intake', 'done'));
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_students_username ON intake_students(LOWER(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_students_lead       ON intake_students(lead_id);
CREATE INDEX IF NOT EXISTS idx_intake_students_counsellor ON intake_students(counsellor_id);
CREATE INDEX IF NOT EXISTS idx_intake_students_active     ON intake_students(updated_at DESC) WHERE is_archived = FALSE;

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
-- Race guard: enforce one active file per slot. COALESCE turns NULL row_index
-- into a stable -1 so two non-repeater uploads at the same field collide via
-- 23505 instead of both committing. Caller catches 23505 and retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_files_one_active
  ON intake_files(student_id, field_id, COALESCE(row_index, -1))
  WHERE superseded_at IS NULL;

-- Auto-extraction was retired in favour of manual entry on the
-- doc-review screen. Drop the table + its indexes if present so the
-- DB reflects the live code surface.
DROP TABLE IF EXISTS intake_extractions CASCADE;

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

-- ============================================================
-- intake_audit_log: append-only history of mutations on the
-- intake side. Every UPDATE/INSERT/DELETE that staff or students
-- trigger writes one row here, so "who changed this and when"
-- is answerable for any row, ever. Required for DPDP / GDPR
-- requests + parental data-access asks.
--   actor_kind: 'admin' | 'counsellor' | 'student' | 'system'
--   actor_id: counsellor_id (for counsellor) or student_id (for
--             student) or NULL for admin/system
--   target_table / target_id: what was touched
--   action: 'create' | 'update' | 'delete' | 'view' | 'login' |
--           'password_reset' | 'archive' | ...
--   diff: JSONB { before: {...}, after: {...} } where useful
-- ============================================================
CREATE TABLE IF NOT EXISTS intake_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_kind    TEXT NOT NULL,
  actor_id      TEXT,
  ip            TEXT,
  user_agent    TEXT,
  target_table  TEXT NOT NULL,
  target_id     TEXT,
  action        TEXT NOT NULL,
  diff          JSONB,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_intake_audit_target
  ON intake_audit_log(target_table, target_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_audit_actor
  ON intake_audit_log(actor_kind, actor_id, occurred_at DESC);

-- ============================================================
-- intake_consents: per-student consent records. The student (or
-- their guardian for minors) signs once per consent_type+version;
-- the row captures the legal moment for DPDP compliance. Snapshot
-- of the document text is preserved so a later policy revision
-- doesn't retroactively change what the student agreed to.
--   consent_type: 'tos' | 'privacy_dpdp' | 'service_agreement' |
--                 'data_sharing_universities' | 'parent_consent_minor' |
--                 'payment_authorization'
--   version: bumped per legal text change
--   signed_by_minor_guardian: when student is under 18 per DPDP
-- ============================================================
CREATE TABLE IF NOT EXISTS intake_consents (
  id                       BIGSERIAL PRIMARY KEY,
  student_id               TEXT NOT NULL REFERENCES intake_students(student_id) ON DELETE RESTRICT,
  consent_type             TEXT NOT NULL,
  version                  TEXT NOT NULL,
  signed_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip                       TEXT,
  user_agent               TEXT,
  signed_by_minor_guardian TEXT,
  document_snapshot        TEXT NOT NULL,
  notes                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_intake_consents_student
  ON intake_consents(student_id, consent_type, signed_at DESC);

-- Sessions: extend to allow user_kind='student' + carry student_id.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS student_id TEXT REFERENCES intake_students(student_id) ON DELETE CASCADE;
-- Absolute upper bound on session lifetime independent of sliding window.
-- requireAuth checks created_at + this cap before honouring a cookie, so a
-- leaked cookie can't survive forever just because the attacker keeps it warm.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS max_age_days INT NOT NULL DEFAULT 90;
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
