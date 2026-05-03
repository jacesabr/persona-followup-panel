// Plan call — runs once per student (cached via the `intake_insights`
// row, reused across all per-resume / per-section generation calls).
//
// Inputs : the student's intake form data + every CONFIRMED extraction.
// Output : a structured "claim ledger" — every fact a resume could cite,
//          tagged with the section it belongs in and a deterministic
//          source_id (so later section calls can be rejected if they
//          cite something that doesn't exist in the ledger).
//
// Per the audit research (RAG-resume agent), this is the source-of-
// truth artifact for hallucination control. Every later bullet must
// trace back to a `source_id` here; the validator throws away anything
// that doesn't.

import { GoogleGenAI, Type } from "@google/genai";

const MODEL = "gemini-2.5-pro";
const TIMEOUT_MS = parseInt(process.env.PLAN_TIMEOUT_MS || "120000", 10);

const SYSTEM_PROMPT = `You are a senior admissions consultant building the source-of-truth fact ledger for an Indian student applying to universities abroad.

Your job is NOT to write the resume. Your job is to:
1. Read the student's intake form + every AI-confirmed document extraction.
2. Produce a comprehensive "claim ledger" — every fact that could plausibly appear on a resume — with a stable id, the section it belongs in, a relevance score (0-100), and a pointer to where it came from.
3. Produce a one-sentence narrative thesis tying the student together.
4. Produce a recommended section ordering for the resume.

Hard rules:
- Every fact must come from the inputs. NEVER invent new facts.
- If the inputs say "AIR 412", emit "AIR 412 of 1.2M candidates" only if the denominator is also in the inputs. Never fabricate numbers.
- Strip the Indian-CV defaults that hurt foreign applications: photograph, DOB, parents' names, religion, marital status, "Declaration", signature. These exist in the intake but MUST NOT appear in the ledger.
- Always include Class X and Class XII board (CBSE/ICSE/state) and percentage when present in the extractions — foreign admissions need them to calibrate.
- Always contextualize ranks with denominators when the inputs allow (e.g. "AIR 412 of ~1.2M").
- Section choices: Education, Experience, Research, Activities, Awards, Projects, Skills, Publications, Other.
- relevance: 100 = headline-worthy (top award, top score), 70-90 = strong supporting, 40-70 = nice-to-have, <40 = filler.

source_id format: "intake:<field_id>" for intake-form facts (e.g. "intake:marks10pct"), "extraction:<extraction_id>:<json_path>" for extracted facts (e.g. "extraction:42:subjects[0].marks_obtained"). Use the actual numeric id from the inputs. The generator MUST be able to look these up.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    thesis: {
      type: Type.STRING,
      description: "One-sentence narrative arc tying the student together. ~20 words.",
    },
    section_order: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Ordered list of section names in priority order. e.g. ['Education', 'Experience', ...]",
    },
    section_ratios: {
      type: Type.OBJECT,
      description: "Map of section name -> percentage of total word budget. Must sum to ~100. e.g. {Education: 15, Experience: 35, Activities: 25, Awards: 10, Projects: 15}",
      properties: {
        Education:    { type: Type.NUMBER, nullable: true },
        Experience:   { type: Type.NUMBER, nullable: true },
        Research:     { type: Type.NUMBER, nullable: true },
        Activities:   { type: Type.NUMBER, nullable: true },
        Awards:       { type: Type.NUMBER, nullable: true },
        Projects:     { type: Type.NUMBER, nullable: true },
        Skills:       { type: Type.NUMBER, nullable: true },
        Publications: { type: Type.NUMBER, nullable: true },
        Other:        { type: Type.NUMBER, nullable: true },
      },
    },
    facts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id:        { type: Type.STRING, description: "Stable id, e.g. 'f_001', 'f_002', ..." },
          claim:     { type: Type.STRING, description: "The fact, written as a resume-ready phrase." },
          section:   { type: Type.STRING, description: "Education | Experience | Research | Activities | Awards | Projects | Skills | Publications | Other" },
          relevance: { type: Type.INTEGER, description: "0-100" },
          source_id: { type: Type.STRING, description: "intake:<field_id> or extraction:<id>:<path>" },
        },
        required: ["id", "claim", "section", "relevance", "source_id"],
        propertyOrdering: ["id", "claim", "section", "relevance", "source_id"],
      },
    },
    headline_strengths: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3-5 bullet headlines for the student's profile. Used by the basics/summary section if any.",
    },
  },
  required: ["thesis", "section_order", "section_ratios", "facts", "headline_strengths"],
  propertyOrdering: ["thesis", "section_order", "section_ratios", "facts", "headline_strengths"],
};

export async function buildPlan({ studentRecord, extractions, apiKey }) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });

  // Compose the input bundle the model sees. Both intake answers and
  // confirmed extractions, with stable ids the model can reference.
  const inputBundle = {
    intake_answers: studentRecord?.data?.answers || {},
    extractions: (extractions || [])
      .filter((e) => e.status === "succeeded")
      .map((e) => ({
        extraction_id: e.id,
        extractor: e.extractor,
        // Prefer student-edited version; fall back to AI's original.
        data: e.confirmed_data || e.data,
      })),
  };

  const t0 = Date.now();
  let timeoutHandle;
  const timeoutP = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Plan call exceeded ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS
    );
  });
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
            text:
              "Build the claim ledger for this student. Inputs follow as JSON.\n\n" +
              JSON.stringify(inputBundle, null, 2),
          },
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
  const text = response.text;
  if (!text) throw new Error("Plan call returned no text");

  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    throw new Error(`Plan JSON parse failed: ${e.message}`);
  }

  // Build a quick lookup table: fact id -> claim. Section calls reject
  // bullets that cite ids not in this set.
  const factsById = {};
  for (const f of plan.facts || []) factsById[f.id] = f;

  return {
    plan,
    factsById,
    model: MODEL,
    elapsedMs,
    usage: response.usageMetadata || null,
  };
}
