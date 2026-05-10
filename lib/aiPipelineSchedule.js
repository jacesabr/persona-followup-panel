// Compute when the persona-ai-pipeline routine will next fire.
//
// The Claude Code routine schedule lives at
// https://claude.ai/code/routines/trig_01BTTjNjGDpdGyywLqBTtk1a
// with cron expression `0 3-17 * * *` UTC = IST 08:30–22:30, every
// hour at the top. 15 runs/day, exactly the Claude Max daily-job cap.
// Skips IST 23:00–08:00 so it never wakes Anthropic Cloud at night
// (and so we don't burn jobs on hours when no new students sign up).
//
// This helper is consumed by the NextAiRunTimer banner on the
// student-creation flow. If you change the routine cron, change the
// RUN_HOURS_UTC array below to match.

const RUN_HOURS_UTC = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

// Returns a Date of the next scheduled routine run, given `now`.
// Strict semantics: if `now` is exactly on a run-hour boundary
// (e.g. 03:00:00.000 UTC), this returns the NEXT run-hour, not the
// current one — because by the time the UI renders, the current hour
// has already begun (or fired). Callers that want "current or next"
// can subtract a few minutes from `now` first.
export function nextAiPipelineRunAt(now = new Date()) {
  // Walk forward from the next top-of-hour after `now`. The pipeline
  // fires at minute 0; rounding `now` UP to the next 0-minute mark
  // gives us the candidate. If that hour isn't in the run set, hop
  // forward an hour at a time until we land in one. Bounded loop —
  // there are 15 valid hours in any 24-hour window so we'll always
  // find one within 24 iterations.
  const candidate = new Date(now);
  candidate.setUTCMilliseconds(0);
  candidate.setUTCSeconds(0);
  candidate.setUTCMinutes(0);
  candidate.setUTCHours(candidate.getUTCHours() + 1);

  for (let i = 0; i < 30; i++) {
    if (RUN_HOURS_UTC.includes(candidate.getUTCHours())) {
      return candidate;
    }
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }
  // Unreachable on any valid clock; keep the function total.
  return candidate;
}

// Format a milliseconds duration as "in 23m", "in 4h 12m", "<1m".
// Negative durations (the run already happened) collapse to "<1m" —
// the UI will refresh on the next setInterval tick and the next run
// time will advance.
export function formatTimeUntil(ms) {
  if (ms < 60_000) return "<1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// Render the next-run instant in IST so the counsellor sees a wall-
// clock time that matches their watch.
export function formatInIstHm(date) {
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
