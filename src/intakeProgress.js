// Convert an admin/counsellor student-list row into a single-line
// progress string. The list endpoint returns the phase column plus
// the raw `data` jsonb; we read both client-side so we don't have to
// duplicate the manifest into the server.
//
// `data` shape (mirrors what StudentIntake.persist() writes):
//   { answers: { fieldId: value, ... }, order: [...], lastStep: N }

import { CHAPTERS } from "./StudentIntake.jsx";
import { DOC_REVIEW_GROUPS } from "../lib/docReviewManifest.js";
import { isFileUploaded } from "./intakeFiles.js";

const TOTAL_INTAKE_PAGES = CHAPTERS.reduce((n, c) => n + c.pages.length, 0);

// Doc-review "filled" rule: for each group, the doc must be uploaded.
// Groups with typed fields additionally need every non-optional field
// non-empty. Groups with no fields (verify-only) only need the doc.
function isDocGroupFilled(group, answers) {
  const file = answers?.[group.docFieldId];
  if (!isFileUploaded(file)) return false;
  for (const f of group.fields || []) {
    if (f.optional) continue;
    const v = answers?.[f.id];
    if (v === undefined || v === null || String(v).trim() === "") return false;
  }
  return true;
}

// Doc-review "applicable" rule: a group only counts toward the
// denominator if the student actually uploaded the doc OR a sibling
// field is non-empty. Otherwise we'd show "0 of 28" forever for a
// student who never plans to take the SAT, AP, etc.
function isDocGroupApplicable(group, answers) {
  if (isFileUploaded(answers?.[group.docFieldId])) return true;
  for (const f of group.fields || []) {
    const v = answers?.[f.id];
    if (v !== undefined && v !== null && String(v).trim() !== "") return true;
  }
  return false;
}

export function progressFor(row) {
  const phase = row?.intake_phase || (row?.intake_complete ? "done" : "intake");
  const data = row?.data || {};
  const answers = (data && typeof data === "object" && data.answers) || {};

  if (phase === "done") {
    return { label: "✓ Complete", tone: "done" };
  }
  if (phase === "generating") {
    return { label: "Generating resume…", tone: "generating" };
  }
  if (phase === "doc_review") {
    const applicable = DOC_REVIEW_GROUPS.filter((g) => isDocGroupApplicable(g, answers));
    const filled = applicable.filter((g) => isDocGroupFilled(g, answers)).length;
    const total = applicable.length;
    if (total === 0) {
      return { label: "Reviewing docs · awaiting uploads", tone: "doc_review" };
    }
    return { label: `Reviewing docs · ${filled} of ${total} filled`, tone: "doc_review" };
  }
  // phase === "intake"
  const lastStep = Number.isInteger(data.lastStep) ? data.lastStep : -1;
  // lastStep is 0-indexed; -1 means hasn't passed the welcome screen.
  // Use max(lastStep + 1, 1) so a student who's started but not advanced
  // still reads as "page 1".
  const page = Math.min(TOTAL_INTAKE_PAGES, Math.max(1, lastStep + 1));
  // Show 0/N for a student who hasn't typed anything yet so it doesn't
  // claim "page 1" when nothing's been entered.
  const hasAnyAnswer = Object.values(answers).some(
    (v) => v !== undefined && v !== null && v !== "" && (typeof v !== "object" || v.status !== undefined)
  );
  if (!hasAnyAnswer) {
    return { label: `Filling intake · 0 of ${TOTAL_INTAKE_PAGES} pages`, tone: "intake" };
  }
  return {
    label: `Filling intake · page ${page} of ${TOTAL_INTAKE_PAGES}`,
    tone: "intake",
  };
}

export const TONE_CLASSES = {
  done: "text-emerald-700",
  generating: "text-amber-700",
  doc_review: "text-amber-700",
  intake: "text-stone-500",
};
