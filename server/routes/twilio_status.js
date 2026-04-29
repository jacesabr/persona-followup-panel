import express from "express";
import twilio from "twilio";
import pool from "../db.js";
import { explainTwilioError } from "../notify/twilio.js";

const router = express.Router();

let warnedNoToken = false;

// Reconstruct the public-facing URL Twilio signed against. Prefer the explicit
// PUBLIC_BASE_URL when set (handles non-standard ports / path prefixes). Otherwise
// infer from the request — relies on `app.set("trust proxy", 1)` so req.protocol
// reads X-Forwarded-Proto. Mirrors twilio-node's own webhook() middleware.
function buildTwilioUrl(req) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (base) return `${base}${req.originalUrl || req.path}`;
  return `${req.protocol}://${req.get("host")}${req.originalUrl || req.path}`;
}

function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (!warnedNoToken) {
      console.warn("[twilio status] TWILIO_AUTH_TOKEN not set — skipping signature validation");
      warnedNoToken = true;
    }
    return true;
  }
  const signature = req.headers["x-twilio-signature"];
  return twilio.validateRequest(authToken, signature, buildTwilioUrl(req), req.body || {});
}

// Twilio's StatusCallback: form-urlencoded POST.
// Docs: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
//
// Important fields:
//   MessageSid    — Twilio Message SID (matches our lead_activity.provider_sid)
//   MessageStatus — queued | sent | delivered | read | failed | undelivered ...
//   ErrorCode     — present on failure
//
// Signature validation is opt-in via TWILIO_AUTH_TOKEN. When unset, every
// callback is accepted (one-time warning logged) — acceptable for trial mode.
router.post("/status", express.urlencoded({ extended: false }), async (req, res) => {
  // Wrapped in try/catch so a transient DB blip doesn't 500-back to Twilio,
  // which would trigger their retry policy and risk multiple updates per
  // delivery event.
  try {
    if (!validateTwilioSignature(req)) {
      return res.status(403).send("invalid signature");
    }
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
      "UPDATE lead_activity SET type = $1, text = $2, error_code = $3 WHERE id = $4",
      [newType, newText, ErrorCode || null, a.id]
    );

    res.status(204).end();
  } catch (e) {
    console.error("[twilio status] handler error:", e.message);
    // 200 instead of 500 so Twilio doesn't retry — we'd rather lose a status
    // update than handle the same delivery twice.
    res.status(200).send("error noted");
  }
});

export default router;
