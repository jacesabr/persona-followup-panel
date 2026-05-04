// Post-intake landing screen for the student. Shows the auto-fired
// 300-word resume; polls for status while it's still generating.
//
// One resume for v1 (the multi-resume picker comes back later). Until
// then, the student's account is essentially: "this is the one short
// summary the system produced; come back later for more."

import { useEffect, useState, useRef } from "react";
import { Loader2, AlertTriangle, RefreshCw, LogOut } from "lucide-react";
import { listResumes } from "./intakeFiles.js";

const POLL_INTERVAL_MS = 4000;

export default function StudentDashboard({ studentName, onExit }) {
  const [resumes, setResumes] = useState(null); // null = loading, [] = none, [{...}] = list
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await listResumes();
        if (cancelled) return;
        setResumes(list);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || "Couldn't load your resume.");
      }
    }
    load();
    // Poll while any resume is still pending/running.
    pollRef.current = setInterval(() => {
      const inflight = (resumes || []).some(
        (r) => r.status === "pending" || r.status === "running"
      );
      // First load (resumes === null) also benefits from polling.
      if (resumes === null || inflight) load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [resumes]);

  return (
    <div className="min-h-screen w-full font-serif text-stone-900" style={{ backgroundColor: "#f4f0e6" }}>
      <header className="border-b border-stone-900/10 bg-[#f4f0e6]/80 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-sm italic text-stone-500">the</span>
            <span className="text-lg font-semibold tracking-tight">Persona</span>
            <span className="text-[10px] uppercase tracking-[0.25em] text-stone-500">
              · {studentName || "student"}
            </span>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-stone-500 hover:text-stone-900"
          >
            <LogOut className="h-3 w-3" /> Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="font-serif text-3xl">Your dashboard</h1>
        <p className="mt-2 text-sm text-stone-600">
          Intake complete. Your counsellor has access to everything you submitted.
        </p>

        <section className="mt-10">
          <h2 className="text-xs uppercase tracking-[0.2em] text-stone-500">Generated resume</h2>
          <div className="mt-3 border border-stone-900/15 bg-white p-6">
            <ResumeCard resumes={resumes} error={error} />
          </div>
        </section>
      </main>
    </div>
  );
}

function ResumeCard({ resumes, error }) {
  if (error) {
    return (
      <div className="flex items-start gap-3 text-sm text-red-700">
        <AlertTriangle className="mt-0.5 h-4 w-4" />
        <div>{error}</div>
      </div>
    );
  }
  if (resumes === null) {
    return (
      <div className="flex items-center gap-3 text-sm text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (resumes.length === 0) {
    return (
      <div className="text-sm text-stone-600">
        No resume yet. The auto-generation is queued — refresh in a minute.
      </div>
    );
  }
  // Show the most recent resume (created_at DESC from the server).
  const latest = resumes[0];
  if (latest.status === "pending" || latest.status === "running") {
    return (
      <div className="flex items-center gap-3 text-sm text-stone-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        <div>
          Generating your resume… this usually takes 30–60 seconds.
          <div className="mt-1 text-xs text-stone-400">
            Status: {latest.status}
          </div>
        </div>
      </div>
    );
  }
  if (latest.status === "failed") {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>Resume generation failed. Your counsellor has been notified.</div>
        </div>
        {latest.error && (
          <details className="text-xs text-stone-500">
            <summary className="cursor-pointer">Technical details</summary>
            <pre className="mt-2 overflow-auto bg-stone-50 p-2 text-[10px]">
              {String(latest.error).slice(0, 600)}
            </pre>
          </details>
        )}
      </div>
    );
  }
  // Succeeded — render the markdown. /me/resumes returns camelCase
  // (contentMd, lengthWords, etc) — different from the admin
  // /api/students/:id endpoint which exposes raw snake_case rows.
  return (
    <article className="prose prose-sm max-w-none whitespace-pre-wrap font-serif">
      {latest.contentMd || "(empty resume)"}
    </article>
  );
}
