import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// Password hashing for counsellor accounts. Admin creds live in env vars
// and are compared directly (env is the source of truth, not user input).
//
// Format: "scrypt:<saltHex>:<hashHex>". Stored straight in counsellors.password.
// Legacy rows pre-dating this helper are bare plaintext; the login route
// detects them via isHashed() and upgrades on first successful login.

const KEY_LEN = 64;
const SALT_LEN = 16;

export function hashPassword(plain) {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(plain, salt, KEY_LEN);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt:");
}

// Constant-time verify against a stored "scrypt:salt:hash" string.
// Returns false on any malformed input rather than throwing — callers
// treat false as "wrong password" without leaking shape info.
export function verifyHashed(plain, stored) {
  if (!isHashed(stored)) return false;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length !== SALT_LEN || expected.length !== KEY_LEN) return false;
  const actual = scryptSync(plain, salt, expected.length);
  return timingSafeEqual(expected, actual);
}
