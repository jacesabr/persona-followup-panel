import express from "express";
import pool from "../db.js";
import { explainTwilioError } from "../notify/twilio.js";

const router = express.Router();

// Twilio's StatusCallback: form-urlencoded POST.
// Docs: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
//
// Important fields:
//   MessageSid   — Twilio Message SID (matches our lead_activity.provider_sid)
//   MessageStatus — queued | sent | delivered | read | failed | undelivered ...
//   ErrorCode    — present on failure
//
// Note: not validating X-Twilio-Signature here. For production, use
// twilio.validateRequest with the auth token. For this trial-mode demo,
// the cost of a stray POST hitting this endpoint is at most a stale
// activity-row update.
router.post("/status", express.urlencoded({ extended: false }), async (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode } = req.body || {};
  if (!MessageSid || !MessageStatus) return res.status(400).send("missing fields");

  const { rows } = await pool.query(
    "SELECT * FROM lead_activity WHERE provider_sid = $1 ORDER BY id DESC LIMIT 1",
    [MessageSid]
  );
  if (rows.length === 0) {
    // Could be a delayed callback for a row we lost, or a misdirected POST.
    console.warn(`[twilio status] no activity row for sid=${MessageSid} status=${MessageStatus}`);
    return res.status(204).end();
  }
  const a = rows[0];

  const label = a.kind === "reminder" ? "12hr reminder" : "Welcome";
  const target = `${a.recipient}${ErrorCode ? ` · ${ErrorCode}` : ""}`;

  let newType = a.type;
  let newText = a.text;

  if (MessageStatus === "delivered" || MessageStatus === "read" || MessageStatus === "sent") {
    newType = "notification_sent";
    newText = `${label} whatsapp ${MessageStatus} to ${target}.`;
  } else if (MessageStatus === "failed" || MessageStatus === "undelivered") {
    newType = "notification_error";
    const hint = explainTwilioError(parseInt(ErrorCode, 10));
    newText = `${label} whatsapp to ${target} ${MessageStatus}${hint ? ` — ${hint}` : ""}.`;
  } else {
    // queued / sending / accepted / scheduled — keep pending, but refresh text
    newText = `${label} whatsapp to ${a.recipient}: ${MessageStatus}.`;
  }

  await pool.query(
    "UPDATE lead_activity SET type = $1, text = $2, error_code = $3, ts = NOW() WHERE id = $4",
    [newType, newText, ErrorCode || null, a.id]
  );

  res.status(204).end();
});

export default router;
