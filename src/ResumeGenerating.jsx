import { useEffect, useState, useCallback } from "react";
import {
  Loader2,
  Check,
  AlertCircle,
  RotateCcw,
  ArrowRight,
} from "lucide-react";
import {
  listResumes,
  regenerateResume,
  isResumeTerminal,
} from "./intakeFiles.js";

// ResumeGenerating — interim screen while the backend works through
// each requested resume. Polls every 4s until every row is terminal,
// then hands off to onAllDone (parent moves to the viewer phase).
//
// Each card shows the spec, the live status, the cost so far, and a
// peek at the provenance (sections rendered + bullet count) once the
// resume succeeds. Failed rows get a "regenerate" button.
export default function ResumeGenerating({ onAllDone, onBack }) {
  const [resumes, setResumes] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listResumes();
      setResumes(list);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll until every resume is terminal.
  useEffect(() => {
    if (!resumes) return;
    const inflight = resumes.some((r) => !isResumeTerminal(r.status));
    if (!inflight) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [resumes, refresh]);

  const allDone = resumes != null && resumes.length > 0 &&
    resumes.every((r) => isResumeTerminal(r.status));
  const allSucceeded = resumes != null && resumes.length > 0 &&
    resumes.every((r) => r.status === "succeeded");

  const onRegen = async (id) => {
    try {
      await regenerateResume(id);
      await refresh();
    } catch (e) {
      alert(`Regenerate failed: ${e.message}`);
    }
  };

  if (resumes == null) {
    return (
      <div className="flex flex-col items-center py-20 text-stone-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="mt-3 text-[11px] uppercase tracking-[0.2em]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="animate-fadeUp py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
        Step · Generating
      </p>
      <h2 className="mt-2 font-serif text-3xl leading-tight md:text-4xl">
        Writing your resume{resumes.length === 1 ? "" : "s"}…
      </h2>
      <p className="mt-3 max-w-2xl text-sm italic text-stone-500">
        Each resume runs through Plan → per-section drafting → citation validation.
        Typical run: ~30-90 seconds per resume.
      </p>

      {loadError && (
        <div className="mt-6 inline-flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3 w-3" /> {loadError}
        </div>
      )}

      <div className="mt-8 space-y-3">
        {resumes.map((r) => (
          <ResumeStatusCard key={r.id} resume={r} onRegen={() => onRegen(r.id)} />
        ))}
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-stone-200 pt-6">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 border border-stone-300 bg-transparent px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-stone-600 transition hover:border-stone-700 hover:text-stone-900"
        >
          ← back to setup
        </button>
        <button
          onClick={onAllDone}
          disabled={!allDone}
          className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
        >
          {allSucceeded
            ? "View resumes"
            : allDone
              ? "View what we have"
              : "Working…"}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function ResumeStatusCard({ resume: r, onRegen }) {
  const tone = r.status === "succeeded"
    ? "border-emerald-700/30 bg-emerald-50/40"
    : r.status === "failed"
      ? "border-red-700/30 bg-red-50/40"
      : "border-stone-300 bg-stone-50";

  return (
    <div className={`border ${tone} px-4 py-3`}>
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold text-stone-900">
          {r.label}
          <span className="ml-2 text-[10px] font-normal uppercase tracking-[0.15em] text-stone-500">
            {r.lengthPages}p · {r.style || "default style"}
            {r.domain ? ` · ${r.domain}` : ""}
          </span>
        </p>
        <StatusBadge resume={r} />
      </div>

      {r.status === "succeeded" && r.sourceSnapshot && (
        <p className="mt-1 text-[11px] text-stone-500">
          {countBullets(r.sourceSnapshot)} bullets ·
          {" "}
          {r.exampleIds?.length || 0} style example{r.exampleIds?.length === 1 ? "" : "s"} used ·
          {" "}
          ~${(r.costCents / 100).toFixed(2)} estimated
        </p>
      )}

      {r.status === "failed" && (
        <div className="mt-2 flex items-center gap-3">
          <p className="text-[11px] text-red-700">
            {r.error || "Generation failed."}
          </p>
          <button
            onClick={onRegen}
            className="inline-flex items-center gap-1 border border-stone-700 bg-stone-700 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-white transition hover:bg-stone-800"
          >
            <RotateCcw className="h-2.5 w-2.5" /> Try again
          </button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ resume: r }) {
  if (r.status === "succeeded") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-emerald-700">
        <Check className="h-2.5 w-2.5" /> ready
      </span>
    );
  }
  if (r.status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-red-700">
        <AlertCircle className="h-2.5 w-2.5" /> failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-stone-500">
      <Loader2 className="h-2.5 w-2.5 animate-spin" /> {r.status}
    </span>
  );
}

function countBullets(snapshot) {
  try {
    const s = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
    return (s?.sections_meta || []).reduce((acc, m) => acc + (m.bullet_count || 0), 0);
  } catch {
    return 0;
  }
}
