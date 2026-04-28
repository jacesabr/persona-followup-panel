import pool from "../db.js";
import { sendWhatsApp } from "./twilio.js";
import { sendEmail } from "./email.js";
import {
  assignmentMessageForLead,
  assignmentMessageForCounsellor,
  reminderMessageForLead,
  reminderMessageForCounsellor,
} from "../messages.js";

function statusCallbackUrl() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/api/twilio/status`;
}

async function logActivity(leadId, entry) {
  await pool.query(
    `INSERT INTO lead_activity (lead_id, type, channel, recipient, kind, provider_sid, error_code, text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      leadId,
      entry.type,
      entry.channel || null,
      entry.recipient || null,
      entry.kind || null,
      entry.provider_sid || null,
      entry.error_code || null,
      entry.text,
    ]
  );
}

async function trySendWhatsApp(leadId, recipient, contact, body, kind) {
  const label = kind === "reminder" ? "12hr reminder" : "Welcome";
  try {
    const result = await sendWhatsApp(contact, body, { statusCallback: statusCallbackUrl() });
    // Insert as PENDING — the Twilio webhook will update us to delivered / failed.
    await logActivity(leadId, {
      type: "notification_pending",
      channel: "whatsapp",
      recipient,
      kind,
      provider_sid: result.sid,
      text: `${label} whatsapp queued for ${recipient} (${result.to}). Awaiting Twilio delivery callback.`,
    });
    return { ok: true, result };
  } catch (e) {
    await logActivity(leadId, {
      type: "notification_error",
      channel: "whatsapp",
      recipient,
      kind,
      text: `${label} whatsapp to ${recipient} failed at send: ${e.message}`,
    });
    console.error(`[notify] WA send to ${recipient} for ${leadId}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function trySendEmail(leadId, recipient, addr, subject, body, kind) {
  const label = kind === "reminder" ? "12hr reminder" : "Welcome";
  try {
    const result = await sendEmail(addr, subject, body);
    await logActivity(leadId, {
      type: "notification_sent",
      channel: "email",
      recipient,
      kind,
      text: `${label} email sent to ${recipient} (${result.to}).`,
    });
    return { ok: true, result };
  } catch (e) {
    await logActivity(leadId, {
      type: "notification_error",
      channel: "email",
      recipient,
      kind,
      text: `${label} email to ${recipient} failed: ${e.message}`,
    });
    console.error(`[notify] email to ${recipient} for ${leadId}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export async function fireAssignmentNotifications(lead, counsellor) {
  const leadMsg = assignmentMessageForLead(lead, counsellor);
  const counsellorMsg = assignmentMessageForCounsellor(lead, counsellor);
  const subjLead = `Welcome to Persona — your ${lead.purpose} is scheduled`;
  const subjCounsellor = `New lead assigned — ${lead.name} (${lead.purpose})`;

  await Promise.allSettled([
    lead.contact && trySendWhatsApp(lead.id, "lead", lead.contact, leadMsg, "assignment"),
    lead.email && trySendEmail(lead.id, "lead", lead.email, subjLead, leadMsg, "assignment"),
    counsellor.whatsapp && trySendWhatsApp(lead.id, "counsellor", counsellor.whatsapp, counsellorMsg, "assignment"),
    counsellor.email && trySendEmail(lead.id, "counsellor", counsellor.email, subjCounsellor, counsellorMsg, "assignment"),
  ]);
}

export async function fireReminderNotifications(lead, counsellor) {
  const leadMsg = reminderMessageForLead(lead, counsellor);
  const counsellorMsg = reminderMessageForCounsellor(lead, counsellor);
  const subjLead = `Reminder — your ${lead.purpose} session in 12 hours`;
  const subjCounsellor = `Reminder — ${lead.name} session in 12 hours`;

  await Promise.allSettled([
    lead.contact && trySendWhatsApp(lead.id, "lead", lead.contact, leadMsg, "reminder"),
    lead.email && trySendEmail(lead.id, "lead", lead.email, subjLead, leadMsg, "reminder"),
    counsellor.whatsapp && trySendWhatsApp(lead.id, "counsellor", counsellor.whatsapp, counsellorMsg, "reminder"),
    counsellor.email && trySendEmail(lead.id, "counsellor", counsellor.email, subjCounsellor, counsellorMsg, "reminder"),
  ]);
}
