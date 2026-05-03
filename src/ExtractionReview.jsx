import { useEffect, useState, useCallback } from "react";
import {
  Loader2,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  RotateCcw,
  Pencil,
  X as XIcon,
} from "lucide-react";
import {
  listExtractions,
  confirmExtraction,
  retryExtraction,
  isExtractionTerminal,
} from "./intakeFiles.js";

// ============================================================
// ExtractionReview — student-facing screen between intake completion
// and resume generation. Goal is TRUST: every claim the AI made about
// a student's documents is shown back to them, in a friendly form,
// editable, before any of it feeds the resume generator.
//
// Polls listExtractions() every 5s until every extraction is terminal
// (or until all visible ones are confirmed). Each terminal extraction
// renders a typed card (MarksheetCard for marksheet_v1, Generic for
// extractor types we haven't built a custom view for yet).
// ============================================================
export default function ExtractionReview({ onContinue, onBack }) {
  const [extractions, setExtractions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Local edits + confirm state, keyed by extraction id. We only push
  // to the server on Confirm (or Save & Confirm). The server stores
  // both the AI's original `data` AND the student's `confirmed_data`,
  // so this never destroys provenance.
  const [editsById, setEditsById] = useState({});
  const [confirmingId, setConfirmingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listExtractions();
      setExtractions(list);
      setLoadError(null);
      // Auto-expand the first un-confirmed extraction on first load,
      // so the student lands on something actionable.
      setExpandedId((cur) => {
        if (cur) return cur;
        const next = list.find((e) => isExtractionTerminal(e.status) && !e.confirmedAt);
        return next?.id || null;
      });
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll while any extraction is still pending/running. Stops as soon
  // as everything is terminal so we don't pound the API after that.
  useEffect(() => {
    if (!extractions) return;
    const anyInflight = extractions.some((e) => !isExtractionTerminal(e.status));
    if (!anyInflight) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [extractions, refresh]);

  if (extractions == null) {
    return <CenteredLoader label="Loading what we read…" />;
  }

  const inflight = extractions.filter((e) => !isExtractionTerminal(e.status));
  const failed = extractions.filter((e) => e.status === "failed");
  const succeeded = extractions.filter((e) => e.status === "succeeded");
  const confirmed = succeeded.filter((e) => e.confirmedAt);
  const unconfirmed = succeeded.filter((e) => !e.confirmedAt);
  const allConfirmed = unconfirmed.length === 0 && inflight.length === 0 && failed.length === 0;

  const handleConfirm = async (extraction) => {
    setConfirmingId(extraction.id);
    const edited = editsById[extraction.id];
    const dataToSend = edited != null ? edited : (extraction.data || null);
    try {
      await confirmExtraction(extraction.id, dataToSend);
      // Drop the local edit after server accepts it.
      setEditsById((p) => {
        const { [extraction.id]: _drop, ...rest } = p;
        return rest;
      });
      await refresh();
    } catch (e) {
      alert(`Couldn't save: ${e.message}`);
    } finally {
      setConfirmingId(null);
    }
  };

  const handleRetryExtraction = async (extraction) => {
    try {
      await retryExtraction(extraction.fileId);
      await refresh();
    } catch (e) {
      alert(`Retry failed: ${e.message}`);
    }
  };

  const setEdit = (id, value) => {
    setEditsById((p) => ({ ...p, [id]: value }));
  };

  return (
    <div className="animate-fadeUp py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
        Step · Review
      </p>
      <h2 className="mt-2 font-serif text-3xl leading-tight md:text-4xl">
        Here's what we read from your documents
      </h2>
      <p className="mt-3 max-w-2xl text-sm italic text-stone-500">
        Our AI parsed every PDF you uploaded. Look through each one — fix anything
        that's wrong, then confirm. Nothing flows into your resume until you do.
      </p>

      {loadError && (
        <div className="mt-6 inline-flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3 w-3" /> {loadError}
        </div>
      )}

      {/* Status banner */}
      <div className="mt-6 grid gap-2 text-[10px] uppercase tracking-[0.2em] sm:grid-cols-4">
        <Stat label="To review" value={unconfirmed.length} tone="amber" />
        <Stat label="Still reading" value={inflight.length} tone="stone" />
        <Stat label="Confirmed" value={confirmed.length} tone="emerald" />
        <Stat label="Failed" value={failed.length} tone={failed.length ? "red" : "stone"} />
      </div>

      {/* The list — inflight + failed first (need attention), then unconfirmed
          succeeded, then already-confirmed (collapsed below for traceability). */}
      <div className="mt-8 space-y-3">
        {extractions.length === 0 && (
          <p className="rounded-sm border border-dashed border-stone-300 bg-white px-4 py-6 text-sm italic text-stone-500">
            You haven't uploaded any documents we can extract yet. Go back and add some
            marksheets, LORs, or test results, then return here.
          </p>
        )}

        {[
          ...inflight,
          ...failed,
          ...unconfirmed,
          ...confirmed,
        ].map((e) => (
          <ExtractionCard
            key={e.id}
            extraction={e}
            expanded={expandedId === e.id}
            onToggle={() => setExpandedId((p) => (p === e.id ? null : e.id))}
            edited={editsById[e.id]}
            onEdit={(v) => setEdit(e.id, v)}
            onConfirm={() => handleConfirm(e)}
            onRetry={() => handleRetryExtraction(e)}
            confirming={confirmingId === e.id}
          />
        ))}
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-stone-200 pt-6">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 border border-stone-300 bg-transparent px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-stone-600 transition hover:border-stone-700 hover:text-stone-900"
        >
          ← back to intake
        </button>
        <button
          onClick={onContinue}
          disabled={!allConfirmed}
          className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
        >
          {allConfirmed
            ? "Continue to resume setup"
            : inflight.length > 0
              ? `Waiting on ${inflight.length} extraction${inflight.length === 1 ? "" : "s"}…`
              : failed.length > 0
                ? `Resolve ${failed.length} failed extraction${failed.length === 1 ? "" : "s"}`
                : `Confirm ${unconfirmed.length} more`}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const toneCls = {
    emerald: "border-emerald-700/30 bg-emerald-50 text-emerald-800",
    amber:   "border-amber-700/30 bg-amber-50 text-amber-800",
    red:     "border-red-700/30 bg-red-50 text-red-800",
    stone:   "border-stone-300 bg-white text-stone-600",
  }[tone];
  return (
    <div className={`flex items-baseline justify-between border ${toneCls} px-3 py-2`}>
      <span>{label}</span>
      <span className="text-base font-semibold not-italic tracking-normal">{value}</span>
    </div>
  );
}

// ============================================================
// ExtractionCard — one collapsible card per extraction. Routes to
// type-specific renderer (Marksheet today; more as we add extractors).
// ============================================================
function ExtractionCard({
  extraction,
  expanded,
  onToggle,
  edited,
  onEdit,
  onConfirm,
  onRetry,
  confirming,
}) {
  const e = extraction;
  const status = e.status;
  const isConfirmed = !!e.confirmedAt;
  const isInflight = !isExtractionTerminal(status);

  const headerTone = isConfirmed
    ? "border-emerald-700/30 bg-emerald-50/40"
    : status === "failed"
      ? "border-red-700/30 bg-red-50/40"
      : isInflight
        ? "border-stone-300 bg-stone-50"
        : "border-amber-700/30 bg-amber-50/30";

  return (
    <div className={`border ${headerTone}`}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        disabled={isInflight}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-stone-500" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-stone-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-stone-900">
            {prettyExtractor(e.extractor)}
            {" — "}
            <span className="font-normal text-stone-600">{e.fileName}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-stone-500">
            <StatusPill status={status} confirmedAt={e.confirmedAt} error={e.error} />
            {" · "}<span className="font-mono text-stone-400">{e.fieldId}</span>
          </p>
        </div>
      </button>

      {expanded && !isInflight && (
        <div className="border-t border-stone-200 bg-white p-4">
          {status === "failed" ? (
            <FailedBody extraction={e} onRetry={onRetry} />
          ) : (
            <ExtractionBody
              extraction={e}
              edited={edited}
              onEdit={onEdit}
              onConfirm={onConfirm}
              confirming={confirming}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, confirmedAt, error }) {
  if (confirmedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-emerald-700">
        <Check className="h-2.5 w-2.5" /> confirmed
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-red-700">
        <AlertCircle className="h-2.5 w-2.5" /> failed{error ? ` · ${error.slice(0, 60)}` : ""}
      </span>
    );
  }
  if (status === "succeeded") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-amber-800">
        needs review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-stone-500">
      <Loader2 className="h-2.5 w-2.5 animate-spin" /> {status}
    </span>
  );
}

function FailedBody({ extraction, onRetry }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-700">
        We couldn't read this document. The original is still saved — only the AI
        extraction failed.
      </p>
      {extraction.error && (
        <pre className="overflow-x-auto bg-stone-100 p-2 text-[11px] text-red-700">
          {extraction.error}
        </pre>
      )}
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-2 border border-stone-700 bg-stone-700 px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-stone-800"
      >
        <RotateCcw className="h-3 w-3" /> Try again
      </button>
    </div>
  );
}

function ExtractionBody({ extraction, edited, onEdit, onConfirm, confirming }) {
  // Custom UI per extractor type. Today only marksheet_v1 has a tailored
  // view; everything else falls through to the generic JSON editor.
  const data = edited ?? extraction.confirmedData ?? extraction.data ?? {};

  let body;
  if (extraction.extractor === "marksheet_v1") {
    body = <MarksheetReview data={data} onChange={onEdit} />;
  } else {
    body = <GenericJsonReview data={data} onChange={onEdit} />;
  }

  const isDirty = edited != null;

  return (
    <div className="space-y-4">
      {data.warnings && data.warnings.length > 0 && (
        <div className="border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <p className="font-semibold uppercase tracking-[0.15em] text-[10px]">Heads up</p>
          <ul className="mt-1 list-disc pl-4">
            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {body}
      <div className="flex items-center gap-3 border-t border-stone-100 pt-3">
        <button
          onClick={onConfirm}
          disabled={confirming}
          className="inline-flex items-center gap-2 border border-emerald-700 bg-emerald-700 px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-emerald-800 disabled:opacity-50"
        >
          {confirming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {isDirty ? "Save edits & confirm" : "Looks correct — confirm"}
        </button>
        {isDirty && (
          <button
            onClick={() => onEdit(null)}
            className="text-[11px] uppercase tracking-[0.2em] text-stone-500 underline-offset-4 hover:text-stone-900 hover:underline"
          >
            Discard edits
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// MarksheetReview — typed view of a CBSE/ISC/state-board marksheet.
// Shape comes from server/extractors/marksheet.js SCHEMA. Editable
// inline; emits the full updated `data` blob to the parent on each
// keystroke. The parent decides when to push to the server.
// ============================================================
function MarksheetReview({ data, onChange }) {
  const subjects = Array.isArray(data.subjects) ? data.subjects : [];
  const updateField = (k, v) => onChange({ ...data, [k]: v });
  const updateSubject = (i, k, v) => {
    const next = subjects.map((s, idx) => idx === i ? { ...s, [k]: v } : s);
    onChange({ ...data, subjects: next });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Field label="Board" value={data.board} onChange={(v) => updateField("board", v)} />
        <Field label="Year"  value={data.exam_year} onChange={(v) => updateField("exam_year", numOrStr(v))} />
        <Field label="Roll #"  value={data.roll_no} onChange={(v) => updateField("roll_no", v)} />
        <Field label="Student name"  value={data.student_name} onChange={(v) => updateField("student_name", v)} wide />
        <Field label="School name"   value={data.school_name}  onChange={(v) => updateField("school_name", v)} wide />
        <Field label="School code"   value={data.school_code}  onChange={(v) => updateField("school_code", v)} />
      </div>

      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-stone-600">
          Subjects ({subjects.length})
        </p>
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-stone-300 text-[10px] uppercase tracking-[0.15em] text-stone-500">
              <th className="px-2 py-1.5 text-left">Code</th>
              <th className="px-2 py-1.5 text-left">Subject</th>
              <th className="px-2 py-1.5 text-right">Marks</th>
              <th className="px-2 py-1.5 text-right">Out of</th>
              <th className="px-2 py-1.5 text-left">Grade</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((s, i) => (
              <tr key={i} className="border-b border-stone-100">
                <td className="px-2 py-1"><Cell value={s.code} onChange={(v) => updateSubject(i, "code", v)} /></td>
                <td className="px-2 py-1"><Cell value={s.name} onChange={(v) => updateSubject(i, "name", v)} /></td>
                <td className="px-2 py-1 text-right"><Cell value={s.marks_obtained} onChange={(v) => updateSubject(i, "marks_obtained", numOrStr(v))} align="right" /></td>
                <td className="px-2 py-1 text-right"><Cell value={s.max_marks} onChange={(v) => updateSubject(i, "max_marks", numOrStr(v))} align="right" /></td>
                <td className="px-2 py-1"><Cell value={s.grade} onChange={(v) => updateSubject(i, "grade", v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 border-t border-stone-200 pt-3">
        <Field label="Total obtained" value={data.total_obtained} onChange={(v) => updateField("total_obtained", numOrStr(v))} />
        <Field label="Total max"      value={data.total_max}      onChange={(v) => updateField("total_max", numOrStr(v))} />
        <Field label="Percentage"     value={data.percentage}     onChange={(v) => updateField("percentage", numOrStr(v))} />
        <Field label="Overall grade"  value={data.overall_grade}  onChange={(v) => updateField("overall_grade", v)} />
      </div>
    </div>
  );
}

// Generic JSON editor — fallback for extractor types we haven't built
// a tailored UI for yet. Renders top-level keys as inline fields,
// arrays/objects as a code block.
function GenericJsonReview({ data, onChange }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] italic text-stone-500">
        We haven't built a custom view for this document type yet — here's the raw extracted data.
      </p>
      {Object.entries(data || {}).map(([k, v]) => {
        if (k === "warnings" || k === "_meta") return null;
        if (typeof v === "object" && v !== null) {
          return (
            <div key={k}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-stone-600">{k}</p>
              <pre className="mt-1 overflow-x-auto bg-stone-50 p-2 text-[11px] text-stone-800">
                {JSON.stringify(v, null, 2)}
              </pre>
            </div>
          );
        }
        return (
          <Field
            key={k}
            label={k}
            value={v}
            onChange={(nv) => onChange({ ...data, [k]: nv })}
            wide
          />
        );
      })}
    </div>
  );
}

function Field({ label, value, onChange, wide }) {
  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">{label}</span>
      <input
        type="text"
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="mt-1 w-full border-b border-stone-300 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
      />
    </label>
  );
}

function Cell({ value, onChange, align = "left" }) {
  return (
    <input
      type="text"
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className={`w-full border-b border-stone-200 bg-transparent px-1 py-0.5 text-[12px] outline-none focus:border-stone-700 text-${align}`}
    />
  );
}

function CenteredLoader({ label }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-stone-500">
      <Loader2 className="h-5 w-5 animate-spin" />
      <p className="mt-3 text-[11px] uppercase tracking-[0.2em]">{label}</p>
    </div>
  );
}

const numOrStr = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

const prettyExtractor = (key) => {
  const map = {
    marksheet_v1: "Marksheet",
    transcript_v1: "Transcript",
    lor_v1: "Letter of Recommendation",
    sop_v1: "Statement of Purpose",
    ielts_v1: "IELTS Result",
    toefl_v1: "TOEFL Result",
    sat_v1: "SAT Result",
    ap_v1: "AP Scores",
  };
  return map[key] || key;
};
