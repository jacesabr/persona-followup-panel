// Standalone smoke test for the R2/S3 storage path. Loads the same
// .env the rest of the codebase reads, runs through getStorage().save
// → exists → openReadStream → deleteIfExists with a tiny in-memory
// blob, and verifies the bytes round-trip. Use this before flipping
// STORAGE_BACKEND=s3 on Render so a misconfigured token surfaces
// here instead of silently 500-ing every student upload.
//
// Usage: node server/scripts/test-r2.js

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getStorage } from "../storage.js";

async function main() {
  const expectedBackend = (process.env.STORAGE_BACKEND || "local").toLowerCase();
  if (expectedBackend !== "s3") {
    console.error(`[test-r2] STORAGE_BACKEND=${expectedBackend} — set it to "s3" in .env first.`);
    process.exit(1);
  }
  const required = ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[test-r2] missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const store = await getStorage();
  if (store.name !== "s3") {
    console.error(`[test-r2] expected backend=s3 but getStorage returned ${store.name}`);
    process.exit(1);
  }

  const payload = `r2-roundtrip ${new Date().toISOString()} ${crypto.randomBytes(8).toString("hex")}\n`;
  const tmpPath = path.join(os.tmpdir(), `r2-test-${crypto.randomBytes(6).toString("hex")}.txt`);
  fs.writeFileSync(tmpPath, payload);

  let key = null;
  try {
    const saved = await store.save({
      tmpPath,
      scope: "_smoke_test",
      originalName: "r2-roundtrip.txt",
      mimeType: "text/plain",
    });
    key = saved.key;
    console.log(`[test-r2] save ok — key=${key} size=${saved.size}`);

    const exists = await store.exists(key);
    if (!exists) throw new Error("exists() returned false right after save()");
    console.log(`[test-r2] exists ok`);

    const stream = await store.openReadStream(key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const got = Buffer.concat(chunks).toString("utf8");
    if (got !== payload) {
      throw new Error(`bytes mismatch — wrote ${payload.length}B, read ${got.length}B`);
    }
    console.log(`[test-r2] read ok — bytes match (${got.length}B)`);

    await store.deleteIfExists(key);
    const stillThere = await store.exists(key);
    if (stillThere) throw new Error("deleteIfExists() did not remove the object");
    console.log(`[test-r2] delete ok`);

    console.log("\n[test-r2] PASS — R2 read/write round-trip works.");
  } catch (e) {
    console.error("[test-r2] FAIL:", e?.message || e);
    if (key) {
      try { await store.deleteIfExists(key); } catch {}
    }
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

main().catch((e) => {
  console.error("[test-r2] uncaught:", e?.stack || e);
  process.exit(1);
});
