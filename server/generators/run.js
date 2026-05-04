// Resume generator orchestrator. One call to scheduleResume(spec)
// inserts an `intake_resumes` row in `pending`, returns its id, and
// fires the section-loop in the background. Caller (the route handler)
// returns the row id immediately; client polls GET /me/resumes/:id
// until status is terminal.
//
// Pipeline:
//   1. Pull the latest intake answers (typed personal info + doc-
//      derived values transcribed alongside each upload).
//   2. Run the Plan call ONCE per resume.
//   3. For each section in plan.section_order: pick the example,
//      generate, validate, accumulate.
//   4. Render Markdown + provenance manifest.
//   5. UPDATE intake_resumes with status='succeeded' and the bytes.

import pool from "../db.js";
import { buildPlan } from "./plan.js";
import { generateSection } from "./section.js";
import { validateSectionBullets } from "./validator.js";
import { renderMarkdown, renderProvenance } from "./render.js";
import { pickExamples } from "./examples.js";

const MODEL_FOR_LOG = "gemini-2.5-pro";

const DEFAULT_SECTION_RATIOS = {
  Education: 15,
  Experience: 25,
  Research: 10,
  Activities: 15,
  Awards: 15,
  Projects: 15,
  Skills: 5,
};

async function loadStudentBundle(studentId) {
  const sRes = await pool.query(
    `SELECT student_id, display_name, data, intake_complete
       FROM intake_students WHERE student_id = $1`,
    [studentId]
  );
  const student = sRes.rows[0];
  if (!student) throw new Error(`student not found: ${studentId}`);
  return { student };
}

function computeSectionBudgets({ ratios, totalWords }) {
  const safe = Object.keys(ratios).length > 0 ? ratios : DEFAULT_SECTION_RATIOS;
  const sum = Object.values(safe).reduce((a, b) => a + (Number(b) || 0), 0) || 100;
  const out = {};
  for (const [k, v] of Object.entries(safe)) {
    out[k] = Math.max(20, Math.round((Number(v) / sum) * totalWords));
  }
  return out;
}

export async function executeResume({ resumeId, spec }) {
  // Helper for status updates.
  const update = async (patch) => {
    const cols = Object.keys(patch);
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    await pool.query(
      `UPDATE intake_resumes SET ${set}, updated_at = NOW() WHERE id = $1`,
      [resumeId, ...cols.map((c) => patch[c])]
    );
  };

  try {
    await update({ status: "running" });

    // 1. Load the student record. All intake answers (typed personal
    //    info + doc-derived values transcribed alongside each upload)
    //    live in the same `data` jsonb.
    const studentRow = await pool.query(
      "SELECT student_id FROM intake_resumes WHERE id = $1",
      [resumeId]
    );
    const studentId = studentRow.rows[0]?.student_id;
    if (!studentId) throw new Error("resume row missing");
    const { student } = await loadStudentBundle(studentId);

    // 2. Plan call — one per resume.
    const planRes = await buildPlan({
      studentRecord: { data: student.data || {} },
    });
    const { plan, factsById, usage: planUsage } = planRes;

    // 3. Per-section generation.
    const totalWords = spec.length_words || (
      spec.length_pages === 1 ? 250 : spec.length_pages === 2 ? 750 : 1100
    );
    const sectionBudgets = computeSectionBudgets({
      ratios: plan.section_ratios || DEFAULT_SECTION_RATIOS,
      totalWords,
    });

    // Pull the single style anchor from intake_examples. All sections
    // see the same voice; the model uses it as a layout/tone reference
    // only.
    const { examples, example_ids } = await pickExamples();

    const sectionOrder = (plan.section_order || Object.keys(DEFAULT_SECTION_RATIOS))
      .filter((s) => s in sectionBudgets);

    const sectionResults = [];
    let totalRejected = 0;
    let totalDriftWarnings = 0;
    let costAccumCents = (planUsage ? estimateCents(planUsage) : 0);

    for (const sectionName of sectionOrder) {
      const claims = (plan.facts || [])
        .filter((f) => f.section === sectionName)
        .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
      if (claims.length === 0) continue;

      try {
        const sec = await generateSection({
          section: sectionName,
          thesis: plan.thesis,
          wordBudget: sectionBudgets[sectionName],
          claims,
          examples,
        });
        const { passed, rejected, warnings } = validateSectionBullets({
          bullets: sec.body.bullets,
          factsById,
        });
        totalRejected += rejected.length;
        totalDriftWarnings += warnings.length;
        costAccumCents += estimateCents(sec.usage);

        sectionResults.push({
          section: sectionName,
          heading: sec.body.heading || sectionName,
          bullets: passed,
          // Keep the rejections + warnings on the row for staff review.
          _meta: {
            rejected_count: rejected.length,
            warning_count: warnings.length,
            rejected_samples: rejected.slice(0, 3),
            warnings: warnings.slice(0, 3),
          },
        });
      } catch (e) {
        console.error(`[resume ${resumeId}] section ${sectionName} failed:`, e.message);
        // Don't fail the whole resume on one section — continue and
        // emit a stub so the other sections survive.
        sectionResults.push({
          section: sectionName,
          heading: sectionName,
          bullets: [],
          _meta: { error: e.message },
        });
      }
    }

    // 4. Render.
    const studentName = inferStudentName(student.data, plan);
    const generatedAt = new Date().toISOString();
    const md = renderMarkdown({
      studentName,
      sections: sectionResults,
      thesis: plan.thesis,
      generatedAt,
    });
    const provenance = renderProvenance({
      sections: sectionResults,
      factsById,
    });

    // Word-count check — log + persist a warning if the generator
    // overshot/undershot the budget. Resumes still ship; this is a
    // signal to staff (rendered in the staff detail view) so they
    // know whether to regenerate. Threshold ±20% — wider than first
    // tried (±15%) because Gemini's stochastic output regularly
    // grazes the ±15% band, producing alert fatigue. The unicode
    // letter class `\p{L}` in the filter keeps non-ASCII names like
    // "Müller" or "Français" from being undercounted.
    const actualWords = md.replace(/[#*_>`~\[\]()|-]/g, " ")
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    const targetWords = totalWords;
    const lo = Math.round(targetWords * 0.8);
    const hi = Math.round(targetWords * 1.2);
    const lengthWarning =
      actualWords < lo
        ? `Resume is ${actualWords} words; target was ${targetWords} (under by ${targetWords - actualWords}).`
        : actualWords > hi
        ? `Resume is ${actualWords} words; target was ${targetWords} (over by ${actualWords - targetWords}).`
        : null;
    if (lengthWarning) {
      console.warn(`[resume ${resumeId}] ${lengthWarning}`);
    }

    // 5. Persist. source_snapshot stores the inputs we generated from,
    //    enabling the staleness-detector to flag this resume if the
    //    student's intake data later drifts away from it.
    await update({
      status: "succeeded",
      content_md: md,
      content_html: null,
      example_ids: example_ids,
      model: MODEL_FOR_LOG,
      cost_cents: costAccumCents,
      source_snapshot: JSON.stringify({
        thesis: plan.thesis,
        section_order: sectionOrder,
        sections_meta: sectionResults.map((s) => ({
          section: s.section,
          bullet_count: s.bullets.length,
          ...s._meta,
        })),
        total_rejected: totalRejected,
        total_drift_warnings: totalDriftWarnings,
        provenance,
        plan_facts_count: (plan.facts || []).length,
        examples_used: example_ids,
        generated_at: generatedAt,
        actual_words: actualWords,
        target_words: targetWords,
        length_warning: lengthWarning,
      }),
    });
  } catch (err) {
    console.error(`[resume ${resumeId}] failed:`, err);
    try {
      await update({
        status: "failed",
        error: err.message || String(err),
      });
    } catch {}
  }
}

// Schedule a single resume generation. Inserts the row, fires
// executeResume() in the background, returns { id }. Client polls
// GET /api/students/me/resumes/:id for status.
export async function scheduleResume({ studentId, spec }) {
  const { rows } = await pool.query(
    `INSERT INTO intake_resumes
       (student_id, label, length_pages, length_words, style, domain, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id, created_at`,
    [
      studentId,
      spec.label || `${spec.length_pages}-page`,
      spec.length_pages || null,
      spec.length_words || null,
      spec.style || null,
      spec.domain || null,
    ]
  );
  const resumeId = rows[0].id;
  // Fire-and-forget; failure is captured to the row's error column.
  executeResume({ resumeId, spec }).catch((e) =>
    console.error("[resume] unexpected unhandled:", e)
  );
  return { id: String(resumeId), status: "pending" };
}

// Rough cost estimate from Gemini usage metadata. Gemini 2.5 Pro
// pricing (Dec 2025): ~$1.25 / M input tokens, ~$5 / M output tokens.
function estimateCents(usage) {
  if (!usage) return 0;
  const inTok = usage.promptTokenCount || 0;
  const outTok = usage.candidatesTokenCount || 0;
  const dollars = (inTok * 1.25 + outTok * 5) / 1_000_000;
  return Math.max(1, Math.round(dollars * 100));
}

function inferStudentName(intakeData, plan) {
  // Try the intake form first; fall back to nothing (the model can
  // include the name in the basics if it wants).
  return (
    intakeData?.answers?.name ||
    intakeData?.display_name ||
    null
  );
}
