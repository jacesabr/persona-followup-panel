// Thin wrapper over fetch with JSON + error handling.
// In production, frontend and API share an origin (Express serves dist/), so /api works.
// In dev, vite.config.js proxies /api → :3000.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
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
  // Per-counsellor login. Returns the matched counsellor (sans password)
  // or throws an Error with .status = 401 on bad creds. Used by App.jsx
  // to populate the active session.
  login: (username, password) =>
    request("POST", "/api/auth/login", { username, password }),
  // Default returns only active leads. Admin passes { includeArchived: true }
  // to also receive archived rows for the collapsible "Archived" section.
  // counsellorId param scopes server-side so the wire response only
  // carries that counsellor's leads (no client-side leakage).
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
  resetLeads: () => request("POST", "/api/leads/reset"),
  // Staff workflow
  markViewed: (leadId, counsellorId) =>
    request("POST", `/api/leads/${leadId}/view`, { counsellor_id: counsellorId }),
  logCall: (leadId, body) =>
    request("POST", `/api/leads/${leadId}/call`, body),
  addActionable: (leadId, text) =>
    request("POST", `/api/leads/${leadId}/actionables`, { text }),
  updateActionable: (leadId, id, patch) =>
    request("PATCH", `/api/leads/${leadId}/actionables/${id}`, patch),
  deleteActionable: (leadId, id) =>
    request("DELETE", `/api/leads/${leadId}/actionables/${id}`),
  extractActionables: (leadId) =>
    request("POST", `/api/leads/${leadId}/actionables/extract`),
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
  uploadAudio: async (leadId, file) => {
    const fd = new FormData();
    fd.append("audio", file);
    const res = await fetch(`/api/leads/${leadId}/transcript/audio`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      let detail;
      try { detail = await res.json(); } catch { detail = { error: res.statusText }; }
      throw new Error(detail.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
};
