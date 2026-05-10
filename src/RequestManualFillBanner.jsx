// Banner shown above the "Sign up a new student" form (and reusable
// in the student-detail modal). Three states:
//
//   1. Idle — no request yet for this student.
//      Shows a button: "Request manual AI fill". Clicking it inserts
//      a manual_ai_requests row + opens a prefilled mailto: to
//      jace100233260@gmail.com so the dev gets notified out-of-band.
//
//   2. Queued — request open, not yet processed.
//      Shows a status block: "Request queued — dev will run the AI
//      pipeline manually within ~1 hour when online. ETA: ~1 hour."
//      Polls the status endpoint every 60s to flip to "complete"
//      automatically.
//
//   3. Complete — request resolved (processed_at non-null).
//      Shows a success block: "Fill-in complete — open the student to
//      view the new resume / SOP / LOR drafts."
//
// `studentId` is required. When undefined / null (e.g. on the
// new-student form before submit), the banner renders an inline
// hint instead so the counsellor sees the workflow exists before
// they click Create.

import { useEffect, useState, useCallback } from "react";
import { Clock, Send, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { api } from "./api.js";

const DEV_EMAIL = "jace100233260@gmail.com";

function buildMailtoUrl({ studentId, displayName, counsellorName }) {
  const subject = `Manual AI fill request — ${displayName || studentId}`;
  const body = [
    `A new manual AI fill request was submitted on persona-followup-panel.`,
    ``,
    `Student: ${displayName || "(name unknown)"}`,
    `Student ID: ${studentId}`,
    counsellorName ? `Requesting counsellor: ${counsellorName}` : null,
    `Requested at: ${new Date().toISOString()}`,
    ``,
    `To run: open Claude Code locally on the persona-followup-panel`,
    `repo and follow automation/instructions_autofill_plus_generate.md.`,
    `The script picks this student up via /api/admin/ai/pending,`,
    `drafts the artifacts, and POSTs /api/admin/ai/dispatch — which`,
    `stamps the matching manual_ai_requests row as processed.`,
  ].filter(Boolean).join("\n");
  return `mailto:${DEV_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function RequestManualFillBanner({
  studentId,
  studentDisplayName,
  counsellorName,
  className = "",
}) {
  const [status, setStatus] = useState(null); // null | "loading" | request row | "idle"
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  // Pre-submit hint — user hasn't created the student yet.
  if (!studentId) {
    return (
      <div className={`inline-flex items-center gap-2 border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700 ${className}`}>
        <Clock className="h-4 w-4 text-stone-700" />
        <span>
          After creating the student, you can request a manual AI fill —
          the dev runs the automation script from Claude Code when notified.
        </span>
      </div>
    );
  }

  const refresh = useCallback(async () => {
    try {
      const out = await api.getManualAiRequestStatus(studentId);
      setStatus(out.request || "idle");
      setErr(null);
    } catch (e) {
      setErr(e.message || "Couldn't load request status.");
    }
  }, [studentId]);

  useEffect(() => {
    refresh();
    // Poll once a minute so a queued banner flips to "complete"
    // shortly after the dev runs the routine, without a refresh.
    const t = setInterval(refresh, 60_000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      await api.requestManualAiFill(studentId, null);
      await refresh();
      // Open the prefilled mailto: in a new tab. The user's mail
      // client picks it up — counsellor reviews and sends.
      const mailto = buildMailtoUrl({
        studentId,
        displayName: studentDisplayName,
        counsellorName,
      });
      window.open(mailto, "_blank", "noopener");
    } catch (e) {
      setErr(e.message || "Couldn't submit request.");
    } finally {
      setSubmitting(false);
    }
  };

  // Loading the initial status
  if (status === null) {
    return (
      <div className={`inline-flex items-center gap-2 text-sm text-stone-700 ${className}`}>
        <Loader2 className="h-3 w-3 animate-spin" /> checking AI fill status…
      </div>
    );
  }

  if (err) {
    return (
      <div className={`inline-flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 ${className}`}>
        <AlertCircle className="h-4 w-4" />
        <span>{err}</span>
      </div>
    );
  }

  // Resolved request → success block
  if (status && status !== "idle" && status.processed_at) {
    return (
      <div className={`inline-flex items-center gap-2 border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ${className}`}>
        <CheckCircle2 className="h-4 w-4" />
        <span>
          AI fill-in complete — open the student to view the new resume,
          SOP, and LOR drafts.
        </span>
      </div>
    );
  }

  // Pending request → queued block
  if (status && status !== "idle" && !status.processed_at) {
    return (
      <div className={`flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 ${className}`}>
        <Clock className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">Request queued.</p>
          <p>
            Dev has been notified to run the automation script from
            Claude Code. This banner flips to <em>complete</em> automatically
            once the run lands.
          </p>
          <a
            href={buildMailtoUrl({ studentId, displayName: studentDisplayName, counsellorName })}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-amber-900 underline underline-offset-4 hover:text-amber-700"
          >
            <Send className="h-3 w-3" /> Re-send notification email
          </a>
        </div>
      </div>
    );
  }

  // Idle (no request yet) → the action button
  return (
    <div className={`flex items-start gap-2 border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 ${className}`}>
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-stone-700" />
      <div className="min-w-0 flex-1">
        <p>
          Ready to AI-fill this student's resume, SOP, LOR drafts and
          file descriptions. The dev runs the automation script from
          Claude Code when notified.
        </p>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="mt-2 inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          Request manual AI fill
        </button>
        <p className="mt-1 text-xs text-stone-600">
          Notifies dev via email at {DEV_EMAIL}. This banner updates
          automatically once the run lands.
        </p>
      </div>
    </div>
  );
}
