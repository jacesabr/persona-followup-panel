// File validation + upload pipeline for the student-facing intake.
// Talks to the Express backend over same-origin /api/students/me/* routes.
// The student is identified by the persona_session cookie issued at
// /api/auth/login (user_kind='student'). No client-side id management,
// no localStorage.

const SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

const matchSig = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

async function readMagicBytes(file, n = 8) {
  const buf = await file.slice(0, n).arrayBuffer();
  return new Uint8Array(buf);
}

export async function detectActualType(file) {
  const bytes = await readMagicBytes(file);
  if (matchSig(bytes, SIGNATURES.pdf)) return "application/pdf";
  if (matchSig(bytes, SIGNATURES.jpeg)) return "image/jpeg";
  if (matchSig(bytes, SIGNATURES.png)) return "image/png";
  return null;
}

export const humanSize = (b) => {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
};

const friendlyType = (m) =>
  m === "application/pdf" ? "PDF" : m === "image/jpeg" ? "JPG" : m === "image/png" ? "PNG" : m;

export async function validateFile(file, { accept, maxSizeMB } = {}) {
  const acceptList = (accept || "application/pdf").split(",").map((s) => s.trim()).filter(Boolean);
  const maxMB = maxSizeMB ?? 10;
  const maxBytes = maxMB * 1024 * 1024;

  if (file.size === 0) {
    return { ok: false, error: "File is empty." };
  }
  if (file.size > maxBytes) {
    return { ok: false, error: `File is ${humanSize(file.size)} — limit is ${maxMB} MB.` };
  }

  const actual = await detectActualType(file);
  if (!actual) {
    const wanted = acceptList.map(friendlyType).join(" or ");
    return { ok: false, error: `Couldn't recognise the file. Please upload a ${wanted}.` };
  }

  const allowed = acceptList.some(
    (a) => a === actual || (a.endsWith("/*") && actual.startsWith(a.slice(0, -1)))
  );
  if (!allowed) {
    const wanted = acceptList.map(friendlyType).join(" or ");
    return { ok: false, error: `Wrong file type — please upload a ${wanted}.` };
  }

  return { ok: true, actualType: actual };
}

// Construct the JSON-safe metadata blob stored in answers.
export const fileMeta = (file) => ({
  name: file.name,
  size: file.size,
  type: file.type,
  lastModified: file.lastModified,
  status: "pending",
  error: null,
  uploadedUrl: null,
  uploadedAt: null,
});

export const isFileSlot = (v) =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof v.name === "string" && "status" in v;

export const isFileUploaded = (v) => isFileSlot(v) && v.status === "uploaded";
export const isFileInflight = (v) => isFileSlot(v) && (v.status === "uploading" || v.status === "validating");
export const isFileErrored = (v) => isFileSlot(v) && v.status === "error";

// ----------------------------------------------------------------
// Upload to the Express backend. The persona_session cookie identifies
// the student; no need to pass any id from the client.
// ----------------------------------------------------------------
export async function uploadFile(file, { fieldId, rowIndex, accept } = {}) {
  const form = new FormData();
  form.append("file", file);
  form.append("fieldId", fieldId || "unknown");
  if (rowIndex != null) form.append("rowIndex", String(rowIndex));
  if (accept) form.append("accept", accept);

  const res = await fetch("/api/students/me/upload", {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    let msg = `Upload failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }

  const { url, uploadedAt, fileId } = await res.json();
  return { url, uploadedAt, fileId };
}

// Persist the form state. Backend is the source of truth — caller
// surfaces errors via the SaveIndicator state machine. Pass the
// expectedUpdatedAt the client last saw so the server can reject
// stale writes (concurrent-tab scenario) with a 409 instead of
// silently overwriting another tab's edits.
//
// On 409 the server returns { latest: { data, intakeComplete, updatedAt } }.
// We surface it as a typed error the caller can catch + reconcile.
export async function syncRecord({ data, intakeComplete, expectedUpdatedAt } = {}) {
  const res = await fetch("/api/students/me/record", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: data || {},
      intakeComplete: !!intakeComplete,
      expectedUpdatedAt: expectedUpdatedAt || null,
    }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.error || "stale write");
    err.code = "STALE_WRITE";
    err.latest = body?.latest || null;
    throw err;
  }
  if (!res.ok) {
    let msg = `Sync failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// Hydrate the form on mount. Always returns the same shape, with
// `data` empty when the student is brand-new.
export async function loadRecord() {
  const res = await fetch("/api/students/me/record");
  if (!res.ok) {
    let msg = `Load failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ----------------------------------------------------------------
// Resume APIs. POST a batch of specs → returns the created rows;
// poll GET /me/resumes/:id (or list) until status is terminal.
// ----------------------------------------------------------------

const RESUME_TERMINAL = new Set(["succeeded", "failed", "stale", "superseded"]);
export const isResumeTerminal = (s) => RESUME_TERMINAL.has(s);

export async function generateResumes(specs) {
  const res = await fetch("/api/students/me/resumes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specs }),
  });
  if (!res.ok) {
    let msg = `Generation kick-off failed (${res.status}).`;
    try { const body = await res.json(); if (body?.error) msg = body.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function listResumes() {
  const res = await fetch("/api/students/me/resumes");
  if (!res.ok) throw new Error(`Listing resumes failed (${res.status}).`);
  return res.json();
}

export async function getResume(id, { signal } = {}) {
  const res = await fetch(`/api/students/me/resumes/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`Resume lookup failed (${res.status}).`);
  return res.json();
}

// Forward-only phase transitions for the post-intake state machine.
// `phase` is "doc_review" (after general intake) or "done" (after
// doc-review; server auto-fires one 300-word resume in the same tx).
// Server validates the current phase and 409s on illegal transitions —
// the client surfaces that as a typed error so the caller can refetch.
export async function transitionPhase(phase) {
  const res = await fetch("/api/students/me/intake/phase", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phase }),
  });
  if (!res.ok) {
    let msg = `Phase transition failed (${res.status}).`;
    let body = null;
    try { body = await res.json(); if (body?.error) msg = body.error; } catch {}
    const err = new Error(msg);
    err.code = res.status === 409 ? "PHASE_CONFLICT" : "PHASE_FAIL";
    err.currentPhase = body?.currentPhase || null;
    throw err;
  }
  return res.json();
}

export async function regenerateResume(id) {
  const res = await fetch(`/api/students/me/resumes/${encodeURIComponent(id)}/regenerate`, {
    method: "POST",
  });
  if (!res.ok) {
    let msg = `Regenerate failed (${res.status}).`;
    try { const body = await res.json(); if (body?.error) msg = body.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
