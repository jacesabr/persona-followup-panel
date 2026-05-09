// OutstandingMarksheetsPanel — staff workspace surfacing students who
// have not yet submitted one or more of their school marksheets.
// Tab: "Outstanding Marksheets" (admin + counsellor)
//
// "Submitted" rules (mirror lib/intakeSchema.js page definitions):
//   - Class 10: marks10sheet uploaded AND marks10pct filled
//   - Class 11: marks11sheet uploaded AND marks11pct filled
//   - Class 12: at least one full pair —
//                 (marks12sheet + marks12pct) OR
//                 (marks12predictedSheet + marks12predicted)
//
// A student appears in the panel if any of the three grades is not
// fully submitted. The 3-day reminder cadence is wired up elsewhere;
// this panel is the staff-facing read view + manual nudge surface.
//
// Source of truth: each student's intake answers (data.answers) from
// the staff /api/students roster, same shape as IeltsPanel uses.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, Search, ExternalLink, CheckCircle2, FileQuestion } from "lucide-react";
import { api } from "./api.js";
import useAutoRefresh from "./useAutoRefresh.js";

function readAnswers(s) {
  const data = s?.data;
  return (data && typeof data === "object" && data.answers) || data || {};
}

function fileFilled(slot) {
  return !!slot && typeof slot === "object" && !Array.isArray(slot) && slot.status === "uploaded";
}

function textFilled(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

// Per-grade verdict. Returns { complete: boolean, hint: string }.
// hint summarises which piece(s) are still missing — surfaced in the
// row's tooltip so staff know exactly what to chase.
function class10Status(a) {
  const sheet = fileFilled(a.marks10sheet);
  const pct   = textFilled(a.marks10pct);
  if (sheet && pct) return { complete: true,  hint: "" };
  if (!sheet && !pct) return { complete: false, hint: "marksheet + %" };
  if (!sheet) return { complete: false, hint: "marksheet" };
  return { complete: false, hint: "%" };
}
function class11Status(a) {
  const sheet = fileFilled(a.marks11sheet);
  const pct   = textFilled(a.marks11pct);
  if (sheet && pct) return { complete: true,  hint: "" };
  if (!sheet && !pct) return { complete: false, hint: "marksheet + %" };
  if (!sheet) return { complete: false, hint: "marksheet" };
  return { complete: false, hint: "%" };
}
function class12Status(a) {
  const actualPair    = fileFilled(a.marks12sheet) && textFilled(a.marks12pct);
  const predictedPair = fileFilled(a.marks12predictedSheet) && textFilled(a.marks12predicted);
  if (actualPair || predictedPair) return { complete: true, hint: "" };
  // Half-filled? Tell staff what's there so the nudge is specific.
  const anyActual    = fileFilled(a.marks12sheet) || textFilled(a.marks12pct);
  const anyPredicted = fileFilled(a.marks12predictedSheet) || textFilled(a.marks12predicted);
  if (anyActual)    return { complete: false, hint: "actual pair incomplete" };
  if (anyPredicted) return { complete: false, hint: "predicted pair incomplete" };
  return { complete: false, hint: "marksheet OR predicted-scores" };
}

function summarize(student) {
  const a = readAnswers(student);
  const c10 = class10Status(a);
  const c11 = class11Status(a);
  const c12 = class12Status(a);
  const missingCount = [c10, c11, c12].filter((g) => !g.complete).length;
  return { c10, c11, c12, missingCount, allComplete: missingCount === 0 };
}

export default function OutstandingMarksheetsPanel({ role = "admin", onViewStudent }) {
  const [students, setStudents] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [filter,   setFilter]   = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await api.listStudents();
      setStudents(list);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    let active = true;
    refresh().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  useAutoRefresh(refresh);

  // Outstanding = any of the three grades incomplete. Hide students who
  // have submitted all three — they're done, they don't need chasing.
  const outstanding = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return students
      .map((s) => ({ student: s, summary: summarize(s) }))
      .filter(({ summary }) => !summary.allComplete)
      .filter(({ student }) => {
        if (!q) return true;
        const haystack = [student.username, student.display_name, student.counsellor_name]
          .filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(q);
      })
      // Most missing first, then oldest signup first (longest outstanding).
      .sort((a, b) => {
        if (b.summary.missingCount !== a.summary.missingCount) {
          return b.summary.missingCount - a.summary.missingCount;
        }
        return new Date(a.student.created_at) - new Date(b.student.created_at);
      });
  }, [students, filter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  // 6 cols: name · class 10 · class 11 · class 12 · counsellor · profile
  const gridCols = "1.5fr 7rem 7rem 7rem 8rem 6rem";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Outstanding Marksheets</h2>
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
            {outstanding.length} {outstanding.length === 1 ? "student" : "students"}
          </span>
        </div>
        <div className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1">
          <Search className="h-3 w-3 text-stone-400" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="w-40 bg-transparent text-xs outline-none"
          />
        </div>
      </div>

      <p className="mb-3 text-sm text-stone-800">
        Auto-reminder cadence: every 3 days while any grade is outstanding.
      </p>

      {error && (
        <div className="mb-3 inline-flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      )}

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-700"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span className="whitespace-nowrap">Student</span>
          <span className="whitespace-nowrap">Class 10</span>
          <span className="whitespace-nowrap">Class 11</span>
          <span className="whitespace-nowrap">Class 12</span>
          <span className="whitespace-nowrap">Counsellor</span>
          <span className="whitespace-nowrap">Profile</span>
        </div>

        {outstanding.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-stone-800">
            No outstanding marksheets — every student has submitted.
          </div>
        )}

        {outstanding.map(({ student, summary }) => (
          <Row
            key={student.student_id}
            student={student}
            summary={summary}
            onView={() => onViewStudent?.(student.student_id)}
            gridCols={gridCols}
          />
        ))}
      </div>
    </>
  );
}

function StatusBadge({ status, label }) {
  if (status.complete) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.15em] text-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> Submitted
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.15em] text-red-700"
      title={`${label}: missing ${status.hint}`}
    >
      <FileQuestion className="h-3 w-3" /> Missing
    </span>
  );
}

function Row({ student, summary, onView, gridCols }) {
  return (
    <div
      className="grid items-center gap-3 border-b border-stone-200 px-3 py-2 text-[13px] text-stone-800 last:border-b-0 hover:bg-stone-50"
      style={{ gridTemplateColumns: gridCols }}
    >
      <span className="min-w-0 truncate">
        <span className="font-semibold">{student.display_name || student.username}</span>
        {student.display_name && (
          <span className="ml-1 text-[11px] font-normal text-stone-500">@{student.username}</span>
        )}
      </span>
      <StatusBadge status={summary.c10} label="Class 10" />
      <StatusBadge status={summary.c11} label="Class 11" />
      <StatusBadge status={summary.c12} label="Class 12" />
      <span className="truncate text-[12px] text-stone-700">{student.counsellor_name || "—"}</span>
      <button
        onClick={onView}
        className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700"
      >
        <ExternalLink className="h-3 w-3" /> View
      </button>
    </div>
  );
}
