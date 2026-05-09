/**
 * One-shot import: reads the 'application' sheet from the Persona Discover
 * Dashboard .xlsx and bulk-inserts coloured rows into intake_applications.
 *
 * Usage:
 *   node server/scripts/import-excel-applications.js <path-to-xlsx>
 *
 * Requires xlsx package:  npm install xlsx
 * Requires DATABASE_URL to be set in .env (loaded automatically via dotenv).
 *
 * Safe to re-run: uses ON CONFLICT DO NOTHING keyed on
 * (student_name, university, program), but only enforces uniqueness
 * among archived=FALSE rows. So a re-run that includes both an old
 * cancelled application AND a new active one for the same student/uni
 * will land both: the cancelled row is inserted as archived=TRUE
 * (out of the unique-index slot), and the active row gets the slot.
 *
 * The unique index itself is created/maintained by server/migrate.js
 * — running this script no longer mutates the schema.
 */

import "dotenv/config";
import { createRequire } from "module";
import pool from "../db.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

// ── colour → canonical status ───────────────────────────────────────────────
const COLOR_STATUS = {
  "00FF00": "active",
  "6AA84F": "offer",
  "93C47D": "submitted",
  FF9900: "on_hold",
  FF0000: "cancelled",
  FFFFFF: "ongoing",
};

// ── column indices (0-based) ─────────────────────────────────────────────────
const C_NAME = 0;
const C_B = 1;
const C_C = 2;
const C_D = 3;
const C_E = 4;
const C_F = 5;
const C_G = 6;
const C_J = 9;
const C_K = 10;

// Known country names used as destination groupings in col C/D
const COUNTRIES = new Set([
  "india", "dubai", "usa", "uk", "canada", "australia", "astralia",
  "newzealand", "new zealand", "netherlands", "germany", "ireland",
  "singapore", "france", "italy", "usa ", "uk ",
]);

function isCountry(v) {
  if (v == null) return false;
  return COUNTRIES.has(String(v).trim().toLowerCase());
}

// Col C values that are task notes / markers, not university names
function isSkipC(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  if (s === "") return true;
  if (/^\*+$/.test(s)) return true;                             // *** markers
  if (COUNTRIES.has(s)) return true;                            // country destinations
  if (/^(nil|sop|known|essay|required)$/.test(s)) return true; // metadata words
  // Task-note phrases: "question to be found", "video questions", "univ finalisation", etc.
  if (/question|finalisation|video\s+question|univ\s+final/i.test(s)) return true;
  return false;
}

// ── strip leading ranking prefix: "1. ", "1 ", "1UCL", "⁠1. " ───────────────
// Only strips when digits are followed by dot/space then a letter, or directly by an uppercase letter.
// Does NOT strip "30/11/2025" (digits followed by "/").
function cleanUniversity(v) {
  if (v == null) return null;
  const cleaned = String(v)
    .trim()
    .replace(/^⁠/, "")                                    // zero-width no-break space
    .replace(/^[0-9]+(?:[.\s]+(?=[A-Za-z])|(?=[A-Z]))/, "") // "1. x", "1 x", "4UCL"
    .trim();
  return cleaned || null;
}

// ── detect values that look like a date (shouldn't be used as university) ───
function looksLikeDate(s) {
  if (s == null) return false;
  const str = String(s).trim();
  if (/^[0-9]{4,5}$/.test(str)) return true;                          // Excel serial
  if (/^[0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4}$/.test(str)) return true; // dd/mm/yy
  if (/^[0-9]{1,2}-[0-9]{1,2}/.test(str)) return true;               // date range "10-15 dec"
  if (/^[0-9]{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(str)) return true;
  return false;
}

// ── Excel serial date → JS Date ──────────────────────────────────────────────
function excelSerialToDate(serial) {
  const d = new Date((serial - 25569) * 86400 * 1000);
  return isNaN(d) ? null : d;
}

// ── parse a date string like "25/01/26", "15/12/25", "4th dec" ──────────────
function parseTextDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^done$/i.test(str)) return null;

  const dmY = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (dmY) {
    let [, d, m, y] = dmY;
    if (y.length === 2) y = "20" + y;
    const dt = new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
    if (!isNaN(dt)) return dt;
  }

  const ordinal = str.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)/i);
  if (ordinal) {
    const dt = new Date(`${ordinal[2]} ${ordinal[1]} 2025`);
    if (!isNaN(dt)) return dt;
  }

  return null;
}

function resolveDeadline(row) {
  for (const ci of [C_D, C_E, C_F]) {
    const v = row[ci];
    if (v == null) continue;
    if (typeof v === "number" && v > 40000 && v < 60000) return excelSerialToDate(v);
    const dt = parseTextDate(v);
    if (dt) return dt;
  }
  return null;
}

// ── resolve the best university value from the row ──────────────────────────
function resolveUniversity(row) {
  const rawC = row[C_C];
  const rawD = row[C_D];
  const rawE = row[C_E];

  const dIsDate =
    rawD == null ||
    (typeof rawD === "number" && rawD > 40000 && rawD < 60000) ||
    (typeof rawD === "string" && looksLikeDate(rawD.trim()));

  // Case 1 — col C is a real university name (not a marker, not a country, not a note)
  if (!isSkipC(rawC)) {
    const candidate = cleanUniversity(rawC);
    if (candidate && !looksLikeDate(candidate)) return candidate;
  }

  // Case 2 — col C is a country (Australia, UK, Canada, etc.)
  if (isCountry(rawC)) {
    if (!dIsDate) {
      // Col D has a real university name
      const candidate = cleanUniversity(rawD);
      if (candidate && !looksLikeDate(candidate)) return candidate;
    }

    // Col D is absent/date — try col E for a specific university (Pryanan-style)
    if (rawE != null) {
      const candidate = cleanUniversity(rawE);
      if (candidate && !looksLikeDate(candidate) && !/question|finalisation/i.test(candidate)) {
        return candidate;
      }
    }

    // Fall back: use the country itself as the destination grouping label
    return String(rawC).trim();
  }

  // Case 3 — col C is a marker/note/null → col D holds the university
  if (!dIsDate && rawD != null) {
    const candidate = cleanUniversity(rawD);
    if (candidate && !looksLikeDate(candidate)) return candidate;
  }

  return null;
}

// ── combine non-null text fields into a single notes string ─────────────────
function joinNotes(...parts) {
  return (
    parts
      .map((p) => (p != null ? String(p).trim() : ""))
      .filter(Boolean)
      .join(" | ") || null
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("Usage: node server/scripts/import-excel-applications.js <path-to-xlsx>");
    process.exit(1);
  }

  console.log("Reading:", xlsxPath);
  const wb = XLSX.readFile(xlsxPath, { cellStyles: true });

  const ws = wb.Sheets["application"];
  if (!ws) {
    console.error('Sheet "application" not found. Available:', wb.SheetNames.join(", "));
    process.exit(1);
  }

  const range = XLSX.utils.decode_range(ws["!ref"]);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const records = [];

  for (let r = 0; r <= range.e.r; r++) {
    const row = rows[r] || [];

    const cellAddr = XLSX.utils.encode_cell({ r, c: 0 });
    const cell = ws[cellAddr];
    const color = cell?.s?.fgColor?.rgb || cell?.s?.bgColor?.rgb;

    const status = COLOR_STATUS[color];
    if (!status) continue;

    const studentName = row[C_NAME] != null ? String(row[C_NAME]).trim() : null;
    if (!studentName) continue;

    const university = resolveUniversity(row);
    if (!university) continue;

    // Program: col F, then col J, then col E (skip date/status words)
    let program = null;
    for (const ci of [C_F, C_J, C_E]) {
      const v = row[ci];
      if (v == null) continue;
      const s = String(v).trim();
      if (!s || looksLikeDate(s)) continue;
      if (/^(done|offer|required|test|sop|nil|payment pending)$/i.test(s)) continue;
      program = s;
      break;
    }

    const deadline = resolveDeadline(row);

    // Country: col B if it's a place name; col C if it's a known country
    let country = null;
    const colB = row[C_B] != null ? String(row[C_B]).trim() : "";
    if (colB && !/^(sop|known|nil|required|essay|done|\*+)$/i.test(colB) && colB.length < 30) {
      country = colB;
    } else if (isCountry(row[C_C])) {
      country = String(row[C_C]).trim();
    }

    const requirements = row[C_E] != null ? String(row[C_E]).trim() || null : null;
    const notes = joinNotes(row[C_G], row[C_J], row[C_K]);

    records.push({ studentName, university, program, deadline, country, requirements, notes, status });
  }

  console.log(`Found ${records.length} coloured application rows to import.`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let insertedActive = 0;
    let insertedArchived = 0;
    let skipped = 0;

    for (const rec of records) {
      // status='cancelled' rows represent applications the student has
      // already given up on — insert them as archived=TRUE so they
      // don't occupy the (name, uni, program) unique-index slot, and a
      // re-application later (or in the same import) lands cleanly.
      const isCancelled = rec.status === "cancelled";
      const res = await client.query(
        `INSERT INTO intake_applications
           (student_name, university, program, deadline, country, requirements, notes, status, pending, archived, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10)
         ON CONFLICT (LOWER(TRIM(student_name)), LOWER(TRIM(university)), COALESCE(LOWER(TRIM(program)), ''))
           WHERE student_id IS NULL AND archived = FALSE
         DO NOTHING`,
        [
          rec.studentName,
          rec.university,
          rec.program ?? null,
          rec.deadline ?? null,
          rec.country ?? null,
          rec.requirements ?? null,
          rec.notes ?? null,
          rec.status,
          isCancelled,
          isCancelled ? new Date() : null,
        ]
      );
      if (res.rowCount > 0) {
        if (isCancelled) insertedArchived++;
        else insertedActive++;
      } else skipped++;
    }

    await client.query("COMMIT");
    console.log(
      `Done. Inserted active: ${insertedActive}, inserted archived (cancelled): ${insertedArchived}, skipped (active duplicates): ${skipped}`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Import failed, rolled back:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
