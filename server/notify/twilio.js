import twilio from "twilio";

let client = null;

function getClient() {
  if (client) return client;
  const sid = process.env.TWILIO_API_KEY_SID;
  const secret = process.env.TWILIO_API_KEY_SECRET;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !secret || !accountSid) {
    throw new Error("Twilio creds missing (TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET / TWILIO_ACCOUNT_SID)");
  }
  client = twilio(sid, secret, { accountSid });
  return client;
}

const FROM = () => process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886"; // sandbox default
const TEST_TO = () => process.env.TEST_RECIPIENT_WHATSAPP; // overrides ALL WA recipients during trial

const TWILIO_ERR_HINTS = {
  63015: "Recipient hasn't joined the WhatsApp sandbox. From their phone, send 'join <code>' to +14155238886.",
  63016: "Outside 24-hour session window — recipient must re-message the sandbox to re-open the session.",
  63018: "Daily message limit exceeded for this WhatsApp number.",
  21211: "Invalid 'To' number format.",
  21408: "Permission denied for this 'To' number — may need verified caller ID on trial accounts.",
};

export function explainTwilioError(code) {
  if (code == null) return null;
  return TWILIO_ERR_HINTS[code] || `Twilio error code ${code}`;
}

export async function sendWhatsApp(toRaw, body) {
  const overridden = TEST_TO();
  const to = `whatsapp:+${overridden || toRaw}`;
  const msg = await getClient().messages.create({ from: FROM(), to, body });
  return { sid: msg.sid, to, status: msg.status };
}

const TERMINAL = new Set(["delivered", "sent", "failed", "undelivered", "canceled"]);

export async function pollWhatsAppFinalStatus(sid, { maxMs = 25000, intervalMs = 2500 } = {}) {
  const client = getClient();
  const start = Date.now();
  let last = null;
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const m = await client.messages(sid).fetch();
    last = { status: m.status, errorCode: m.errorCode, errorMessage: m.errorMessage };
    if (TERMINAL.has(m.status)) return last;
  }
  return last; // timed out — return last seen
}
