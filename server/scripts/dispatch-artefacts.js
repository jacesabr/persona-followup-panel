// Dispatch a JSON drafts file to /api/admin/ai/dispatch.
//
//   node server/scripts/dispatch-artefacts.js path/to/drafts.json
//
// drafts.json shape mirrors the /dispatch body exactly (student_id,
// optional force, sop_draft, lor_drafts[], file_descriptions[],
// autofill_answers, resume_json, etc.). The script just handles auth +
// POST so the operator (or a wrapping automation) can focus on the
// payload.
//
// Env (with sensible defaults so the script runs as a one-liner):
//   PERSONA_URL       — defaults to https://persona-y9pt.onrender.com
//   ADMIN_USERNAME    — defaults to admin123
//   ADMIN_PASSWORD    — defaults to admin123
//
// This is the dispatch slot of the eventual single-command pipeline.
// The other slots (read intake, read files, AUTHOR drafts via the
// Anthropic SDK) plug in upstream and write into the same drafts.json
// shape this script consumes. See automation/ai_grounding_strategy.md
// section 7 for the architecture.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const PERSONA_URL = process.env.PERSONA_URL || "https://persona-y9pt.onrender.com";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin123";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

async function main() {
  const draftsPath = process.argv[2];
  if (!draftsPath) {
    console.error("usage: node server/scripts/dispatch-artefacts.js <drafts.json>");
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(path.resolve(draftsPath), "utf8"));
  if (!payload.student_id) {
    console.error("drafts file must include student_id");
    process.exit(2);
  }

  // Log in (admin).
  const loginRes = await fetch(`${PERSONA_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error(`[dispatch] login failed: ${loginRes.status}`, await loginRes.text());
    process.exit(1);
  }
  // Capture the Set-Cookie persona_session=… header verbatim so we can
  // forward it on the dispatch call. fetch in Node 20 exposes the raw
  // header via .headers.getSetCookie() (returns string[]).
  const setCookies = loginRes.headers.getSetCookie?.() || [];
  const sessionCookie = setCookies.find((c) => c.startsWith("persona_session="))?.split(";")[0];
  if (!sessionCookie) {
    console.error("[dispatch] no persona_session cookie in login response");
    process.exit(1);
  }

  console.log(`[dispatch] authenticated; posting to ${PERSONA_URL}/api/admin/ai/dispatch …`);
  const dispatchRes = await fetch(`${PERSONA_URL}/api/admin/ai/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify(payload),
  });
  const body = await dispatchRes.json().catch(() => ({}));
  if (!dispatchRes.ok) {
    console.error(`[dispatch] FAILED ${dispatchRes.status}`, body);
    process.exit(1);
  }
  console.log("[dispatch] OK");
  console.log(JSON.stringify(body, null, 2));
}

main().catch((e) => {
  console.error("[dispatch] crash:", e);
  process.exit(1);
});
