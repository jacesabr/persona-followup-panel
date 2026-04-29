// Hybrid: Gemini for actionables extraction (text in → JSON out, free tier)
//         + OpenAI Whisper for audio transcription (audio in → English text out,
//           translation is Whisper's purpose-built strength).
//
// The endpoints that call this:
//   - POST /api/leads/:id/actionables/extract  → extractActionables(transcript)
//   - POST /api/leads/:id/transcript/audio     → transcribeAudio(buffer, mime)

import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";

let geminiClient = null;
function getGeminiClient() {
  if (geminiClient) return geminiClient;
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }
  geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
}

let openaiClient = null;
function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
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
  const response = await getGeminiClient().models.generateContent({
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

// Transcribe an audio buffer using OpenAI Whisper's audio.translations endpoint.
// Whisper's translation mode auto-detects the source language (Hindi, Tamil,
// Bengali, Punjabi, etc. — all 99 supported langs) and emits English. Single
// API call, no prompt engineering required, gold-standard quality on Indian-
// language → English. ~$0.006/min.
//
// File size cap: 25 MB per request (matches our multer limit). For longer
// recordings, the caller should chunk; current counsellor-call lengths
// (~10 min ≈ 5 MB) sit well under.
//
// mimeType examples: "audio/mpeg", "audio/wav", "audio/mp4", "audio/webm",
// "audio/ogg". Whisper accepts mp3, mp4, mpeg, mpga, m4a, wav, webm.
export async function transcribeAudio(buffer, mimeType) {
  if (!buffer || !buffer.length) throw new Error("empty audio buffer");

  const ext = (mimeType || "").split("/")[1]?.split(";")[0] || "mp3";
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });

  const result = await getOpenAIClient().audio.translations.create({
    file,
    model: "whisper-1",
  });

  if (!result?.text) throw new Error("Whisper returned no transcript");
  return result.text.trim();
}
