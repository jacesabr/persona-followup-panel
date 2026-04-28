import { useState } from "react";
import { LogOut, User, Lock } from "lucide-react";
import LeadFollowup from "./LeadFollowup.jsx";

const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";

export default function App() {
  const [authed, setAuthed] = useState(false);

  if (!authed) {
    return <Login onAuth={() => setAuthed(true)} />;
  }

  return (
    <div
      className="min-h-screen w-full font-serif text-stone-900"
      style={{
        backgroundColor: "#faf9f5",
      }}
    >
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-10 flex items-center justify-between border-b border-stone-200 pb-4">
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-semibold tracking-tight">Persona</span>
            <span className="text-xs uppercase tracking-[0.25em] text-stone-500">
              · Followup Panel
            </span>
          </div>
          <button
            onClick={() => setAuthed(false)}
            className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.2em] text-stone-600 hover:text-stone-900"
          >
            <LogOut className="h-3 w-3" /> sign out
          </button>
        </header>

        <LeadFollowup />
      </div>
    </div>
  );
}

// ============================================================
// Login — full-screen, username + password
// ============================================================
function Login({ onAuth }) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (user.trim().toLowerCase() === ADMIN_USER && pw === ADMIN_PASS) {
      onAuth();
    } else {
      setErr(true);
    }
  };

  return (
    <div
      className="flex min-h-screen w-full items-center justify-center font-serif text-stone-900"
      style={{
        backgroundColor: "#faf9f5",
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-xl border border-stone-200 bg-white/80 p-12"
      >
        <div className="mb-10 text-center">
          <p className="text-[11px] uppercase tracking-[0.35em] text-stone-500">
            Sign in
          </p>
          <h1 className="mt-3 font-serif text-5xl leading-[1.05]">
            Persona
          </h1>
          <p className="mt-3 text-xs uppercase tracking-[0.3em] text-stone-500">
            Followup Panel
          </p>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
            Username
          </span>
          <div className="mt-2 flex items-center gap-2 border-b border-stone-300 focus-within:border-stone-600">
            <User className="h-4 w-4 text-stone-500" />
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
              placeholder="admin"
            />
          </div>
        </label>

        <label className="mt-6 block">
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
            Password
          </span>
          <div className="mt-2 flex items-center gap-2 border-b border-stone-300 focus-within:border-stone-600">
            <Lock className="h-4 w-4 text-stone-500" />
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
      </form>
    </div>
  );
}
