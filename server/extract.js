// Gemini-backed actionable extractor.
//
// Takes a counselling-call transcript and returns a list of concrete next
// steps. Uses gemini-2.5-flash with structured-output via responseJsonSchema
// so the response is validated against our shape server-side, not parsed
// loosely from prose. Counsellor activity (~10/day) sits well inside Gemini's
// free tier (15 RPM, 1500 req/day, 1M tokens/day).
//
// The endpoint that calls this is POST /api/leads/:id/actionables/extract.

import { GoogleGenAI } from "@google/genai";

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }
  client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const SYSTEM = `You are an assistant analyzing a counselling-call transcript at Persona, an education-counselling firm. Counsellors talk with prospective students or their parents about university applications, aptitude testing, SOP review, interview prep, and similar.

Your job: extract a list of concrete, actionable next steps from the conversation. Each actionable should:
- Start with a verb (Send, Schedule, Review, Confirm, Share, Follow up, etc.)
- Be specific enough that someone can check it off when complete
- Reference a clear owner where possible (counsellor or student/parent)
- Avoid vague items like "think about it" or "consider X"

If the transcript contains no clear actionables, return an empty list.`;

const SCHEMA = {
  type: "object",
  properties: {
    actionables: {
      type: "array",
      items: { type: "string" },
      description: "Concrete next steps extracted from the call",
    },
  },
  required: ["actionables"],
};

export async function extractActionables(transcript) {
  const response = await getClient().models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Transcript:\n\n${transcript}`,
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: SCHEMA,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned no text");

  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed.actionables) ? parsed.actionables : [];
  // Clamp to sane sizes; the schema doesn't constrain length, but we don't
  // want a runaway transcript producing 200 rows.
  return list
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().slice(0, 1000))
    .slice(0, 30);
}
