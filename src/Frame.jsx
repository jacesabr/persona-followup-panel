// Shared shell for logged-in panels (admin / counsellor / student).
// Banner reads "Welcome, {displayName} · you are a/an {roleLabel} at Persona"
// so every signed-in user sees the same chrome regardless of role.

import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { formatInIst } from "../lib/time.js";

export default function Frame({ children, onSignOut, displayName, roleLabel, belowHeader = null }) {
  const article = roleLabel === "Admin" ? "an" : "a";
  return (
    <div
      className="min-h-screen w-full font-serif text-black"
      style={{ backgroundColor: "#faf9f5" }}
    >
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className={`${belowHeader ? "mb-6" : "mb-10"} flex items-center gap-4 border-b border-stone-300 pb-4`}>
          <span className="shrink-0 text-2xl font-semibold tracking-tight">Persona</span>

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

          <div className="shrink-0 flex items-center gap-5">
            <LiveClock />
            {onSignOut && (
              <button
                onClick={onSignOut}
                className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.2em] text-black hover:text-black"
              >
                <LogOut className="h-3 w-3" /> sign out
              </button>
            )}
          </div>
        </header>
        {belowHeader}
        {children}
      </div>
    </div>
  );
}

// Always-visible clock pinned to IST. Lives here so every Frame
// rendering shares the same instance + tick cadence.
export function LiveClock() {
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
