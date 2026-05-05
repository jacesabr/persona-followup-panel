// Single source of truth for the general intake form's schema.
// Imported by:
//   - src/StudentIntake.jsx (renders the form)
//   - src/intakeProgress.js (computes step-of-N for staff lists)
//   - server/routes/students.js (defence-in-depth validation on the
//     intake → done phase transition)
//
// Plain JS (no JSX) so node-side ESM can import without a bundler.
//
// Flag semantics relevant to validation:
//   - page.optional       → entire page can be skipped; nothing on it
//                           is required regardless of field flags.
//   - page.requireAtLeastOne → at least one field on the page must be
//                              filled, even if every field is
//                              individually marked optional. (Used for
//                              p_marks12: marksheet OR predicted-scores
//                              sheet, either is fine.)
//   - field.optional      → field doesn't block page advance.
//   - field.type === 'repeater' → array; treated as "filled" if any
//                                 row has at least one populated cell.
//   - page.layout === 'split' → renders the page in a left (file slot
//                               + inline preview) / right (text fields)
//                               split layout so the student can
//                               transcribe doc-derived values while
//                               looking at the upload they just made.
//                               StudentIntake.jsx auto-detects mixed
//                               pages, but pages can opt-in explicitly.

export const CHAPTERS = [
  {
    id: "personal",
    title: "Personal details",
    pages: [
      {
        id: "p_basics",
        title: "Tell us about yourself",
        helper: "The basics — we'll use these everywhere else.",
        fields: [
          { id: "name", label: "Full name", type: "text", placeholder: "First Last" },
          { id: "email", label: "Email", type: "email", placeholder: "name@example.com" },
          { id: "phone", label: "Phone", type: "tel", placeholder: "+91 98XXX XXXXX" },
          { id: "bloodGroup", label: "Blood group", type: "text", placeholder: "O+", optional: true },
        ],
      },
      {
        id: "p_address",
        title: "Where you live",
        fields: [
          { id: "houseAddress", label: "House address", type: "textarea", placeholder: "Street, area, city, state, PIN" },
        ],
      },
      {
        id: "p_aadhar",
        title: "Aadhar card",
        helper: "Upload a photo or scan, then type the number from it.",
        fields: [
          { id: "aadharFile", label: "Aadhar card scan", type: "file", accept: "image/jpeg,image/png,application/pdf", maxSizeMB: 5 },
          { id: "aadhar", label: "Aadhar card #", type: "text", placeholder: "XXXX XXXX XXXX", normalize: "aadhar", inputMode: "numeric", autoComplete: "off" },
        ],
      },
      {
        id: "p_pan",
        title: "PAN card",
        helper: "Skip if you don't have a PAN yet.",
        optional: true,
        fields: [
          { id: "pan", label: "PAN card #", type: "text", optional: true },
        ],
      },
      {
        id: "p_photo",
        title: "Upload your photo",
        helper: "White background, formals, 3.5×4.5 cm. JPG or PDF.",
        fields: [
          { id: "photoFile", label: "Photo", type: "file", accept: "image/jpeg,image/png,application/pdf", maxSizeMB: 5 },
        ],
      },
    ],
  },
  {
    id: "schooling",
    title: "Schooling",
    pages: [
      {
        id: "p_school",
        title: "Your school (undergraduate)",
        fields: [
          { id: "schoolName", label: "School name", type: "text" },
          { id: "schoolEmail", label: "School email", type: "email" },
          { id: "schoolAddress", label: "School address", type: "textarea" },
        ],
      },
      {
        id: "p_uni",
        title: "Your university (post-graduate)",
        helper: "Skip if you're applying for an undergraduate program.",
        optional: true,
        fields: [
          { id: "uniName", label: "University / college", type: "text", optional: true },
          { id: "uniEmail", label: "University email", type: "email", optional: true },
          { id: "uniAddress", label: "Address", type: "textarea", optional: true },
        ],
      },
    ],
  },
  {
    id: "academics",
    title: "Academic record",
    pages: [
      {
        id: "p_marks10",
        title: "10th-grade marksheet",
        helper: "Upload the marksheet, then type the overall percentage from it.",
        fields: [
          { id: "marks10sheet", label: "Marksheet", type: "file" },
          { id: "marks10pct", label: "Overall percentage", type: "number", placeholder: "85" },
        ],
      },
      {
        id: "p_marks11",
        title: "11th-grade marksheet",
        helper: "Upload the marksheet, then type the overall percentage.",
        fields: [
          { id: "marks11sheet", label: "Marksheet", type: "file" },
          { id: "marks11pct", label: "Overall percentage", type: "number" },
        ],
      },
      {
        id: "p_marks12",
        title: "12th-grade marksheet",
        helper: "Upload either the actual marksheet OR a predicted-scores sheet (or both), then type the values from the upload.",
        // Each field is individually optional but at least one must be
        // filled — the helper says "either OR or both", and a student
        // shouldn't be able to skip class 12 entirely.
        requireAtLeastOne: true,
        fields: [
          { id: "marks12sheet", label: "Marksheet", type: "file", optional: true },
          { id: "marks12pct", label: "Overall percentage", type: "number", optional: true },
          { id: "marks12predictedSheet", label: "Predicted-scores sheet", type: "file", optional: true },
          { id: "marks12predicted", label: "Predicted score", type: "text", optional: true, placeholder: "e.g. 92% predicted" },
        ],
      },
      {
        id: "p_cgpa",
        title: "Graduate transcripts",
        helper: "Only fill if applying for a post-graduate program. Type your CGPA from the transcript.",
        optional: true,
        fields: [
          { id: "transcript", label: "Transcript", type: "file", optional: true },
          { id: "cgpa", label: "CGPA", type: "text", optional: true, placeholder: "8.5 / 10" },
          { id: "finalDegree", label: "Final degree", type: "file", optional: true },
          { id: "semesterTranscripts", label: "All-semester transcripts", type: "file", optional: true },
        ],
      },
    ],
  },
  {
    id: "passport",
    title: "Passport scans",
    pages: [
      {
        id: "p_passport_scans",
        title: "Upload passport pages",
        helper: "Front-and-back combined, plus front and last pages alone. Type the passport number and expiry from the scan.",
        fields: [
          { id: "passportFrontBack", label: "Front & back (combined)", type: "file" },
          { id: "passport", label: "Passport #", type: "text", placeholder: "A1234567", normalize: "passport", autoComplete: "off" },
          { id: "passportExpiry", label: "Expiry date", type: "date" },
          { id: "dob", label: "Date of birth", type: "date" },
          { id: "passportFront", label: "Front page", type: "file" },
          { id: "passportLast", label: "Last page", type: "file" },
        ],
      },
    ],
  },
  {
    id: "tests",
    title: "Standardized tests",
    pages: [
      {
        id: "p_ielts",
        title: "IELTS",
        helper: "Tell us where you are with IELTS. Pick one — we'll only ask follow-ups for the option you choose.",
        fields: [
          {
            id: "ielts_status",
            label: "Your IELTS status",
            type: "select",
            options: ["Already taken", "Planning to take", "Won't take"],
          },
          // Shown only when "Already taken". Score is required so the
          // counsellor panel always has a number to surface; result file
          // stays optional (some students only have the score email).
          {
            id: "ielts_score",
            label: "Overall band score",
            type: "text",
            placeholder: "7.5",
            showIf: { field: "ielts_status", equals: "Already taken" },
          },
          {
            id: "ielts_result",
            label: "Result document",
            type: "file",
            optional: true,
            showIf: { field: "ielts_status", equals: "Already taken" },
          },
          // Shown only when "Planning to take". Date helps the panel
          // surface upcoming exams; booking # is nice-to-have.
          {
            id: "ielts_planned_date",
            label: "Planned exam date",
            type: "date",
            showIf: { field: "ielts_status", equals: "Planning to take" },
          },
          {
            id: "ielts_bookingNum",
            label: "Booking #",
            type: "text",
            optional: true,
            showIf: { field: "ielts_status", equals: "Planning to take" },
          },
        ],
      },
      {
        id: "p_tests",
        title: "Other test bookings & results",
        helper: "Per test: whether it's booked, booking #, the result PDF, and the score from the result. Skip what doesn't apply.",
        optional: true,
        fields: [
          // TOEFL
          { id: "toefl_booked", label: "TOEFL · booked?", type: "checkbox", optional: true },
          { id: "toefl_bookingNum", label: "TOEFL · booking #", type: "text", optional: true },
          { id: "toefl_result", label: "TOEFL · result", type: "file", optional: true },
          { id: "toefl_score", label: "TOEFL · total score", type: "text", optional: true, placeholder: "108" },
          // SAT / ACT
          { id: "sat_booked", label: "SAT / ACT · booked?", type: "checkbox", optional: true },
          { id: "sat_bookingNum", label: "SAT / ACT · booking #", type: "text", optional: true },
          { id: "sat_result", label: "SAT / ACT · result", type: "file", optional: true },
          { id: "sat_score", label: "SAT / ACT · total score", type: "text", optional: true, placeholder: "1480" },
          // AP
          { id: "ap_booked", label: "AP · booked?", type: "checkbox", optional: true },
          { id: "ap_bookingNum", label: "AP · booking #", type: "text", optional: true },
          { id: "ap_result", label: "AP · result", type: "file", optional: true },
          { id: "ap_score", label: "AP · scores (per subject)", type: "text", optional: true, placeholder: "Calc BC: 5, Physics C: 5" },
          // Other (TUMA / TSA / etc.)
          { id: "other_booked", label: "Other · booked?", type: "checkbox", optional: true },
          { id: "other_bookingNum", label: "Other · booking #", type: "text", optional: true },
          { id: "other_result", label: "Other · result", type: "file", optional: true },
          { id: "other_score", label: "Other · score", type: "text", optional: true },
        ],
      },
    ],
  },
  {
    id: "family",
    title: "Family",
    pages: [
      {
        id: "p_father",
        title: "Father's details",
        fields: [
          { id: "father_name", label: "Name", type: "text" },
          { id: "father_dob", label: "Date of birth", type: "date" },
          { id: "father_education", label: "Education", type: "text" },
          { id: "father_institution", label: "Educational institution", type: "text" },
          { id: "father_aadhar", label: "Aadhar card", type: "text", normalize: "aadhar", inputMode: "numeric", autoComplete: "off" },
          { id: "father_occupation", label: "Occupation", type: "text" },
          { id: "father_position", label: "Position at workplace", type: "text" },
          { id: "father_phone", label: "Phone", type: "tel" },
          { id: "father_email", label: "Email", type: "email" },
          { id: "father_org", label: "Name of organisation", type: "text" },
        ],
      },
      {
        id: "p_mother",
        title: "Mother's details",
        fields: [
          { id: "mother_name", label: "Name", type: "text" },
          { id: "mother_dob", label: "Date of birth", type: "date" },
          { id: "mother_education", label: "Education", type: "text" },
          { id: "mother_institution", label: "Educational institution", type: "text" },
          { id: "mother_aadhar", label: "Aadhar card", type: "text", normalize: "aadhar", inputMode: "numeric", autoComplete: "off" },
          { id: "mother_occupation", label: "Occupation", type: "text" },
          { id: "mother_position", label: "Position at workplace", type: "text" },
          { id: "mother_phone", label: "Phone", type: "tel" },
          { id: "mother_email", label: "Email", type: "email" },
          { id: "mother_org", label: "Name of organisation", type: "text" },
        ],
      },
    ],
  },
  {
    id: "extracurriculars",
    title: "Activities & achievements",
    pages: [
      {
        id: "p_activities",
        title: "Activities, clubs, awards",
        helper: "Community service, art & culture, leadership, sports — anything that says something about you. Only 1 is required; add up to 25 if you'd like.",
        fields: [
          {
            id: "activities_list",
            label: "Your activities",
            type: "repeater",
            minRows: 1,
            max: 25,
            itemFields: [
              { id: "name", label: "Name of activity", type: "text", placeholder: "School CS Club" },
              { id: "description", label: "Description", type: "text", placeholder: "Founder & president, 30+ members" },
              { id: "proof", label: "Proof (PDF)", type: "file" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "profile_docs",
    title: "Profile documents",
    pages: [
      {
        id: "p_lors",
        title: "Letters of recommendation",
        fields: [
          { id: "lor1", label: "LOR 1", type: "file" },
          { id: "lor2", label: "LOR 2", type: "file" },
          { id: "lor3", label: "LOR 3", type: "file", optional: true },
        ],
      },
      {
        id: "p_internships",
        title: "Internships",
        helper: "Offer letters or completion certificates.",
        optional: true,
        fields: [
          { id: "internship1", label: "Internship 1", type: "file", optional: true },
          { id: "internship2", label: "Internship 2", type: "file", optional: true },
          { id: "internship3", label: "Internship 3", type: "file", optional: true },
        ],
      },
      {
        id: "p_sop",
        title: "Statement of purpose",
        helper: "Upload a draft — we'll review and give feedback.",
        fields: [
          { id: "sop", label: "SOP (PDF)", type: "file" },
        ],
      },
      {
        id: "p_resume",
        title: "Resume",
        helper: "We can also generate one from your profile. Upload one if you already have it.",
        optional: true,
        fields: [
          { id: "resumeFile", label: "Resume (PDF)", type: "file", optional: true },
        ],
      },
      {
        id: "p_other_docs",
        title: "Any other documents?",
        helper: "Anything else worth attaching — awards, certificates, character references, etc. Add as many as you need.",
        optional: true,
        fields: [
          {
            id: "otherDocs_list",
            label: "Other documents",
            type: "repeater",
            minRows: 2,
            max: 15,
            itemFields: [
              { id: "description", label: "Description", type: "text", placeholder: "What is this document?" },
              { id: "file", label: "File (PDF)", type: "file" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "story",
    title: "Your story",
    pages: [
      {
        id: "p_summary",
        title: "Tell us a bit about yourself",
        helper: "What do you love? What are you curious about? A few sentences is fine.",
        fields: [
          { id: "summary", label: "About you", type: "textarea" },
        ],
      },
    ],
  },
  {
    id: "destination",
    title: "Where you want to go",
    pages: [
      {
        id: "p_country",
        title: "Your target country",
        fields: [
          {
            id: "targetCountry",
            label: "Primary target country",
            type: "select",
            options: ["Canada", "USA", "UK", "Switzerland", "Singapore", "Australia", "Germany", "Other"],
          },
        ],
      },
      {
        id: "p_paths",
        title: "Programs & universities",
        helper: "Each row is one program at one university in one country. Add as many as you like.",
        fields: [
          {
            id: "paths_list",
            label: "Your application list",
            type: "repeater",
            minRows: 1,
            max: 10,
            itemFields: [
              { id: "country", label: "Country", type: "text", placeholder: "USA" },
              { id: "university", label: "University", type: "text", placeholder: "MIT" },
              { id: "program", label: "Program", type: "text", placeholder: "BSc Computer Science" },
            ],
          },
        ],
      },
    ],
  },
];

// Default file-slot detector — must agree with the client's
// `isFileSlot` from intakeFiles.js. The slot is "uploaded" only once
// the upload finishes (status === 'uploaded').
function defaultIsUploaded(val) {
  return (
    !!val &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    val.status === "uploaded"
  );
}

// Conditional-visibility check. Mirrored on the client in
// StudentIntake.jsx so a hidden field never appears as "missing" in the
// page-advance gate, and never blocks the intake → done transition
// here. `showIf` shape: { field: <otherFieldId>, equals: <value> }.
export function isFieldVisible(field, answers) {
  if (!field || !field.showIf) return true;
  const safe = answers && typeof answers === "object" ? answers : {};
  const { field: depField, equals } = field.showIf;
  return safe[depField] === equals;
}

// "Filled" check — kept in lock-step with the client's `isFieldFilled`
// in StudentIntake.jsx. Drift between the two would let the server
// reject answers the UI accepted (or vice versa), so any change to one
// must be mirrored in the other.
function isFilled(val, isUploaded) {
  if (val === "" || val === null || val === undefined) return false;
  if (typeof val === "boolean") return val;
  // File slot.
  if (val && typeof val === "object" && !Array.isArray(val) && "status" in val) {
    return isUploaded(val);
  }
  if (Array.isArray(val)) {
    return val.some(
      (row) =>
        row &&
        typeof row === "object" &&
        Object.values(row).some((v) => {
          if (v && typeof v === "object" && "status" in v) return isUploaded(v);
          return v !== "" && v !== null && v !== undefined && v !== false;
        })
    );
  }
  return true;
}

// Validate that every required field across the general intake is
// filled. Returns { ok, missing: [{ pageId, fieldId, label }] }.
//
// Rules (match the client's page-advance gate):
//   - skip the whole page if page.optional is true
//   - every non-optional field must be filled
//   - if page.requireAtLeastOne, at least one field on the page must
//     be filled regardless of individual flags
//
// `isUploaded` is overridable so the server can pass a different
// predicate if the persisted file-slot shape ever diverges from what
// the client writes.
export function validateIntakeRequired(
  answers,
  { isUploaded = defaultIsUploaded } = {}
) {
  const safe = answers && typeof answers === "object" ? answers : {};
  const missing = [];
  for (const chapter of CHAPTERS) {
    for (const page of chapter.pages) {
      if (page.optional) continue;
      for (const f of page.fields) {
        if (f.optional) continue;
        // Hidden conditional field → not required (the dependency answer
        // doesn't match), even if the field itself is non-optional.
        if (!isFieldVisible(f, safe)) continue;
        if (!isFilled(safe[f.id], isUploaded)) {
          missing.push({ pageId: page.id, fieldId: f.id, label: f.label });
        }
      }
      if (page.requireAtLeastOne) {
        const any = page.fields.some(
          (f) => isFieldVisible(f, safe) && isFilled(safe[f.id], isUploaded)
        );
        if (!any) {
          missing.push({
            pageId: page.id,
            fieldId: null,
            label: `${page.title} — at least one upload`,
          });
        }
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
