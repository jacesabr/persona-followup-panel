// Shared admin-credential helpers used by auth.js (login) and tasks.js
// (assignee validation). Parsed from env vars so both places stay in sync.

function parseExtraAdmins(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.username === "string" && typeof e.password === "string")
      .map((e) => ({ username: e.username.toLowerCase(), password: e.password }));
  } catch {
    return [];
  }
}

// Full list: primary admin + any extras from EXTRA_ADMINS. Called at
// runtime (not module load) so test environments can override env vars.
export function getAdmins() {
  const list = [];
  if (process.env.ADMIN_USERNAME) {
    list.push({
      username: process.env.ADMIN_USERNAME.toLowerCase(),
      password: process.env.ADMIN_PASSWORD || "",
      isPrimary: true,
    });
  }
  for (const e of parseExtraAdmins(process.env.EXTRA_ADMINS)) {
    list.push({ ...e, isPrimary: false });
  }
  return list;
}

// Set of all valid admin usernames (lowercase) for fast membership checks.
export function adminUsernameSet() {
  return new Set(getAdmins().map((a) => a.username));
}

// Named (non-primary) admins — shown in counsellor assignee pickers so
// counsellors can assign tasks to specific admins without seeing "admin".
export function namedAdmins() {
  return getAdmins()
    .filter((a) => !a.isPrimary)
    .map((a) => ({ username: a.username }));
}
