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

export async function sendWhatsApp(toRaw, body) {
  const overridden = TEST_TO();
  const to = `whatsapp:+${overridden || toRaw}`;
  const msg = await getClient().messages.create({ from: FROM(), to, body });
  return { sid: msg.sid, to, status: msg.status };
}
