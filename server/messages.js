import { formatInIst } from "../lib/time.js";

// Long-form IST display for outbound message bodies (weekday + full date + time).
const fmtDateTime = (iso) =>
  iso ? formatInIst(iso, { weekday: "short" }) : "TBD";

export function assignmentMessageForLead(lead, counsellor) {
  const firstName = lead.name.split(" ")[0];
  return [
    `Hello from Persona,`,
    ``,
    `Thanks for reaching out, ${firstName}. Your inquiry has been received.`,
    ``,
    `We've assigned ${counsellor.name} as your counsellor for your ${lead.purpose} session.`,
    ``,
    `Your session is scheduled for ${fmtDateTime(lead.service_date)} (IST).`,
    ``,
    `${counsellor.name} will reach out to confirm shortly. You'll also receive a reminder 12 hours before the event.`,
    ``,
    `— Team Persona`,
  ].join("\n");
}

export function assignmentMessageForCounsellor(lead, counsellor) {
  const firstName = counsellor.name.split(" ")[0];
  return [
    `Hello ${firstName},`,
    ``,
    `A new lead has been assigned to you:`,
    ``,
    `• Name: ${lead.name}`,
    `• Contact: +${lead.contact}`,
    `• Service: ${lead.purpose}`,
    `• Scheduled: ${fmtDateTime(lead.service_date)} (IST)`,
    lead.notes ? `• Notes: ${lead.notes}` : null,
    ``,
    `You'll receive a reminder 12 hours before the session. Please reach out to confirm.`,
    ``,
    `— Persona admin`,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

export function reminderMessageForLead(lead, counsellor) {
  const firstName = lead.name.split(" ")[0];
  return [
    `Hello from Persona — quick reminder, ${firstName}.`,
    ``,
    `Your ${lead.purpose} session with ${counsellor.name} is in approximately 12 hours.`,
    ``,
    `Scheduled for ${fmtDateTime(lead.service_date)} (IST).`,
    ``,
    `Please be on time. Reply if you need to reschedule.`,
    ``,
    `— Team Persona`,
  ].join("\n");
}

export function reminderMessageForCounsellor(lead, counsellor) {
  const firstName = counsellor.name.split(" ")[0];
  return [
    `Hello ${firstName},`,
    ``,
    `Reminder — your ${lead.purpose} session with ${lead.name} is in approximately 12 hours.`,
    ``,
    `• Lead: ${lead.name} (+${lead.contact})`,
    `• Scheduled: ${fmtDateTime(lead.service_date)} (IST)`,
    lead.notes ? `• Notes: ${lead.notes}` : null,
    ``,
    `— Persona admin`,
  ]
    .filter((x) => x !== null)
    .join("\n");
}
