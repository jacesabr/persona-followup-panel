import pool from "./db.js";
import { fireReminderNotifications } from "./notify/dispatch.js";

const CHECK_INTERVAL_MS = 60_000; // 1 minute

async function checkReminders() {
  const { rows } = await pool.query(`
    SELECT
      l.*,
      c.name AS _c_name,
      c.whatsapp AS _c_whatsapp,
      c.email AS _c_email
    FROM leads l
    JOIN counsellors c ON c.id = l.counsellor_id
    WHERE l.service_date IS NOT NULL
      AND l.service_date > NOW()
      AND l.service_date <= NOW() + INTERVAL '12 hours'
      AND l.reminder_sent = FALSE
      AND l.status = 'scheduled'
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
      await pool.query("UPDATE leads SET reminder_sent = TRUE WHERE id = $1", [lead.id]);
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
