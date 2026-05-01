// Thin wrapper over fetch with JSON + error handling.
// In production, frontend and API share an origin (Express serves dist/), so /api works.
// In dev, vite.config.js proxies /api → :3000.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    // credentials: "same-origin" is fetch's default and matches our
    // setup (Express serves the React bundle from the same origin in
    // production, vite proxies through localhost in dev — both qualify
    // as same-origin). Explicit here so a future contributor doesn't
    // wonder why cookies are flowing.
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
  // Default returns only active leads. Pass { includeArchived: true } to
  // also receive archived rows. Counsellor scope is enforced server-side
  // by the auth middleware — clients don't pick the scope.
  listLeads: ({ includeArchived = false } = {}) =>
    request(
      "GET",
      `/api/leads${includeArchived ? "?include_archived=true" : ""}`
    ),
  listCounsellors: () => request("GET", "/api/counsellors"),
  createCounsellor: (data) => request("POST", "/api/counsellors", data),
  updateCounsellor: (id, patch) =>
    request("PATCH", `/api/counsellors/${id}`, patch),
  createLead: (data) => request("POST", "/api/leads", data),
  updateLead: (id, patch) => request("PATCH", `/api/leads/${id}`, patch),
  archiveLead: (id) => request("POST", `/api/leads/${id}/archive`),
  unarchiveLead: (id) => request("POST", `/api/leads/${id}/unarchive`),
  // Appointment history (used by the simple panel calendar).
  listAppointments: (leadId) =>
    request("GET", `/api/leads/${leadId}/appointments`),
  createAppointment: (leadId, body) =>
    request("POST", `/api/leads/${leadId}/appointments`, body),
  updateAppointment: (leadId, apptId, body) =>
    request("PATCH", `/api/leads/${leadId}/appointments/${apptId}`, body),
  // Counsellor task list (separate from per-lead actionables). Default
  // hides archived; pass includeArchived to retrieve both sets.
  listTasks: ({ includeArchived = false } = {}) =>
    request(
      "GET",
      `/api/tasks${includeArchived ? "?include_archived=true" : ""}`
    ),
  createTask: (data) => request("POST", "/api/tasks", data),
  updateTask: (id, patch) => request("PATCH", `/api/tasks/${id}`, patch),
  archiveTask: (id) => request("POST", `/api/tasks/${id}/archive`),
  unarchiveTask: (id) => request("POST", `/api/tasks/${id}/unarchive`),
};
