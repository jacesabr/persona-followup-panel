import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Archive, Search, AlertCircle, ChevronDown, Check, X, Plus, ArrowUpDown, ExternalLink, ClipboardList, MessageSquare, Send } from "lucide-react";
import { api } from "./api.js";
import ArchivedSection from "./ArchivedSection.jsx";
import useAutoRefresh from "./useAutoRefresh.js";

// Status keys + colours mirror the operator's master xlsx ('Persona
// Discover Dashboard', `application` sheet). Keep the keys in sync with
// server/routes/applications.js KNOWN_STATUSES.
//
// `swatch` is the literal cell colour from the sheet so the UI keeps the
// visual mapping the team already has muscle memory for; `tone` is the
// matching text colour for legibility on the swatch.
const STATUS_META = {
  active:    { label: "Active",                swatch: "#00FF00", tone: "text-black" },
  submitted: { label: "Application submitted", swatch: "#93C47D", tone: "text-black" },
  offer:     { label: "Offer received",        swatch: "#6AA84F", tone: "text-white"     },
  ongoing:   { label: "Ongoing",               swatch: "#FFFFFF", tone: "text-black" },
  on_hold:   { label: "On hold",               swatch: "#FF9900", tone: "text-black" },
  cancelled: { label: "Cancelled",             swatch: "#FF0000", tone: "text-white"     },
};

const STATUS_KEYS = Object.keys(STATUS_META);

function metaFor(status) {
  return STATUS_META[status] || { label: status || "—", swatch: "#E7E5E4", tone: "text-black" };
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  } catch { return d; }
}

export default function ApplicationsPanel({ role = "admin", counsellors = [], onViewStudent, onViewTasks }) {
  const [data, setData] = useState({ pending: [], active: [], archived: [] });
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState("urgency"); // urgency | student | status | university
  const [reviewing, setReviewing] = useState(null); // pending row being reviewed in the modal
  const [creating, setCreating] = useState(false); // "+ New application" modal
  const [detailRow, setDetailRow] = useState(null); // active row open in detail modal

  const refresh = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        api.listApplications(),
        api.listStudents().catch(() => []),
      ]);
      setData(d || { pending: [], active: [], archived: [] });
      setStudents(Array.isArray(s) ? s : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    refresh().finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refresh]);

  useAutoRefresh(refresh);

  const filterRows = (rows) => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.student_name, r.student_username, r.country, r.university,
        r.program, r.notes, r.status,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  };
  const pending  = useMemo(() => filterRows(data.pending),  [data.pending,  filter]);
  const archived = useMemo(() => filterRows(data.archived), [data.archived, filter]);

  const active = useMemo(() => {
    const rows = filterRows(data.active);
    const sorted = [...rows];
    switch (sortBy) {
      case "urgency":
        return sorted.sort((a, b) => {
          if (!a.deadline && !b.deadline) return 0;
          if (!a.deadline) return 1;
          if (!b.deadline) return -1;
          return new Date(a.deadline) - new Date(b.deadline);
        });
      case "student":
        return sorted.sort((a, b) =>
          (a.student_name || a.student_username || "").localeCompare(b.student_name || b.student_username || ""));
      case "status":
        return sorted.sort((a, b) =>
          STATUS_KEYS.indexOf(a.status) - STATUS_KEYS.indexOf(b.status));
      case "university":
        return sorted.sort((a, b) => (a.university || "").localeCompare(b.university || ""));
      default:
        return sorted;
    }
  }, [data.active, filter, sortBy]);

  const onPatch = async (id, patch) => {
    // Optimistic: update local state immediately, snap back on error.
    setData((prev) => ({
      ...prev,
      active: prev.active.map((r) => r.id === id ? { ...r, ...patch } : r),
    }));
    try {
      await api.updateApplication(id, patch);
    } catch (e) {
      setError(e.message);
      refresh();
    }
  };

  const onArchive = async (id) => {
    if (!window.confirm("Archive this application?")) return;
    try {
      await api.archiveApplication(id);
      setDetailRow(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const onDetailSave = async (id, patch) => {
    try {
      await api.updateApplication(id, patch);
      setDetailRow(null);
      await refresh();
    } catch (e) {
      setError(e.message);
      throw e;
    }
  };

  const onLinkStudent = async (id, studentId) => {
    try {
      await api.updateApplication(id, { student_id: studentId });
      setDetailRow(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const onUnarchive = async (id) => {
    try {
      await api.unarchiveApplication(id);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const onPromote = async (id, extras) => {
    try {
      // university + student_name aren't accepted by the promote endpoint — patch them first
      const { university, student_name, ...promoteFields } = extras || {};
      if (university !== undefined || student_name !== undefined) {
        await api.updateApplication(id, {
          ...(university    !== undefined ? { university }    : {}),
          ...(student_name  !== undefined ? { student_name }  : {}),
        });
      }
      await api.promoteApplication(id, promoteFields);
      setReviewing(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const onCreate = async (payload) => {
    try {
      await api.createApplication(payload);
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e.message);
      throw e;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-black">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  // 9 cols: status · student · counsellor · country · university · program · deadline · notes · actions
  const gridCols = "10rem 1.2fr 8rem 0.55fr 1.2fr 1fr 9rem 1fr 6rem";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Applications</h2>
          <span className="text-[10px] uppercase tracking-[0.2em] text-black">
            {active.length} active{pending.length ? ` · ${pending.length} pending` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f]"
          >
            <Plus className="h-3 w-3" /> New application
          </button>
          <div className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1">
            <Search className="h-3 w-3 text-black" />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter…"
              className="w-48 bg-transparent text-xs outline-none"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-3 inline-flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-5">
          <div className="mb-2 flex items-baseline gap-3">
            <h3 className="text-[12px] font-bold uppercase tracking-[0.18em] text-[#cc785c]">
              Pending review
            </h3>
            <span className="text-[10px] uppercase tracking-[0.18em] text-black">
              {pending.length} new selection{pending.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="border border-[#cc785c]/40 bg-[#cc785c]/5">
            <PendingHeader />
            {pending.map((r) => (
              <PendingRow
                key={r.id}
                row={r}
                onReview={() => setReviewing(r)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sort toolbar */}
      <div className="mb-2 flex items-center gap-2">
        <ArrowUpDown className="h-3.5 w-3.5 text-black" />
        <span className="text-[11px] uppercase tracking-[0.15em] text-black">Sort:</span>
        {[
          { key: "urgency",    label: "Urgency" },
          { key: "student",    label: "Student" },
          { key: "status",     label: "Status" },
          { key: "university", label: "University" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSortBy(key)}
            className={`border px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] transition ${
              sortBy === key
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white text-black hover:border-stone-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-2 border-b border-stone-300 bg-stone-100 px-3 py-2 text-xs font-bold uppercase tracking-[0.08em] text-black"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span>Status</span>
          <span>Student</span>
          <span>Counsellor</span>
          <span>Country</span>
          <span>University</span>
          <span>Program</span>
          <span>Deadline</span>
          <span>Notes</span>
          <span></span>
        </div>

        {active.length === 0 && (
          <div className="px-3 py-6 text-center text-xs  text-black">
            No active applications.
          </div>
        )}

        {active.map((r) => (
          <ActiveRow
            key={r.id}
            row={r}
            gridCols={gridCols}
            onPatch={(p) => onPatch(r.id, p)}
            onArchive={() => onArchive(r.id)}
            onClick={() => setDetailRow(r)}
          />
        ))}
      </div>

      <ArchivedSection
        items={archived}
        renderRow={(r) => (
          <li key={r.id} className="px-3 py-2">
            <ArchivedRow row={r} onUnarchive={() => onUnarchive(r.id)} />
          </li>
        )}
      />

      {reviewing && (
        <ReviewModal
          row={reviewing}
          students={students}
          counsellors={counsellors}
          role={role}
          onClose={() => setReviewing(null)}
          onPromote={(extras) => onPromote(reviewing.id, extras)}
          onViewStudent={onViewStudent}
          onViewTasks={onViewTasks}
        />
      )}

      {creating && (
        <CreateModal
          students={students}
          onClose={() => setCreating(false)}
          onCreate={onCreate}
        />
      )}

      {detailRow && (
        <ApplicationDetailModal
          row={detailRow}
          students={students}
          counsellors={counsellors}
          role={role}
          onClose={() => setDetailRow(null)}
          onSave={(patch) => onDetailSave(detailRow.id, patch)}
          onArchive={() => onArchive(detailRow.id)}
          onViewStudent={onViewStudent}
          onViewTasks={onViewTasks}
          onCounsellorAssigned={() => { setDetailRow(null); refresh(); }}
          onLinkStudent={(studentId) => onLinkStudent(detailRow.id, studentId)}
        />
      )}
    </>
  );
}

function PendingHeader() {
  return (
    <div
      className="grid items-center gap-2 border-b border-[#cc785c]/30 bg-[#cc785c]/10 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-black"
      style={{ gridTemplateColumns: "1.4fr 0.7fr 1.4fr 1.2fr 1fr 7rem" }}
    >
      <span>Student</span>
      <span>Country</span>
      <span>University</span>
      <span>Program</span>
      <span>Submitted</span>
      <span></span>
    </div>
  );
}

function PendingRow({ row, onReview }) {
  return (
    <div
      className="grid items-start gap-2 border-b border-[#cc785c]/20 px-3 py-2 text-[13px] text-black last:border-b-0 hover:bg-[#cc785c]/5"
      style={{ gridTemplateColumns: "1.4fr 0.7fr 1.4fr 1.2fr 1fr 7rem" }}
    >
      <span className="min-w-0 break-words">
        <span className="font-semibold">{row.student_name || row.student_username}</span>
        {row.student_name && (
          <span className="ml-1 text-[11px] font-normal text-black">@{row.student_username}</span>
        )}
      </span>
      <span className="break-words text-[12px] text-black">{row.country || "—"}</span>
      <span className="break-words">{row.university}</span>
      <span className="break-words text-[12px] text-black">{row.program || "—"}</span>
      <span className="text-[11px] tabular-nums text-black">{fmtDate(row.created_at)}</span>
      <button
        onClick={onReview}
        className="inline-flex items-center justify-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-white hover:bg-[#b86a4f]"
      >
        Review
      </button>
    </div>
  );
}

function ActiveRow({ row, gridCols, onPatch, onArchive, onClick }) {
  return (
    <div
      className="grid items-start gap-2 border-b border-stone-200 px-3 py-3 text-sm text-black last:border-b-0 hover:bg-stone-50 cursor-pointer"
      style={{ gridTemplateColumns: gridCols }}
      onClick={onClick}
    >
      {/* Stop propagation so dropdown clicks don't open the modal */}
      <div onClick={(e) => e.stopPropagation()}>
        <StatusDropdown value={row.status} onChange={(v) => onPatch({ status: v })} />
      </div>
      <StudentCell row={row} />
      <span className="break-words text-sm text-black pt-1">{row.counsellor_name || <span className=" text-black">—</span>}</span>
      <span className="break-words text-sm text-black pt-1">{row.country || "—"}</span>
      <span className="break-words font-medium pt-1">{row.university}</span>
      <span className="break-words text-sm text-black pt-1">{row.program || "—"}</span>
      <div onClick={(e) => e.stopPropagation()} className="pt-1">
        <DeadlineCell value={row.deadline} onChange={(v) => onPatch({ deadline: v })} />
      </div>
      {/* Full note — no truncation */}
      <span className="break-words text-sm text-black pt-1 leading-snug">
        {row.notes || <span className=" text-black">—</span>}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        title="Archive this application"
        className="inline-flex items-center justify-center gap-1 border border-stone-300 bg-white px-2 py-1 text-xs uppercase tracking-[0.12em] text-black hover:border-stone-700"
      >
        <Archive className="h-3.5 w-3.5" /> Archive
      </button>
    </div>
  );
}

// Student name + the "Unlinked" badge if the row has no intake account.
// Wraps inline so long names + the badge break to the next line rather
// than getting truncated.
function StudentCell({ row }) {
  const linked = !!row.student_id;
  return (
    <span className="flex flex-wrap items-baseline gap-1.5">
      <span className="text-sm font-bold text-black break-words">
        {row.student_name || row.student_username || "—"}
      </span>
      {!linked && (
        <span
          title="Unlinked: this application has no intake account yet"
          className="border border-stone-400 bg-stone-100 px-1 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-black"
        >
          Unlinked
        </span>
      )}
    </span>
  );
}

function StatusDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const meta = metaFor(value);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex w-full items-center justify-between gap-1 border border-stone-400 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] ${meta.tone}`}
        style={{ backgroundColor: meta.swatch }}
      >
        <span className="break-words text-left">{meta.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul className="absolute left-0 top-full z-20 mt-1 w-56 border border-stone-400 bg-white shadow-lg">
            {STATUS_KEYS.map((key) => {
              const m = STATUS_META[key];
              return (
                <li key={key}>
                  <button
                    onClick={() => { onChange(key); setOpen(false); }}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-stone-50"
                  >
                    <span
                      className="inline-block h-3 w-3 border border-stone-400"
                      style={{ backgroundColor: m.swatch }}
                    />
                    <span className="flex-1">{m.label}</span>
                    {key === value && <Check className="h-3 w-3 text-[#cc785c]" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function DeadlineCell({ value, onChange }) {
  const isoDate = value ? String(value).slice(0, 10) : "";
  const [editing, setEditing] = useState(false);

  // When a deadline is set: show formatted plain text + 📅 to switch to edit
  if (value && !editing) {
    const date = new Date(value);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysLeft = Math.round((date - today) / 86400000);
    const urgent = daysLeft >= 0 && daysLeft <= 7;
    const overdue = daysLeft < 0;
    return (
      <span className="flex items-center gap-1.5 group">
        <span className={`text-sm font-bold tabular-nums ${overdue ? "text-red-700" : urgent ? "text-amber-700" : "text-black"}`}>
          {fmtDate(value)}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Change deadline"
          className="text-base leading-none opacity-40 hover:opacity-90 transition-opacity"
        >
          📅
        </button>
      </span>
    );
  }

  return (
    <input
      type="date"
      value={isoDate}
      autoFocus={editing}
      onChange={(e) => {
        onChange(e.target.value || null);
        setEditing(false);
      }}
      onBlur={() => setEditing(false)}
      className="w-full border border-stone-300 bg-transparent px-1 py-0.5 text-sm tabular-nums text-black hover:border-stone-500 focus:border-[#cc785c] focus:outline-none"
    />
  );
}


function ArchivedRow({ row, onUnarchive }) {
  const meta = metaFor(row.status);
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12px]">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${meta.tone}`}
          style={{ backgroundColor: meta.swatch, border: "1px solid #57534e" }}
        >
          {meta.label}
        </span>
        <span className="font-semibold text-black break-words">{row.student_name || row.student_username}</span>
        <span className="text-black break-words">· {row.university}</span>
        {row.program && <span className="text-black break-words">· {row.program}</span>}
      </span>
      <button
        onClick={onUnarchive}
        className="shrink-0 text-[10px] uppercase tracking-[0.15em] text-[#cc785c] hover:text-[#b86a4f]"
      >
        Unarchive
      </button>
    </div>
  );
}

function ApplicationDetailModal({ row, students, counsellors, role, onClose, onSave, onArchive, onViewStudent, onViewTasks, onCounsellorAssigned, onLinkStudent }) {
  const [status,       setStatus]       = useState(row.status || "active");
  const [deadline,     setDeadline]     = useState(row.deadline ? String(row.deadline).slice(0, 10) : "");
  const [country,      setCountry]      = useState(row.country || "");
  const [university,   setUniversity]   = useState(row.university || "");
  const [program,      setProgram]      = useState(row.program || "");
  const [requirements, setRequirements] = useState(row.requirements || "");
  const [notes,        setNotes]        = useState(row.notes || "");
  const [busy,         setBusy]         = useState(false);
  const [localErr,     setLocalErr]     = useState(null);

  // Link-to-student (unlinked apps only)
  const [linkSearch,    setLinkSearch]   = useState("");
  const [linkStudentId, setLinkStudentId] = useState("");
  const [linkBusy,      setLinkBusy]     = useState(false);
  const filteredForLink = useMemo(() => {
    const q = linkSearch.trim().toLowerCase();
    const pool = students.filter(s => !q || [s.display_name, s.username].filter(Boolean).join(" ").toLowerCase().includes(q));
    return pool.slice(0, 15);
  }, [students, linkSearch]);

  const doLink = async () => {
    if (!linkStudentId) return;
    setLinkBusy(true);
    setLocalErr(null);
    try { await onLinkStudent(linkStudentId); }
    catch (e) { setLocalErr(e.message); setLinkBusy(false); }
  };

  // Counsellor assign — application-level (works for linked AND unlinked)
  const currentCounsellorId   = row.counsellor_id || null;
  const currentCounsellorName = row.counsellor_name || null;
  const [assignCounsellor, setAssignCounsellor] = useState(currentCounsellorId || "");
  const [assignBusy,       setAssignBusy]       = useState(false);
  const counsellorChanged = assignCounsellor !== (currentCounsellorId || "");

  const saveCounsellor = async () => {
    setAssignBusy(true);
    try {
      await api.updateApplication(row.id, { counsellor_id: assignCounsellor || null });
      onCounsellorAssigned?.();
    } catch (e) {
      setLocalErr(e.message);
    } finally { setAssignBusy(false); }
  };

  const meta = metaFor(status);

  const save = async () => {
    if (!university.trim()) { setLocalErr("University is required."); return; }
    setBusy(true);
    setLocalErr(null);
    try {
      await onSave({ status, deadline: deadline || null, country: country.trim() || null,
        university: university.trim(), program: program.trim() || null,
        requirements: requirements.trim() || null, notes: notes.trim() || null });
    } catch (e) { setLocalErr(e.message); }
    finally { setBusy(false); }
  };

  const onBackdrop = (e) => { if (e.target === e.currentTarget) onClose(); };
  const studentLabel = row.student_name || row.student_username || "—";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onBackdrop}>
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto border border-stone-300 bg-[#faf9f5] shadow-xl">

        {/* Header */}
        <div className="border-b border-stone-300 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`shrink-0 border border-stone-400 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.1em] ${meta.tone}`} style={{ backgroundColor: meta.swatch }}>
                  {meta.label}
                </span>
                {!row.student_id && (
                  <span className="shrink-0 border border-stone-400 bg-stone-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.1em] text-black">Unlinked</span>
                )}
              </div>
              <h3 className="mt-2 text-2xl font-bold text-black">{studentLabel}</h3>
              <p className="text-base text-black">
                {row.university}{row.program ? ` · ${row.program}` : ""}{row.country ? ` · ${row.country}` : ""}
              </p>
            </div>
            <button onClick={onClose} className="shrink-0 text-black hover:text-black" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Link to student (unlinked only) */}
        {!row.student_id && students.length > 0 && (
          <div className="border-b border-amber-200 bg-amber-50/60 px-5 py-4 space-y-3">
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-amber-800">
              Link to student account
            </p>
            <input
              type="search"
              value={linkSearch}
              onChange={e => setLinkSearch(e.target.value)}
              placeholder="Search by name or username…"
              className="w-full border border-stone-300 bg-white px-3 py-2 text-sm focus:border-[#cc785c] focus:outline-none"
            />
            {filteredForLink.length > 0 && (
              <div className="max-h-36 overflow-y-auto border border-stone-300 bg-white">
                {filteredForLink.map(s => (
                  <button key={s.student_id} type="button"
                    onClick={() => setLinkStudentId(s.student_id)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${linkStudentId === s.student_id ? "bg-[#cc785c]/10" : "hover:bg-stone-50"}`}>
                    <span>
                      <span className="font-semibold">{s.display_name || s.username}</span>
                      {s.display_name && <span className="ml-1.5 text-xs text-black">@{s.username}</span>}
                    </span>
                    {linkStudentId === s.student_id && <Check className="h-4 w-4 text-[#cc785c]" />}
                  </button>
                ))}
              </div>
            )}
            {linkStudentId && (
              <button type="button" onClick={doLink} disabled={linkBusy}
                className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-sm font-semibold uppercase tracking-[0.12em] text-white hover:bg-[#b86a4f] disabled:opacity-50">
                {linkBusy && <Loader2 className="h-4 w-4 animate-spin" />} Link student
              </button>
            )}
          </div>
        )}

        {/* Action bar: view buttons (linked only) + counsellor assign (all apps) */}
        <div className="border-b border-stone-200 bg-stone-50 px-5 py-4 space-y-4">
          {row.student_id && (
            <div className="flex flex-wrap gap-2">
              {onViewStudent && (
                <button type="button" onClick={() => { onClose(); onViewStudent(row.student_id); }}
                  className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black hover:border-[#cc785c] hover:text-[#cc785c] transition">
                  <ExternalLink className="h-4 w-4" /> View student profile
                </button>
              )}
              {onViewTasks && (
                <button type="button" onClick={() => { onClose(); onViewTasks(); }}
                  className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black hover:border-[#cc785c] hover:text-[#cc785c] transition">
                  <ClipboardList className="h-4 w-4" /> View tasks for this student
                </button>
              )}
            </div>
          )}
          {/* Counsellor — always shown, assigned at application level */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-base font-medium text-black">Counsellor:</span>
            {currentCounsellorName
              ? <span className="text-base font-bold text-black">{currentCounsellorName}</span>
              : <span className="text-base font-semibold text-black">Not assigned</span>
            }
            {counsellors.length > 0 && (
              <>
                <select value={assignCounsellor} onChange={e => setAssignCounsellor(e.target.value)}
                  className="border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-[#cc785c] focus:outline-none">
                  <option value="">— Assign counsellor —</option>
                  {counsellors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {counsellorChanged && (
                  <button type="button" onClick={saveCounsellor} disabled={assignBusy}
                    className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-sm font-semibold uppercase tracking-[0.1em] text-white hover:bg-[#b86a4f] disabled:opacity-50">
                    {assignBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Edit fields */}
        <div className="space-y-4 px-5 py-5">
          {localErr && <div className="border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{localErr}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)}
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none">
                {STATUS_KEYS.map(k => <option key={k} value={k}>{STATUS_META[k].label}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Deadline</label>
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base tabular-nums focus:border-[#cc785c] focus:outline-none" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">University *</label>
              <input type="text" value={university} onChange={e => setUniversity(e.target.value)}
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Country</label>
              <input type="text" value={country} onChange={e => setCountry(e.target.value)}
                placeholder="e.g. India, UK, USA"
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none" />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Program</label>
            <input type="text" value={program} onChange={e => setProgram(e.target.value)}
              className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Requirements</label>
            <textarea rows={3} value={requirements} onChange={e => setRequirements(e.target.value)}
              placeholder="SOP, portfolio, recommendations…"
              className="w-full border border-stone-300 bg-white px-3 py-2 font-serif text-base leading-relaxed focus:border-[#cc785c] focus:outline-none" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Notes</label>
            <textarea rows={5} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Any notes about this application…"
              className="w-full border border-stone-300 bg-white px-3 py-2 font-serif text-base leading-relaxed focus:border-[#cc785c] focus:outline-none" />
          </div>
        </div>

        {/* Comments thread — two-way (student ↔ counsellor ↔ admin).
            Lives between the edit fields and the footer so the staff
            user can read what the student flagged before saving notes. */}
        <div className="border-t border-stone-300 px-5 py-5">
          <StaffCommentThread appId={row.id} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-stone-300 px-5 py-4">
          <button onClick={onArchive} disabled={busy}
            className="inline-flex items-center gap-2 border border-stone-300 bg-white px-4 py-2 text-sm uppercase tracking-[0.12em] text-black hover:border-red-400 hover:text-red-600 disabled:opacity-50">
            <Archive className="h-4 w-4" /> Archive
          </button>
          <div className="flex items-center gap-3">
            <button onClick={onClose} disabled={busy}
              className="border border-stone-300 bg-white px-4 py-2 text-sm uppercase tracking-[0.12em] text-black hover:border-stone-700 disabled:opacity-50">
              Cancel
            </button>
            <button onClick={save} disabled={busy}
              className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-sm uppercase tracking-[0.12em] text-white hover:bg-[#b86a4f] disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// "+ New application" modal. Counsellor either picks an existing
// intake student from the dropdown, or types a free-text name (the
// transition path while many real students aren't in the system yet).
// Free-text names round-trip as the row's student_name; linking the
// row to an intake account later is just a PATCH editing student_name
// — no separate UX for that yet.
function CreateModal({ students, onClose, onCreate }) {
  const [mode, setMode] = useState("freetext"); // 'linked' | 'freetext'
  const [studentId, setStudentId] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [university, setUniversity] = useState("");
  const [program, setProgram] = useState("");
  const [deadline, setDeadline] = useState("");
  const [requirements, setRequirements] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("active");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(null);

  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    if (!q) return students.slice(0, 20);
    return students
      .filter((s) => {
        const hay = [s.display_name, s.username].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 20);
  }, [students, studentSearch]);

  const submit = async () => {
    setLocalError(null);
    if (!university.trim()) {
      setLocalError("University is required.");
      return;
    }
    if (mode === "linked" && !studentId) {
      setLocalError("Pick a student or switch to free-text name.");
      return;
    }
    if (mode === "freetext" && !name.trim()) {
      setLocalError("Type a student name or switch to picking an existing one.");
      return;
    }
    setBusy(true);
    try {
      await onCreate({
        student_id: mode === "linked" ? studentId : null,
        student_name: mode === "freetext" ? name.trim() : null,
        country: country.trim() || null,
        university: university.trim(),
        program: program.trim() || null,
        deadline: deadline || null,
        requirements: requirements || null,
        notes: notes || null,
        status,
        pending: false,
      });
    } catch (e) {
      setLocalError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto border border-stone-300 bg-[#faf9f5] shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-300 px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight">New application</h3>
          <button onClick={onClose} className="text-black hover:text-black" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4 text-[13px]">
          {localError && (
            <div className="border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              {localError}
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center gap-3 text-[11px] uppercase tracking-[0.15em] text-black">
              <span>Student</span>
              <span className="ml-auto inline-flex border border-stone-300">
                <button
                  type="button"
                  onClick={() => setMode("freetext")}
                  className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${
                    mode === "freetext" ? "bg-[#cc785c] text-white" : "bg-white text-black hover:bg-stone-50"
                  }`}
                >
                  Type name
                </button>
                <button
                  type="button"
                  onClick={() => setMode("linked")}
                  className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] border-l border-stone-300 ${
                    mode === "linked" ? "bg-[#cc785c] text-white" : "bg-white text-black hover:bg-stone-50"
                  }`}
                >
                  Pick existing
                </button>
              </span>
            </div>
            {mode === "freetext" ? (
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Aarna"
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
              />
            ) : (
              <div className="space-y-1">
                <input
                  type="search"
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  placeholder="search by name or username…"
                  className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
                />
                <div className="max-h-40 overflow-y-auto border border-stone-300 bg-white">
                  {filteredStudents.length === 0 && (
                    <div className="px-2 py-2 text-[12px]  text-black">
                      {studentSearch ? "no match" : "no students yet"}
                    </div>
                  )}
                  {filteredStudents.map((s) => (
                    <button
                      key={s.student_id}
                      type="button"
                      onClick={() => setStudentId(s.student_id)}
                      className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[12px] ${
                        studentId === s.student_id ? "bg-[#cc785c]/10" : "hover:bg-stone-50"
                      }`}
                    >
                      <span className="truncate">
                        <span className="font-semibold">{s.display_name || s.username}</span>
                        {s.display_name && (
                          <span className="ml-1 text-[11px] text-black">@{s.username}</span>
                        )}
                      </span>
                      {studentId === s.student_id && <Check className="h-3 w-3 text-[#cc785c]" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-black">University *</label>
              <input
                type="text"
                value={university}
                onChange={(e) => setUniversity(e.target.value)}
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-black">Country</label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="e.g. India, UK, USA"
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-black">Program</label>
              <input
                type="text"
                value={program}
                onChange={(e) => setProgram(e.target.value)}
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-black">Deadline</label>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] tabular-nums focus:border-[#cc785c] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-black">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
            >
              {STATUS_KEYS.map((k) => (
                <option key={k} value={k}>{STATUS_META[k].label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-black">Requirements</label>
            <textarea
              rows={2}
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder="SOP, portfolio, recommendations…"
              className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-black">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-300 px-4 py-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="border border-stone-300 bg-white px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-black hover:border-stone-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewModal({ row, students, counsellors, role, onClose, onPromote, onViewStudent, onViewTasks }) {
  const [studentName,  setStudentName]  = useState(row.student_name || "");
  const [university,   setUniversity]   = useState(row.university || "");
  const [country,      setCountry]      = useState(row.country || "");
  const [program,      setProgram]      = useState(row.program || "");
  const [status,       setStatus]       = useState(row.status || "active");
  const [deadline,     setDeadline]     = useState(row.deadline ? String(row.deadline).slice(0, 10) : "");
  const [requirements, setRequirements] = useState(row.requirements || "");
  const [notes,        setNotes]        = useState(row.notes || "");
  const [busy,         setBusy]         = useState(false);
  const [localErr,     setLocalErr]     = useState(null);

  // Counsellor assign — application-level, works for all rows
  const currentCounsellorId   = row.counsellor_id || null;
  const currentCounsellorName = row.counsellor_name || null;
  const [assignCounsellor, setAssignCounsellor] = useState(currentCounsellorId || "");
  const [assignBusy,       setAssignBusy]       = useState(false);
  const counsellorChanged = assignCounsellor !== (currentCounsellorId || "");

  const saveCounsellor = async () => {
    setAssignBusy(true);
    try {
      await api.updateApplication(row.id, { counsellor_id: assignCounsellor || null });
    } catch (e) {
      setLocalErr(e.message);
    } finally {
      setAssignBusy(false);
    }
  };

  const submit = async () => {
    if (!university.trim()) { setLocalErr("University is required."); return; }
    setBusy(true);
    setLocalErr(null);
    try {
      await onPromote({
        student_name: !row.student_id ? (studentName.trim() || null) : undefined,
        university:   university.trim(),
        country:      country.trim() || null,
        program:      program.trim() || null,
        status,
        deadline:     deadline || null,
        requirements: requirements.trim() || null,
        notes:        notes.trim() || null,
      });
    } catch (e) {
      setLocalErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onBackdrop = (e) => { if (e.target === e.currentTarget) onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onBackdrop}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto border border-stone-300 bg-[#faf9f5] shadow-xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-stone-300 px-5 py-4">
          <div>
            <h3 className="text-xl font-bold text-black">Review application</h3>
            <p className="text-sm text-black">Fill in details, then push to active workflow</p>
          </div>
          <button onClick={onClose} className="text-black hover:text-black" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Action bar: view buttons (linked only) + counsellor assign (all apps) */}
        <div className="border-b border-stone-200 bg-stone-50 px-5 py-4 space-y-4">
          {row.student_id && (
            <div className="flex flex-wrap gap-2">
              {onViewStudent && (
                <button type="button" onClick={() => { onClose(); onViewStudent(row.student_id); }}
                  className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black hover:border-[#cc785c] hover:text-[#cc785c] transition">
                  <ExternalLink className="h-4 w-4" /> View student profile
                </button>
              )}
              {onViewTasks && (
                <button type="button" onClick={() => { onClose(); onViewTasks(); }}
                  className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black hover:border-[#cc785c] hover:text-[#cc785c] transition">
                  <ClipboardList className="h-4 w-4" /> View tasks for this student
                </button>
              )}
            </div>
          )}
          {/* Counsellor — always shown */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-base font-medium text-black">Counsellor:</span>
            {currentCounsellorName
              ? <span className="text-base font-bold text-black">{currentCounsellorName}</span>
              : <span className="text-base font-semibold text-black">Not assigned</span>
            }
            {counsellors.length > 0 && (
              <>
                <select value={assignCounsellor} onChange={e => setAssignCounsellor(e.target.value)}
                  className="border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-[#cc785c] focus:outline-none">
                  <option value="">— Assign counsellor —</option>
                  {counsellors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {counsellorChanged && (
                  <button type="button" onClick={saveCounsellor} disabled={assignBusy}
                    className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-sm font-semibold uppercase tracking-[0.1em] text-white hover:bg-[#b86a4f] disabled:opacity-50">
                    {assignBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Edit fields */}
        <div className="space-y-4 px-5 py-5">
          {localErr && <div className="border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{localErr}</div>}

          {/* Student name — editable for unlinked rows */}
          <div>
            <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Student</label>
            {row.student_id
              ? <p className="px-3 py-2 text-base font-semibold text-black">{row.student_name || row.student_username}</p>
              : <input type="text" value={studentName} onChange={e => setStudentName(e.target.value)}
                  className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none" />
            }
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">University *</label>
              <input type="text" value={university} onChange={e => setUniversity(e.target.value)}
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Country</label>
              <input type="text" value={country} onChange={e => setCountry(e.target.value)}
                placeholder="e.g. India, UK, USA"
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Program</label>
              <input type="text" value={program} onChange={e => setProgram(e.target.value)}
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)}
                className="w-full border border-stone-300 bg-white px-3 py-2 text-base focus:border-[#cc785c] focus:outline-none">
                {STATUS_KEYS.map(k => <option key={k} value={k}>{STATUS_META[k].label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Deadline</label>
            <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
              className="w-full border border-stone-300 bg-white px-3 py-2 text-base tabular-nums focus:border-[#cc785c] focus:outline-none" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Requirements</label>
            <textarea rows={3} value={requirements} onChange={e => setRequirements(e.target.value)}
              placeholder="SOP, portfolio, recommendations…"
              className="w-full border border-stone-300 bg-white px-3 py-2 font-serif text-base leading-relaxed focus:border-[#cc785c] focus:outline-none" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold uppercase tracking-[0.12em] text-black">Notes</label>
            <textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full border border-stone-300 bg-white px-3 py-2 font-serif text-base leading-relaxed focus:border-[#cc785c] focus:outline-none" />
          </div>
        </div>

        {/* Comments thread — surfaces anything the student flagged on
            their Status tab before the counsellor pushes the row live. */}
        <div className="border-t border-stone-300 px-5 py-5">
          <StaffCommentThread appId={row.id} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-stone-300 px-5 py-4">
          <button onClick={onClose} disabled={busy}
            className="border border-stone-300 bg-white px-4 py-2 text-sm uppercase tracking-[0.12em] text-black hover:border-stone-700 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-sm uppercase tracking-[0.12em] text-white hover:bg-[#b86a4f] disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Push to active
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// StaffCommentThread — staff side of the per-application thread.
// Same wire shape + endpoint as the student side; just hits the
// staff route which scopes by visibility (assigned counsellor + admin).
// ============================================================
function fmtCommentTime(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return d; }
}

function StaffCommentThread({ appId }) {
  const [comments, setComments] = useState(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listApplicationComments(appId);
      setComments(list);
      setErr(null);
    } catch (e) {
      setErr(e?.message || "Couldn't load comments.");
    }
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addApplicationComment(appId, body.trim());
      setBody("");
      await load();
    } catch (e) {
      setErr(e?.message || "Couldn't post.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.12em] text-black">
        <MessageSquare className="h-4 w-4" /> Comments
      </p>
      <p className="mt-1 text-sm text-stone-800">
        Two-way thread with the student. Append-only — posts can't be edited or deleted.
      </p>

      {err && (
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4" /> {err}
        </p>
      )}

      <div className="mt-3">
        {comments === null ? (
          <p className="inline-flex items-center gap-2 text-sm text-stone-800">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading comments…
          </p>
        ) : comments.length === 0 ? (
          <p className="text-sm text-stone-800">
            No comments yet. Use the box below to reply to the student.
          </p>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => <StaffCommentBubble key={c.id} comment={c} />)}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="mt-3 space-y-2">
        <textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Reply to the student about requirements, deadlines, next steps."
          className="w-full border border-stone-300 bg-white px-3 py-2 font-serif text-base leading-relaxed focus:border-[#cc785c] focus:outline-none"
        />
        <div className="flex items-center justify-end">
          <button
            type="submit"
            disabled={busy || !body.trim()}
            className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Post
          </button>
        </div>
      </form>
    </div>
  );
}

function StaffCommentBubble({ comment }) {
  const fromStudent = comment.author_kind === "student";
  const bg = fromStudent ? "bg-[#cc785c]/10" : "bg-stone-50";
  const align = fromStudent ? "" : "ml-auto";
  const roleLabel = comment.author_kind === "student"
    ? `${comment.author_name || "Student"} (student)`
    : comment.author_kind === "admin"
    ? `${comment.author_name || "Admin"} (admin)`
    : `${comment.author_name || "Counsellor"}`;
  return (
    <li className={`max-w-[90%] border border-stone-200 ${bg} px-3 py-2 ${align}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold text-black">{roleLabel}</span>
        <span className="text-[11px] text-stone-700">{fmtCommentTime(comment.created_at)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-stone-800">
        {comment.body}
      </p>
    </li>
  );
}
