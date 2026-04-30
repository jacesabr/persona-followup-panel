import pool from "./db.js";
import { fireReminderNotifications } from "./notify/dispatch.js";

// Polled check — fires each lead's reminder ONCE (gated by reminder_sent flag).
// 5 min is plenty for human-scale appointments and keeps DB load low.
//
// Silent-skip rules to be aware of (these exclude leads from the query):
//   - status != 'scheduled'  →  completed / no_show / unassigned leads
//                              don't get reminders even if rescheduled.
//                              Re-arm by setting status back to 'scheduled'.
//   - counsellor_id IS NULL  →  free-text-counsellor leads (created via
//                              the simple panel with a typed name) are
//                              skipped — no FK row means no notify target.
//   - archived = TRUE        →  archived leads never trigger.
// Each of these is intentional but easy to forget; surface in the UI
// where it matters (the new-lead form already has an italic hint).
const CHECK_INTERVAL_MS = 5 * 60_000;

async function checkReminders() {
  const { rows } = await pool.query(`
    WITH claimed AS (
      UPDATE leads
      SET reminder_sent = TRUE
      WHERE id IN (
        SELECT id FROM leads
        WHERE service_date IS NOT NULL
          AND service_date > NOW()
          AND service_date <= NOW() + INTERVAL '12 hours'
          AND reminder_sent = FALSE
          AND status = 'scheduled'
          AND counsellor_id IS NOT NULL
          AND archived = FALSE
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    )
    SELECT c.*, ct.name AS _c_name, ct.whatsapp AS _c_whatsapp, ct.email AS _c_email
    FROM claimed c
    JOIN counsellors ct ON ct.id = c.counsellor_id
  `);

  if (rows.length === 0) return;

  console.log(`[cron] firing reminders for ${rows.length} lead(s)`);
  for (const r of rows) {
    const lead = { ...r };
    delete lead._c_name;
    delete lead._c_whatsapp;
    delete lead._c_email;
    const counsellor = {
      id: r.counsellor_id,
      name: r._c_name,
      whatsapp: r._c_whatsapp,
      email: r._c_email,
    };
    try {
      await fireReminderNotifications(lead, counsellor);
    } catch (e) {
      console.error(`[cron] reminder failed for ${lead.id}:`, e.message);
    }
  }
}

export function startCron() {
  setInterval(() => {
    checkReminders().catch((e) => console.error("[cron] check failed:", e));
  }, CHECK_INTERVAL_MS);
  console.log(`[cron] started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
}
