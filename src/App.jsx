import { useEffect, useState } from "react";
import { LogOut, User, Lock } from "lucide-react";
import LeadFollowup from "./LeadFollowup.jsx";
import StaffDashboard from "./StaffDashboard.jsx";
import SimplePanel from "./SimplePanel.jsx";
import AdminPanel from "./AdminPanel.jsx";
import { api } from "./api.js";
import { formatInIst } from "../lib/time.js";

const ADMIN_USER = "admin";
// Admin password is intentionally case-sensitive (matches counsellor
// behavior — counsellor passwords are also compared as-is server-side).
// Trial mode only.
const ADMIN_PASS = "admin";
const SESSION_KEY = "persona_session";
const IMPERSONATE_KEY = "persona_impersonating";

function loadKey(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveKey(key, v) {
  if (v == null) {
    sessionStorage.removeItem(key);
    return;
  }
  sessionStorage.setItem(key, JSON.stringify(v));
}
// Validate the session shape on load. Old browsers may have leftover
// sessions from before the auth rework — `{role: "staff", counsellorId}`
// or `{role: "simple"}` — and those would otherwise fall through to the
// counsellor branch in App.jsx without ever hitting /api/auth/login. That
// would be an auth bypass: anyone with a stale tab gets dropped into a
// counsellor view (or worse, the unscoped admin-like view) without
// supplying credentials. Refuse anything that doesn't match the new shape.
function loadSession() {
  const raw = loadKey(SESSION_KEY);
  if (!raw || typeof raw !== "object") return null;
  if (raw.role === "admin") return { role: "admin" };
  if (raw.role === "counsellor" && typeof raw.counsellorId === "string" && raw.counsellorId.length > 0) {
    return { role: "counsellor", counsellorId: raw.counsellorId };
  }
  // Stale or malformed — wipe so the next render shows the login form.
  saveKey(SESSION_KEY, null);
  saveKey(IMPERSONATE_KEY, null);
  return null;
}
function loadImpersonating() {
  const raw = loadKey(IMPERSONATE_KEY);
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.counsellorId !== "string" || !raw.counsellorId) return null;
  if (raw.view !== "simple" && raw.view !== "staff") return null;
  return raw;
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  // Admin-only "view as counsellor" impersonation. Persisted in
  // sessionStorage so a hard refresh keeps the impersonation context
  // (otherwise admin would silently bounce back to admin view).
  // Shape: { counsellorId, view }
  //   view: "staff"  → legacy StaffDashboard
  //   view: "simple" → scoped SimplePanel
  const [impersonating, setImpersonatingRaw] = useState(loadImpersonating);
  const setImpersonating = (next) => {
    saveKey(IMPERSONATE_KEY, next);
    setImpersonatingRaw(next);
  };
  const [counsellors, setCounsellors] = useState([]);

  // Refresh the counsellor roster whenever there's an active session — the
  // admin's impersonation dropdown and the per-counsellor login pickers
  // both depend on it.
  useEffect(() => {
    if (!session) return;
    api.listCounsellors().then(setCounsellors).catch(() => {});
  }, [session]);

  const onAdminAuth = () => {
    const s = { role: "admin" };
    saveKey(SESSION_KEY, s);
    setSession(s);
  };

  // Per-counsellor login: hand creds to the server and let it validate.
  // Distinguishes auth failure (401 → "wrong creds") from network/server
  // failure (other → "server error") so the form can show the right
  // message instead of always saying "incorrect password" when the API
  // is just unreachable.
  const onCounsellorAuth = async (username, password) => {
    try {
      const c = await api.login(username, password);
      const s = { role: "counsellor", counsellorId: c.id };
      saveKey(SESSION_KEY, s);
      setSession(s);
      return { ok: true };
    } catch (e) {
      if (e && e.status === 401) return { ok: false, kind: "auth" };
      return { ok: false, kind: "network", message: e?.message || "Couldn't reach the server" };
    }
  };

  const onSignOut = () => {
    saveKey(SESSION_KEY, null);
    saveKey(IMPERSONATE_KEY, null);
    setSession(null);
    setImpersonatingRaw(null);
  };

  if (!session)
    return (
      <Login
        onAdminAuth={onAdminAuth}
        onCounsellorAuth={onCounsellorAuth}
      />
    );

  // Admin viewing-as a counsellor. View defaults to "simple" (the new
  // scoped SimplePanel) unless the caller explicitly opted into the
  // legacy StaffDashboard (only the Old dropdown's "view as" does that).
  if (session.role === "admin" && impersonating) {
    const staffName =
      counsellors.find((c) => c.id === impersonating.counsellorId)?.name || "—";
    const isStaffView = impersonating.view === "staff";
    return (
      <Frame
        onSignOut={onSignOut}
        viewLabel={isStaffView ? "Counsellor followup dashboard view" : "Counsellor view"}
      >
        <BackToAdminBanner staffName={staffName} onExit={() => setImpersonating(null)} />
        {isStaffView ? (
          <StaffDashboard
            counsellorId={impersonating.counsellorId}
            counsellors={counsellors}
            isImpersonation
          />
        ) : (
          <SimplePanel
            role="counsellor"
            scopedCounsellorId={impersonating.counsellorId}
          />
        )}
      </Frame>
    );
  }

  if (session.role === "admin") {
    return (
      <Frame onSignOut={onSignOut} viewLabel="Admin followup dashboard view">
        <AdminPanel
          onPickStaff={(impersonationState) =>
            // Legacy "view as" from LeadFollowup → StaffDashboard.
            setImpersonating({ ...impersonationState, view: "staff" })
          }
          onImpersonate={(counsellorId) =>
            // New path: clicking a counsellor name in the task list.
            setImpersonating({ counsellorId, view: "simple" })
          }
        />
      </Frame>
    );
  }

  // session.role === "counsellor"
  return (
    <Frame onSignOut={onSignOut} viewLabel="Counsellor view">
      <SimplePanel
        role="counsellor"
        scopedCounsellorId={session.counsellorId}
      />
    </Frame>
  );
}

function Frame({ children, onSignOut, viewLabel }) {
  return (
    <div
      className="min-h-screen w-full font-serif text-stone-900"
      style={{ backgroundColor: "#faf9f5" }}
    >
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-10 flex items-center border-b border-stone-300 pb-4">
          <div className="flex flex-1 items-baseline gap-3">
            <span className="text-2xl font-semibold tracking-tight">Persona</span>
            {viewLabel && (
              <span className="text-xs font-semibold uppercase tracking-[0.25em] text-[#cc785c]">
                · {viewLabel}
              </span>
            )}
          </div>
          <div className="flex flex-1 items-center justify-end gap-5">
            <LiveClock />
            <button
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.2em] text-stone-600 hover:text-stone-900"
            >
              <LogOut className="h-3 w-3" /> sign out
            </button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

// Always-visible clock pinned to IST (Ludhiana / Asia/Kolkata). Updates every
// second so anyone glancing at the header can confirm the displayed time
// matches their wall clock — that's the whole point of having it here.
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="text-right leading-tight">
      <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
        Ludhiana time
      </p>
      <p className="text-xs font-semibold tabular-nums text-stone-700">
        {formatInIst(now.toISOString(), {
          weekday: "short",
          second: "2-digit",
        })}
      </p>
    </div>
  );
}

function BackToAdminBanner({ staffName, onExit }) {
  return (
    <div className="mb-6 flex items-center justify-between border border-[#cc785c] bg-[#cc785c]/10 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.15em] text-[#cc785c]">
        Viewing Staff Panel of : <span className="font-semibold">{staffName}</span>
      </p>
      <button
        onClick={onExit}
        className="text-xs uppercase tracking-[0.15em] text-[#cc785c] underline underline-offset-4 hover:text-[#b86a4f]"
      >
        ← Back to admin
      </button>
    </div>
  );
}

// ============================================================
// Login
// ============================================================
function Login({ onAdminAuth, onCounsellorAuth }) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  // err is null when no error, or { kind: "auth"|"network", message? }.
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const clearErr = () => setErr(null);

  const submit = async (e) => {
    e.preventDefault();
    const u = user.trim();
    if (u.toLowerCase() === ADMIN_USER && pw === ADMIN_PASS) {
      onAdminAuth();
      return;
    }
    setBusy(true);
    const result = await onCounsellorAuth(u, pw);
    setBusy(false);
    if (!result.ok) setErr(result);
  };

  return (
    <div
      className="flex min-h-screen w-full items-center justify-center font-serif text-stone-900"
      style={{ backgroundColor: "#faf9f5" }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-xl border border-stone-300 bg-white p-12"
      >
        <div className="mb-10 text-center">
          <p className="text-[13px] uppercase tracking-[0.35em] text-stone-600">
            Sign in
          </p>
          <h1 className="mt-3 font-serif text-5xl leading-[1.05]">Persona</h1>
          <p className="mt-3 text-xs uppercase tracking-[0.3em] text-stone-600">
            Followup Panel
          </p>
        </div>

        <label className="block">
          <span className="text-[12px] uppercase tracking-[0.2em] text-stone-600">
            Username
          </span>
          <div className="mt-2 flex items-center gap-2 border-b border-stone-400 focus-within:border-stone-600">
            <User className="h-4 w-4 text-stone-600" />
            <input
              type="text"
              value={user}
              onChange={(e) => {
                setUser(e.target.value);
                clearErr();
              }}
              autoFocus
              autoComplete="username"
              className="flex-1 bg-transparent py-3 text-lg outline-none"
              placeholder="admin or your counsellor username"
            />
          </div>
        </label>

        <label className="mt-6 block">
          <span className="text-[12px] uppercase tracking-[0.2em] text-stone-600">
            Password
          </span>
          <div className="mt-2 flex items-center gap-2 border-b border-stone-400 focus-within:border-stone-600">
            <Lock className="h-4 w-4 text-stone-600" />
            <input
              type="password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                clearErr();
              }}
              autoComplete="current-password"
              className="flex-1 bg-transparent py-3 text-lg outline-none"
              placeholder="••••••"
            />
          </div>
        </label>

        {err && (
          <p className="mt-4 text-xs text-red-700">
            {err.kind === "network"
              ? `Couldn't reach the server${err.message ? ` (${err.message})` : ""}.`
              : "Incorrect username or password."}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-10 w-full border border-[#cc785c] bg-[#cc785c] px-6 py-4 text-sm uppercase tracking-[0.25em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Enter →"}
        </button>

        <p className="mt-6 text-center text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Trial mode · admin/admin · counsellors: c1/c1, c2/c2, … (set per row)
        </p>
      </form>
    </div>
  );
}
