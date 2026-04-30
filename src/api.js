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
    throw new Error(detail.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Default returns only active leads. Admin passes { includeArchived: true }
  // to also receive archived rows for the collapsible "Archived" section.
  listLeads: ({ includeArchived = false } = {}) =>
    request(
      "GET",
      `/api/leads${includeArchived ? "?include_archived=true" : ""}`
    ),
  listCounsellors: () => request("GET", "/api/counsellors"),
  createCounsellor: (data) => request("POST", "/api/counsellors", data),
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
