import fs from "node:fs";

// Defense-in-depth: re-check magic bytes on the server. The client already
// validates, but we never trust the client.

const SIGNATURES = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

const matchSig = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

export function detectActualType(filePath) {
  const buf = Buffer.alloc(8);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  for (const [mime, sig] of Object.entries(SIGNATURES)) {
    if (matchSig(buf, sig)) return mime;
  }
  return null;
}

export function validateUploadedFile(filePath, accept) {
  const acceptList = (accept || "application/pdf").split(",").map((s) => s.trim());
  const actual = detectActualType(filePath);
  if (!actual) return { ok: false, error: "Unrecognized file type." };
  const ok = acceptList.some(
    (a) => a === actual || (a.endsWith("/*") && actual.startsWith(a.slice(0, -1)))
  );
  if (!ok) return { ok: false, error: `File type ${actual} not allowed (expected ${accept}).` };
  return { ok: true, actualType: actual };
}
