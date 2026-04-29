// Hybrid: Gemini for actionables extraction (text in → JSON out, free tier)
//         + OpenAI Whisper for audio transcription (audio in → English text out,
//           translation is Whisper's purpose-built strength).
//
// The endpoints that call this:
//   - POST /api/leads/:id/actionables/extract  → extractActionables(transcript)
//   - POST /api/leads/:id/transcript/audio     → transcribeAudio(buffer, mime)

import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

let geminiClient = null;
function getGeminiClient() {
  if (geminiClient) return geminiClient;
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }
  geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
}

// 120s ceiling on Whisper calls — long enough for ≤10 min audio (our cap)
// in the worst case, short enough that a hung call doesn't tie up a request
// past Render's HTTP timeout.
const OPENAI_TIMEOUT_MS = 120_000;

let openaiClient = null;
function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: 1, // one retry on transient network errors
  });
  return openaiClient;
}

// 30s on Gemini text extraction — input is small (≤100k transcript chars)
// and the response is bounded by our JSON schema. A timeout this short
// catches genuinely-hung calls; normal latency is 2–8s.
const GEMINI_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const response = await withTimeout(
    getGeminiClient().models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Transcript:\n\n${transcript}`,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
      },
    }),
    GEMINI_TIMEOUT_MS,
    "Gemini extractActionables"
  );

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

// Transcribe an audio file on disk via OpenAI Whisper's translations endpoint.
// We pass a fs.ReadStream rather than buffering the whole file into memory —
// this matters once multiple counsellor uploads land concurrently (Render
// free tier is 512 MB; 5 × 10 MB streamed >> 5 × 10 MB buffered).
//
// Whisper's translation mode auto-detects the source language across its 99
// supported languages (Hindi, Tamil, Bengali, Punjabi, etc.) and emits
// English. Single API call, no prompt engineering required, gold-standard
// quality on Indian-language → English. ~$0.006/min.
//
// File size cap is enforced at the multer layer (10 MB ≈ ~10 min audio).
// Whisper accepts mp3, mp4, mpeg, mpga, m4a, wav, webm.
export async function transcribeAudio(filePath) {
  if (!filePath) throw new Error("transcribeAudio requires a file path");
  const stream = fs.createReadStream(filePath);
  const result = await getOpenAIClient().audio.translations.create({
    file: stream,
    model: "whisper-1",
  });
  if (!result?.text) throw new Error("Whisper returned no transcript");
  return result.text.trim();
}
