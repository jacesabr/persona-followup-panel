import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, LogOut, User, Lock } from "lucide-react";
import SimplePanel from "./SimplePanel.jsx";
import AdminPanel from "./AdminPanel.jsx";
import StudentIntake from "./StudentIntake.jsx";
import { api, setUnauthorizedHandler } from "./api.js";
import { formatInIst } from "../lib/time.js";
import VersionBanner from "./VersionBanner.jsx";
import useAutoRefresh from "./useAutoRefresh.js";

// Cross-tab auth notification. When one tab logs in/out the shared
// persona_session cookie changes; other tabs would otherwise keep
// rendering UI for a now-stale role until they hit a 401/403 or refocus.
// Posting on the channel lets them re-bootstrap immediately.
const AUTH_CHANNEL = "persona_auth";

// Impersonation is admin-only UI state — purely a view switch, no
// security boundary (admin's session cookie is what authorizes the
// underlying API requests). Persisted in sessionStorage so a hard
// refresh keeps the "viewing as Neha" context.
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
function loadImpersonating() {
  const raw = loadKey(IMPERSONATE_KEY);
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.counsellorId !== "string" || !raw.counsellorId) return null;
  return { counsellorId: raw.counsellorId };
}

// Identity check for session objects. Used by the periodic refresh so a
// no-op /api/auth/me poll doesn't churn child effects keyed on
// [session]. Compares the fields that drive routing + identity, not
// the whole object (display names etc. change without affecting which
// panel renders).
function sessionsEquivalent(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a === "loading" || b === "loading") return false;
  return (
    a.role === b.role &&
    (a.counsellorId ?? null) === (b.counsellorId ?? null) &&
    (a.studentId ?? null) === (b.studentId ?? null) &&
    (a.adminUsernameRaw ?? "") === (b.adminUsernameRaw ?? "") &&
    (a.displayName ?? "") === (b.displayName ?? "")
  );
}

export default function App() {
  // session is null until /api/auth/me resolves. The server's httpOnly
  // cookie is the source of truth — we never trust localStorage for who
  // someone is, only for UI-state. This is the auth boundary.
  // Shape:
  //   null            → not logged in (login form)
  //   "loading"       → initial bootstrap, awaiting /api/auth/me
  //   { role: "admin" } | { role: "counsellor", counsellorId }
  const [session, setSession] = useState("loading");

  const [impersonating, setImpersonatingRaw] = useState(loadImpersonating);
  const setImpersonating = (next) => {
    saveKey(IMPERSONATE_KEY, next);
    setImpersonatingRaw(next);
  };
  const [counsellors, setCounsellors] = useState([]);

  // Lazily-created BroadcastChannel for cross-tab login/logout pings.
  // Same instance handles incoming messages and outgoing posts (a tab
  // doesn't receive its own posts, which is exactly what we want — the
  // posting tab updates state directly, peers update via this channel).
  const authChannelRef = useRef(null);

  // Re-fetch /api/auth/me and update local session state. Idempotent —
  // safe to call from initial bootstrap, focus/poll backstop, the 401/
  // 403 unauthorized handler, and cross-tab BroadcastChannel messages.
  // Clears impersonation if the new session isn't admin (impersonation
  // is admin-only and goes stale instantly when the cookie's role
  // flips).
  const refreshSession = useCallback(async () => {
    let me;
    try {
      me = await api.me();
    } catch {
      setSession(null);
      saveKey(IMPERSONATE_KEY, null);
      setImpersonatingRaw(null);
      return;
    }
    let next = null;
    if (me.user_kind === "admin") {
      next = {
        role: "admin",
        displayName: me.username || "Admin",
        adminUsernameRaw: me.usernameRaw || "",
        adminMirrors: me.mirrors || [],
      };
    } else if (me.user_kind === "counsellor" && me.counsellor?.id) {
      next = {
        role: "counsellor",
        counsellorId: me.counsellor.id,
        displayName: me.counsellor.name || "Counsellor",
      };
    } else if (me.user_kind === "student" && me.student?.student_id) {
      next = {
        role: "student",
        studentId: me.student.student_id,
        studentName: me.student.display_name || me.student.username,
        displayName: me.student.display_name || me.student.username,
      };
    }
    setSession((prev) => (sessionsEquivalent(prev, next) ? prev : next));
    if (!next || next.role !== "admin") {
      saveKey(IMPERSONATE_KEY, null);
      setImpersonatingRaw(null);
    }
  }, []);

  // Global 401/role-mismatch-403 handler — api.js fires this when a
  // protected request reveals the cookie's role is stale (expired,
  // overwritten by another tab, etc.). Re-bootstrap so the UI re-routes
  // to whatever the cookie actually represents now (or to login if
  // gone). Without this, a tab whose cookie was overwritten by another
  // tab's login would keep rendering the original role's UI and
  // surfacing opaque "staff only" / "admin only" banners.
  useEffect(() => {
    setUnauthorizedHandler(refreshSession);
    return () => setUnauthorizedHandler(null);
  }, [refreshSession]);

  // First-paint bootstrap.
  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // Backstop poll: re-check session on tab focus, visibility change,
  // and a slow interval. Catches role flips even when the user hasn't
  // triggered an API call yet (e.g. they refocus an admin tab whose
  // cookie was overwritten by a student login in another tab).
  useAutoRefresh(refreshSession, { intervalMs: 60_000 });

  // Cross-tab notification: when this tab logs in or out, peers re-
  // bootstrap immediately instead of waiting for their next poll/
  // request to discover the cookie changed.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(AUTH_CHANNEL);
    ch.onmessage = (ev) => {
      if (ev?.data?.type === "auth-changed") refreshSession();
    };
    authChannelRef.current = ch;
    return () => {
      ch.close();
      authChannelRef.current = null;
    };
  }, [refreshSession]);

  const broadcastAuthChange = () => {
    authChannelRef.current?.postMessage({ type: "auth-changed" });
  };

  // Refresh the counsellor roster only for staff sessions — the admin's
  // impersonation banner reads the counsellor name from this list. Students
  // never need it (and the server now returns [] for them anyway, but
  // skipping the request avoids a useless round-trip).
  useEffect(() => {
    if (!session || session === "loading") return;
    if (session.role === "student") return;
    api.listCounsellors().then(setCounsellors).catch(() => {});
  }, [session]);

  // Login: hands creds to the server, gets back the session cookie and a
  // shape describing what landed in. We mirror that into local state so
  // the next render picks the right panel without a second roundtrip.
  // Distinguishes 401 (wrong creds) from other errors so the form can
  // show the right copy.
  const onAuth = async (username, password) => {
    try {
      const out = await api.login(username, password);
      if (out.user_kind === "admin") {
        setSession({
          role: "admin",
          displayName: out.username || "Admin",
          adminUsernameRaw: out.usernameRaw || "",
          adminMirrors: out.mirrors || [],
        });
      } else if (out.user_kind === "counsellor") {
        setSession({ role: "counsellor", counsellorId: out.counsellor.id, displayName: out.counsellor.name || "Counsellor" });
      } else if (out.user_kind === "student") {
        setSession({
          role: "student",
          studentId: out.student.student_id,
          studentName: out.student.display_name || out.student.username,
        });
      }
      broadcastAuthChange();
      return { ok: true };
    } catch (e) {
      if (e && e.status === 401) return { ok: false, kind: "auth" };
      return { ok: false, kind: "network", message: e?.message || "Couldn't reach the server" };
    }
  };

  const onSignOut = async () => {
    // Best-effort: even if the server delete fails (e.g. network blip),
    // we still wipe local UI state so the user lands on the login form.
    // The cookie's httpOnly + same-origin scope means a half-cleared
    // session won't leak elsewhere.
    try {
      await api.logout();
    } catch {
      /* ignore — client state still clears below */
    }
    saveKey(IMPERSONATE_KEY, null);
    setSession(null);
    setImpersonatingRaw(null);
    broadcastAuthChange();
  };

  if (session === "loading") {
    return (
      <>
        <VersionBanner />
        <div
          className="flex min-h-screen w-full items-center justify-center font-serif text-black"
          style={{ backgroundColor: "#faf9f5" }}
        >
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </>
    );
  }

  if (!session)
    return (
      <>
        <VersionBanner />
        <Login onAuth={onAuth} />
      </>
    );

  // Student session — render the intake form, no admin chrome. The
  // intake's TopBar provides its own sign-out path via the existing
  // /api/auth/logout flow.
  if (session.role === "student") {
    return (
      <>
        <VersionBanner />
        <StudentIntake
          studentName={session.studentName || "student"}
          onExit={onSignOut}
          onComplete={() => { /* server-side intake_complete flag flips inside the intake UI */ }}
        />
      </>
    );
  }

  // Admin viewing-as a counsellor. Renders the same scoped SimplePanel
  // a counsellor would see for themselves; the impersonation banner up
  // top + the cookie's admin role are what mark this as an admin view.
  if (session.role === "admin" && impersonating) {
    const staffName =
      counsellors.find((c) => c.id === impersonating.counsellorId)?.name || "—";
    return (
      <>
        <VersionBanner />
        <Frame onSignOut={onSignOut} displayName={staffName} roleLabel="Counsellor">
          <BackToAdminBanner staffName={staffName} onExit={() => setImpersonating(null)} />
          <SimplePanel
            role="counsellor"
            scopedCounsellorId={impersonating.counsellorId}
          />
        </Frame>
      </>
    );
  }

  if (session.role === "admin") {
    return (
      <>
        <VersionBanner />
        <Frame onSignOut={onSignOut} displayName={session.displayName || "Admin"} roleLabel="Admin">
          <AdminPanel
            onImpersonate={(counsellorId) => setImpersonating({ counsellorId })}
            adminUsername={session.displayName || ""}
            adminUsernameRaw={session.adminUsernameRaw || ""}
            adminMirrors={session.adminMirrors || []}
          />
        </Frame>
      </>
    );
  }

  // session.role === "counsellor"
  return (
    <>
      <VersionBanner />
      <Frame onSignOut={onSignOut} displayName={session.displayName || "Counsellor"} roleLabel="Counsellor">
        <SimplePanel
          role="counsellor"
          scopedCounsellorId={session.counsellorId}
        />
      </Frame>
    </>
  );
}

function Frame({ children, onSignOut, displayName, roleLabel }) {
  const article = roleLabel === "Admin" ? "an" : "a";
  return (
    <div
      className="min-h-screen w-full font-serif text-black"
      style={{ backgroundColor: "#faf9f5" }}
    >
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-10 flex items-center gap-4 border-b border-stone-300 pb-4">
          {/* Left: wordmark */}
          <span className="shrink-0 text-2xl font-semibold tracking-tight">Persona</span>

          {/* Centre: welcome */}
          {displayName && (
            <div className="flex-1 text-center">
              <span className="text-base font-bold text-black">Welcome, {displayName}</span>
              <span className="text-base text-black"> · </span>
              <span className="text-base text-[#cc785c]">
                you are {article} <span className="font-bold">{roleLabel}</span> at Persona
              </span>
            </div>
          )}
          {!displayName && <div className="flex-1" />}

          {/* Right: clock + sign out */}
          <div className="shrink-0 flex items-center gap-5">
            <LiveClock />
            <button
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.2em] text-black hover:text-black"
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
      <p className="text-[11px] uppercase tracking-[0.2em] text-black">
        Ludhiana time
      </p>
      <p className="text-xs font-semibold tabular-nums text-black">
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
function Login({ onAuth }) {
  // Prefill the username from a `?u=` URL param so onboarding links
  // sent by the counsellor (StudentsAdmin's CredentialsModal) drop the
  // student straight into the form with their username already typed.
  // Strip the param after read so refreshing the login screen later
  // doesn't keep showing it.
  const initialUser = (() => {
    if (typeof window === "undefined") return "";
    try {
      const params = new URLSearchParams(window.location.search);
      const u = params.get("u");
      if (u && /^[a-zA-Z0-9_.-]{1,50}$/.test(u)) return u;
    } catch {}
    return "";
  })();
  const [user, setUser] = useState(initialUser);
  const [pw, setPw] = useState("");
  // err is null when no error, or { kind: "auth"|"network", message? }.
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const clearErr = () => setErr(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const result = await onAuth(user.trim(), pw);
    setBusy(false);
    if (!result.ok) setErr(result);
  };

  return (
    <div
      className="flex min-h-screen w-full items-center justify-center font-serif text-black"
      style={{ backgroundColor: "#faf9f5" }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-xl border border-stone-300 bg-white p-12"
      >
        <div className="mb-10 text-center">
          <p className="text-[13px] uppercase tracking-[0.35em] text-black">
            Sign in
          </p>
          <h1 className="mt-3 font-serif text-5xl leading-[1.05]">Persona</h1>
          <p className="mt-3 text-xs uppercase tracking-[0.3em] text-black">
            Followup Panel
          </p>
        </div>

        <label className="block">
          <span className="text-[12px] uppercase tracking-[0.2em] text-black">
            Username
          </span>
          <div className="mt-2 flex items-center gap-2 border-b border-stone-400 focus-within:border-stone-600">
            <User className="h-4 w-4 text-black" />
            <input
              type="text"
              value={user}
              onChange={(e) => {
                setUser(e.target.value);
                clearErr();
              }}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-transparent py-3 text-lg outline-none"
              placeholder="username"
            />
          </div>
        </label>

        <label className="mt-6 block">
          <span className="text-[12px] uppercase tracking-[0.2em] text-black">
            Password
          </span>
          <div className="mt-2 flex items-center gap-2 border-b border-stone-400 focus-within:border-stone-600">
            <Lock className="h-4 w-4 text-black" />
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
      </form>
    </div>
  );
}
