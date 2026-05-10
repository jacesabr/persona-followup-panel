// Banner component shown above the create-student / upload flow so
// the counsellor knows when the AI pipeline will next process the
// student they're signing up. The pipeline runs at UTC top-of-hour
// 03:00–17:00 (IST 08:30–22:30), 15 times a day, capped by the
// Claude Max daily-job ceiling.
//
// Refreshes every 30 seconds — no need for a tighter interval since
// the displayed precision is minutes anyway.

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import {
  nextAiPipelineRunAt,
  formatTimeUntil,
  formatInIstHm,
} from "../lib/aiPipelineSchedule.js";

export default function NextAiRunTimer({ className = "", compact = false }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setNow(new Date());
    const interval = setInterval(tick, 30_000);
    // Also tick when the tab regains focus — a tab idle for an hour
    // should snap to the right "in 4m" display the moment the user
    // looks at it again.
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const next = nextAiPipelineRunAt(now);
  const remaining = formatTimeUntil(next - now);
  const istClock = formatInIstHm(next);

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs text-stone-700 ${className}`}>
        <Clock className="h-3 w-3" />
        Next bulk fill-in in {remaining} (~{istClock} IST)
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 ${className}`}
    >
      <Clock className="h-4 w-4 text-stone-700" />
      <span>
        Next AI bulk fill-in in <span className="font-semibold">{remaining}</span>
        <span className="text-stone-600"> (~{istClock} IST)</span>
      </span>
    </div>
  );
}
