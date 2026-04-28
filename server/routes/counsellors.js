import express from "express";
import pool from "../db.js";

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM counsellors ORDER BY name ASC");
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

export default router;
