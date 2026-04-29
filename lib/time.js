// Shared time-handling helpers. Pure ESM, no deps. Imported by both the
// browser bundle and the Node server. The whole point of this module is to
// keep timezone conversions at the edges (input -> UTC, UTC -> IST display)
// so business logic never deals with bare local-time strings.
//
// Rules of thumb (codified by the helpers below):
//   1. Persist UTC ISO 8601 with `Z`. Postgres TIMESTAMPTZ on top.
//   2. The browser's <input type="datetime-local"> emits a *local* string with
//      no offset — convert via localInputToUtcIso() before submitting.
//   3. Display via formatInIst() so emails, WhatsApp body, and the dashboard
//      all show the same wall-clock time regardless of host/browser TZ.
//   4. Server validators must reject bare strings (isValidUtcIso) so an
//      external API client can't reintroduce the same bug.

const IST = "Asia/Kolkata";

// IST is UTC+5:30 year-round (no DST), so a fixed offset is exact. If India
// ever adopted DST this would need a TZ-aware library, but that hasn't been
// on the table since 1945.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// Convert a "YYYY-MM-DDTHH:mm" datetime-local input value into a UTC ISO 8601
// string ending in Z. The local string is always interpreted as IST
// (Ludhiana / Asia/Kolkata) — NOT the browser's local timezone. This means
// "2026-04-29T14:00" entered in any browser anywhere always means 2:00 PM IST.
// Returns null for empty / invalid input so callers can pass the result
// straight through to the API.
export function localInputToUtcIso(localStr) {
  if (!localStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localStr);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asIfUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  if (Number.isNaN(asIfUtc)) return null;
  return new Date(asIfUtc - IST_OFFSET_MS).toISOString();
}

// Inverse of localInputToUtcIso: render a UTC ISO instant as the
// "YYYY-MM-DDTHH:mm" string an <input type="datetime-local"> expects, in IST.
// Used to pre-fill appointment edit forms and the "fill test data" helper so
// the input shows IST wall-clock regardless of the browser's local TZ.
export function utcIsoToIstInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return [
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  ].join("");
}

const DEFAULT_FORMAT_OPTS = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: IST,
  hour12: true,
};

// Format a UTC ISO instant in IST. Always uses Asia/Kolkata regardless of the
// host's locale or environment timezone, so the same lead reads identically
// in the dashboard, email body, and WhatsApp message.
export function formatInIst(iso, opts = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", { ...DEFAULT_FORMAT_OPTS, ...opts });
}

const DATE_FORMAT_OPTS = {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: IST,
};

export function formatDateInIst(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", DATE_FORMAT_OPTS);
}

const TIME_FORMAT_OPTS = {
  hour: "numeric",
  minute: "2-digit",
  timeZone: IST,
  hour12: true,
};

// Time-only in IST (h:mm AM/PM) — used by the admin activity log when events
// are already grouped by day.
export function formatTimeInIst(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-IN", TIME_FORMAT_OPTS);
}

// Match Z suffix or ±HH:MM / ±HHMM offset at end of string. Used to refuse
// bare local-time strings that would otherwise get silently reinterpreted as
// UTC by Postgres (the original bug).
const TZ_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

export function hasExplicitTimezone(iso) {
  return typeof iso === "string" && TZ_SUFFIX_RE.test(iso);
}

export function isValidUtcIso(iso) {
  if (!hasExplicitTimezone(iso)) return false;
  return !Number.isNaN(new Date(iso).getTime());
}

// Hours from now to the given UTC instant. Negative for past. Both sides of
// the subtraction are absolute, so this is timezone-independent.
export function hoursUntil(iso) {
  if (!iso) return Infinity;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Infinity;
  return Math.round((d.getTime() - Date.now()) / 3_600_000);
}
