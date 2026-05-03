// Anthropic adapter implementing the generateStructured contract.
//
// Wired but DORMANT today — only fires when LLM_PROVIDER=anthropic
// (or per-purpose override) is set AND ANTHROPIC_API_KEY is present.
// The Gemini adapter remains the default so this code path doesn't
// burn budget against the unfunded key.
//
// Per the comparative-implementation audit, Claude on the citation-
// bound generation steps (plan + section) materially reduces
// hallucination vs Gemini (~3% vs ~6% on Vectara's 2026 leaderboard,
// and noticeably better at "cite source IDs, do not invent" prompts).
// When the user funds the key, flip LLM_PROVIDER=anthropic on Render
// and the entire generator pipeline routes through Claude.
//
// Structured output: Anthropic forces the model into a single
// tool_use block via tool_choice. We pass the responseSchema
// (converted from Gemini Type-enum to vanilla JSON Schema) as the
// tool's input_schema, then read the tool input back as our `data`.
// Same shape the caller expects; no upstream changes needed.

import Anthropic from "@anthropic-ai/sdk";
import { toJsonSchema } from "./index.js";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const STRUCTURED_TOOL_NAME = "respond";

export async function generateWithAnthropic({
  systemInstruction,
  userParts = [],
  responseSchema,
  temperature = 0,
  timeoutMs = 120000,
  model = DEFAULT_MODEL,
}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey: key });

  // Translate provider-agnostic userParts into Anthropic's content
  // block shape. PDFs ride as document blocks (Claude vision handles
  // them natively, same as Gemini's inlineData).
  const content = userParts.map((p) => {
    if (p.type === "pdf") {
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: p.mimeType || "application/pdf",
          data: p.data, // base64 string, no data: URI prefix
        },
      };
    }
    if (p.type === "text") return { type: "text", text: p.text };
    throw new Error(`unknown part type: ${p.type}`);
  });

  // Force structured output via a single forced tool_use. The
  // tool's input_schema doubles as the response schema; we read
  // the input out of the tool_use block as our data.
  const tool = {
    name: STRUCTURED_TOOL_NAME,
    description: "Submit your structured response. Required.",
    input_schema: toJsonSchema(responseSchema),
  };

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let resp;
  try {
    resp = await client.messages.create(
      {
        model,
        max_tokens: 8192,
        system: systemInstruction,
        messages: [{ role: "user", content }],
        tools: [tool],
        tool_choice: { type: "tool", name: STRUCTURED_TOOL_NAME },
        temperature,
      },
      { signal: ctrl.signal }
    );
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Anthropic call exceeded ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = Date.now() - t0;

  const block = (resp.content || []).find((b) => b.type === "tool_use");
  if (!block) {
    throw new Error("Anthropic response missing tool_use block");
  }

  return {
    data: block.input,
    model,
    elapsedMs,
    usage: resp.usage || null,
  };
}
