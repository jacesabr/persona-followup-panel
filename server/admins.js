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

// Mirror groups: array of arrays of lowercase usernames that share a task inbox.
// Parsed from ADMIN_MIRRORS env var, e.g. [["admin123","adminsuhas"]].
function getMirrorGroups() {
  try {
    const raw = process.env.ADMIN_MIRRORS;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((g) => (Array.isArray(g) ? g.map((u) => u.toLowerCase()) : []));
  } catch { return []; }
}

// Returns display names of all mirror partners for the given username.
export function getMirrorDisplayNames(username) {
  const lower = username.toLowerCase();
  for (const group of getMirrorGroups()) {
    if (group.includes(lower)) {
      return group.filter((u) => u !== lower).map(adminDisplayName);
    }
  }
  return [];
}

// Strips a leading "admin" prefix if the remainder starts with a letter,
// then capitalises. adminJyoti → Jyoti, adminSuhas → Suhas, admin123 unchanged.
export function adminDisplayName(username) {
  const rest = username.replace(/^admin/i, "");
  if (rest && /^[a-zA-Z]/.test(rest)) {
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return username;
}

// All admin accounts — shown in counsellor assignee pickers so counsellors
// can assign tasks to any admin account.
export function namedAdmins() {
  return getAdmins().map((a) => ({ username: a.username, name: adminDisplayName(a.username) }));
}
