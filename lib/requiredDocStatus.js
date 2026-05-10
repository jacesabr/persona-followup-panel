// Canonical state machine for `intake_required_docs` rows.
//
// Single source of truth — both the counsellor view (RequiredDocsPanel)
// and the student view (StudentDashboard) compute state from the same
// DB columns, so a divergence would mean each surface drew different
// conclusions from identical data. Each consumer keeps its OWN label
// map (counsellors and students see different copy intentionally) but
// agrees on the state.
//
// States (LOR / Internship):
//   awaiting_draft     — no staff_draft yet
//   draft_in_progress  — staff_draft present, not yet marked done
//   drafted            — marked_done_at set, ready for the student to send
//   requested          — requested_at set, sent to recipient, awaiting return
//   received           — final_file_id set, recipient sent it back
//
// States (SOP — no recipient round trip; admin approves directly):
//   awaiting_draft     — no staff_draft yet
//   drafted_sop        — staff_draft present, awaiting admin approval
//   approved           — approved_by_admin_at set

export function computeRequiredDocState(doc) {
  if (doc.kind === "sop") {
    if (doc.approved_by_admin_at) return "approved";
    if (doc.staff_draft)          return "drafted_sop";
    return "awaiting_draft";
  }
  if (doc.final_file_id)  return "received";
  if (doc.requested_at)   return "requested";
  if (doc.marked_done_at) return "drafted";
  if (doc.staff_draft)    return "draft_in_progress";
  return "awaiting_draft";
}
