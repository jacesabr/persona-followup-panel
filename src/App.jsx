import { useEffect, useState } from "react";
import { LogOut, User, Lock } from "lucide-react";
import LeadFollowup from "./LeadFollowup.jsx";
import StaffDashboard from "./StaffDashboard.jsx";
import SimpleFollowup from "./SimpleFollowup.jsx";
import { api } from "./api.js";
import { formatInIst } from "../lib/time.js";

const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";
const STAFF_USER = "staff";
const STAFF_PASS = "staff";
const SIMPLE_USER = "simple";
const SIMPLE_PASS = "simple";
const SESSION_KEY = "persona_session";

function loadSession() {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveSession(s) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  // For admin only — when set, render the StaffDashboard "as" this counsellor.
  // Shape: { counsellorId }
  const [impersonating, setImpersonating] = useState(null);
  const [counsellors, setCounsellors] = useState([]);

  // Refresh the counsellor roster whenever there's an active session — both
  // the admin's view-as dropdown and the staff login's random pick need it.
  useEffect(() => {
    if (!session) return;
    api.listCounsellors().then(setCounsellors).catch(() => {});
  }, [session]);

  const onAdminAuth = () => {
    const s = { role: "admin" };
    saveSession(s);
    setSession(s);
  };

  const onSimpleAuth = () => {
    const s = { role: "simple" };
    saveSession(s);
    setSession(s);
  };

  const onStaffAuth = async () => {
    // Pick a random counsellor at login time. Stable for the session.
    let pick = null;
    try {
      const list = await api.listCounsellors();
      setCounsellors(list);
      if (list.length > 0) pick = list[Math.floor(Math.random() * list.length)];
    } catch {
      // network error — still let them in, dashboard will surface the error
    }
    const s = { role: "staff", counsellorId: pick?.id || null };
    saveSession(s);
    setSession(s);
  };

  const onSignOut = () => {
    clearSession();
    setSession(null);
    setImpersonating(null);
  };

  if (!session)
    return (
      <Login
        onAdminAuth={onAdminAuth}
        onStaffAuth={onStaffAuth}
        onSimpleAuth={onSimpleAuth}
      />
    );

  // Admin viewing-as a staff member
  if (session.role === "admin" && impersonating) {
    const staffName =
      counsellors.find((c) => c.id === impersonating.counsellorId)?.name || "—";
    return (
      <Frame onSignOut={onSignOut} viewLabel="Counsellor followup dashboard view">
        <BackToAdminBanner staffName={staffName} onExit={() => setImpersonating(null)} />
        <StaffDashboard
          counsellorId={impersonating.counsellorId}
          counsellors={counsellors}
          isImpersonation
        />
      </Frame>
    );
  }

  if (session.role === "admin") {
    return (
      <Frame onSignOut={onSignOut} viewLabel="Admin followup dashboard view">
        <LeadFollowup
          onPickStaff={(impersonationState) => setImpersonating(impersonationState)}
        />
      </Frame>
    );
  }

  if (session.role === "simple") {
    return (
      <Frame onSignOut={onSignOut} viewLabel="Simple followup panel view">
        <SimpleFollowup />
      </Frame>
    );
  }

  // session.role === "staff"
  return (
    <Frame onSignOut={onSignOut} viewLabel="Counsellor followup dashboard view">
      <StaffDashboard
        counsellorId={session.counsellorId}
        counsellors={counsellors}
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
function Login({ onAdminAuth, onStaffAuth, onSimpleAuth }) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    const u = user.trim().toLowerCase();
    if (u === ADMIN_USER && pw === ADMIN_PASS) {
      onAdminAuth();
    } else if (u === STAFF_USER && pw === STAFF_PASS) {
      onStaffAuth();
    } else if (u === SIMPLE_USER && pw === SIMPLE_PASS) {
      onSimpleAuth();
    } else {
      setErr(true);
    }
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
                setErr(false);
              }}
              autoFocus
              autoComplete="username"
              className="flex-1 bg-transparent py-3 text-lg outline-none"
              placeholder="admin, staff, or simple"
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
                setErr(false);
              }}
              autoComplete="current-password"
              className="flex-1 bg-transparent py-3 text-lg outline-none"
              placeholder="••••••"
            />
          </div>
        </label>

        {err && (
          <p className="mt-4 text-xs text-red-700">
            Incorrect username or password.
          </p>
        )}

        <button
          type="submit"
          className="mt-10 w-full border border-[#cc785c] bg-[#cc785c] px-6 py-4 text-sm uppercase tracking-[0.25em] text-white transition hover:bg-[#b86a4f]"
        >
          Enter →
        </button>

        <p className="mt-6 text-center text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Trial mode · admin/admin · staff/staff · simple/simple
        </p>
      </form>
    </div>
  );
}
