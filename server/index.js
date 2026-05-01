import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import pool from "./db.js";
import { requireAuth } from "./middleware/auth.js";
import leadsRouter from "./routes/leads.js";
import counsellorsRouter from "./routes/counsellors.js";
import tasksRouter from "./routes/tasks.js";
import authRouter from "./routes/auth.js";
import { migrate } from "./migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);

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
app.use("/api/auth", writeLimiter);

app.use("/api/leads", requireAuth, leadsRouter);
app.use("/api/counsellors", requireAuth, counsellorsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
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
  app.listen(PORT, () => {
    console.log(`Persona Followup Panel listening on :${PORT}`);
  });
}

start().catch((e) => {
  console.error("[startup] failed:", e);
  process.exit(1);
});
