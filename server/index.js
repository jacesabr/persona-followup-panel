import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import pool from "./db.js";
import { requireAuth, requireStaff, SLIDING_EXPIRY_DAYS } from "./middleware/auth.js";
import leadsRouter from "./routes/leads.js";
import counsellorsRouter from "./routes/counsellors.js";
import tasksRouter from "./routes/tasks.js";
import authRouter from "./routes/auth.js";
import studentsRouter from "./routes/students.js";
import applicationsRouter from "./routes/applications.js";
import requiredDocsRouter from "./routes/required-docs.js";
import adminAiRouter from "./routes/admin-ai.js";
import { migrate } from "./migrate.js";
import { initStorage } from "./storage.js";
import { autoAudit } from "./auditing.js";
import { corpusHasExample } from "./generators/examples.js";
import { runImportFromCorpusDir } from "./scripts/import-examples.js";

const SESSION_GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

// Drop sessions whose last_seen_at fell out of the sliding window. The
// requireAuth middleware already rejects expired rows on read, but
// without this the table grows unbounded — every login leaves a row
// that never gets revisited after its cookie expires. Runs once at boot
// + once a day while the process lives.
async function pruneExpiredSessions() {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM sessions WHERE last_seen_at < NOW() - $1::interval",
      [`${SLIDING_EXPIRY_DAYS} days`]
    );
    if (rowCount > 0) {
      console.log(`[sessions] pruned ${rowCount} expired session row(s)`);
    }
  } catch (e) {
    console.error("[sessions] prune failed:", e);
  }
}

// Boot-time sweeper for in-flight async jobs. If the process died
// mid-LLM-call (Render redeploy, OOM, free-tier sleep cycle), the
// row stays 'running' forever. Mark them failed so the dashboard
// surfaces a retry path instead of an indefinite spinner.
async function failOrphanedAsyncJobs() {
  for (const table of ["intake_resumes", "intake_insights"]) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE ${table}
            SET status = 'failed',
                error  = COALESCE(error, 'Process restarted before job completed.')
          WHERE status IN ('pending', 'running')`
      );
      if (rowCount > 0) {
        console.log(`[${table}] swept ${rowCount} orphaned row(s) to failed`);
      }
    } catch (e) {
      console.error(`[${table}] orphan sweep failed:`, e);
    }
  }
}

// Boot-time corpus seed. Resume generation hard-fails when
// intake_examples is empty (fresh DB, post-deploy on a wiped instance,
// or a Render Postgres reset). Auto-import from automation/resume_corpus/example_resume/
// when the table has no active row so a deploy is self-healing — no
// admin click required for the common case. Only runs when empty so
// existing rows are never disturbed by a restart. Failures are logged
// but non-fatal: the existing 503 NO_CORPUS path still surfaces a
// clear actionable error to the student if seeding didn't work.
async function seedCorpusIfEmpty() {
  try {
    if (await corpusHasExample()) return;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const corpusDir = path.resolve(here, "..", "automation", "resume_corpus", "example_resume");
    const { results } = await runImportFromCorpusDir(corpusDir);
    const inserted = results.filter((r) => r.action === "inserted").length;
    const errors = results.filter((r) => r.action === "error");
    console.log(`[corpus] auto-seeded ${inserted} example(s) from ${corpusDir}`);
    for (const e of errors) console.error(`[corpus] ${e.file}: ${e.reason}`);
  } catch (e) {
    console.error("[corpus] auto-seed failed:", e.message);
  }
}

// Boot-time integrity gate: if any counsellor row still holds a bare
// plaintext password (pre-hash-migration legacy), the constant-time
// compare path in /api/auth/login still fires and we never get to a
// fully-hashed DB. Refuse to start when we shouldn't be deployed.
async function refuseIfPlaintextPasswordsPresent() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, username,
              (password_hash IS NULL) AS hash_null,
              (password_hash IS NOT NULL AND password_hash NOT LIKE 'scrypt:%') AS plaintext
         FROM counsellors`
    );
    const plaintext = rows.filter((r) => r.plaintext);
    const nullHash = rows.filter((r) => r.hash_null);
    if (plaintext.length > 0) {
      console.error(
        `[startup] ${plaintext.length} counsellor row(s) still hold plaintext passwords:`,
        plaintext.map((r) => `${r.username || r.id} (${r.name})`).join(", ")
      );
      console.error(
        "[startup] reset their passwords (admin UI) so they get re-hashed, then redeploy."
      );
      process.exit(1);
    }
    // password_hash IS NULL is a softer state — the row exists but
    // can't authenticate. The original guard silently passed those
    // rows because its WHERE clause filtered them out, which hid the
    // problem. Warn (don't crash) so an operator notices and fixes
    // it via the reset-password admin action.
    if (nullHash.length > 0) {
      console.warn(
        `[startup] ${nullHash.length} counsellor row(s) have NULL password_hash — those accounts cannot log in:`,
        nullHash.map((r) => `${r.username || r.id} (${r.name})`).join(", ")
      );
      console.warn(
        "[startup] use admin → reset password to set credentials before they're needed."
      );
    }
  } catch (e) {
    // If counsellors table doesn't exist yet (very first boot), skip gracefully.
    if (e.code === "42P01") return;
    console.error("[startup] plaintext-password check failed:", e);
    process.exit(1);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);

// Security headers — defense in depth on top of cookie hardening + auth
// gating. Default helmet config covers:
//   - HSTS (production HTTPS pin)
//   - X-Content-Type-Options: nosniff
//   - frameguard (clickjacking)
//   - referrer-policy: no-referrer
//   - X-DNS-Prefetch-Control
//   - X-Permitted-Cross-Domain-Policies
//   - Content-Security-Policy with our exact needs:
//       script-src 'self'              — Vite-bundled JS, no inline
//       style-src 'self' https: 'unsafe-inline'  — bundled CSS + Google Fonts CSS
//       font-src   'self' https: data: — Google Fonts (gstatic) + base64 fallbacks
//       img-src    'self' data:        — covers the data: URI favicon in index.html
//       object-src 'self'              — same-origin PDF embeds (FilePreview /
//                                        MiniFilePreview render uploaded marksheets
//                                        inline via <object data="/api/students/...
//                                        /files/:id" type="application/pdf">). Helmet's
//                                        default is 'none' which would silently blank
//                                        the embed; the fallback card inside <object>
//                                        still works there but desktop users miss the
//                                        whole point of the inline view.
//       frame-src  'self'              — Chrome routes <object type=application/pdf>
//                                        through its built-in PDF viewer iframe, which
//                                        is governed by frame-src; without this the
//                                        PDF area renders blank on Chromium browsers.
//
// Default helmet style-src includes 'unsafe-inline' for backwards compat
// with libraries that inject inline styles; lucide-react's SVG icons are
// rendered through React (no inline <style>) so this is generous but
// not load-bearing today.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // @react-pdf/renderer compiles its layout engine via WebAssembly
        // at runtime (yoga-wasm-web). Browsers gate WebAssembly.instantiate
        // behind script-src 'unsafe-eval' (the wasm-eval directive isn't
        // shipped in Chromium yet). Without this, the PDF picker on the
        // Resumes slide errors with "Compiling or instantiating WebAssembly
        // module violates the following Content Security policy directive
        // because 'unsafe-eval' is not an allowed source." 'wasm-unsafe-eval'
        // is the narrower modern alternative and we list it first; the
        // 'unsafe-eval' fallback covers older browsers that don't
        // recognise the wasm-specific keyword.
        "script-src": ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'"],
        "object-src": ["'self'"],
        // <iframe> embeds need both:
        //   - same-origin <object type=application/pdf> (Chrome routes
        //     these through its built-in PDF viewer)
        //   - blob: URLs from @react-pdf/renderer's <PDFViewer> (it
        //     generates a blob and feeds it to an iframe for live preview)
        "frame-src": ["'self'", "blob:"],
        // pdf.js spawns a Worker from a same-origin module asset
        // (configured via pdfjs.GlobalWorkerOptions.workerSrc in
        // src/viewer.js). worker-src in CSP3 falls back to script-src,
        // but some browsers still gate it explicitly — naming it here
        // avoids "fake worker" mode (which renders synchronously in
        // the main thread and stalls the UI on big PDFs). 'blob:' is
        // included for the rare path where pdf.js bootstraps via a
        // blob: URL on Safari.
        "worker-src": ["'self'", "blob:"],
        // @react-pdf/renderer's font loader fetches each registered
        // font URL, then re-reads it through Fetch from an internal
        // data: URL it builds from the buffer. Helmet's default
        // connect-src 'self' blocks that re-fetch, which leaves the
        // font buffer empty and crashes fontkit on the first glyph
        // encode with "RangeError: Offset is outside the bounds of
        // the DataView" (txe._addGlyph → txe.encode → ZP.embed). Allow
        // data: and blob: in connect-src so font + image embeds work.
        "connect-src": ["'self'", "data:", "blob:"],
      },
    },
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "ok", ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: "error", error: e.message });
  }
});

// Build version. Captured once at process start. Render redeploys
// always restart the process, so the value bumps with every deploy.
// Clients poll this and reload the page when it changes — keeps users
// on a stale bundle from missing schema/UI changes that just shipped.
const BUILD_VERSION = String(Date.now());
app.get("/api/version", (req, res) => {
  res.json({ version: BUILD_VERSION });
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/leads", (req, res, next) =>
  req.method === "GET" ? next() : writeLimiter(req, res, next)
);
app.use("/api/counsellors", (req, res, next) =>
  req.method === "GET" ? next() : writeLimiter(req, res, next)
);
app.use("/api/tasks", (req, res, next) =>
  req.method === "GET" ? next() : writeLimiter(req, res, next)
);
app.use("/api/students", (req, res, next) =>
  req.method === "GET" ? next() : writeLimiter(req, res, next)
);
app.use("/api/applications", (req, res, next) =>
  req.method === "GET" ? next() : writeLimiter(req, res, next)
);
app.use("/api/required-docs", (req, res, next) =>
  req.method === "GET" ? next() : writeLimiter(req, res, next)
);
app.use("/api/admin/ai", (req, res, next) =>
  req.method === "GET" ? next() : writeLimiter(req, res, next)
);
app.use("/api/auth", writeLimiter);

// autoAudit middleware on the pre-merge surfaces (leads/tasks/counsellors)
// closes the audit gap the wiring agent flagged: those routes had ZERO
// audit log coverage despite being in production. Students router has
// inline audit() calls per-handler (more granular metadata) so it stays
// without the wrapper.
// requireStaff at the mount: leads/tasks/counsellors are admin+counsellor
// surfaces. Without this gate the GET handlers in leads.js and tasks.js
// fell through to the "no scope filter" branch for student sessions and
// returned the full firm-wide roster (PII: contact, lead notes, due
// dates, counsellor assignments). The /counsellors handler already
// bottomed out at `return [].json([])` for students, but mounting
// requireStaff makes the boundary explicit + uniform across all three
// staff routes.
app.use("/api/leads", requireAuth, requireStaff, autoAudit("leads"), leadsRouter);
app.use("/api/counsellors", requireAuth, requireStaff, autoAudit("counsellors"), counsellorsRouter);
app.use("/api/tasks", requireAuth, requireStaff, autoAudit("counsellor_tasks"), tasksRouter);
app.use("/api/students", requireAuth, studentsRouter);
// Applications router carries both staff and student (/me) handlers.
app.use("/api/applications", requireAuth, autoAudit("intake_applications"), applicationsRouter);
// Required-docs router carries BOTH staff and student handlers, so it
// can't be gated by requireStaff at the mount point — each handler
// calls requireStaff or requireStudent itself. Audit wrapper still
// fine: it noops on routes that don't write.
app.use("/api/required-docs", requireAuth, autoAudit("intake_required_docs"), requiredDocsRouter);
// Admin-only AI artifact pipeline (/pending, /dispatch). Mount-level
// requireAuth + admin-only checks inside each handler. Used by the
// scheduled Claude Code routine that runs manual_opus_generate.md
// every hour against unprocessed students.
app.use("/api/admin/ai", requireAuth, autoAudit("intake_students"), adminAiRouter);
app.use("/api/auth", authRouter);

const distPath = path.join(__dirname, "..", "dist");
// Hashed-asset / HTML cache split. Vite emits assets under /assets/
// with a content hash in the filename so they can be cached forever
// — if the content changes, the hash changes and the URL changes
// with it. The index.html that references them must NOT be cached
// or a returning user keeps loading the previous asset bundle for
// weeks. Reported by a counsellor on 2026-05-11: code change shipped
// two days earlier, they still saw the pre-slide-review vertical
// layout on first page-load today.
app.use(express.static(distPath, {
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
}));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(distPath, "index.html"));
});

app.use((err, req, res, next) => {
  // express.json() throws SyntaxError on malformed JSON bodies — surface
  // as 400 rather than 500 (live probe found this leaking as a 500
  // before, which adversarial scanners love to flag). express-rate-limit
  // throws a typed error too; respect its statusCode if present.
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "request body too large" });
  }
  if (err && (err instanceof SyntaxError) && "body" in err) {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  if (err && typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message || "bad request" });
  }
  console.error("[error]", err);
  res.status(500).json({ error: err.message || "internal error" });
});

const PORT = process.env.PORT || 3000;

async function start() {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.error(
      "[startup] ADMIN_USERNAME and ADMIN_PASSWORD must be set in env. Refusing to start."
    );
    process.exit(1);
  }
  await migrate();
  // Boot invariants: refuse to start if plaintext counsellor passwords
  // remain. Surface storage misconfig (e.g., STORAGE_BACKEND=s3 with
  // missing bucket creds) at startup, not at first upload. Sweep async
  // jobs that died with the previous process so the frontend doesn't
  // poll dead rows forever.
  await refuseIfPlaintextPasswordsPresent();
  await initStorage();
  await seedCorpusIfEmpty();
  await failOrphanedAsyncJobs();
  await pruneExpiredSessions();
  setInterval(pruneExpiredSessions, SESSION_GC_INTERVAL_MS).unref?.();
  app.listen(PORT, () => {
    console.log(`Persona Followup Panel listening on :${PORT}`);
  });
}

start().catch((e) => {
  console.error("[startup] failed:", e);
  process.exit(1);
});
