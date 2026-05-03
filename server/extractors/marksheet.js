// Marksheet extractor (CBSE / ICSE / ISC / state boards).
//
// Sends the PDF to Gemini 2.5 Pro with a strict responseSchema, then runs a
// cross-field sanity check (sum of subject marks vs total; computed % vs
// reported %). Mismatches don't fail — they get flagged in `data.warnings`
// so the student catches them in the review step.

import fs from "node:fs";
import { GoogleGenAI, Type } from "@google/genai";
import { getStorage } from "../storage.js";

const MODEL = "gemini-2.5-pro";

// Hard wall-clock cap on a single Gemini call. Beyond this we return a
// failed extraction the student can retry. The boot-time sweeper in
// server/index.js is a safety net; this is the primary defense.
const EXTRACTION_TIMEOUT_MS = parseInt(
  process.env.EXTRACTION_TIMEOUT_MS || "120000",
  10
);

const SYSTEM_PROMPT = `You are extracting data from an Indian school-board marksheet.

Rules — these are absolute:
1. Every numeric field must come VERBATIM from the document. Do not compute.
2. If a value is illegible or absent, use null. Never guess.
3. Subject names are taken from the marksheet, not normalised — preserve exact spelling and capitalisation.
4. "code" is the board's subject code (e.g. "041" for Mathematics on CBSE). Omit if not printed.
5. The seal/signature region is not data — ignore embossed text inside stamps.
6. For board: detect from header — "CBSE", "ICSE", "ISC", or the state name (e.g. "Punjab School Education Board"). Use "Other" if ambiguous.
7. exam_year is the year the result was issued, four digits.
8. If the marksheet shows BOTH "marks obtained" and "grade points" columns, prefer marks.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    board: {
      type: Type.STRING,
      description: "CBSE | ICSE | ISC | <State name> | Other",
    },
    exam_year: { type: Type.INTEGER, nullable: true },
    roll_no: { type: Type.STRING, nullable: true },
    student_name: { type: Type.STRING, nullable: true },
    school_name: { type: Type.STRING, nullable: true },
    school_code: { type: Type.STRING, nullable: true },
    subjects: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          code: { type: Type.STRING, nullable: true },
          name: { type: Type.STRING },
          max_marks: { type: Type.INTEGER, nullable: true },
          marks_obtained: { type: Type.INTEGER, nullable: true },
          grade: { type: Type.STRING, nullable: true },
        },
        required: ["name"],
        propertyOrdering: ["code", "name", "max_marks", "marks_obtained", "grade"],
      },
    },
    total_max: { type: Type.INTEGER, nullable: true },
    total_obtained: { type: Type.INTEGER, nullable: true },
    percentage: { type: Type.NUMBER, nullable: true },
    overall_grade: { type: Type.STRING, nullable: true },
    issue_date: { type: Type.STRING, nullable: true, description: "ISO date if present, else null" },
  },
  required: ["board", "subjects"],
  propertyOrdering: [
    "board",
    "exam_year",
    "roll_no",
    "student_name",
    "school_name",
    "school_code",
    "subjects",
    "total_max",
    "total_obtained",
    "percentage",
    "overall_grade",
    "issue_date",
  ],
};

// Cross-field consistency checks. Anything off becomes a warning the
// student sees in the review step. Never throws — the extraction is
// still considered "succeeded", just flagged.
function validate(data) {
  const warnings = [];
  const subjects = Array.isArray(data.subjects) ? data.subjects : [];

  if (subjects.length === 0) {
    warnings.push("No subjects extracted.");
  }

  const sumObtained = subjects.reduce(
    (acc, s) => acc + (typeof s.marks_obtained === "number" ? s.marks_obtained : 0),
    0
  );
  const sumMax = subjects.reduce(
    (acc, s) => acc + (typeof s.max_marks === "number" ? s.max_marks : 0),
    0
  );

  if (typeof data.total_obtained === "number" && Math.abs(data.total_obtained - sumObtained) > 1) {
    warnings.push(
      `Reported total (${data.total_obtained}) doesn't match sum of subject marks (${sumObtained}).`
    );
  }
  if (typeof data.total_max === "number" && Math.abs(data.total_max - sumMax) > 1) {
    warnings.push(
      `Reported max-total (${data.total_max}) doesn't match sum of subject max marks (${sumMax}).`
    );
  }
  if (typeof data.percentage === "number" && sumMax > 0) {
    const computed = (sumObtained / sumMax) * 100;
    if (Math.abs(computed - data.percentage) > 1) {
      warnings.push(
        `Reported percentage (${data.percentage}) differs from computed (${computed.toFixed(2)}).`
      );
    }
  }

  return warnings;
}

export async function extractMarksheet(file, { apiKey } = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });

  // Read via the storage abstraction so this works whether storage_path
  // is a local disk path or an S3 key.
  const store = await getStorage();
  const stream = await store.openReadStream(file.storagePath);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const pdfBytes = Buffer.concat(chunks);

  const t0 = Date.now();
  let timeoutHandle;
  const timeoutP = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Gemini call exceeded ${EXTRACTION_TIMEOUT_MS}ms`)),
      EXTRACTION_TIMEOUT_MS
    );
  });
  // The SDK doesn't expose AbortController on generateContent today; the
  // Promise.race lets us return early on timeout while the underlying
  // network request may still be in flight. Worst case the connection
  // dangles until the OS / Node socket timeout finishes it. Acceptable —
  // the row gets marked failed and the student sees a retry button.
  const callP = ai.models.generateContent({
    model: MODEL,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0,
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: file.mimeType || "application/pdf",
              data: pdfBytes.toString("base64"),
            },
          },
          { text: "Extract the marksheet data per the schema." },
        ],
      },
    ],
  });

  let response;
  try {
    response = await Promise.race([callP, timeoutP]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const elapsedMs = Date.now() - t0;

  // Gemini may return tool/function-call style results; for responseSchema +
  // application/json the text is a JSON string we just parse.
  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned no text");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse Gemini JSON response: ${e.message}`);
  }

  const warnings = validate(data);
  if (warnings.length) data.warnings = warnings;

  return {
    data,
    model: MODEL,
    elapsedMs,
    usage: response.usageMetadata || null,
  };
}

export default extractMarksheet;
