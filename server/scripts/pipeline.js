// One-script pipeline for the AI artifact run on a single student.
//
//   node server/scripts/pipeline.js prep      <student_id-or-username>
//   node server/scripts/pipeline.js dispatch  <student_id-or-username>
//   node server/scripts/pipeline.js pending                     # list candidates
//
// or via package.json:
//
//   npm run pipeline -- prep      <student_id>
//   npm run pipeline -- dispatch  <student_id>
//   npm run pipeline -- pending
//
// Design (matches the workflow the operator is actually running):
//
//   prep     — fetches every input the Claude Code session needs to
//              author this student's artefacts, drops them into
//              tmp/pipeline/<student_id>/, and prints the next-step
//              command. The operator then opens Claude Code in this
//              repo, follows automation/instructions_autofill_plus_generate.md,
//              and edits tmp/pipeline/<student_id>/drafts.json by hand
//              (or via the agent).
//
//   dispatch — reads tmp/pipeline/<student_id>/drafts.json and POSTs
//              it to /api/admin/ai/dispatch atomically. Pratham's
//              regeneration on 2026-05-13 used this exact path.
//
//   pending  — lists candidates from the deployed /api/admin/ai/pending
//              endpoint so the operator can decide who's next.
//
// Env (with defaults so the command runs as a one-liner from a clean shell):
//   PERSONA_URL      — defaults to https://persona-y9pt.onrender.com
//   ADMIN_USERNAME   — defaults to admin123
//   ADMIN_PASSWORD   — defaults to admin123
//
// When ANTHROPIC_API_KEY lands later (per user direction, this is the
// "bigger-budget" follow-up), an `author` subcommand will plug in
// between `prep` and `dispatch` to call the SDK + write drafts.json
// automatically. The folder layout is already shaped for that.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline as streamPipeline } from "node:stream/promises";

const PERSONA_URL = process.env.PERSONA_URL || "https://persona-y9pt.onrender.com";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin123";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// fileURLToPath handles Windows drive-letter URLs cleanly; the bare
// .pathname approach landed on /C:/Users/... which broke the path
// joins below.
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const WORK_ROOT = path.join(REPO_ROOT, "tmp", "pipeline");

// ---------- helpers ----------

async function login() {
  const res = await fetch(`${PERSONA_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`login ${res.status}: ${await res.text()}`);
  }
  const setCookies = res.headers.getSetCookie?.() || [];
  const cookie = setCookies.find((c) => c.startsWith("persona_session="))?.split(";")[0];
  if (!cookie) throw new Error("no persona_session cookie in login response");
  return cookie;
}

async function api(cookie, method, urlPath, body) {
  const res = await fetch(`${PERSONA_URL}${urlPath}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function downloadFile(cookie, urlPath, dst) {
  const res = await fetch(`${PERSONA_URL}${urlPath}`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`GET ${urlPath} -> ${res.status}`);
  await streamPipeline(res.body, fs.createWriteStream(dst));
}

async function resolveStudentId(cookie, idOrUsername) {
  // Accept either an s_… id or a username. Username lookup goes
  // through the staff list endpoint (cheap on the deployed instance).
  if (idOrUsername.startsWith("s_")) return idOrUsername;
  const list = await api(cookie, "GET", "/api/students");
  const match = list.find((s) => s.username?.toLowerCase() === idOrUsername.toLowerCase());
  if (!match) throw new Error(`no student found with username "${idOrUsername}"`);
  return match.student_id;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// ---------- subcommands ----------

async function cmdPending() {
  const cookie = await login();
  const body = await api(cookie, "GET", "/api/admin/ai/pending?limit=10");
  const rows = body.candidates || [];
  if (rows.length === 0) {
    console.log("No pending students in the AI queue.");
    return;
  }
  console.log(`${rows.length} candidate(s):\n`);
  for (const r of rows) {
    const src = r.source_kind === "pre_upload" ? "pre-upload" : "intake-done";
    console.log(`  ${r.student_id}  (${r.display_name || r.username || "?"})  files=${r.files_count}  source=${src}`);
  }
}

async function cmdPrep(idOrUsername) {
  const cookie = await login();
  const studentId = await resolveStudentId(cookie, idOrUsername);
  const workDir = path.join(WORK_ROOT, studentId);
  ensureDir(workDir);
  ensureDir(path.join(workDir, "files"));

  console.log(`[prep] student ${studentId}`);
  console.log(`[prep] working directory: ${workDir}`);

  // 1. Student bundle — the staff-side detail endpoint returns the
  // student record AND the full file + resume metadata in one shot.
  const bundle = await api(cookie, "GET", `/api/students/${studentId}`);
  fs.writeFileSync(path.join(workDir, "student.json"), JSON.stringify(bundle.student, null, 2));
  fs.writeFileSync(path.join(workDir, "resumes.json"), JSON.stringify(bundle.resumes || [], null, 2));
  console.log(
    `[prep] wrote student.json — phase=${bundle.student.intake_phase}, intake_complete=${bundle.student.intake_complete}`
  );

  // 2. File bytes. Downloads every ACTIVE upload so the operator's
  // Claude Code session can read them via the Read tool without
  // re-hitting the API. Superseded rows are skipped — we only want
  // the current version of each slot.
  const allFiles = bundle.files || [];
  const activeFiles = allFiles.filter((f) => !f.superseded_at);
  fs.writeFileSync(path.join(workDir, "files-index.json"), JSON.stringify(activeFiles, null, 2));

  for (const f of activeFiles) {
    const safeName = `${f.id}-${f.field_id || "unknown"}-${f.original_name}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dst = path.join(workDir, "files", safeName);
    if (fs.existsSync(dst)) continue;
    try {
      await downloadFile(cookie, `/api/students/${studentId}/files/${f.id}`, dst);
      console.log(`[prep]   ${safeName}  (${Math.round((f.size || 0) / 1024)} KB)`);
    } catch (e) {
      console.warn(`[prep]   ! ${safeName} download failed: ${e.message}`);
    }
  }
  console.log(`[prep] downloaded ${activeFiles.length} active file(s) of ${allFiles.length} total`);

  // 3. Required-docs rows (LOR / SOP / internship lifecycle). Lives
  // under the dedicated required-docs router, not the students one.
  const reqDocs = await api(cookie, "GET", `/api/required-docs/student/${studentId}`).catch(() => null);
  if (reqDocs) {
    fs.writeFileSync(path.join(workDir, "required-docs.json"), JSON.stringify(reqDocs, null, 2));
  }

  // 4. Financial dossier (Section "Financial documents" feature).
  const fin = await api(cookie, "GET", `/api/students/${studentId}/financial`).catch(() => null);
  if (fin) {
    fs.writeFileSync(path.join(workDir, "financial.json"), JSON.stringify(fin, null, 2));
  }

  // 5. drafts.json skeleton — student_id is pre-filled and the LOR
  // doc_id slots come from required-docs so the operator only has to
  // paste in the drafts themselves.
  const draftsPath = path.join(workDir, "drafts.json");
  if (!fs.existsSync(draftsPath)) {
    // required-docs endpoint returns a flat array of rows.
    const lorRows = Array.isArray(reqDocs) ? reqDocs.filter((d) => d.kind === "lor") : [];
    const skeleton = {
      student_id: studentId,
      force: false,
      summary_notes: "",
      file_descriptions: [],
      autofill_answers: {},
      // Resume goes here as resume_json once authored.
      // resume_json: { schema_version: 2, name: "...", ... },
      sop_draft: "",
      lor_drafts: lorRows.map((d) => ({
        doc_id: d.id,
        recipient_name: d.recipient_name,
        recipient_role: d.recipient_role,
        reason_brief: d.reason_brief,
        draft: "",
      })),
      lor_suggestions: [],
      internship_drafts: [],
    };
    fs.writeFileSync(draftsPath, JSON.stringify(skeleton, null, 2));
    console.log(`[prep] wrote drafts.json skeleton with ${skeleton.lor_drafts.length} LOR slot(s)`);
  } else {
    console.log(`[prep] drafts.json already exists — left as-is`);
  }

  // 6. README for the operator. Concrete next steps in one place.
  const readme = `# Pipeline workdir — ${studentId}

This folder was created by \`npm run pipeline -- prep ${idOrUsername}\`. It
holds every input the Claude Code session needs to author this
student's artefacts.

## Files

- \`student.json\` — intake answers, phase, AI artefact state
- \`files-index.json\` — active uploaded-file metadata
- \`files/\` — raw uploaded files (Aadhar, marksheets, IELTS, etc.) — open
  these in Claude Code via the Read tool
- \`required-docs.json\` — LOR / SOP / internship rows the dispatch will
  write \`staff_draft\` into
- \`financial.json\` — financial dossier (if any)
- \`drafts.json\` — **the artefact you fill in** before running dispatch

## Next steps

1. Open Claude Code in the repo root.
2. Open and follow \`automation/instructions_autofill_plus_generate.md\`
   top to bottom. Read the SOP + resume corpora
   (\`automation/sop_corpus/\`, \`automation/resume_corpus/\`) and the
   intake + files in this workdir. The LOR corpus's \`examples/\`
   directory is no longer many-shot grounding — only read
   \`lor-guideline.md\` for the 8-beat structure.
3. Author each artefact in \`drafts.json\`:
   - \`file_descriptions[]\` — one entry per file in \`files/\`
   - \`autofill_answers\` — keys per Section C of the runbook
   - \`resume_json\` — payload per \`automation/resume_schema_v2.md\`
   - \`sop_draft\` — 400–500 words, 6–8 beats from
     \`automation/sop_corpus/construction-guidelines.md\`
   - \`lor_drafts\` — target_words ±10% each (default 600), 8 beats
     from \`automation/lor_corpus/lor-guideline.md\`, subject-focused
     per each row's \`subject\` + \`instructions\` columns
4. Set \`force: true\` if you are overwriting an existing draft.
5. Dispatch:

\`\`\`
npm run pipeline -- dispatch ${studentId}
\`\`\`

The dispatch step POSTs \`drafts.json\` to
\`/api/admin/ai/dispatch\`, which writes everything atomically and
stamps \`ai_artifacts_generated_at\`.
`;
  fs.writeFileSync(path.join(workDir, "README.md"), readme);

  console.log("");
  console.log(`[prep] done. Next: open this repo in Claude Code, follow ${path.relative(REPO_ROOT, workDir)}/README.md`);
  console.log(`[prep]       then: npm run pipeline -- dispatch ${studentId}`);
}

async function cmdDispatch(idOrUsername) {
  const cookie = await login();
  const studentId = await resolveStudentId(cookie, idOrUsername);
  const workDir = path.join(WORK_ROOT, studentId);
  const draftsPath = path.join(workDir, "drafts.json");
  if (!fs.existsSync(draftsPath)) {
    throw new Error(
      `no drafts.json at ${draftsPath} — run \`npm run pipeline -- prep ${idOrUsername}\` first`
    );
  }
  const payload = JSON.parse(fs.readFileSync(draftsPath, "utf8"));
  if (payload.student_id !== studentId) {
    throw new Error(
      `drafts.json student_id (${payload.student_id}) does not match resolved student_id (${studentId})`
    );
  }

  console.log(`[dispatch] POST /api/admin/ai/dispatch for ${studentId} …`);
  const body = await api(cookie, "POST", "/api/admin/ai/dispatch", payload);
  console.log("[dispatch] OK");
  console.log(JSON.stringify(body, null, 2));
}

// ---------- entry ----------

async function main() {
  const [, , verb, arg] = process.argv;
  if (!verb) {
    console.error(
      "usage:\n" +
        "  node server/scripts/pipeline.js pending\n" +
        "  node server/scripts/pipeline.js prep      <student_id-or-username>\n" +
        "  node server/scripts/pipeline.js dispatch  <student_id-or-username>"
    );
    process.exit(2);
  }
  if (verb === "pending") return cmdPending();
  if (verb === "prep") {
    if (!arg) throw new Error("prep requires a student_id or username");
    return cmdPrep(arg);
  }
  if (verb === "dispatch") {
    if (!arg) throw new Error("dispatch requires a student_id or username");
    return cmdDispatch(arg);
  }
  throw new Error(`unknown subcommand "${verb}"`);
}

main().catch((e) => {
  console.error("[pipeline] error:", e.message);
  process.exit(1);
});
