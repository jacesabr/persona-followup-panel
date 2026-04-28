// Thin wrapper over fetch with JSON + error handling.
// In production, frontend and API share an origin (Express serves dist/), so /api works.
// In dev, vite.config.js proxies /api → :3000.

async function request(method, path, body) {
  const token = import.meta.env.VITE_ADMIN_TOKEN;
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
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
  return res.json();
}

export const api = {
  listLeads: () => request("GET", "/api/leads"),
  listCounsellors: () => request("GET", "/api/counsellors"),
  createLead: (data) => request("POST", "/api/leads", data),
  updateLead: (id, patch) => request("PATCH", `/api/leads/${id}`, patch),
  resetLeads: () => request("POST", "/api/leads/reset"),
};
