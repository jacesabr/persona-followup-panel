import sgMail from "@sendgrid/mail";

let initialized = false;
function init() {
  if (initialized) return;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error("SENDGRID_API_KEY not set");
  sgMail.setApiKey(key);
  initialized = true;
}

const FROM = () => process.env.SENDGRID_FROM;
const TEST_TO = () => process.env.TEST_RECIPIENT_EMAIL; // overrides ALL email recipients during trial

export async function sendEmail(toRaw, subject, body) {
  init();
  const from = FROM();
  if (!from) throw new Error("SENDGRID_FROM (verified sender) not set");
  const to = TEST_TO() || toRaw;
  const [response] = await sgMail.send({ to, from, subject, text: body });
  return { to, statusCode: response.statusCode };
}
