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
