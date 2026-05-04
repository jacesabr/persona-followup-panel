// Post-intake landing screen for the student. Shows the auto-fired
// 300-word resume; polls for status while it's still generating.
//
// One resume for v1 (the multi-resume picker comes back later). Until
// then, the student's account is essentially: "this is the one short
// summary the system produced; come back later for more."

import { useEffect, useState, useRef, useCallback } from "react";
import { Loader2, AlertTriangle, RefreshCw, LogOut, CheckCircle2 } from "lucide-react";
import { listResumes, regenerateResume } from "./intakeFiles.js";
import ResumeMarkdown from "./ResumeMarkdown.jsx";

const POLL_INTERVAL_MS = 4000;

export default function StudentDashboard({ studentName, onExit }) {
  const [resumes, setResumes] = useState(null); // null = loading, [] = none, [{...}] = list
  const [error, setError] = useState(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenErr, setRegenErr] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const list = await listResumes();
      setResumes(list);
      setError(null);
    } catch (e) {
      setError(e?.message || "Couldn't load your resume.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
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
  }, [resumes, load]);

  const latest = (resumes || [])[0] || null;

  const onRegenerate = async () => {
    if (!latest) return;
    if (!window.confirm(
      "Regenerate your resume?\n\nThis will replace the current one and takes 30–60 seconds. " +
      "Note: it uses the information you already submitted — there's no way to edit your answers from here. " +
      "If you spotted a mistake in your intake, ask your counsellor to reopen it before regenerating."
    )) return;
    setRegenBusy(true);
    setRegenErr(null);
    try {
      await regenerateResume(latest.id);
      await load(); // pick up the now-pending status; polling takes over
    } catch (e) {
      setRegenErr(e?.message || "Couldn't start regenerate. Try again.");
    } finally {
      setRegenBusy(false);
    }
  };

  const succeeded = latest?.status === "succeeded";

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
        {succeeded ? (
          <>
            <h1 className="font-serif text-3xl">You're all set, {studentName || "there"}.</h1>
            <p className="mt-2 text-sm text-stone-600">
              Your intake is complete and your counsellor has access to everything you submitted. Below is the 300-word summary the system generated from your information — review it whenever you like, and ping your counsellor if anything needs tweaking.
            </p>
            <div className="mt-4 inline-flex items-center gap-2 border border-emerald-700/30 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5" /> Submission complete · resume ready
            </div>
          </>
        ) : (
          <>
            <h1 className="font-serif text-3xl">Almost there, {studentName || "there"}.</h1>
            <p className="mt-2 text-sm text-stone-600">
              Your intake is in. We're putting together a 300-word summary from what you submitted — this usually takes 30–60 seconds. You don't need to do anything; the page will update once it's ready.
            </p>
          </>
        )}

        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs uppercase tracking-[0.2em] text-stone-500">Your resume</h2>
            {succeeded && (
              <button
                type="button"
                onClick={onRegenerate}
                disabled={regenBusy}
                className="inline-flex items-center gap-1.5 border border-stone-900/30 bg-white px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-900 disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${regenBusy ? "animate-spin" : ""}`} />
                {regenBusy ? "Starting…" : "Regenerate"}
              </button>
            )}
          </div>
          {regenErr && (
            <p className="mt-2 inline-flex items-center gap-2 text-xs text-red-700">
              <AlertTriangle className="h-3 w-3" /> {regenErr}
            </p>
          )}
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
          <div>Resume generation failed. Your counsellor has been notified — you can also tap Regenerate above.</div>
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
  return <ResumeMarkdown>{latest.contentMd || "(empty resume)"}</ResumeMarkdown>;
}
