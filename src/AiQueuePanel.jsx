// Admin-only view of the manual_ai_requests queue. Counsellors file
// requests via <RequestManualFillBanner> on the create-student
// credentials modal; this panel surfaces those requests so the dev
// (Jace) can see what's outstanding before running the script.
//
// Two states per row:
//   - pending  → row still needs the dev to run the script locally
//                from Claude Code (per
//                automation/instructions_autofill_plus_generate.md)
//   - resolved → row was processed; resolved_resume_id links to the
//                resume that came out (filtered out of the default
//                view; show via the "Show resolved" toggle)
//
// The dispatch endpoint stamps processed_at + processed_by +
// resolved_resume_id when the script runs, so resolved rows here
// are an audit trail of "who fired what, when."
//
// onViewStudent: SimplePanel's cross-tab handoff — clicking a row
// jumps to the Students tab and auto-expands that student's modal.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Terminal, Send, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { api } from "./api.js";
import useAutoRefresh from "./useAutoRefresh.js";

export default function AiQueuePanel({ onViewStudent = () => {} }) {
  const [showAll, setShowAll] = useState(false);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const out = await api.listManualAiRequests({ status: showAll ? "all" : "pending" });
      setRequests(out.requests || []);
      setError(null);
    } catch (e) {
      setError(e.message || "Couldn't load requests.");
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  useAutoRefresh(refresh);

  const pendingCount = useMemo(
    () => requests.filter((r) => !r.processed_at).length,
    [requests]
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-black">
          AI Queue
          {pendingCount > 0 && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-none border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-normal uppercase tracking-[0.15em] text-amber-900">
              <Clock className="h-3 w-3" /> {pendingCount} pending
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-black" />}
          <label className="inline-flex cursor-pointer items-center gap-2 border border-stone-300 bg-white px-2.5 py-1.5 text-[11px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="h-3 w-3"
            />
            Show resolved
          </label>
          <button
            onClick={() => { setLoading(true); refresh(); }}
            className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1.5 text-[11px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="mb-3 inline-flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4" /> {error}
        </p>
      )}

      <div className="mb-4 flex items-start gap-2 border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800">
        <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-stone-700" />
        <div>
          <p>
            Counsellors file these from the credentials modal after signing a
            student up. To process the queue: open Claude Code locally on the
            persona-followup-panel repo and run the script per
            <code className="mx-1 border border-stone-300 bg-white px-1 text-[11px]">automation/instructions_autofill_plus_generate.md</code>
            (it covers candidate selection, vision pass, draft authoring, and
            dispatch). The run resolves matching pending rows automatically.
          </p>
        </div>
      </div>

      {!loading && requests.length === 0 && (
        <p className="mt-6 text-sm text-stone-700">
          {showAll ? "No requests yet." : "No pending requests. You're caught up."}
        </p>
      )}

      <div className="space-y-2">
        {requests.map((r) => (
          <RequestRow key={r.id} row={r} onViewStudent={onViewStudent} />
        ))}
      </div>
    </div>
  );
}

function RequestRow({ row, onViewStudent }) {
  const isResolved = !!row.processed_at;
  const requestedBy =
    row.requested_by_kind === "admin"
      ? `admin · ${row.requested_by_admin_username || "unknown"}`
      : `counsellor · ${row.counsellor_name || row.requested_by_id || "unknown"}`;
  const requestedWhen = row.requested_at ? new Date(row.requested_at).toLocaleString() : "";
  const processedWhen = row.processed_at ? new Date(row.processed_at).toLocaleString() : null;

  return (
    <div
      className={`border ${
        isResolved
          ? "border-emerald-200 bg-emerald-50/40"
          : "border-amber-300 bg-amber-50/60"
      } px-4 py-3`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <button
              type="button"
              onClick={() => onViewStudent(row.student_id)}
              className="font-semibold text-black underline-offset-4 hover:underline"
            >
              {row.student_display_name || row.student_username || row.student_id}
            </button>
            <span className="ml-2 text-stone-700">{requestedBy}</span>
          </p>
          <p className="mt-0.5 text-xs text-stone-700">
            Requested {requestedWhen}
            {processedWhen && (
              <>
                {" · "}
                Resolved {processedWhen}
                {row.processed_by_admin_username && ` by ${row.processed_by_admin_username}`}
              </>
            )}
            {row.ai_artifacts_generated_at && (
              <>
                {" · "}
                <span className="text-emerald-800">AI artifacts on file</span>
              </>
            )}
          </p>
          {row.notes && (
            <p className="mt-1.5 text-sm text-stone-800">{row.notes}</p>
          )}
        </div>
        <div className="shrink-0">
          {isResolved ? (
            <span className="inline-flex items-center gap-1 border border-emerald-300 bg-white px-2 py-0.5 text-[11px] uppercase tracking-[0.15em] text-emerald-800">
              <CheckCircle2 className="h-3 w-3" /> resolved
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 border border-amber-300 bg-white px-2 py-0.5 text-[11px] uppercase tracking-[0.15em] text-amber-900">
              <Send className="h-3 w-3" /> pending
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
