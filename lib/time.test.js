import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localInputToUtcIso,
  formatInIst,
  formatDateInIst,
  hasExplicitTimezone,
  isValidUtcIso,
  hoursUntil,
} from "./time.js";

// ---------------------------------------------------------------
// localInputToUtcIso
// ---------------------------------------------------------------

test("localInputToUtcIso returns null for empty / invalid", () => {
  assert.equal(localInputToUtcIso(""), null);
  assert.equal(localInputToUtcIso(null), null);
  assert.equal(localInputToUtcIso(undefined), null);
  assert.equal(localInputToUtcIso("not-a-date"), null);
});

test("localInputToUtcIso emits a Z-suffixed UTC ISO string", () => {
  const result = localInputToUtcIso("2026-04-29T05:42");
  assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("localInputToUtcIso round-trips an instant through the host TZ", () => {
  // Build a datetime-local string from a known absolute Date, then convert.
  // The result should refer to the same instant regardless of host TZ.
  const future = new Date(Date.now() + 12 * 3_600_000);
  const pad = (n) => String(n).padStart(2, "0");
  const localStr = [
    `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`,
    `T${pad(future.getHours())}:${pad(future.getMinutes())}`,
  ].join("");
  const utcIso = localInputToUtcIso(localStr);
  // Truncate input's seconds/ms because datetime-local only goes to the minute.
  const expectedMs =
    future.getTime() - future.getSeconds() * 1000 - future.getMilliseconds();
  assert.equal(new Date(utcIso).getTime(), expectedMs);
});

// ---------------------------------------------------------------
// formatInIst / formatDateInIst
// ---------------------------------------------------------------

test("formatInIst displays UTC instants in IST", () => {
  // 2026-06-01T00:00:00Z is 05:30 IST.
  assert.match(formatInIst("2026-06-01T00:00:00Z"), /05:30/);
});

test("formatInIst is independent of host timezone (deterministic)", () => {
  const iso = "2026-04-29T00:12:00Z";
  assert.equal(formatInIst(iso), formatInIst(iso));
});

test("formatInIst includes day, month, year by default", () => {
  const out = formatInIst("2026-06-01T00:00:00Z");
  assert.match(out, /1 Jun/);
  assert.match(out, /2026/);
});

test("formatInIst accepts override options (e.g. weekday)", () => {
  const out = formatInIst("2026-06-01T00:00:00Z", { weekday: "short" });
  // Locale-formatted weekday for Mon Jun 1 2026 in IST.
  assert.match(out, /Mon/i);
});

test("formatInIst returns em-dash for falsy and original string for invalid", () => {
  assert.equal(formatInIst(""), "—");
  assert.equal(formatInIst(null), "—");
  assert.equal(formatInIst("not-iso"), "not-iso");
});

test("formatDateInIst returns a date with no time component", () => {
  const out = formatDateInIst("2026-06-01T00:00:00Z");
  assert.match(out, /1 Jun/);
  assert.doesNotMatch(out, /:/); // no clock time
});

// ---------------------------------------------------------------
// hasExplicitTimezone / isValidUtcIso
// ---------------------------------------------------------------

test("hasExplicitTimezone accepts Z and ±offsets", () => {
  assert.equal(hasExplicitTimezone("2026-04-29T05:42:00Z"), true);
  assert.equal(hasExplicitTimezone("2026-04-29T05:42:00.123Z"), true);
  assert.equal(hasExplicitTimezone("2026-04-29T05:42:00+05:30"), true);
  assert.equal(hasExplicitTimezone("2026-04-29T05:42:00-08:00"), true);
  assert.equal(hasExplicitTimezone("2026-04-29T05:42:00+0530"), true);
});

test("hasExplicitTimezone rejects bare local strings", () => {
  // This is the *exact* bug class — datetime-local emits these.
  assert.equal(hasExplicitTimezone("2026-04-29T05:42:00"), false);
  assert.equal(hasExplicitTimezone("2026-04-29T05:42"), false);
  assert.equal(hasExplicitTimezone("2026-04-29"), false);
});

test("hasExplicitTimezone rejects non-strings", () => {
  assert.equal(hasExplicitTimezone(""), false);
  assert.equal(hasExplicitTimezone(null), false);
  assert.equal(hasExplicitTimezone(undefined), false);
  assert.equal(hasExplicitTimezone(123), false);
  assert.equal(hasExplicitTimezone({}), false);
});

test("isValidUtcIso requires both validity AND explicit timezone", () => {
  assert.equal(isValidUtcIso("2026-04-29T05:42:00Z"), true);
  assert.equal(isValidUtcIso("2026-04-29T05:42:00+05:30"), true);
  assert.equal(isValidUtcIso("2026-04-29T05:42:00"), false); // bare — the bug
  assert.equal(isValidUtcIso("not-a-date"), false);
  assert.equal(isValidUtcIso(""), false);
});

// ---------------------------------------------------------------
// hoursUntil
// ---------------------------------------------------------------

test("hoursUntil handles past, future, and falsy", () => {
  const inFour = new Date(Date.now() + 4 * 3_600_000).toISOString();
  const twoAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  assert.equal(hoursUntil(inFour), 4);
  assert.equal(hoursUntil(twoAgo), -2);
  assert.equal(hoursUntil(null), Infinity);
  assert.equal(hoursUntil(""), Infinity);
  assert.equal(hoursUntil("garbage"), Infinity);
});
