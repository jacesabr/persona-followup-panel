import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import leadsRouter from "./routes/leads.js";
import counsellorsRouter from "./routes/counsellors.js";
import { migrate } from "./migrate.js";
import { seedIfEmpty } from "./seed.js";
import { startCron } from "./cron.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

app.use("/api/leads", leadsRouter);
app.use("/api/counsellors", counsellorsRouter);

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
  startCron();
  app.listen(PORT, () => {
    console.log(`Persona Followup Panel listening on :${PORT}`);
  });
}

start().catch((e) => {
  console.error("[startup] failed:", e);
  process.exit(1);
});
