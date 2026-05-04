// Shared manifest for the doc-review step. Imported by:
//   - src/StudentIntake.jsx (renders the screen)
//   - src/intakeProgress.js (computes step-of-N for staff lists)
//   - server/routes/students.js (validates the transition to "done")
//
// Plain JS (no JSX) so node-side ESM can import it without a bundler.
// Each entry:
//   - docFieldId: upload field id (matches a CHAPTERS file slot)
//   - title:      heading shown above the doc viewer
//   - fields:     fields the student must type while viewing the doc.
//                 Empty fields means "verify-only" (no data to type).
//   - helper:     optional sub-heading.

export const DOC_REVIEW_GROUPS = [
  {
    docFieldId: "photoFile",
    title: "Profile photo",
    helper: "Confirm this is the photo you want to use.",
    fields: [],
  },
  {
    docFieldId: "marks10sheet",
    title: "Class 10 marksheet",
    fields: [
      { id: "marks10pct", label: "Overall percentage", type: "number", placeholder: "85" },
    ],
  },
  {
    docFieldId: "marks11sheet",
    title: "Class 11 marksheet",
    fields: [
      { id: "marks11pct", label: "Overall percentage", type: "number" },
    ],
  },
  {
    docFieldId: "marks12sheet",
    title: "Class 12 marksheet",
    fields: [
      { id: "marks12pct", label: "Overall percentage", type: "number", optional: true },
    ],
  },
  {
    docFieldId: "marks12predictedSheet",
    title: "Class 12 predicted scores",
    fields: [
      { id: "marks12predicted", label: "Predicted score", type: "text", optional: true, placeholder: "e.g. 92% predicted" },
    ],
  },
  {
    docFieldId: "transcript",
    title: "University transcript",
    fields: [
      { id: "cgpa", label: "CGPA", type: "text", placeholder: "8.5 / 10" },
    ],
  },
  { docFieldId: "finalDegree", title: "Final degree", fields: [] },
  { docFieldId: "semesterTranscripts", title: "Semester transcripts", fields: [] },
  {
    docFieldId: "passportFrontBack",
    title: "Passport (front & back)",
    helper: "Type the values shown on the passport.",
    fields: [
      { id: "passport", label: "Passport #", type: "text", placeholder: "A1234567" },
      { id: "passportExpiry", label: "Expiry date", type: "date" },
    ],
  },
  { docFieldId: "passportFront", title: "Passport — front page", fields: [] },
  { docFieldId: "passportLast", title: "Passport — last page", fields: [] },
  {
    docFieldId: "ielts_result",
    title: "IELTS result",
    fields: [{ id: "ielts_score", label: "Overall score", type: "text", placeholder: "7.5" }],
  },
  {
    docFieldId: "toefl_result",
    title: "TOEFL result",
    fields: [{ id: "toefl_score", label: "Total score", type: "text", placeholder: "108" }],
  },
  {
    docFieldId: "sat_result",
    title: "SAT / ACT result",
    fields: [{ id: "sat_score", label: "Total score", type: "text", placeholder: "1480" }],
  },
  {
    docFieldId: "ap_result",
    title: "AP result",
    fields: [{ id: "ap_score", label: "Scores (per subject)", type: "text", placeholder: "Calc BC: 5, Physics C: 5" }],
  },
  {
    docFieldId: "other_result",
    title: "Other test result",
    fields: [{ id: "other_score", label: "Score", type: "text", optional: true }],
  },
  { docFieldId: "lor1", title: "Letter of recommendation 1", fields: [] },
  { docFieldId: "lor2", title: "Letter of recommendation 2", fields: [] },
  { docFieldId: "lor3", title: "Letter of recommendation 3", fields: [] },
  { docFieldId: "internship1", title: "Internship 1", fields: [] },
  { docFieldId: "internship2", title: "Internship 2", fields: [] },
  { docFieldId: "internship3", title: "Internship 3", fields: [] },
  { docFieldId: "sop", title: "Statement of purpose", fields: [] },
  { docFieldId: "resumeFile", title: "Existing resume", fields: [] },
];

export const DOC_REVIEW_BY_FIELD = Object.fromEntries(
  DOC_REVIEW_GROUPS.map((g) => [g.docFieldId, g])
);

// File slot shape: `{ name, status: "uploaded", uploadedUrl, ... }`
// when uploaded; either missing or some other shape otherwise.
function defaultIsUploaded(slot) {
  return !!slot && typeof slot === "object" && !Array.isArray(slot) && slot.status === "uploaded";
}

// Validate that the doc-review step is complete: for each group whose
// doc was uploaded, every non-optional typed field must be non-empty.
// Returns { ok, missing: [{ docFieldId, fieldId, label }] }.
//
// `isUploaded` is overridable so the server can pass a different
// predicate if the persisted shape changes; defaults to the slot shape
// the client writes.
export function validateDocReview(answers, { isUploaded = defaultIsUploaded } = {}) {
  const safe = answers && typeof answers === "object" ? answers : {};
  const missing = [];
  for (const group of DOC_REVIEW_GROUPS) {
    if (!isUploaded(safe[group.docFieldId])) continue;
    for (const f of group.fields) {
      if (f.optional) continue;
      const v = safe[f.id];
      if (v === undefined || v === null || String(v).trim() === "") {
        missing.push({ docFieldId: group.docFieldId, fieldId: f.id, label: f.label });
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
