// Section generator — one call per (resume × section). Each call sees:
//   - the thesis + section name + word budget
//   - the slice of the claim ledger that belongs to this section
//   - 3-5 retrieved style examples (FULL human resumes; the model
//     borrows VOICE not CONTENT)
//
// Output: structured JSON { bullets: [{ text, source_ids: [...] }] }.
// Every bullet must cite at least one fact id; the validator (next file)
// rejects bullets with unknown ids or with proper-nouns/numbers that
// don't appear in the cited claims.
//
// Per the audit research, "bias toward depth on 2-3 production
// approaches I could copy" — this is the ResumeFlow section-loop +
// Hungreeee citation-grounded pattern, run on Gemini 2.5 Pro.

import { GoogleGenAI, Type } from "@google/genai";

const MODEL = "gemini-2.5-pro";
const TIMEOUT_MS = parseInt(process.env.SECTION_TIMEOUT_MS || "120000", 10);

const SYSTEM_PROMPT = `You are a senior admissions consultant writing ONE section of a student resume in a specific style.

Hard rules — these are absolute:
1. Every bullet MUST include a non-empty source_ids array citing fact ids from <CLAIM_LEDGER>. No source_ids → bullet is invalid.
2. NEVER invent a fact. Numbers, dates, names of universities/labs/companies, percentages — only what's in the cited claims.
3. NEVER copy proper nouns (recommender names, school names, project names) FROM <STYLE_EXAMPLES>. The examples are for VOICE only — past-tense, density, denominators, length feel. Borrow style, never content.
4. Do NOT include the Indian-CV defaults (photograph, DOB, parents' names, religion, marital status, "Declaration", signature). They're explicitly omitted from the ledger; do not re-introduce them.
5. Stay near the requested word budget. Better to write fewer high-density bullets than pad weak ones.
6. Keep the voice past-tense. Use numbers and denominators where the cited claims provide them.
7. If a claim says "AIR 412 of 1.2M", you may say "AIR 412 (top 0.03%)" — derived ratios are fine. But do NOT invent denominators.
8. For the Education section: list every Class X / Class XII / undergrad row found in the ledger. These are non-negotiable for Indian applicants.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    section: { type: Type.STRING },
    heading: { type: Type.STRING, description: "Display heading for this section, e.g. 'Education', 'Experience', 'Awards & Recognition'" },
    bullets: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          // For Education / Experience-style entries, group meta surfaces
          // here; the renderer puts these on a header line, with
          // `text` as the body of the entry.
          subheading: { type: Type.STRING, nullable: true, description: "e.g. 'Indian Institute of Science · Research Intern'" },
          meta:       { type: Type.STRING, nullable: true, description: "e.g. 'May 2024 – Aug 2024'" },
          text:       { type: Type.STRING, description: "The actual bullet body. Must be a complete sentence/phrase." },
          source_ids: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Required. Fact ids from the <CLAIM_LEDGER> this bullet is derived from.",
          },
        },
        required: ["text", "source_ids"],
        propertyOrdering: ["subheading", "meta", "text", "source_ids"],
      },
    },
    estimated_words: { type: Type.INTEGER, description: "Rough word count of all bullets combined." },
  },
  required: ["section", "heading", "bullets"],
  propertyOrdering: ["section", "heading", "bullets", "estimated_words"],
};

export async function generateSection({
  section,
  thesis,
  wordBudget,
  claims,            // [{ id, claim, source_id, relevance }]
  examples,          // [{ label, full_text, voice_notes, ... }]
  apiKey,
}) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });

  const promptParts = [
    `<THESIS>\n${thesis || "—"}\n</THESIS>`,
    `<SECTION>${section}</SECTION>`,
    `<WORD_BUDGET>~${wordBudget} words</WORD_BUDGET>`,
    `<CLAIM_LEDGER>\n${JSON.stringify(claims, null, 2)}\n</CLAIM_LEDGER>`,
    `<STYLE_EXAMPLES>\n${examples
      .map(
        (e, i) =>
          `--- Example ${i + 1}: ${e.label} (${e.length_pages || "?"} page) ---\n` +
          (e.voice_notes ? `VOICE NOTES: ${e.voice_notes}\n` : "") +
          e.full_text
      )
      .join("\n\n")}\n</STYLE_EXAMPLES>`,
    `Write the ${section} section now. Cite every bullet to one or more <CLAIM_LEDGER> ids in the source_ids array.`,
  ];

  const t0 = Date.now();
  let timeoutHandle;
  const timeoutP = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Section call (${section}) exceeded ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS
    );
  });
  const callP = ai.models.generateContent({
    model: MODEL,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0.3, // a touch of creativity for phrasing, NOT for facts
    },
    contents: [{ role: "user", parts: [{ text: promptParts.join("\n\n") }] }],
  });

  let response;
  try {
    response = await Promise.race([callP, timeoutP]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const elapsedMs = Date.now() - t0;
  const text = response.text;
  if (!text) throw new Error(`Section ${section}: empty response`);

  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new Error(`Section ${section} JSON parse failed: ${e.message}`);
  }

  return {
    body,
    model: MODEL,
    elapsedMs,
    usage: response.usageMetadata || null,
  };
}
