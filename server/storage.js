// Pluggable file storage. Two backends today:
//   - "local"  → writes to UPLOADS_DIR on local disk. Default; matches
//     current behaviour. Render free tier wipes this on every redeploy
//     and on cold-start cycles, so do NOT use this in production once
//     real students upload.
//   - "s3"     → S3-compatible. Works with AWS S3, Cloudflare R2 (free
//     up to 10GB + free egress — recommended), Supabase Storage (S3
//     compat layer), MinIO. Configured by:
//       STORAGE_BACKEND=s3
//       S3_BUCKET=...
//       S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com  (R2)
//                or https://s3.amazonaws.com                          (AWS)
//                or https://<project>.supabase.co/storage/v1/s3       (Supabase)
//       S3_REGION=auto (R2) | us-east-1 | etc.
//       S3_ACCESS_KEY_ID=...
//       S3_SECRET_ACCESS_KEY=...
//       S3_FORCE_PATH_STYLE=true (R2 + MinIO + Supabase) | false (AWS)
//
// The interface is small and synchronous-looking; multer's `_handleFile`
// adapter wraps it. Everything stores bytes addressed by an opaque key
// and returns { key, size, mimeType } on save. Downloads stream.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BACKEND = (process.env.STORAGE_BACKEND || "local").toLowerCase();

// ---------------------------------------------------------------
// Local-disk backend (default)
// ---------------------------------------------------------------
function makeLocal() {
  const root = path.resolve(process.env.UPLOADS_DIR || "uploads");
  fs.mkdirSync(root, { recursive: true });

  return {
    name: "local",
    async save({ tmpPath, scope, originalName }) {
      const dir = path.join(root, sanitize(scope || "anon"));
      fs.mkdirSync(dir, { recursive: true });
      const id = crypto.randomBytes(12).toString("hex");
      const ext = path.extname(originalName) || "";
      const dest = path.join(dir, `${id}${ext}`);
      // Move (rename) is atomic when src+dst are on the same filesystem;
      // multer's tmp lives under the same root so this is safe.
      fs.renameSync(tmpPath, dest);
      const stat = fs.statSync(dest);
      return { key: dest, size: stat.size };
    },
    async exists(key) {
      return fs.existsSync(key);
    },
    async openReadStream(key, opts = {}) {
      const { start, end } = opts;
      if (start != null) {
        // fs.createReadStream's start/end are inclusive byte offsets,
        // matching HTTP Range semantics — pass them through unchanged.
        return fs.createReadStream(key, { start, end });
      }
      return fs.createReadStream(key);
    },
    async deleteIfExists(key) {
      try { fs.unlinkSync(key); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------
// S3-compatible backend (R2 / AWS / Supabase / MinIO)
//
// Lazy-loads @aws-sdk/client-s3 only when STORAGE_BACKEND=s3 so the
// 1MB+ SDK doesn't bloat boot time on the local-default path.
// ---------------------------------------------------------------
async function makeS3() {
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
          DeleteObjectCommand } = await import("@aws-sdk/client-s3");

  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;
  if (!bucket) throw new Error("STORAGE_BACKEND=s3 requires S3_BUCKET");
  if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
    throw new Error("STORAGE_BACKEND=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
  }

  const client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: endpoint || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });

  return {
    name: "s3",
    async save({ tmpPath, scope, originalName, mimeType }) {
      const id = crypto.randomBytes(12).toString("hex");
      const ext = path.extname(originalName) || "";
      const key = `${sanitize(scope || "anon")}/${id}${ext}`;
      const body = fs.readFileSync(tmpPath);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: mimeType || "application/octet-stream",
      }));
      // Defense-in-depth: HEAD the object we just wrote so save()
      // guarantees "if I return, the bytes are in R2". R2 is strongly
      // consistent so PutObject 200 already implies presence — this
      // check exists to catch silent SDK/network/proxy failures and
      // mis-signed requests that would otherwise let the upload route
      // INSERT a DB row pointing at nothing. Throws on miss; the
      // caller already runs orphan cleanup on save() throw.
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const reportedSize = Number(head.ContentLength ?? -1);
      if (reportedSize !== body.length) {
        throw new Error(
          `[storage:s3] post-save HEAD size mismatch: wrote ${body.length}B, R2 reports ${reportedSize}B (key=${key})`
        );
      }
      // Best-effort tmp cleanup; multer also cleans on success/failure.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { key, size: body.length };
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (e) {
        if (e.$metadata?.httpStatusCode === 404 || e.name === "NotFound") return false;
        throw e;
      }
    },
    async openReadStream(key, opts = {}) {
      const params = { Bucket: bucket, Key: key };
      if (opts.start != null) {
        // Translate fs-style {start, end} into S3's HTTP Range header
        // so partial reads round-trip the same way as the local backend.
        params.Range = `bytes=${opts.start}-${opts.end ?? ""}`;
      }
      const out = await client.send(new GetObjectCommand(params));
      return out.Body; // Readable stream in Node
    },
    async deleteIfExists(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch { /* ignore */ }
    },
  };
}

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);

// Singleton — chosen at boot, never swapped at runtime.
let _instance;
export async function getStorage() {
  if (_instance) return _instance;
  if (BACKEND === "s3") {
    _instance = await makeS3();
  } else {
    _instance = makeLocal();
  }
  // stderr, not stdout: scripts like fetch-file.js stream binary bytes
  // through process.stdout, and any module that writes to stdout at
  // import/first-call time prepends text to those bytes and corrupts
  // every download.
  console.error(`[storage] backend = ${_instance.name}`);
  return _instance;
}

// Eager init for the boot sanity check — surfaces missing config at
// startup instead of at first upload. Production refuses to boot on
// the local-disk backend: Render wipes the container disk on every
// redeploy, so a "local" boot in prod silently corrupts every future
// student upload. Make it loud and crash-fast so the deploy fails
// instead of going live with the wrong storage.
export async function initStorage() {
  await getStorage();
  if (process.env.NODE_ENV === "production" && _instance.name !== "s3") {
    throw new Error(
      `[storage] refusing to boot in production with backend=${_instance.name}. ` +
      `Render's container disk is wiped on every redeploy, so set STORAGE_BACKEND=s3 ` +
      `with valid S3_BUCKET / S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.`
    );
  }
}
