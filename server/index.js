import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import pool from "./db.js";
import leadsRouter from "./routes/leads.js";
import counsellorsRouter from "./routes/counsellors.js";
import twilioStatusRouter from "./routes/twilio_status.js";
import tasksRouter from "./routes/tasks.js";
import { migrate } from "./migrate.js";
import {
  seedIfEmpty,
  ensureTestCounsellor,
  seedAppointmentsIfEmpty,
  seedTasksIfEmpty,
  backfillLeadsWithDemoHistory,
} from "./seed.js";
import { startCron } from "./cron.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));

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

app.use("/api/leads", leadsRouter);
app.use("/api/counsellors", counsellorsRouter);
app.use("/api/twilio", twilioStatusRouter);
app.use("/api/tasks", tasksRouter);

// Static frontend (Vite build output)
const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  res.sendFile(path.join(distPath, "index.html"));
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error("[error]", err);
  res.status(500).json({ error: err.message || "internal error" });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await migrate();
  await seedIfEmpty();
  await ensureTestCounsellor();
  // Backfill demo appointment history + counsellor tasks for existing DBs
  // that had seed leads before those tables were introduced. Both no-op
  // once their respective table is non-empty.
  await seedAppointmentsIfEmpty();
  await seedTasksIfEmpty();
  // Per-lead demo backfill: fills any active lead with zero appointments
  // (covers leads the user created via the form that weren't in the
  // original seed). Idempotent per-lead. Demo behavior — remove or gate
  // before going to real production.
  await backfillLeadsWithDemoHistory();
  startCron();
  app.listen(PORT, () => {
    console.log(`Persona Followup Panel listening on :${PORT}`);
  });
}

start().catch((e) => {
  console.error("[startup] failed:", e);
  process.exit(1);
});
