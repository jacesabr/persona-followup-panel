import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localInputToUtcIso,
  utcIsoToIstInput,
  formatInIst,
  formatDateInIst,
  hasExplicitTimezone,
  isValidUtcIso,
  isValidYmd,
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

test("localInputToUtcIso always interprets input as IST (Asia/Kolkata)", () => {
  // 14:00 IST on 2026-04-29 == 08:30 UTC. Result must be the same regardless
  // of where the browser running this code happens to be.
  assert.equal(
    localInputToUtcIso("2026-04-29T14:00"),
    "2026-04-29T08:30:00.000Z"
  );
  // Midnight IST → 18:30 UTC the previous day.
  assert.equal(
    localInputToUtcIso("2026-04-29T00:00"),
    "2026-04-28T18:30:00.000Z"
  );
});

test("localInputToUtcIso round-trips through utcIsoToIstInput", () => {
  const inputs = ["2026-04-29T14:00", "2026-12-31T23:59", "2026-01-01T00:00"];
  for (const s of inputs) {
    assert.equal(utcIsoToIstInput(localInputToUtcIso(s)), s);
  }
});

test("utcIsoToIstInput renders a UTC instant as IST datetime-local string", () => {
  // 08:30 UTC == 14:00 IST.
  assert.equal(utcIsoToIstInput("2026-04-29T08:30:00.000Z"), "2026-04-29T14:00");
  // Midnight UTC == 05:30 IST.
  assert.equal(utcIsoToIstInput("2026-06-01T00:00:00Z"), "2026-06-01T05:30");
});

test("utcIsoToIstInput handles falsy and invalid input", () => {
  assert.equal(utcIsoToIstInput(""), "");
  assert.equal(utcIsoToIstInput(null), "");
  assert.equal(utcIsoToIstInput("not-iso"), "");
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
// isValidYmd
// ---------------------------------------------------------------

test("isValidYmd accepts real calendar dates", () => {
  assert.equal(isValidYmd("2026-04-29"), true);
  assert.equal(isValidYmd("2024-02-29"), true); // leap day
  assert.equal(isValidYmd("2026-12-31"), true);
  assert.equal(isValidYmd("0001-01-01"), true);
});

test("isValidYmd rejects shape-matching but invalid dates", () => {
  // The shape regex passes these but they aren't real calendar dates.
  assert.equal(isValidYmd("9999-99-99"), false);
  assert.equal(isValidYmd("2026-13-01"), false); // month 13
  assert.equal(isValidYmd("2026-02-30"), false); // Feb 30
  assert.equal(isValidYmd("2025-02-29"), false); // not a leap year
  assert.equal(isValidYmd("2026-04-31"), false); // April only has 30
  assert.equal(isValidYmd("2026-00-01"), false); // month 0
  assert.equal(isValidYmd("2026-01-00"), false); // day 0
  assert.equal(isValidYmd("2026-01-32"), false); // day 32
});

test("isValidYmd rejects bad shapes and non-strings", () => {
  assert.equal(isValidYmd(""), false);
  assert.equal(isValidYmd("2026/04/29"), false);
  assert.equal(isValidYmd("26-04-29"), false);
  assert.equal(isValidYmd("2026-4-29"), false);
  assert.equal(isValidYmd(null), false);
  assert.equal(isValidYmd(undefined), false);
  assert.equal(isValidYmd(20260429), false);
  assert.equal(isValidYmd({}), false);
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
