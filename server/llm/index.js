// Provider-agnostic LLM facade. Every server-side LLM call goes through
// generateStructured() — extractor + plan + section all use the same
// contract, so swapping providers is one env var.
//
// Default provider: gemini (we have a funded Gemini key).
// Fallback provider: anthropic (wired but currently dormant — flips on
// when LLM_PROVIDER=anthropic is set + ANTHROPIC_API_KEY is present).
//
// When the user funds the Anthropic key:
//   1. Set LLM_PROVIDER=anthropic on the Render service (env var only).
//   2. Restart. All structured-LLM calls route to Claude.
//   3. Once stable, the Gemini code path can be deleted.
//
// Choosing per-call: pass `purpose` ('extract' | 'plan' | 'section').
// Today they all resolve to the same provider; in future we can route
// vision (extract) to Gemini and text (plan/section) to Claude even
// when both keys are funded — each provider has its own strength
// per the audit research.

import { generateWithGemini } from "./gemini.js";
import { generateWithAnthropic } from "./anthropic.js";

const PROVIDER_ENV = (process.env.LLM_PROVIDER || "gemini").toLowerCase();

// Per-purpose override env. Lets us mix providers when both keys are
// funded — e.g. LLM_PROVIDER_EXTRACT=gemini LLM_PROVIDER_PLAN=anthropic.
// Falls back to PROVIDER_ENV.
function pickProvider(purpose) {
  const override = process.env[`LLM_PROVIDER_${(purpose || "").toUpperCase()}`];
  return (override || PROVIDER_ENV).toLowerCase();
}

/**
 * Single entrypoint for structured LLM calls.
 *
 * @param {object} req
 * @param {string} req.systemInstruction         — system prompt
 * @param {Array}  req.userParts                 — [{ type:"text", text }, { type:"pdf", data, mimeType }]
 * @param {object} req.responseSchema            — JSON-Schema-like (Gemini Type enums tolerated; converted)
 * @param {string} [req.purpose]                 — "extract" | "plan" | "section" (routing hint)
 * @param {number} [req.temperature=0]
 * @param {number} [req.timeoutMs=120000]
 * @returns {Promise<{ data: object, model: string, elapsedMs: number, usage: object|null, provider: "gemini"|"anthropic" }>}
 */
export async function generateStructured(req) {
  const provider = pickProvider(req.purpose);
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY not set");
    }
    const r = await generateWithAnthropic(req);
    return { ...r, provider: "anthropic" };
  }
  // Default: gemini.
  const r = await generateWithGemini(req);
  return { ...r, provider: "gemini" };
}

// ----------------------------------------------------------------
// Schema converter shared by both adapters. Gemini's @google/genai
// SDK uses uppercase Type enums (Type.OBJECT, Type.STRING, …) which
// are essentially JSON Schema with type strings UPPERCASED + a few
// proprietary keys (propertyOrdering). Anthropic tool_use expects
// vanilla lowercase JSON Schema. Convert recursively at the boundary.
// ----------------------------------------------------------------
export function toJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "propertyOrdering") continue; // Gemini-only
    if (k === "type" && typeof v === "string") {
      out.type = v.toLowerCase();
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)])
      );
    } else if (k === "items") {
      out.items = toJsonSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
