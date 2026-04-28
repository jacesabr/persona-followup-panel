import pool from "../db.js";
import { sendWhatsApp, pollWhatsAppFinalStatus, explainTwilioError } from "./twilio.js";
import { sendEmail } from "./email.js";
import {
  assignmentMessageForLead,
  assignmentMessageForCounsellor,
  reminderMessageForLead,
  reminderMessageForCounsellor,
} from "../messages.js";

async function logActivity(leadId, entry) {
  await pool.query(
    "INSERT INTO lead_activity (lead_id, type, channel, recipient, kind, text) VALUES ($1, $2, $3, $4, $5, $6)",
    [leadId, entry.type, entry.channel || null, entry.recipient || null, entry.kind || null, entry.text]
  );
}

async function trySend(leadId, channel, recipient, fn, kind) {
  const label = kind === "reminder" ? "12hr reminder" : "Welcome";
  try {
    const result = await fn();

    // For WhatsApp, Twilio's create() returns "queued" — actual delivery
    // happens asynchronously. Poll until terminal so the activity log
    // reflects what really happened.
    if (channel === "whatsapp" && result.sid) {
      const final = await pollWhatsAppFinalStatus(result.sid);
      if (final && (final.status === "delivered" || final.status === "sent")) {
        await logActivity(leadId, {
          type: "notification_sent",
          channel, recipient, kind,
          text: `${label} ${channel} delivered to ${recipient} (${result.to}).`,
        });
        return { ok: true, result };
      }
      const reason = final
        ? `${final.status}${final.errorCode ? ` · ${final.errorCode}` : ""}${
            explainTwilioError(final.errorCode) ? ` — ${explainTwilioError(final.errorCode)}` : ""
          }`
        : "no terminal status within 25s";
      await logActivity(leadId, {
        type: "notification_error",
        channel, recipient, kind,
        text: `${label} ${channel} to ${recipient} (${result.to}) failed: ${reason}`,
      });
      console.error(`[notify] WA to ${recipient} for ${leadId}: ${reason}`);
      return { ok: false, error: reason };
    }

    // Email — SendGrid throws synchronously on failure, so success here is real.
    await logActivity(leadId, {
      type: "notification_sent",
      channel, recipient, kind,
      text: `${label} ${channel} sent to ${recipient} (${result.to || "ok"}).`,
    });
    return { ok: true, result };
  } catch (e) {
    await logActivity(leadId, {
      type: "notification_error",
      channel, recipient, kind,
      text: `${label} ${channel} to ${recipient} failed: ${e.message}`,
    });
    console.error(`[notify] ${label} ${channel} to ${recipient} for ${leadId}:`, e.message);
    return { ok: false, error: e.message };
  }
}

export async function fireAssignmentNotifications(lead, counsellor) {
  const leadMsg = assignmentMessageForLead(lead, counsellor);
  const counsellorMsg = assignmentMessageForCounsellor(lead, counsellor);
  const subjLead = `Welcome to Persona — your ${lead.purpose} is scheduled`;
  const subjCounsellor = `New lead assigned — ${lead.name} (${lead.purpose})`;

  await Promise.all([
    lead.contact && trySend(lead.id, "whatsapp", "lead", () => sendWhatsApp(lead.contact, leadMsg), "assignment"),
    lead.email && trySend(lead.id, "email", "lead", () => sendEmail(lead.email, subjLead, leadMsg), "assignment"),
    counsellor.whatsapp && trySend(lead.id, "whatsapp", "counsellor", () => sendWhatsApp(counsellor.whatsapp, counsellorMsg), "assignment"),
    counsellor.email && trySend(lead.id, "email", "counsellor", () => sendEmail(counsellor.email, subjCounsellor, counsellorMsg), "assignment"),
  ]);
}

export async function fireReminderNotifications(lead, counsellor) {
  const leadMsg = reminderMessageForLead(lead, counsellor);
  const counsellorMsg = reminderMessageForCounsellor(lead, counsellor);
  const subjLead = `Reminder — your ${lead.purpose} session in 12 hours`;
  const subjCounsellor = `Reminder — ${lead.name} session in 12 hours`;

  await Promise.all([
    lead.contact && trySend(lead.id, "whatsapp", "lead", () => sendWhatsApp(lead.contact, leadMsg), "reminder"),
    lead.email && trySend(lead.id, "email", "lead", () => sendEmail(lead.email, subjLead, leadMsg), "reminder"),
    counsellor.whatsapp && trySend(lead.id, "whatsapp", "counsellor", () => sendWhatsApp(counsellor.whatsapp, counsellorMsg), "reminder"),
    counsellor.email && trySend(lead.id, "email", "counsellor", () => sendEmail(counsellor.email, subjCounsellor, counsellorMsg), "reminder"),
  ]);
}
