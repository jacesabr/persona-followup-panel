// Structured resume payload. The AI pipeline writes one of these per
// student into intake_resumes.content_json; the <ResumeTemplate>
// component renders it as a designed single-column layout that
// matches the staff/student dashboard expectation of a real resume
// rather than free-form markdown.
//
// Schema is intentionally flat — no nested `sections[]` array — so the
// LLM prompt + the renderer + the persist script all agree on the same
// shape without needing a discriminated-union walker. Optional fields
// are either null/undefined or empty arrays; the renderer skips
// sections that have no items.
//
// schema_version is bumped any time a backward-incompatible field
// rename or shape change is made. The renderer handles unknown future
// versions by falling back to a "schema X not supported, regenerate"
// banner so a stale frontend doesn't silently mis-render.

export const CURRENT_RESUME_SCHEMA_VERSION = 1;

// JSDoc shapes — kept in this file so any consumer (renderer,
// persist script, prompt-doc generator) imports a single source of
// truth.
//
// /**
//  * @typedef {Object} ResumeBulletItem
//  * @property {string} label   Bolded leading label, e.g. "Class X" or "Entrepreneurship & Innovation Foundation Course"
//  * @property {string} body    The factual line(s); 1-3 sentences. No em-dashes, see Stealth Mode rules.
//  * @property {string} [meta]  Optional secondary line under body, e.g. dates / institution. Rendered smaller.
//  */
//
// /**
//  * @typedef {Object} ResumeContact
//  * @property {boolean} show    Renderer only includes the contact line when true. Default off — applications carry contact details, the resume is for human review.
//  * @property {string} [phone]
//  * @property {string} [email]
//  */
//
// /**
//  * @typedef {Object} ResumeJson
//  * @property {number}            schema_version       Always CURRENT_RESUME_SCHEMA_VERSION at write time.
//  * @property {string}            name                 Student's full name as written in answers.name. No nicknames.
//  * @property {string}            headline             One-liner under the name, e.g. "Class XI student, Sat Paul Mittal School, Ludhiana, Punjab".
//  * @property {ResumeContact}     [contact]
//  * @property {string}            [lede]               60-90 word intro paragraph. No bullets. Establishes voice before the hard data.
//  * @property {ResumeBulletItem[]} [education]          One bullet per schooling row with marks.
//  * @property {ResumeBulletItem[]} [standardized_tests] IELTS / TOEFL / SAT / AP rows the student has results or registrations for.
//  * @property {ResumeBulletItem[]} [activities]         Co-curricular profile: 3-6 bullets, one per activities_list row.
//  * @property {ResumeBulletItem[]} [internships]        Internship rows; label = company, body = what they did, meta = dates.
//  * @property {ResumeBulletItem[]} [volunteer]          Volunteer rows; same shape as internships.
//  * @property {string[]}          [skills]             Short list of skills woven into the closing if used; otherwise an inline strip.
//  * @property {string[]}          [languages]          ["English", "Hindi", ...]. Inline strip.
//  * @property {string}            [closing_note]       50-80 word summary paragraph at the foot. Optional.
//  */

// Render-time guard: the renderer hands this an unknown payload and
// gets back a normalised one with safe defaults. Keeps the JSX free of
// `payload?.education ?? []` noise.
export function normalizeResumeJson(raw) {
  const j = raw || {};
  return {
    schema_version: Number.isFinite(j.schema_version) ? j.schema_version : CURRENT_RESUME_SCHEMA_VERSION,
    name: typeof j.name === "string" ? j.name : "",
    headline: typeof j.headline === "string" ? j.headline : "",
    contact: j.contact && typeof j.contact === "object"
      ? { show: !!j.contact.show, phone: j.contact.phone || "", email: j.contact.email || "" }
      : { show: false, phone: "", email: "" },
    lede: typeof j.lede === "string" ? j.lede : "",
    education: arrayOfItems(j.education),
    standardized_tests: arrayOfItems(j.standardized_tests),
    activities: arrayOfItems(j.activities),
    internships: arrayOfItems(j.internships),
    volunteer: arrayOfItems(j.volunteer),
    skills: arrayOfStrings(j.skills),
    languages: arrayOfStrings(j.languages),
    closing_note: typeof j.closing_note === "string" ? j.closing_note : "",
  };
}

function arrayOfItems(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      label: typeof x.label === "string" ? x.label : "",
      body: typeof x.body === "string" ? x.body : "",
      meta: typeof x.meta === "string" ? x.meta : "",
    }))
    .filter((x) => x.label || x.body);
}

function arrayOfStrings(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
}
