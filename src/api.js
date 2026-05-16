// Thin wrapper over fetch with JSON + error handling.
// In production, frontend and API share an origin (Express serves dist/), so /api works.
// In dev, vite.config.js proxies /api → :3000.

// Global handler invoked when a protected route returns 401 (cookie no
// longer good) OR a role-mismatch 403 (cookie is valid but for a
// different role than the UI expects — happens when another tab logs
// in as a different role and overwrites the shared persona_session
// cookie). App.jsx registers a listener that re-bootstraps from
// /api/auth/me so the UI re-routes to the role the cookie now holds,
// or falls back to login if the cookie is gone.
//
// /api/auth/login, /api/auth/me, and /api/auth/logout are excluded —
// each handles its own 401 in-place (wrong creds, bootstrap probe,
// already-cleared session). Without this exclusion, a failed login
// would yank the user back to a fresh login screen mid-keystroke.
let onUnauthorized = () => {};
const AUTH_EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
]);
// 403 bodies emitted by requireStaff / requireAdmin / requireStudent.
// These three indicate a role mismatch (the cookie is valid, just for a
// role that doesn't match this route) — the signal we use to trigger a
// session re-bootstrap.
const ROLE_MISMATCH_ERRORS = new Set(["staff only", "admin only", "student only"]);

export function setUnauthorizedHandler(fn) {
  onUnauthorized = typeof fn === "function" ? fn : () => {};
}

async function request(method, path, body) {
  const res = await fetch(path, {
    // credentials: "same-origin" is fetch's default and matches our
    // setup (Express serves the React bundle from the same origin in
    // production, vite proxies through localhost in dev — both qualify
    // as same-origin). Explicit here so a future contributor doesn't
    // wonder why cookies are flowing.
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = { error: res.statusText };
    }
    const err = new Error(detail.error || `HTTP ${res.status}`);
    err.status = res.status;
    // 401 = cookie no longer maps to a live session. 403 with one of
    // ROLE_MISMATCH_ERRORS = cookie is valid but for a different role
    // (typically because another tab overwrote the shared cookie). Both
    // mean the UI's notion of who's logged in is stale — fire the
    // handler so App.jsx re-bootstraps from /api/auth/me and re-routes.
    if (!AUTH_EXEMPT_PATHS.has(path)) {
      if (res.status === 401) onUnauthorized();
      else if (res.status === 403 && ROLE_MISMATCH_ERRORS.has(detail.error)) onUnauthorized();
    }
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Auth: cookie-based sessions (httpOnly + SameSite=Strict). The cookie
  // is the source of truth — these methods just open / close it on the
  // server and tell the client what role landed in.
  login: (username, password) =>
    request("POST", "/api/auth/login", { username, password }),
  logout: () => request("POST", "/api/auth/logout"),
  // Returns { user_kind, counsellor? } when a valid cookie is present;
  // throws 401 otherwise. App.jsx calls this on first paint to decide
  // whether to render the login form or the role-appropriate panel.
  me: () => request("GET", "/api/auth/me"),
  // Build version — bumps on every Render redeploy (server captures
  // process start time at boot). Client polls this and prompts a reload
  // when it changes so users on a stale bundle don't miss schema/UI
  // shipped under them.
  getVersion: () => request("GET", "/api/version"),
  // Default returns only active leads. Pass { includeArchived: true } to
  // also receive archived rows. Counsellor sessions are server-scoped to
  // their own leads regardless of params; admin sessions can opt-in to a
  // counsellor scope via { counsellorId } (used by the impersonation
  // view so the wire response only carries that counsellor's leads).
  listLeads: ({ includeArchived = false, counsellorId = null } = {}) => {
    const qs = [];
    if (includeArchived) qs.push("include_archived=true");
    if (counsellorId) qs.push(`counsellor_id=${encodeURIComponent(counsellorId)}`);
    return request(
      "GET",
      `/api/leads${qs.length ? `?${qs.join("&")}` : ""}`
    );
  },
  listCounsellors: () => request("GET", "/api/counsellors"),
  // Named admins (from EXTRA_ADMINS) shown in the counsellor assignee picker.
  listAdminAccounts: () => request("GET", "/api/counsellors/admin-accounts"),
  createCounsellor: (data) => request("POST", "/api/counsellors", data),
  updateCounsellor: (id, patch) =>
    request("PATCH", `/api/counsellors/${id}`, patch),
  createLead: (data) => request("POST", "/api/leads", data),
  updateLead: (id, patch) => request("PATCH", `/api/leads/${id}`, patch),
  archiveLead: (id) => request("POST", `/api/leads/${id}/archive`),
  unarchiveLead: (id) => request("POST", `/api/leads/${id}/unarchive`),
  // Admin-only hard delete of an archived lead. Server enforces the
  // archived-only guard + admin role; the FK on intake_students.lead_id
  // is ON DELETE SET NULL so the student row + their intake data stay
  // intact — only the followup series (lead row + appointments + tasks)
  // is removed.
  deleteLead: (id) => request("DELETE", `/api/leads/${id}`),
  // Appointment history (used by the simple panel calendar).
  listAppointments: (leadId) =>
    request("GET", `/api/leads/${leadId}/appointments`),
  createAppointment: (leadId, body) =>
    request("POST", `/api/leads/${leadId}/appointments`, body),
  updateAppointment: (leadId, apptId, body) =>
    request("PATCH", `/api/leads/${leadId}/appointments/${apptId}`, body),
  setFollowup: (leadId, body) =>
    request("PUT", `/api/leads/${leadId}/followup`, body),
  // Counsellor task list (separate from per-lead actionables). Default
  // hides archived; pass includeArchived to retrieve both sets.
  // appointmentId narrows the list to tasks logged inside one specific
  // session — used by the SessionPopup.
  listTasks: ({ includeArchived = false, appointmentId = null } = {}) => {
    const qs = [];
    if (includeArchived) qs.push("include_archived=true");
    if (appointmentId != null) qs.push(`appointment_id=${encodeURIComponent(appointmentId)}`);
    return request("GET", `/api/tasks${qs.length ? `?${qs.join("&")}` : ""}`);
  },
  // data may include assignee_admin_username (string) instead of assignee_id
  // when the task target is a named admin account.
  createTask: (data) => request("POST", "/api/tasks", data),
  updateTask: (id, patch) => request("PATCH", `/api/tasks/${id}`, patch),
  archiveTask: (id) => request("POST", `/api/tasks/${id}/archive`),
  unarchiveTask: (id) => request("POST", `/api/tasks/${id}/unarchive`),
  // Per-task comment thread. Counsellors use this to attach notes to a
  // task without modifying the task body itself (only admin can edit
  // task fields). Append-only — no edit/delete by design.
  listTaskComments: (id) => request("GET", `/api/tasks/${id}/comments`),
  // Returns intake_audit_log rows for this task, oldest first. The
  // history popup renders these as a timeline of edits / status flips /
  // archives, with the actor labelled and the diff shown.
  getTaskHistory: (id) => request("GET", `/api/tasks/${id}/history`),
  addTaskComment: (id, body) =>
    request("POST", `/api/tasks/${id}/comments`, { body }),
  // ----------------------------------------------------------------
  // Students. Staff (admin/counsellor) creates accounts and reviews
  // intake data; students themselves don't go through this client
  // surface — they see the StudentIntake component, which talks to
  // /api/students/me/* directly.
  // ----------------------------------------------------------------
  // Sign a student up. Returns the new account including a one-time
  // plaintext password the counsellor copies and sends to the student.
  // counsellor_id is admin-only — counsellor sessions are auto-assigned
  // to themselves server-side.
  createStudent: ({ username, counsellor_id, display_name } = {}) =>
    request("POST", "/api/students", { username, counsellor_id, display_name }),
  // Bulk-upload sibling of createStudent. When the counsellor already
  // has documents on hand, this route creates the row AND attaches the
  // uploads in one transaction, flagging the row for the AI pipeline
  // to pick up on its next hourly tick (so the intake form lands
  // pre-filled and the resume + SOP drafts are ready before the
  // student logs in). Plain multipart/form-data — no JSON wrapping —
  // so the global request() helper would lose the FormData; we hit
  // fetch directly here.
  createStudentWithDocs: async ({ username, counsellor_id, display_name } = {}, files = []) => {
    const fd = new FormData();
    fd.append("username", username || "");
    if (counsellor_id) fd.append("counsellor_id", counsellor_id);
    if (display_name) fd.append("display_name", display_name);
    for (const file of files) fd.append("files", file);
    const res = await fetch("/api/students/with-docs", {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    if (!res.ok) {
      let detail;
      try { detail = await res.json(); } catch { detail = { error: res.statusText }; }
      const err = new Error(detail.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },
  // Generate a fresh password for an existing student. Returns the
  // new plaintext one-time.
  resetStudentPassword: (studentId) =>
    request("POST", `/api/students/${studentId}/reset-password`),
  // Roster: admin sees all student accounts, counsellor sees only the
  // ones they created. Pass { includeArchived: true } to also return
  // archived rows (hidden by default so the active roster stays clean).
  listStudents: ({ includeArchived = false } = {}) =>
    request("GET", `/api/students${includeArchived ? "?include_archived=true" : ""}`),
  assignStudentCounsellor: (studentId, counsellorId) =>
    request("PATCH", `/api/students/${studentId}/assign-counsellor`, { counsellor_id: counsellorId }),
  // Detail: full intake data + uploaded files + resumes for one
  // student. Same scoping rules as listStudents.
  getStudent: (studentId) => request("GET", `/api/students/${studentId}`),
  // Admin-only: re-import the resume style corpus from disk into
  // intake_examples. Useful after replacing the example file.
  importExamples: () => request("POST", "/api/students/admin/import-examples"),
  // Staff-triggered regenerate. Used when the staff panel's "may be
  // stale" badge fires on a resume — counsellor regenerates without
  // having to ask the student to log in.
  staffRegenerateResume: (studentId, resumeId) =>
    request("POST", `/api/students/${studentId}/resumes/${resumeId}/regenerate`),
  // ----------------------------------------------------------------
  // Required documents. Per-student LOR / Internship / SOP rows.
  // Staff drafts; bulk send-requests flips to "awaiting student
  // upload" with a 5-business-day deadline; student attaches finals.
  // See server/routes/required-docs.js for the full lifecycle.
  // ----------------------------------------------------------------
  // Staff: list every row for one student (LOR/Internship/SOP).
  listRequiredDocsForStudent: (studentId) =>
    request("GET", `/api/required-docs/student/${studentId}`),
  // Staff: edit any subset of {staff_draft, recipient_*, reason_brief,
  // company_*, activity_brief}. Word caps enforced server-side.
  updateRequiredDoc: (id, patch) =>
    request("PATCH", `/api/required-docs/${id}`, patch),
  // Staff: flip marked_done_at. Body { undo: true } clears it.
  markRequiredDocDone: (id, undo = false) =>
    request("POST", `/api/required-docs/${id}/mark-done`, { undo }),
  // Admin only: approve an SOP draft. Body { undo: true } un-approves.
  approveSop: (id, undo = false) =>
    request("POST", `/api/required-docs/${id}/approve`, { undo }),
  // Staff bulk: flip requested_at + deadline_at on every LOR/Internship
  // row that's marked done and not yet sent. Pre-flight gate: every
  // LOR/Internship row must be marked done; partial sends rejected.
  sendRequiredDocRequests: (studentId) =>
    request("POST", `/api/required-docs/student/${studentId}/send-requests`),
  // Student: read own rows (drives the dashboard card).
  listMyRequiredDocs: () => request("GET", "/api/required-docs/me"),
  // Student: link a previously-uploaded intake_files row to a
  // required-doc as the stamped final. The file itself rides the
  // existing /api/students/me/upload endpoint.
  attachRequiredDocFinal: (id, fileId) =>
    request("POST", `/api/required-docs/me/${id}/attach-final`, { file_id: fileId }),

  // Student: accept an AI-suggested LOR row (sets student_accepted_at).
  // The row leaves the suggestion bucket and enters the regular
  // drafting lifecycle the counsellor manages.
  acceptLorSuggestion: (id) =>
    request("POST", `/api/required-docs/me/${id}/accept-suggestion`),
  // Student: delete an AI-suggested LOR row (only allowed on rows
  // that haven't been accepted yet; accepted rows are the
  // counsellor's responsibility to remove).
  deleteLorSuggestion: (id) =>
    request("DELETE", `/api/required-docs/me/${id}`),
  // Student: add a new LOR row themselves (the "+" button under the
  // suggestion list). Lands as already-accepted since the student
  // explicitly added it.
  createLorSelf: ({ recipient_name, recipient_role, reason_brief }) =>
    request("POST", "/api/required-docs/me", { recipient_name, recipient_role, reason_brief }),

  // ----------------------------------------------------------------
  // Applications. Per-(student × school) tracking. Replaces the
  // operator's xlsx for the active workflow. Returns three buckets in
  // one fetch: pending (awaiting counsellor review), active (in flight),
  // archived (soft-removed).
  // ----------------------------------------------------------------
  listApplications: () => request("GET", "/api/applications"),
  // Staff: same row shape as listApplications, scoped to a single
  // student. Use from the "view student" / staff-preview surfaces so
  // they don't fetch the firm-wide list and filter client-side.
  listApplicationsForStudent: (studentId) =>
    request("GET", `/api/applications/student/${encodeURIComponent(studentId)}`),
  createApplication: (data) => request("POST", "/api/applications", data),
  updateApplication: (id, patch) =>
    request("PATCH", `/api/applications/${id}`, patch),
  promoteApplication: (id, patch = {}) =>
    request("POST", `/api/applications/${id}/promote`, patch),
  archiveApplication: (id) =>
    request("POST", `/api/applications/${id}/archive`),
  unarchiveApplication: (id) =>
    request("POST", `/api/applications/${id}/unarchive`),
  // IELTS-tracking archive (independent of full-student is_archived).
  // Used by the IELTS panel to mirror the lead-sheet archive UX —
  // hides the row from the active list, surfaces it under "Archived".
  // Student: who's their assigned counsellor? Returns
  // { counsellor: { id, name, email } | null }. Used by the Application
  // status tab to surface ownership (and flag "not assigned yet").
  getMyCounsellor: () => request("GET", "/api/students/me/counsellor"),
  // Student self-submits for manual AI automation. Idempotent — safe to call
  // multiple times; returns existing pending row if one already exists.
  requestStudentAiFill: (notes = null) =>
    request("POST", "/api/students/me/request-ai-fill", { notes }),
  // Poll status: has_request, pending, processed, artifacts_ready.
  getStudentAiFillStatus: () =>
    request("GET", "/api/students/me/ai-fill-status"),
  // AI artifact pipeline — manual-fill request workflow.
  // Counsellor clicks "Request manual fill" on the create-student
  // banner; this inserts a row into manual_ai_requests so Jace sees
  // the queue and triggers the routine. Idempotent — repeated calls
  // for the same student return the existing pending row.
  // notes: free-text note from the counsellor (e.g. "use Mr Sharma as
  // Class XII Maths teacher"). force_redraft: pass true to redraft
  // existing artifacts — the dispatch endpoint reads this and runs
  // setDraft with force=true so previously-written staff_drafts are
  // overwritten rather than skipped.
  requestManualAiFill: (student_id, { notes = null, force_redraft = false } = {}) =>
    request("POST", "/api/admin/ai/request-manual-fill", {
      student_id,
      notes: notes || null,
      force_redraft: !!force_redraft,
    }),
  // Banner polls this every minute to flip "queued" → "complete"
  // once the dispatch endpoint resolves the request.
  getManualAiRequestStatus: (student_id) =>
    request("GET", `/api/admin/ai/request-status/${encodeURIComponent(student_id)}`),
  // Admin queue view — every pending (or all-time) request, with
  // student + counsellor join.
  listManualAiRequests: ({ status = "pending" } = {}) =>
    request("GET", `/api/admin/ai/manual-requests?status=${encodeURIComponent(status)}`),
  // Student: read own non-archived applications (status + deadline, no notes).
  listMyApplications: () => request("GET", "/api/applications/me"),
  // Student: create a new application against own account. Always lands
  // pending=true so the staff Applications panel surfaces it under
  // "Pending review" for triage. No archive/delete by design — once
  // submitted, the row is the staff's to triage.
  createMyApplication: (data) => request("POST", "/api/applications/me", data),
  // Per-application comment thread. Two-way: student, assigned
  // counsellor, and admin all read + write. Append-only — no edit/delete.
  listApplicationComments: (id) =>
    request("GET", `/api/applications/${id}/comments`),
  addApplicationComment: (id, body) =>
    request("POST", `/api/applications/${id}/comments`, { body }),
  listMyApplicationComments: (id) =>
    request("GET", `/api/applications/me/${id}/comments`),
  addMyApplicationComment: (id, body) =>
    request("POST", `/api/applications/me/${id}/comments`, { body }),
  archiveStudentIelts: (studentId) =>
    request("POST", `/api/students/${studentId}/ielts-archive`),
  unarchiveStudentIelts: (studentId) =>
    request("POST", `/api/students/${studentId}/ielts-unarchive`),
  // Soft-archive a student (admin or counsellor for own students).
  // Invalidates the student's sessions so they cannot log in while archived.
  archiveStudent: (studentId, reason = null) =>
    request("POST", `/api/students/${studentId}/archive`, { reason }),
  // Restore an archived student (admin only).
  unarchiveStudent: (studentId) =>
    request("POST", `/api/students/${studentId}/unarchive`),
  // Hard-delete a student (admin only). Removes all associated rows in a
  // transaction. The student should be archived first — use archiveStudent
  // before calling this. Storage blobs are NOT removed (data-persistence rule).
  deleteStudent: (studentId) =>
    request("POST", `/api/students/${studentId}/hard-delete`),

  // ----------------------------------------------------------------
  // Invoices (admin only). All routes are gated by requireAdmin on
  // the server. Company settings (firm identity, GSTIN, bank account,
  // signature, logo) are the source of truth that every invoice
  // header reads from. Both the live row AND every mutation are
  // mirrored to R2 (invoices/{fy}/{number}/{event}-{ts}.json) so the
  // bucket itself is the audit trail.
  // ----------------------------------------------------------------
  getCompanySettings: () => request("GET", "/api/admin/invoices/company-settings"),
  putCompanySettings: ({ data, logoBase64, signatureBase64 } = {}) =>
    request("PUT", "/api/admin/invoices/company-settings", { data, logoBase64, signatureBase64 }),
  listInvoices: ({ from = null, to = null, type = null } = {}) => {
    const qs = [];
    if (from) qs.push(`from=${encodeURIComponent(from)}`);
    if (to) qs.push(`to=${encodeURIComponent(to)}`);
    if (type) qs.push(`type=${encodeURIComponent(type)}`);
    return request("GET", `/api/admin/invoices${qs.length ? `?${qs.join("&")}` : ""}`);
  },
  getInvoice: (id) => request("GET", `/api/admin/invoices/${id}`),
  getNextInvoiceNumber: (fy) =>
    request("GET", `/api/admin/invoices/next-number${fy ? `?fy=${fy}` : ""}`),
  createInvoice: (data) => request("POST", "/api/admin/invoices", data),
  updateInvoice: (id, data) => request("PUT", `/api/admin/invoices/${id}`, data),
  approveInvoice: (id) => request("POST", `/api/admin/invoices/${id}/approve`),
  revertInvoice: (id) => request("POST", `/api/admin/invoices/${id}/revert`),
  deleteInvoice: (id) => request("DELETE", `/api/admin/invoices/${id}`),
  // PDF backup: client renders an approved invoice via @react-pdf/renderer,
  // POSTs the resulting bytes here so a frozen copy lands in R2 next to
  // the JSON snapshots. Returns { key, size }. Goes through fetch
  // directly because the request body is raw bytes, not JSON.
  uploadInvoicePdf: async (id, pdfBlob) => {
    const res = await fetch(`/api/admin/invoices/${id}/pdf`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBlob,
    });
    if (!res.ok) {
      let detail;
      try { detail = await res.json(); } catch { detail = { error: res.statusText }; }
      const err = new Error(detail.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },
};
