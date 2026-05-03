// Shared async runner used by both:
//   - POST /api/me/extractions      (manual trigger)
//   - POST /api/upload (auto-trigger on successful upload)
//
// Inserts the intake_extractions row in pending state, kicks off the
// Gemini call in the background, updates status as it progresses.
// Returns { id } so callers can hand it to the client for polling.

import pool from "../db.js";
import { getExtractor } from "./index.js";

async function executeAndStore({ extractionId, file, route }) {
  await pool.query(
    `UPDATE intake_extractions SET status = 'running' WHERE id = $1`,
    [extractionId]
  );
  try {
    const { data, model, elapsedMs, usage } = await route.run(file);

    let costCents = null;
    if (usage) {
      const inTok = usage.promptTokenCount || 0;
      const outTok = usage.candidatesTokenCount || 0;
      // Gemini 2.5 Pro: ~$1.25 / M input, ~$5 / M output (Dec 2025).
      const dollars = (inTok * 1.25 + outTok * 5) / 1_000_000;
      costCents = Math.max(1, Math.round(dollars * 100));
    }
    await pool.query(
      `UPDATE intake_extractions
          SET status = 'succeeded',
              data = $1::jsonb,
              cost_cents = $2,
              model = COALESCE(model, $3)
        WHERE id = $4`,
      [JSON.stringify({ ...data, _meta: { elapsedMs } }), costCents, model, extractionId]
    );
  } catch (err) {
    console.error(`[extract] extraction ${extractionId} failed:`, err);
    await pool.query(
      `UPDATE intake_extractions
          SET status = 'failed', error = $1
        WHERE id = $2`,
      [err.message || String(err), extractionId]
    );
  }
}

// Schedule an extraction. Inserts the row, fires the background work,
// returns { id, route, supported }.
//   - file: { id, student_id, field_id, original_name, storage_path, mime_type }
//   - returns { supported: false } if no extractor matches this field_id.
export async function scheduleExtraction(file) {
  const route = getExtractor(file.field_id);
  if (!route) return { supported: false };

  const { rows } = await pool.query(
    `INSERT INTO intake_extractions
       (file_id, student_id, extractor, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [file.id, file.student_id, route.name]
  );
  const extractionId = rows[0].id;

  // Fire-and-forget. Caller doesn't await — client polls
  // GET /api/me/extractions/:id for terminal status.
  executeAndStore({
    extractionId,
    file: {
      storagePath: file.storage_path,
      mimeType: file.mime_type,
      originalName: file.original_name,
    },
    route,
  }).catch((e) => console.error("[extract] unexpected:", e));

  return {
    supported: true,
    id: String(extractionId),
    extractor: route.name,
    status: "pending",
  };
}
