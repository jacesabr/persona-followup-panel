import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import pool from "./db.js";
import { requireAuth, SLIDING_EXPIRY_DAYS } from "./middleware/auth.js";
import leadsRouter from "./routes/leads.js";
import counsellorsRouter from "./routes/counsellors.js";
import tasksRouter from "./routes/tasks.js";
import authRouter from "./routes/auth.js";
import studentsRouter from "./routes/students.js";
import { migrate } from "./migrate.js";
import { initStorage } from "./storage.js";

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

// Boot-time sweeper for in-flight extraction rows. If the process died
// mid-Gemini-call (Render redeploy, OOM, free-tier sleep cycle), the row
// stays 'running' forever and the frontend FileSlot polls it forever
// — the polling loop only stops on a terminal status. Mark them failed
// so the student gets the retry button instead of an indefinite spinner.
async function failOrphanedExtractions() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE intake_extractions
          SET status = 'failed',
              error  = COALESCE(error, 'Process restarted before extraction completed.')
        WHERE status IN ('pending', 'running')`
    );
    if (rowCount > 0) {
      console.log(`[extractions] swept ${rowCount} orphaned row(s) to failed`);
    }
  } catch (e) {
    console.error("[extractions] orphan sweep failed:", e);
  }
}

// Same problem for resumes + insights once those become async-execute.
// Today both tables exist but no executor is wired; this is here so the
// sweeper is in place when generation lands.
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

// Boot-time integrity gate: if any counsellor row still holds a bare
// plaintext password (pre-hash-migration legacy), the constant-time
// compare path in /api/auth/login still fires and we never get to a
// fully-hashed DB. Refuse to start when we shouldn't be deployed.
async function refuseIfPlaintextPasswordsPresent() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, username FROM counsellors
        WHERE password IS NOT NULL AND password NOT LIKE 'scrypt:%'`
    );
    if (rows.length > 0) {
      console.error(
        `[startup] ${rows.length} counsellor row(s) still hold plaintext passwords:`,
        rows.map((r) => `${r.username || r.id} (${r.name})`).join(", ")
      );
      console.error(
        "[startup] reset their passwords (admin UI) so they get re-hashed, then redeploy."
      );
      process.exit(1);
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
//
// Default helmet style-src includes 'unsafe-inline' for backwards compat
// with libraries that inject inline styles; lucide-react's SVG icons are
// rendered through React (no inline <style>) so this is generous but
// not load-bearing today.
app.use(helmet());
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
app.use("/api/auth", writeLimiter);

app.use("/api/leads", requireAuth, leadsRouter);
app.use("/api/counsellors", requireAuth, counsellorsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/students", requireAuth, studentsRouter);
app.use("/api/auth", authRouter);

const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
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
  await failOrphanedExtractions();
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
