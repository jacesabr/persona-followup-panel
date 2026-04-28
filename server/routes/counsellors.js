import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";

const router = express.Router();

const isString = (v) => typeof v === "string";

function validateCounsellorInput(body) {
  const { name, whatsapp, email } = body;
  if (!isString(name) || name.trim().length < 1 || name.length > 200) {
    return "name must be a non-empty string up to 200 chars";
  }
  if (whatsapp !== undefined && whatsapp !== null && whatsapp !== "") {
    if (!isString(whatsapp) || !/^\d{8,15}$/.test(whatsapp)) {
      return "whatsapp must be digits only, 8-15 chars";
    }
  }
  if (email !== undefined && email !== null && email !== "") {
    if (!isString(email) || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return "email must be a valid email address (max 320 chars)";
    }
  }
  // Counsellor must be reachable on at least one channel; otherwise the
  // notify path silently no-ops for them.
  const hasWa = !!(whatsapp && whatsapp !== "");
  const hasEmail = !!(email && email !== "");
  if (!hasWa && !hasEmail) {
    return "at least one of whatsapp or email is required";
  }
  return null;
}

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM counsellors ORDER BY name ASC");
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const validationError = validateCounsellorInput(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { name, whatsapp, email } = req.body;
    const id = "c" + randomUUID().replace(/-/g, "").slice(0, 10);
    const cleanName = name.trim();
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    const cleanWa = whatsapp ? whatsapp : null;

    const { rows } = await pool.query(
      "INSERT INTO counsellors (id, name, whatsapp, email) VALUES ($1, $2, $3, $4) RETURNING *",
      [id, cleanName, cleanWa, cleanEmail]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

export default router;
