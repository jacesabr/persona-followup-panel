// Gemini adapter implementing the generateStructured contract.
// Mirrors the call shape used by server/generators/{plan,section}.js.

import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";

export async function generateWithGemini({
  systemInstruction,
  userParts = [],
  responseSchema,
  temperature = 0,
  timeoutMs = 120000,
  model = DEFAULT_MODEL,
}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });

  // Translate provider-agnostic userParts into Gemini's contents shape.
  const parts = userParts.map((p) => {
    if (p.type === "pdf") {
      return {
        inlineData: {
          mimeType: p.mimeType || "application/pdf",
          data: p.data, // base64 string
        },
      };
    }
    if (p.type === "text") return { text: p.text };
    throw new Error(`unknown part type: ${p.type}`);
  });

  const t0 = Date.now();
  let timeoutHandle;
  const timeoutP = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Gemini call exceeded ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  const callP = ai.models.generateContent({
    model,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema,
      temperature,
    },
    contents: [{ role: "user", parts }],
  });

  let response;
  try {
    response = await Promise.race([callP, timeoutP]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const elapsedMs = Date.now() - t0;
  const text = response.text;
  if (!text) throw new Error("Gemini returned no text");
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini JSON parse failed: ${e.message}`);
  }

  return {
    data,
    model,
    elapsedMs,
    usage: response.usageMetadata || null,
  };
}
