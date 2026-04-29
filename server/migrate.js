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
`;

export async function migrate() {
  await pool.query(SQL);
  console.log("[migrate] schema ready");
}
