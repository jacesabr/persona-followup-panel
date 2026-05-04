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
  // Default: gemini, with automatic failover to Anthropic on quota
  // exhaustion if ANTHROPIC_API_KEY is set. The live QA pass discovered
  // the production Gemini key is on free-tier with limit:0 — every call
  // 429s. Without failover, a single dead key takes the whole pipeline
  // down and the user discovers it by uploading and waiting for a
  // 'failed' row. With failover + a funded Anthropic key, generation
  // degrades to the secondary provider transparently.
  try {
    const r = await generateWithGemini(req);
    return { ...r, provider: "gemini" };
  } catch (e) {
    if (isQuotaError(e) && process.env.ANTHROPIC_API_KEY) {
      console.warn(
        `[llm] Gemini quota exhausted (${e.message?.slice(0, 200)}); failing over to Anthropic for purpose=${req.purpose || "unknown"}`
      );
      const r = await generateWithAnthropic(req);
      return { ...r, provider: "anthropic", failedOver: true };
    }
    throw e;
  }
}

// Detect Gemini's quota-exhausted error shape. The @google/genai SDK
// surfaces the upstream HTTP status as `.status` (number) on its
// ApiError, but quota errors also embed `"code":429` and
// `"status":"RESOURCE_EXHAUSTED"` in the message string. Match any of
// those — false positives here just trigger an extra Anthropic call,
// which is the safer failure mode.
function isQuotaError(e) {
  if (!e) return false;
  if (e.status === 429 || e.code === 429) return true;
  const msg = String(e.message || "").toLowerCase();
  // Tolerant matching: Google's canonical form is uppercase
  // RESOURCE_EXHAUSTED + "code":429 with no space, but the underlying
  // HTTP transport / SDK may reformat. Also catch generic "quota" /
  // "rate limit" phrasing — false positives here just trigger an
  // extra Anthropic call, which is the safer failure mode than
  // surfacing a raw error to the user.
  return (
    msg.includes("resource_exhausted") ||
    msg.includes('"code":429') ||
    msg.includes('"code": 429') ||
    msg.includes("quota") ||
    msg.includes("rate limit")
  );
}

// ----------------------------------------------------------------
// Schema converter shared by both adapters. Gemini's @google/genai
// SDK uses uppercase Type enums (Type.OBJECT, Type.STRING, …) which
// are essentially JSON Schema with type strings UPPERCASED + a few
// proprietary keys (propertyOrdering, nullable). Anthropic tool_use
// expects vanilla JSON Schema 2020-12. Convert recursively at the
// boundary.
//
// Critical (caught by adversarial-on-change agent): `nullable: true`
// is OpenAPI 3.0 syntax that Anthropic does NOT recognise. Without
// translation, every nullable field on the marksheet schema (almost
// all of them) becomes "required string", and Claude fabricates "0"
// or "" to satisfy the schema instead of returning null. JSON Schema
// 2020-12's equivalent is `type: [<t>, "null"]`.
//
// Also drops Gemini-specific `format` values that aren't valid JSON
// Schema (e.g. `format: "enum"`).
// ----------------------------------------------------------------
const GEMINI_ONLY_KEYS = new Set(["propertyOrdering"]);
const VALID_JSON_SCHEMA_FORMATS = new Set([
  "date-time", "time", "date", "duration",
  "email", "idn-email", "hostname", "idn-hostname",
  "ipv4", "ipv6", "uri", "uri-reference", "iri", "iri-reference",
  "uuid", "uri-template",
  "json-pointer", "relative-json-pointer", "regex",
]);

export function toJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toJsonSchema);

  const out = {};
  let typeStr = null;
  let isNullable = false;

  for (const [k, v] of Object.entries(schema)) {
    if (GEMINI_ONLY_KEYS.has(k)) continue;
    if (k === "type" && typeof v === "string") {
      typeStr = v.toLowerCase();
    } else if (k === "nullable") {
      isNullable = !!v;
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)])
      );
    } else if (k === "items") {
      out.items = toJsonSchema(v);
    } else if (k === "format" && typeof v === "string") {
      // Drop format values JSON Schema doesn't know about (Gemini-
      // specific). Anthropic ignores unknown format strings but the
      // strict JSON-Schema-compatible thing is to omit them.
      if (VALID_JSON_SCHEMA_FORMATS.has(v)) out.format = v;
    } else {
      out[k] = v;
    }
  }

  // Type emit: union with "null" if nullable, plain otherwise.
  if (typeStr) {
    out.type = isNullable ? [typeStr, "null"] : typeStr;
  } else if (isNullable) {
    // Nullable without a base type is technically permissive — let
    // it through as just `null`. Shouldn't happen with our schemas.
    out.type = "null";
  }

  return out;
}
