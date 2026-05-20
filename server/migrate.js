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
  password_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotent rename: pre-migration deploys created the column as
-- 'password', which mis-implied plaintext. Match intake_students's
-- naming so the schema reads consistently. Renames only when the old
-- column exists AND the new one doesn't (re-runs are no-ops).
DO $rename_counsellors_password$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='counsellors' AND column_name='password')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='counsellors' AND column_name='password_hash') THEN
    ALTER TABLE counsellors RENAME COLUMN password TO password_hash;
  END IF;
END $rename_counsellors_password$;
-- password_plain was a plaintext copy of the scrypt hash for in-panel
-- support recovery. Removed 2026-05-13 — security tradeoff was reversed.
-- Newly created / reset counsellor passwords are returned in the create /
-- reset API response once and shown in CredentialsModal; the panel
-- no longer surfaces them after the first read. Drop the column so the
-- DB stops carrying plaintext copies.
ALTER TABLE counsellors DROP COLUMN IF EXISTS password_plain;
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

-- Flag for appointment rows created via the always-on "Session" button
-- when no calendar-booked appointment was active. Ad-hoc rows are
-- excluded from the lead.service_date recompute and from the
-- next_appointment_* fields surfaced to the followup table — so a
-- "pre-appointment quick call" note never masquerades as the official
-- next session. The HistoryPopup uses this flag to render a red
-- "pre-appointment quick call" / "post-appointment follow-up" banner
-- on the row.
ALTER TABLE lead_appointments ADD COLUMN IF NOT EXISTS ad_hoc BOOLEAN NOT NULL DEFAULT FALSE;

-- Free-form comments on a task. Counsellors use these to add notes
-- without modifying the task itself (only admin can edit task text /
-- due date). Append-only by design — no edit/delete route — so the
-- thread stays an honest record of what was said when. CASCADE on
-- task delete: comments are inseparable from their parent task.
-- author_counsellor_id is nullable so admin authorship (no counsellor
-- row) is representable; author_kind disambiguates.
CREATE TABLE IF NOT EXISTS task_comments (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES counsellor_tasks(id) ON DELETE CASCADE,
  author_counsellor_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('admin', 'counsellor')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);

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

-- The previous demo-wipe TRUNCATE block has been removed. It was a
-- one-shot guarded by the _persona_post_demo_wipe marker table; the
-- marker now exists in every active prod DB so the block was already
-- inert. Removing it eliminates the foot-gun where someone dropping
-- the marker would silently nuke prod (sessions / tasks / appointments
-- / leads / counsellors) on the next deploy boot. The marker table
-- itself is left in place as archaeology — small, harmless.

-- Legacy cleanup: drop tables and columns from the WhatsApp/email/
-- transcript era. Safe on fresh DBs (IF EXISTS) and on upgraded ones.
DROP TABLE IF EXISTS lead_activity CASCADE;
DROP TABLE IF EXISTS lead_actionables CASCADE;
ALTER TABLE leads DROP COLUMN IF EXISTS transcript;
ALTER TABLE leads DROP COLUMN IF EXISTS notes;
ALTER TABLE leads DROP COLUMN IF EXISTS reminder_sent;
-- counsellor_name was a denormalised cache from the early schema;
-- the followup table now reads counsellor_id and joins. Dead data on
-- existing rows leaks if anyone ever exports the table directly.
ALTER TABLE leads DROP COLUMN IF EXISTS counsellor_name;
-- Redundant with idx_lead_appointments_scheduled (which is a
-- (lead_id, scheduled_for) composite — leftmost-prefix already
-- covers lead_id-only queries). Eats write amplification on every
-- appointment insert without any read benefit.
DROP INDEX IF EXISTS idx_lead_appointments_lead_id;

-- Followup date + notes: counsellor-set "next check-in" separate from
-- the formal appointment calendar. Stored directly on the lead row so
-- the followup table can surface it without a subquery.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_date TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_notes TEXT;

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
-- password_plain was a plaintext copy of the scrypt hash for in-panel
-- support recovery (same shape as counsellors.password_plain above).
-- Removed 2026-05-13; see that block for the migration rationale.
ALTER TABLE intake_students DROP COLUMN IF EXISTS password_plain;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS student_class TEXT;
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
-- Per-student "hide from the IELTS tracking panel" flag. Independent
-- from is_archived (which retires the whole student). Set when staff
-- finishes tracking IELTS for a student (they've taken the exam and
-- the score is logged, or they've decided not to take it). The IELTS
-- panel uses this to move the row into its collapsed "Archived" section
-- — same UX as the lead-sheet's archive flow.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS ielts_archived_at TIMESTAMPTZ;
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
-- Add the phase CHECK only when missing. Earlier this block dropped
-- and re-added on every boot, which rewrites pg_constraint pointlessly
-- and shows up in deploy logs as noise.
DO $intake_phase_check$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'intake_students_phase_check'
  ) THEN
    ALTER TABLE intake_students
      ADD CONSTRAINT intake_students_phase_check
      CHECK (intake_phase IS NULL OR intake_phase IN ('intake', 'done'));
  END IF;
END $intake_phase_check$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_students_username ON intake_students(LOWER(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_students_lead       ON intake_students(lead_id);
CREATE INDEX IF NOT EXISTS idx_intake_students_counsellor ON intake_students(counsellor_id);
CREATE INDEX IF NOT EXISTS idx_intake_students_active     ON intake_students(updated_at DESC) WHERE is_archived = FALSE;
-- Marker for the AI artifacts pipeline (manual_opus_generate.md). NULL
-- means "this student has never been processed"; the scheduled
-- Claude Code routine picks up NULL rows every 4 hours, generates
-- resume / SOP draft / LOR & internship drafts / per-file
-- descriptions / autofilled answers, and stamps NOW() when done.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS ai_artifacts_generated_at TIMESTAMPTZ;
-- Free-form notes from the most recent dispatch run. Holds the
-- Names-needed alert (counsellor must collect these teacher / mentor
-- names from the student before LORs can be sent) plus any other
-- run-level observations the agent surfaces in summary_notes. Read by
-- the AI Queue panel so the alert is visible to staff without them
-- having to hand-query the audit log.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS last_dispatch_summary TEXT;
-- Bulk-upload-at-signup flag. When a counsellor signs a student up via
-- the "starter documents" multi-upload, the row lands with
-- intake_phase='intake' (the student still needs to log in and finish
-- the form themselves) BUT with this flag = TRUE so the AI pipeline
-- treats them like a 'done'-phase row — descriptions, autofilled
-- answers, resume, SOP, LOR drafts all run on the next hourly tick.
-- Default FALSE means the standard intake flow is unchanged.
ALTER TABLE intake_students ADD COLUMN IF NOT EXISTS ai_eligible_via_pre_upload BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_intake_students_ai_pending
  ON intake_students(updated_at DESC)
  WHERE ai_artifacts_generated_at IS NULL AND is_archived = FALSE AND intake_phase = 'done';
-- Companion partial index for the pre-upload-eligible cohort. The
-- list-pending query unions the two so a single hourly tick covers
-- both done-phase and pre-upload students.
CREATE INDEX IF NOT EXISTS idx_intake_students_ai_pending_pre_upload
  ON intake_students(updated_at DESC)
  WHERE ai_artifacts_generated_at IS NULL AND is_archived = FALSE AND ai_eligible_via_pre_upload = TRUE;

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

-- AI-generated description + extracted fields per uploaded file. The
-- Claude Code routine reads each active file, writes a 2-3 sentence
-- description ("This is a 10th grade marksheet from CBSE board…")
-- into ai_description, and any structured key-values it can lift
-- (Aadhar number, marks %, passport expiry, etc.) into ai_extracted.
-- Both stay NULL on legacy rows + on rows the routine hasn't reached
-- yet. ai_extracted feeds the autofill pass that backfills empty
-- intake answers.
ALTER TABLE intake_files ADD COLUMN IF NOT EXISTS ai_description TEXT;
ALTER TABLE intake_files ADD COLUMN IF NOT EXISTS ai_extracted JSONB;

-- ============================================================
-- manual_ai_requests: counsellor-triggered "please run AI fill on
-- this student" queue. The AI pipeline routine
-- (trig_01BTTjNjGDpdGyywLqBTtk1a) runs manually instead of on a cron
-- — when a counsellor signs up a new student and uploads docs, they
-- click "Request manual fill" which inserts a row here. The dev
-- (Jace) sees the queue on the admin panel + via email, opens
-- claude.ai/code/routines/<id> and clicks Run. That run picks up
-- candidates whose ai_artifacts_generated_at is NULL, including
-- this student.
--
-- Lifecycle:
--   pending  → row inserted, processed_at NULL
--   resolved → processed_at set + processed_by_admin_username +
--              resolved_resume_id (the intake_resumes.id created)
--
-- One row per (student, requested_at) — no UNIQUE on student because
-- the same student might legitimately need multiple re-fills (data
-- updated, want a re-run). The pending queue collapses by student
-- on the read side.
-- ============================================================
CREATE TABLE IF NOT EXISTS manual_ai_requests (
  id                BIGSERIAL PRIMARY KEY,
  student_id        TEXT NOT NULL REFERENCES intake_students(student_id) ON DELETE CASCADE,
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('admin', 'counsellor')),
  requested_by_id   TEXT,
  requested_by_admin_username TEXT,
  notes             TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,
  processed_by_admin_username TEXT
);
-- (FK to intake_resumes added below, after intake_resumes is created
-- — keeping the ALTER co-located here would fail on a fresh DB
-- bootstrap because intake_resumes isn't declared until further down.)
-- "Redraft existing artifacts" flag. Set TRUE when a counsellor /
-- admin files a request specifically to overwrite already-written
-- staff_drafts (e.g. "use Mr. Sharma as the Class XII Maths teacher,
-- redraft the LOR"). When the dispatch endpoint runs for a student
-- whose most-recent pending request has force_redraft=TRUE, every
-- setDraft call uses force=true so empty-only protections don't
-- silently skip the new drafts. notes carries the human reason.
ALTER TABLE manual_ai_requests ADD COLUMN IF NOT EXISTS force_redraft BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_manual_ai_requests_pending
  ON manual_ai_requests(requested_at DESC) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_manual_ai_requests_student
  ON manual_ai_requests(student_id, requested_at DESC);

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
-- Structured resume payload. The original content_md path is preserved
-- for older rows; new resumes write content_json instead and the
-- frontend's <ResumeTemplate> renders it as a designed single-column
-- layout. Schema is documented in lib/resumeSchema.js — see that file
-- for field-by-field semantics. Legacy rows (content_md only) keep
-- rendering through the markdown path until they're regenerated.
ALTER TABLE intake_resumes ADD COLUMN IF NOT EXISTS content_json JSONB;
CREATE INDEX IF NOT EXISTS idx_intake_resumes_student ON intake_resumes(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_resumes_active  ON intake_resumes(student_id, status);

-- Deferred FK from manual_ai_requests.resolved_resume_id → intake_resumes(id).
-- Declared down here (rather than next to the table itself) because
-- intake_resumes doesn't exist when manual_ai_requests is created.
-- ON DELETE SET NULL so deleting the resume (rare, manual) doesn't
-- break the request history. ADD COLUMN IF NOT EXISTS is idempotent
-- — re-runs skip the column and its inline constraint entirely.
ALTER TABLE manual_ai_requests ADD COLUMN IF NOT EXISTS resolved_resume_id BIGINT
  REFERENCES intake_resumes(id) ON DELETE SET NULL;

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

-- ============================================================
-- intake_applications: per-(student × school) application tracking.
-- One row = one student applying to one university for one program.
-- Statuses mirror the colour codes in the operator's master sheet
-- ('Persona Discover Dashboard') so an xlsx import maps cleanly.
--
-- Lifecycle:
--   pending=true  → student-selected during intake, awaiting counsellor
--                   review before entering the active workflow.
--   pending=false → in the active workflow; counsellors edit status.
--   archived=true → soft-removed from the active table; readable in a
--                   collapsed "Archived" section.
--
-- The status text is free-form on the wire but the UI offers the six
-- canonical values below; new strings are accepted (forward-compat for
-- statuses we discover later).
-- ============================================================
-- student_id is OPTIONAL: while the firm transitions from the legacy
-- xlsx, counsellors create applications for students who don't yet have
-- an intake account. student_name carries the free-text label in that
-- case; when student_id is set, student_name is either NULL or a cached
-- display name. A row MUST have one or the other (CHECK below).
CREATE TABLE IF NOT EXISTS intake_applications (
  id           BIGSERIAL PRIMARY KEY,
  student_id   TEXT REFERENCES intake_students(student_id) ON DELETE CASCADE,
  student_name TEXT,
  country      TEXT,
  university   TEXT NOT NULL,
  program      TEXT,
  deadline     DATE,
  requirements TEXT,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  pending      BOOLEAN NOT NULL DEFAULT FALSE,
  archived     BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Carry-forward for any earlier deploy that ran the prior NOT NULL
-- definition. Idempotent on a fresh DB.
ALTER TABLE intake_applications ALTER COLUMN student_id DROP NOT NULL;
ALTER TABLE intake_applications ADD COLUMN IF NOT EXISTS student_name TEXT;
DO $apps_identity_check$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'intake_applications_identity_check'
  ) THEN
    ALTER TABLE intake_applications
      ADD CONSTRAINT intake_applications_identity_check
      CHECK (student_id IS NOT NULL OR (student_name IS NOT NULL AND length(trim(student_name)) > 0));
  END IF;
END $apps_identity_check$;
CREATE INDEX IF NOT EXISTS idx_intake_applications_student
  ON intake_applications(student_id);
CREATE INDEX IF NOT EXISTS idx_intake_applications_active
  ON intake_applications(student_id, status)
  WHERE archived = FALSE AND pending = FALSE;
CREATE INDEX IF NOT EXISTS idx_intake_applications_pending
  ON intake_applications(created_at DESC)
  WHERE pending = TRUE AND archived = FALSE;

-- Dedup index for the xlsx import path. Originally written with
-- WHERE student_id IS NULL only — which silently dropped legitimate
-- re-applications: a student who'd cancelled an old UCL CS application
-- and was re-applying this cycle would have their new (active) row
-- skipped by ON CONFLICT DO NOTHING. The fix: only enforce uniqueness
-- among NON-archived rows, so an archived "old try" leaves the slot
-- free for the new active one. The xlsx import script now also marks
-- status='cancelled' rows as archived=TRUE on insert so this works
-- end-to-end on re-runs.
DROP INDEX IF EXISTS uq_app_name_uni_prog;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_name_uni_prog
  ON intake_applications (
    LOWER(TRIM(student_name)),
    LOWER(TRIM(university)),
    COALESCE(LOWER(TRIM(program)), '')
  )
  WHERE student_id IS NULL AND archived = FALSE;

-- ============================================================
-- intake_required_docs: per-student LOR / Internship / SOP items.
-- One row per item. Replaces the legacy lor1/lor2/internship*/sop
-- file fields on intake_students.data.answers.
--
-- Lifecycle (LOR / Internship):
--   1. Student submits brief during intake → row created with the
--      brief fields filled, staff_draft empty.
--   2. Counsellor or admin writes staff_draft, then sets
--      marked_done_at to flag it ready.
--   3. Bulk "Send requests" flips requested_at + deadline_at on every
--      row whose marked_done_at is set and requested_at is null.
--      Deadline = +5 weekdays (Sat/Sun skipped, no holiday calendar).
--   4. Student uploads stamped final to intake_files; final_file_id
--      points at the upload row.
--
-- SOP (kind='sop'):
--   - Auto-created with seq=1 on the first staff visit (or on intake
--     completion — whichever comes first; see server/routes/students.js).
--   - Student puts nothing in. Staff writes staff_draft. Admin
--     approves via approved_by_admin_at. No requested_at, no upload.
--
-- Word-count caps on reason_brief (20) and activity_brief (30) are
-- enforced both in the schema-driven UI and in lib/intakeSchema.js's
-- validateIntakeRequired (server-side defence in depth).
-- ============================================================
CREATE TABLE IF NOT EXISTS intake_required_docs (
  id                     BIGSERIAL PRIMARY KEY,
  student_id             TEXT NOT NULL REFERENCES intake_students(student_id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL CHECK (kind IN ('lor', 'internship', 'sop')),
  seq                    INT  NOT NULL DEFAULT 1,
  -- LOR fields
  recipient_name         TEXT,
  recipient_role         TEXT,
  reason_brief           TEXT,
  -- Internship fields
  company_name           TEXT,
  company_website        TEXT,
  activity_brief         TEXT,
  -- Staff side
  staff_draft            TEXT,
  marked_done_at         TIMESTAMPTZ,
  approved_by_admin_at   TIMESTAMPTZ,
  -- Send-request lifecycle
  requested_at           TIMESTAMPTZ,
  deadline_at            DATE,
  final_file_id          BIGINT REFERENCES intake_files(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One slot per (student, kind, seq). Allows the API to upsert a row
-- by (student_id, kind, seq) without race-creating duplicates from a
-- double-submit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_required_docs_slot
  ON intake_required_docs(student_id, kind, seq);
CREATE INDEX IF NOT EXISTS idx_required_docs_student
  ON intake_required_docs(student_id);
-- Pending-deadline scan: rows that have been requested but not yet
-- received a final upload. Future reminder cron will read this.
CREATE INDEX IF NOT EXISTS idx_required_docs_open_requests
  ON intake_required_docs(deadline_at)
  WHERE requested_at IS NOT NULL AND final_file_id IS NULL;

-- AI-suggested LOR rows. The automation routine writes proposed
-- recommenders (with recipient_name / recipient_role / reason_brief
-- populated from activity / internship leaders in answers.*) as
-- kind='lor' rows with student_accepted_at = NULL. The student then
-- accepts (sets student_accepted_at = NOW()) or deletes via the UI.
-- Once accepted, the row enters the existing draft → request →
-- received lifecycle unchanged.
--
-- Historical note: an earlier version of this migration ran a
-- backfill UPDATE that set student_accepted_at = created_at on every
-- NULL kind='lor' row. That made sense as a one-time pass for the
-- legacy rows that pre-dated the suggestions feature, but migrate.js
-- runs on every deploy — so on any subsequent deploy it would clobber
-- freshly-inserted AI suggestions (which legitimately use NULL to
-- mean "pending student review") and silently mark them as accepted.
-- The backfill has been removed. The one-time pass already happened
-- on the deploy that introduced the column; new rows correctly stay
-- NULL until the student acts on them.
ALTER TABLE intake_required_docs
  ADD COLUMN IF NOT EXISTS student_accepted_at TIMESTAMPTZ;
-- Index for the student-side query that filters suggestions vs
-- accepted rows. Partial index keeps it tiny — only rows that are
-- still suggestions match.
CREATE INDEX IF NOT EXISTS idx_required_docs_suggestions
  ON intake_required_docs(student_id, kind)
  WHERE student_accepted_at IS NULL AND kind = 'lor';

-- Direct counsellor assignment on applications (separate from student.counsellor_id).
-- Lets staff own an application even when the student has no account yet.
ALTER TABLE intake_applications ADD COLUMN IF NOT EXISTS counsellor_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_intake_applications_counsellor ON intake_applications(counsellor_id);

-- Per-application comment thread. Used by the Status tab on the
-- student dashboard so a student can pin requirements/needs against
-- one specific (university, program) row, and by the staff Applications
-- panel so the assigned counsellor + admin can reply in the same place.
-- Append-only by design (mirrors task_comments).
--   author_kind:    'student' | 'counsellor' | 'admin'
--   author_*_id:    nullable per role; the kind disambiguates which one is set
--   author_admin_username: which named admin posted (e.g. 'adminsuhas')
--                          when kind='admin'; NULL otherwise.
CREATE TABLE IF NOT EXISTS intake_application_comments (
  id BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES intake_applications(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('student', 'counsellor', 'admin')),
  author_counsellor_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL,
  author_student_id TEXT REFERENCES intake_students(student_id) ON DELETE SET NULL,
  author_admin_username TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_application_comments_app
  ON intake_application_comments(application_id, created_at);

-- Counsellor supervision chain (one level deep). Himani.supervisor_id =
-- Simran.id lets Simran view and assign tasks to Himani; Simran has NULL.
-- ON DELETE SET NULL so removing a supervisor doesn't cascade to their supervised counsellors.
ALTER TABLE counsellors ADD COLUMN IF NOT EXISTS supervisor_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL;

-- Tasks can now be assigned to admin accounts, not just counsellors.
--   assignee_kind: 'counsellor' (default, all legacy rows) or 'admin'.
--   assignee_admin_username: the specific admin username (e.g. 'adminSuhas')
--     when assignee_kind = 'admin'; NULL otherwise.
--   creator_id / creator_kind: who created the task. Lets counsellors see
--     back tasks they assigned to admin (only their own; admin tasks they
--     didn't create stay invisible to them).
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS assignee_kind TEXT NOT NULL DEFAULT 'counsellor';
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS assignee_admin_username TEXT;
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS creator_id TEXT REFERENCES counsellors(id) ON DELETE SET NULL;
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS creator_kind TEXT NOT NULL DEFAULT 'counsellor';
-- Constrain the kind enums so a buggy PATCH or a hand-crafted INSERT
-- can't land an unknown value (e.g. 'student' on a task) that the UI
-- then renders incorrectly. Idempotent: only adds when missing.
DO $task_kind_checks$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'counsellor_tasks_assignee_kind_check') THEN
    ALTER TABLE counsellor_tasks
      ADD CONSTRAINT counsellor_tasks_assignee_kind_check
      CHECK (assignee_kind IN ('counsellor', 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'counsellor_tasks_creator_kind_check') THEN
    ALTER TABLE counsellor_tasks
      ADD CONSTRAINT counsellor_tasks_creator_kind_check
      CHECK (creator_kind IN ('counsellor', 'admin'));
  END IF;
END $task_kind_checks$;
-- Mirror authorship: when a named admin (e.g. adminSuhas) creates a
-- task, this stores their raw lowercased username so the UI can show
-- "Suhas created this" instead of a generic "Admin" — important now
-- that mirror groups (admin123 + adminsuhas share an inbox) have
-- multiple admins acting on the same row.
ALTER TABLE counsellor_tasks ADD COLUMN IF NOT EXISTS creator_admin_username TEXT;
-- Same idea on the comments side: which named admin posted this comment.
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS author_admin_username TEXT;

-- Sessions: extend to allow user_kind='student' + carry student_id.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS student_id TEXT REFERENCES intake_students(student_id) ON DELETE CASCADE;
-- Absolute upper bound on session lifetime independent of sliding window.
-- requireAuth checks created_at + this cap before honouring a cookie, so a
-- leaked cookie can't survive forever just because the attacker keeps it warm.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS max_age_days INT NOT NULL DEFAULT 90;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admin_username TEXT;
-- Refresh the sessions user_kind CHECK only when its definition
-- doesn't already match the current allow-list. The previous block
-- dropped any check constraint on sessions on every boot — broad
-- enough that adding a different check (e.g. max_age_days > 0)
-- would have been silently wiped.
DO $reauth_sessions$
DECLARE
  current_def TEXT;
  expected_def TEXT := 'CHECK ((user_kind = ANY (ARRAY[''admin''::text, ''counsellor''::text, ''student''::text])))';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conname = 'sessions_user_kind_check';
  IF current_def IS NULL THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_user_kind_check
      CHECK (user_kind IN ('admin', 'counsellor', 'student'));
  ELSIF current_def <> expected_def THEN
    ALTER TABLE sessions DROP CONSTRAINT sessions_user_kind_check;
    ALTER TABLE sessions ADD CONSTRAINT sessions_user_kind_check
      CHECK (user_kind IN ('admin', 'counsellor', 'student'));
  END IF;
END
$reauth_sessions$;

-- ============================================================
-- intake_financial_dossier  --  student's structured financial dossier.
-- One row per student. The data jsonb carries:
--   - studentLoanTaken, kycAdditional
--   - bankManager: card, email, phone
--   - itrPeople / incomePeople / businessPeople / networthPeople /
--     affidavitPeople: arrays of (id, name, relationship)
--   - travelTrips: array of (id, country, purpose, from, to)
-- File uploads themselves live in intake_files with a fin_* field_id
-- namespace (fin_itr_PID_fy1, etc.). One source of truth for blob
-- storage; the dossier row only holds structured metadata + free-text
-- fields. updated_at supports optimistic concurrency with the same
-- expectedUpdatedAt pattern the intake form uses.
-- ============================================================
CREATE TABLE IF NOT EXISTS intake_financial_dossier (
  student_id TEXT PRIMARY KEY REFERENCES intake_students(student_id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INVOICE GENERATION
--
-- Single-row company_settings holds the firm's identity + tax + bank
-- + brand assets that every invoice header reads from. Logo and
-- signature are stored as base64 text (small PNGs — typical signature
-- ~10 KB, logo ~50 KB; well under any sane row limit). They live in
-- the DB rather than the repo because this repo is public on GitHub
-- and the values are private (GSTIN, PAN, bank a/c, IFSC, founder
-- phone, signature image). The id=1 CHECK + PRIMARY KEY constraint
-- enforces "at most one row" so a buggy POST can't accidentally
-- create a second config row that drifts from the live one.
--
-- invoices rows are mutable while approved=false (draft). Once an
-- admin signs an invoice (approve endpoint), approved flips true,
-- approved_at + approved_by_admin are stamped, and the API rejects
-- further mutations. Numbers are unique within an FY.
--
-- Line items use JSONB for the type-specific bits — retail has
-- (studentName, service, amount); B2B India/LUT has (poNumber,
-- studentName, course, university, intake, commission); B2B
-- International adds (siukId, firstName, familyName, tuitionFee,
-- uniRate, partnerRate, currency). Common identifiers (invoice_id,
-- position, amount, commission) stay as columns so list + sum
-- queries don't need to crack JSON.
-- ============================================================
CREATE TABLE IF NOT EXISTS company_settings (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  logo_base64     TEXT,
  signature_base64 TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_admin TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  invoice_number  TEXT NOT NULL UNIQUE,
  invoice_type    TEXT NOT NULL CHECK (invoice_type IN ('retail', 'b2b', 'b2b_lut', 'b2b_intl')),
  invoice_date    DATE NOT NULL,
  fy              INT NOT NULL,
  customer        JSONB NOT NULL DEFAULT '{}'::jsonb,
  currency        TEXT,
  notes           TEXT,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst            NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst            NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst            NUMERIC(14,2) NOT NULL DEFAULT 0,
  grand_total     NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_type        TEXT,
  lut_n_snapshot  TEXT,
  lut_date_snapshot TEXT,
  approved        BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at     TIMESTAMPTZ,
  approved_by_admin TEXT,
  created_by_admin TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_fy ON invoices(fy);
CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(invoice_type);
CREATE INDEX IF NOT EXISTS idx_invoices_approved ON invoices(approved);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position        INT NOT NULL,
  amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission      NUMERIC(14,2) NOT NULL DEFAULT 0,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items(invoice_id, position);

-- Saved B2B partners for quick invoice pre-fill. Stores the same
-- fields as the invoice customer object so selecting a partner
-- auto-populates the customer step in the wizard.
CREATE TABLE IF NOT EXISTS invoice_partners (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  state      TEXT,
  state_code TEXT,
  gstin      TEXT,
  address    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_partners_name ON invoice_partners(lower(name));

-- ============================================================
-- counsellor_task_assignees — multi-assignee junction table.
-- One task can target N people, where each row is either a
-- counsellor (counsellor_id set) or a named admin
-- (admin_username set). The legacy counsellor_tasks.assignee_id /
-- assignee_admin_username columns stay populated with the FIRST
-- assignee so older code paths still work; the junction table is
-- the source of truth for "all assignees" and for scope filtering.
--
-- Completion is shared: whichever assignee marks completed=true
-- closes the task for everyone. (Product choice; see UI spec.)
--
-- ON DELETE CASCADE — wiping a task removes its assignee rows.
-- counsellor_id ON DELETE CASCADE — same as the legacy assignee_id
-- behaviour: deleting a counsellor row removes them from the
-- assignment list rather than orphaning the row.
-- ============================================================
CREATE TABLE IF NOT EXISTS counsellor_task_assignees (
  id              BIGSERIAL PRIMARY KEY,
  task_id         BIGINT NOT NULL REFERENCES counsellor_tasks(id) ON DELETE CASCADE,
  assignee_kind   TEXT NOT NULL CHECK (assignee_kind IN ('counsellor', 'admin')),
  counsellor_id   TEXT REFERENCES counsellors(id) ON DELETE CASCADE,
  admin_username  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (assignee_kind = 'counsellor' AND counsellor_id IS NOT NULL AND admin_username IS NULL)
    OR (assignee_kind = 'admin' AND admin_username IS NOT NULL AND counsellor_id IS NULL)
  )
);
-- Stop the same person being added twice to the same task. PK columns
-- can't be NULLable so the constraint goes on a unique index with
-- COALESCE so the NULL side of each row compares as empty-string rather
-- than as the SQL NULL = NULL → unknown rule (which would let dupes
-- slip through).
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_assignees_unique_target
  ON counsellor_task_assignees(
    task_id,
    assignee_kind,
    COALESCE(counsellor_id, ''),
    COALESCE(admin_username, '')
  );
CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON counsellor_task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_counsellor
  ON counsellor_task_assignees(counsellor_id) WHERE counsellor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_assignees_admin
  ON counsellor_task_assignees(admin_username) WHERE admin_username IS NOT NULL;

-- Backfill: copy each existing single-assignee task into a junction
-- row. Idempotent — skips tasks that already have any junction row.
-- Tasks with NULL assignee on both sides (legacy "unassigned") stay
-- without a junction row; the UI treats absent junction rows as
-- "unassigned" the same way it treats NULL assignee_id today.
INSERT INTO counsellor_task_assignees (task_id, assignee_kind, counsellor_id, admin_username)
SELECT t.id, t.assignee_kind,
       CASE WHEN t.assignee_kind = 'counsellor' THEN t.assignee_id ELSE NULL END,
       CASE WHEN t.assignee_kind = 'admin' THEN t.assignee_admin_username ELSE NULL END
  FROM counsellor_tasks t
 WHERE NOT EXISTS (SELECT 1 FROM counsellor_task_assignees ja WHERE ja.task_id = t.id)
   AND (
        (t.assignee_kind = 'counsellor' AND t.assignee_id IS NOT NULL)
     OR (t.assignee_kind = 'admin' AND t.assignee_admin_username IS NOT NULL)
       );

-- Widen intake_required_docs.kind to include 'ngo' and 'extracurricular'.
-- DROP + re-ADD is idempotent: each deploy removes the old constraint
-- (whatever version it is) and adds the latest definition.
ALTER TABLE intake_required_docs DROP CONSTRAINT IF EXISTS intake_required_docs_kind_check;
ALTER TABLE intake_required_docs ADD CONSTRAINT intake_required_docs_kind_check
  CHECK (kind IN ('lor', 'internship', 'sop', 'ngo', 'extracurricular'));

-- NGO / Extracurricular backfill removed: those slots are now custom-
-- created by the counsellor / admin from the staff UI, mirroring LOR /
-- Internship / SOP. Leaving the old INSERT in place would re-seed empty
-- rows on every deploy after they've been deliberately wiped.

-- Recommended-docs popup: per-row "generate AI" inputs. Subject is the
-- school subject a LOR teacher teaches (or the role for internship/NGO).
-- Instructions is the counsellor's free-text brief that grounds the AI
-- draft. Target_words is the requested word count (default 600 for LOR
-- per the LOR generation spec). All three are nullable — rows existed
-- before this migration with neither set, and the popup is the only
-- writer.
ALTER TABLE intake_required_docs
  ADD COLUMN IF NOT EXISTS subject       TEXT,
  ADD COLUMN IF NOT EXISTS instructions  TEXT,
  ADD COLUMN IF NOT EXISTS target_words  INT;

-- Mandatory LOR backfill removed (same rationale as the NGO/Extracurricular
-- backfill above): LOR rows are now custom-created by the counsellor /
-- admin. Leaving the INSERT here would re-seed three empty LOR slots
-- for every student on every deploy and undo any wipe script run.

-- One-time wipe for Pratham's stale auto-seeded required-doc rows. These
-- pre-date the move to "admin/counsellor custom-creates every slot" and
-- were carrying AI-generated LOR / SOP drafts that no longer reflect
-- the current flow. Backed up in backups/required-docs-pratham-2026-05-20.json
-- (committed) before delete. Idempotent: re-runs delete 0 rows because
-- the WHERE clause matches nothing once cleared. Scoped to Pratham only
-- to avoid touching other students' work; broader sweep is opt-in via
-- server/scripts/wipe-required-docs.js.
DELETE FROM intake_required_docs
 WHERE student_id = 's_moy17coj_7ab6d5bb6e39'
   AND final_file_id IS NULL;

-- Per-student document profile: location (in_india / outside_india) and
-- level (undergrad / postgrad) determine which document columns are shown.
ALTER TABLE intake_students
  ADD COLUMN IF NOT EXISTS doc_location VARCHAR(20),
  ADD COLUMN IF NOT EXISTS doc_level    VARCHAR(20);

-- Global document-visibility config: one row per (location, level) pair.
-- visible_keys is a JSONB array of the doc-column keys shown for students
-- in that category. ON CONFLICT DO NOTHING: re-running migrate never
-- clobbers admin customisations made after the initial seed.
CREATE TABLE IF NOT EXISTS doc_config_visibility (
  location     VARCHAR(20) NOT NULL,
  level        VARCHAR(20) NOT NULL,
  visible_keys JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location, level)
);

INSERT INTO doc_config_visibility (location, level, visible_keys) VALUES
  ('in_india',      'undergrad', '["aadharFile","photoFile","passportFrontBack","passportFront","passportLast","marks10sheet","marks11sheet","marks12predictedSheet","marks12sheet","admitCardFile","transcript","finalDegree","semesterTranscripts","ielts_result","toefl_result","sat_result","resumeFile","itr","income","business","kyc","loan","networth","affidavit","banking","travel","lor","internship","ngo","extracurricular","sop"]'::jsonb),
  ('in_india',      'postgrad',  '["aadharFile","photoFile","passportFrontBack","passportFront","passportLast","marks10sheet","marks11sheet","marks12predictedSheet","marks12sheet","admitCardFile","transcript","finalDegree","semesterTranscripts","ielts_result","toefl_result","sat_result","resumeFile","itr","income","business","kyc","loan","networth","affidavit","banking","travel","lor","internship","ngo","extracurricular","sop"]'::jsonb),
  ('outside_india', 'undergrad', '["aadharFile","photoFile","passportFrontBack","passportFront","passportLast","marks10sheet","marks11sheet","marks12predictedSheet","marks12sheet","admitCardFile","transcript","finalDegree","semesterTranscripts","ielts_result","toefl_result","sat_result","resumeFile","itr","income","business","kyc","loan","networth","affidavit","banking","travel","lor","internship","ngo","extracurricular","sop"]'::jsonb),
  ('outside_india', 'postgrad',  '["aadharFile","photoFile","passportFrontBack","passportFront","passportLast","marks10sheet","marks11sheet","marks12predictedSheet","marks12sheet","admitCardFile","transcript","finalDegree","semesterTranscripts","ielts_result","toefl_result","sat_result","resumeFile","itr","income","business","kyc","loan","networth","affidavit","banking","travel","lor","internship","ngo","extracurricular","sop"]'::jsonb)
ON CONFLICT (location, level) DO NOTHING;
`;

export async function migrate() {
  // Atomic migration. Postgres' simple-query protocol does NOT wrap
  // multi-statement queries in a transaction by default, so a failure
  // in any statement would otherwise leave the DB in a half-applied
  // state (statements before the failing one already committed).
  // BEGIN/COMMIT around the whole SQL string makes this all-or-nothing.
  // Note: CREATE INDEX inside a transaction holds an ACCESS EXCLUSIVE
  // lock on the underlying table for the duration; for our table sizes
  // this is fine (sub-second). For large tables, future migrations
  // should switch to CREATE INDEX CONCURRENTLY out of band.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(SQL);
    await client.query("COMMIT");
    console.log("[migrate] schema ready");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
