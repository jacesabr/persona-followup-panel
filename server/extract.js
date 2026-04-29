// Claude-backed actionable extractor.
//
// Takes a counselling-call transcript and returns a list of concrete next
// steps. Uses Opus 4.7 with structured outputs (JSON schema enforced
// server-side) so we don't have to brittle-parse around markdown fences or
// stray prose. The endpoint that calls this is /api/leads/:id/actionables/extract.

import Anthropic from "@anthropic-ai/sdk";

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
  additionalProperties: false,
};

export async function extractActionables(transcript) {
  const response = await getClient().messages.create({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    system: SYSTEM,
    messages: [
      { role: "user", content: `Transcript:\n\n${transcript}` },
    ],
    output_config: {
      format: { type: "json_schema", schema: SCHEMA },
    },
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude returned no text content");

  const parsed = JSON.parse(textBlock.text);
  const list = Array.isArray(parsed.actionables) ? parsed.actionables : [];
  // Clamp to sane sizes; the schema doesn't constrain length, but we don't
  // want a runaway transcript producing 200 rows.
  return list
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().slice(0, 1000))
    .slice(0, 30);
}
