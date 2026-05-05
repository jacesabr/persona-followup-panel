// Thin wrapper over fetch with JSON + error handling.
// In production, frontend and API share an origin (Express serves dist/), so /api works.
// In dev, vite.config.js proxies /api → :3000.

// Global handler invoked when a protected route returns 401, i.e. the
// server says the cookie is no longer good. App.jsx registers a
// listener that wipes session state and falls back to the login screen.
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
    // Session-expiry: any protected endpoint returning 401 means our
    // cookie no longer maps to a live session. Fire the global handler
    // so App.jsx can clear local state instead of leaving the user with
    // a half-broken UI plus an opaque error banner.
    if (res.status === 401 && !AUTH_EXEMPT_PATHS.has(path)) {
      onUnauthorized();
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
  createTask: (data) => request("POST", "/api/tasks", data),
  updateTask: (id, patch) => request("PATCH", `/api/tasks/${id}`, patch),
  archiveTask: (id) => request("POST", `/api/tasks/${id}/archive`),
  unarchiveTask: (id) => request("POST", `/api/tasks/${id}/unarchive`),
  // Per-task comment thread. Counsellors use this to attach notes to a
  // task without modifying the task body itself (only admin can edit
  // task fields). Append-only — no edit/delete by design.
  listTaskComments: (id) => request("GET", `/api/tasks/${id}/comments`),
  addTaskComment: (id, body) =>
    request("POST", `/api/tasks/${id}/comments`, { body }),
  // ----------------------------------------------------------------
  // Students. Staff (admin/counsellor) creates accounts and reviews
  // intake data; students themselves don't go through this client
  // surface — they see the StudentIntake component, which talks to
  // /api/students/me/* directly.
  // ----------------------------------------------------------------
  // Sign a lead (or anyone) up as a student. Returns the new account
  // including a one-time plaintext password the counsellor copies and
  // sends to the student.
  createStudent: ({ username, lead_id, display_name } = {}) =>
    request("POST", "/api/students", { username, lead_id, display_name }),
  // Generate a fresh password for an existing student. Returns the
  // new plaintext one-time.
  resetStudentPassword: (studentId) =>
    request("POST", `/api/students/${studentId}/reset-password`),
  // Roster: admin sees all student accounts, counsellor sees only the
  // ones they created.
  listStudents: () => request("GET", "/api/students"),
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
};
