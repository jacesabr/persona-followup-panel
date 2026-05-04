// Convert an admin/counsellor student-list row into a single-line
// progress string. The list endpoint returns the phase column plus
// the raw `data` jsonb; we read both client-side so we don't have to
// duplicate the manifest into the server.
//
// `data` shape (mirrors what StudentIntake.persist() writes):
//   { answers: { fieldId: value, ... }, order: [...], lastStep: N }

import { CHAPTERS } from "../lib/intakeSchema.js";

const TOTAL_INTAKE_PAGES = CHAPTERS.reduce((n, c) => n + c.pages.length, 0);

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
  // The legacy 'doc_review' phase is gone (transcription happens inline
  // on each upload page now). Any row still flagged 'doc_review' falls
  // through to the intake counter — the server migration coerces those
  // back to 'intake' so the student re-enters the merged flow.
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
  intake: "text-stone-500",
};
