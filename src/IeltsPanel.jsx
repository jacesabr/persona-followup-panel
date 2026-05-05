import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Archive, Search, ExternalLink, AlertCircle } from "lucide-react";
import { api } from "./api.js";
import ArchivedSection from "./ArchivedSection.jsx";
import useAutoRefresh from "./useAutoRefresh.js";

// IELTS tracking panel — one row per student, source of truth is each
// student's own intake answers (data.answers.ielts_status). Three
// statuses, mirroring the form options in lib/intakeSchema.js's p_ielts
// page. "—" means the student hasn't reached / answered the page yet.
//
// Archive UX mirrors the lead sheet (SimpleFollowup): bulk-select via
// per-row checkboxes, top banner appears when any are selected, archive
// moves them under a collapsed "Archived (N)" section at the bottom.
// The archive flag is independent from is_archived (full-student
// retirement) — see server/routes/students.js ielts-archive.

const STATUS_META = {
  "Already taken":    { label: "Taken",    tone: "text-emerald-700" },
  "Planning to take": { label: "Planning", tone: "text-amber-700"   },
  "Won't take":       { label: "Not taking", tone: "text-stone-500" },
};

function readAnswers(s) {
  const data = s?.data;
  return (data && typeof data === "object" && data.answers) || data || {};
}

function statusOf(s) {
  return readAnswers(s).ielts_status || null;
}

export default function IeltsPanel({ role = "admin", onViewStudent }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

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
    refresh().finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [refresh]);

  useAutoRefresh(refresh);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) => {
      const haystack = [s.username, s.display_name, s.counsellor_name, statusOf(s)]
        .filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [students, filter]);

  const active = useMemo(
    () => filtered.filter((s) => !s.ielts_archived_at),
    [filtered]
  );
  const archived = useMemo(
    () => filtered.filter((s) => s.ielts_archived_at)
      .sort((a, b) => new Date(b.ielts_archived_at) - new Date(a.ielts_archived_at)),
    [filtered]
  );

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const archiveSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!window.confirm(`Archive IELTS tracking for ${ids.length} student${ids.length === 1 ? "" : "s"}?`)) return;
    setBulkBusy(true);
    setError(null);
    const results = await Promise.allSettled(ids.map((id) => api.archiveStudentIelts(id)));
    const stamp = new Date().toISOString();
    const archivedSet = new Set();
    for (let i = 0; i < ids.length; i++) {
      if (results[i].status === "fulfilled") archivedSet.add(ids[i]);
    }
    // Optimistic in-place update so the row jumps to the Archived
    // section without waiting for the next poll. Keep the unrelated
    // fields (data, counsellor, etc.) intact.
    setStudents((prev) => prev.map((s) =>
      archivedSet.has(s.student_id) ? { ...s, ielts_archived_at: stamp } : s
    ));
    clearSelection();
    const failed = ids.length - archivedSet.size;
    if (failed > 0) {
      const firstErr = results.find((r) => r.status === "rejected")?.reason;
      setError(`${failed} of ${ids.length} archives failed${firstErr ? `: ${firstErr.message}` : "."}`);
    }
    setBulkBusy(false);
  };

  const unarchive = async (id) => {
    setError(null);
    try {
      await api.unarchiveStudentIelts(id);
      setStudents((prev) => prev.map((s) =>
        s.student_id === id ? { ...s, ielts_archived_at: null } : s
      ));
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  // 6 cols: select · name · status · score / date · counsellor · profile-action
  const gridCols = "1.75rem 1.5fr 7rem 1fr 7rem 6rem";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">IELTS tracking</h2>
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
            {active.length} {active.length === 1 ? "row" : "rows"}
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

      {error && (
        <div className="mb-3 inline-flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mb-2 flex items-center justify-between border border-[#cc785c] bg-[#cc785c]/10 px-3 py-1.5 text-[12px]">
          <span className="text-stone-800">
            <strong>{selectedIds.size}</strong> selected
          </span>
          <span className="flex items-center gap-2">
            <button
              onClick={clearSelection}
              disabled={bulkBusy}
              className="text-[11px] uppercase tracking-[0.18em] text-stone-600 hover:text-stone-900 disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={archiveSelected}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
            >
              {bulkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
              Archive
            </button>
          </span>
        </div>
      )}

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-700"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span aria-hidden="true"></span>
          <span className="whitespace-nowrap">Student</span>
          <span className="whitespace-nowrap">IELTS Status</span>
          <span className="whitespace-nowrap">Score / Planned</span>
          <span className="whitespace-nowrap">Counsellor</span>
          <span className="whitespace-nowrap">Profile</span>
        </div>

        {active.length === 0 && (
          <div className="px-3 py-6 text-center text-xs italic text-stone-500">
            No active students.
          </div>
        )}

        {active.map((s) => (
          <Row
            key={s.student_id}
            student={s}
            checked={selectedIds.has(s.student_id)}
            onToggle={() => toggleSelected(s.student_id)}
            onView={() => onViewStudent?.(s.student_id)}
            gridCols={gridCols}
          />
        ))}
      </div>

      <ArchivedSection
        items={archived}
        renderRow={(s) => (
          <li key={s.student_id} className="px-3 py-2">
            <ArchivedRow student={s} onUnarchive={() => unarchive(s.student_id)} onView={() => onViewStudent?.(s.student_id)} />
          </li>
        )}
      />
    </>
  );
}

function Row({ student, checked, onToggle, onView, gridCols }) {
  const status = statusOf(student);
  const meta = status ? STATUS_META[status] : null;
  const answers = readAnswers(student);
  // Score / planned-date column: pick whichever the student answered.
  let detail = "—";
  if (status === "Already taken" && answers.ielts_score) {
    detail = answers.ielts_score;
  } else if (status === "Planning to take" && answers.ielts_planned_date) {
    detail = answers.ielts_planned_date;
  }

  return (
    <div
      className="grid items-center gap-3 border-b border-stone-200 px-3 py-2 text-[13px] text-stone-800 last:border-b-0 hover:bg-stone-50"
      style={{ gridTemplateColumns: gridCols }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Select ${student.display_name || student.username}`}
        className="h-3.5 w-3.5"
      />
      <span className="min-w-0 truncate">
        <span className="font-semibold">{student.display_name || student.username}</span>
        {student.display_name && (
          <span className="ml-1 text-[11px] font-normal text-stone-500">@{student.username}</span>
        )}
      </span>
      <span className={`text-[11px] uppercase tracking-[0.15em] ${meta?.tone || "text-stone-400"}`}>
        {meta?.label || "—"}
      </span>
      <span className="truncate text-[12px] tabular-nums text-stone-700">{detail}</span>
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

function ArchivedRow({ student, onUnarchive, onView }) {
  const status = statusOf(student);
  const meta = status ? STATUS_META[status] : null;
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold text-stone-800">{student.display_name || student.username}</span>
        <span className={`ml-3 text-[10px] uppercase tracking-[0.15em] ${meta?.tone || "text-stone-400"}`}>
          {meta?.label || "—"}
        </span>
        {student.counsellor_name && (
          <span className="ml-3 text-[11px] text-stone-500">· {student.counsellor_name}</span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <button
          onClick={onView}
          className="text-[10px] uppercase tracking-[0.15em] text-stone-600 hover:text-stone-900"
        >
          View
        </button>
        <button
          onClick={onUnarchive}
          className="text-[10px] uppercase tracking-[0.15em] text-[#cc785c] hover:text-[#b86a4f]"
        >
          Unarchive
        </button>
      </span>
    </div>
  );
}
