import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Archive, Search, AlertCircle, ChevronDown, Check, X, Plus } from "lucide-react";
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
  active:    { label: "Active",                swatch: "#00FF00", tone: "text-stone-900" },
  submitted: { label: "Application submitted", swatch: "#93C47D", tone: "text-stone-900" },
  offer:     { label: "Offer received",        swatch: "#6AA84F", tone: "text-white"     },
  ongoing:   { label: "Ongoing",               swatch: "#FFFFFF", tone: "text-stone-900" },
  on_hold:   { label: "On hold",               swatch: "#FF9900", tone: "text-stone-900" },
  cancelled: { label: "Cancelled",             swatch: "#FF0000", tone: "text-white"     },
};

const STATUS_KEYS = Object.keys(STATUS_META);

function metaFor(status) {
  return STATUS_META[status] || { label: status || "—", swatch: "#E7E5E4", tone: "text-stone-700" };
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  } catch { return d; }
}

export default function ApplicationsPanel({ role = "admin" }) {
  const [data, setData] = useState({ pending: [], active: [], archived: [] });
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [reviewing, setReviewing] = useState(null); // pending row being reviewed in the modal
  const [creating, setCreating] = useState(false); // "+ New application" modal

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
  const active   = useMemo(() => filterRows(data.active),   [data.active,   filter]);
  const archived = useMemo(() => filterRows(data.archived), [data.archived, filter]);

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
      await api.promoteApplication(id, extras || {});
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
      <div className="flex items-center justify-center py-20 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  // 8 cols: status · student · country · university · program · deadline · notes · actions
  const gridCols = "9rem 1.4fr 0.6fr 1.4fr 1.2fr 6rem 1fr 5.5rem";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Applications</h2>
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
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
            <Search className="h-3 w-3 text-stone-400" />
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
            <span className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
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

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-2 border-b border-stone-300 bg-stone-100 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-700"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span>Status</span>
          <span>Student</span>
          <span>Country</span>
          <span>University</span>
          <span>Program</span>
          <span>Deadline</span>
          <span>Notes</span>
          <span></span>
        </div>

        {active.length === 0 && (
          <div className="px-3 py-6 text-center text-xs italic text-stone-500">
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
          onClose={() => setReviewing(null)}
          onPromote={(extras) => onPromote(reviewing.id, extras)}
        />
      )}

      {creating && (
        <CreateModal
          students={students}
          onClose={() => setCreating(false)}
          onCreate={onCreate}
        />
      )}
    </>
  );
}

function PendingHeader() {
  return (
    <div
      className="grid items-center gap-2 border-b border-[#cc785c]/30 bg-[#cc785c]/10 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-700"
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
      className="grid items-center gap-2 border-b border-[#cc785c]/20 px-3 py-2 text-[13px] text-stone-800 last:border-b-0 hover:bg-[#cc785c]/5"
      style={{ gridTemplateColumns: "1.4fr 0.7fr 1.4fr 1.2fr 1fr 7rem" }}
    >
      <span className="min-w-0 truncate">
        <span className="font-semibold">{row.student_name || row.student_username}</span>
        {row.student_name && (
          <span className="ml-1 text-[11px] font-normal text-stone-500">@{row.student_username}</span>
        )}
      </span>
      <span className="truncate text-[12px] text-stone-700">{row.country || "—"}</span>
      <span className="truncate">{row.university}</span>
      <span className="truncate text-[12px] text-stone-700">{row.program || "—"}</span>
      <span className="text-[11px] tabular-nums text-stone-500">{fmtDate(row.created_at)}</span>
      <button
        onClick={onReview}
        className="inline-flex items-center justify-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-white hover:bg-[#b86a4f]"
      >
        Review
      </button>
    </div>
  );
}

function ActiveRow({ row, gridCols, onPatch, onArchive }) {
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(row.notes || "");

  // Re-sync local draft when the row changes from outside (auto-refresh).
  useEffect(() => {
    if (!editingNotes) setNotesDraft(row.notes || "");
  }, [row.notes, editingNotes]);

  const saveNotes = async () => {
    await onPatch({ notes: notesDraft });
    setEditingNotes(false);
  };

  return (
    <div
      className="grid items-center gap-2 border-b border-stone-200 px-3 py-2 text-[13px] text-stone-800 last:border-b-0 hover:bg-stone-50"
      style={{ gridTemplateColumns: gridCols }}
    >
      <StatusDropdown value={row.status} onChange={(v) => onPatch({ status: v })} />
      <StudentCell row={row} />

      <span className="truncate text-[12px] text-stone-700">{row.country || "—"}</span>
      <span className="truncate">{row.university}</span>
      <span className="truncate text-[12px] text-stone-700">{row.program || "—"}</span>
      <DeadlineCell value={row.deadline} onChange={(v) => onPatch({ deadline: v })} />
      <NotesCell
        editing={editingNotes}
        value={editingNotes ? notesDraft : row.notes}
        onEdit={() => setEditingNotes(true)}
        onChangeDraft={setNotesDraft}
        onSave={saveNotes}
        onCancel={() => { setEditingNotes(false); setNotesDraft(row.notes || ""); }}
      />
      <button
        onClick={onArchive}
        title="Archive this application"
        className="inline-flex items-center justify-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-700"
      >
        <Archive className="h-3 w-3" /> Archive
      </button>
    </div>
  );
}

function StudentCell({ row }) {
  const linked = !!row.student_id;
  return (
    <span className="min-w-0 flex items-center gap-1.5 truncate">
      <span className="font-semibold truncate">
        {row.student_name || row.student_username || "—"}
      </span>
      {!linked && (
        <span
          title="Unlinked: this application has no intake account yet"
          className="shrink-0 border border-stone-400 bg-stone-100 px-1 py-px text-[9px] font-semibold uppercase tracking-[0.1em] text-stone-600"
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
        <span className="truncate">{meta.label}</span>
        <ChevronDown className="h-3 w-3" />
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
  // ISO-string-or-null going in; <input type="date"> wants YYYY-MM-DD.
  const isoDate = value ? String(value).slice(0, 10) : "";
  return (
    <input
      type="date"
      value={isoDate}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full border border-stone-300 bg-transparent px-1 py-0.5 text-[11px] tabular-nums text-stone-700 hover:border-stone-500 focus:border-[#cc785c] focus:outline-none"
    />
  );
}

function NotesCell({ editing, value, onEdit, onChangeDraft, onSave, onCancel }) {
  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <input
          type="text"
          value={value || ""}
          onChange={(e) => onChangeDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
          className="min-w-0 flex-1 border border-[#cc785c] bg-white px-1 py-0.5 text-[12px] outline-none"
        />
        <button onClick={onSave} className="text-emerald-700 hover:text-emerald-900">
          <Check className="h-3.5 w-3.5" />
        </button>
        <button onClick={onCancel} className="text-stone-500 hover:text-stone-800">
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      onClick={onEdit}
      className="min-w-0 truncate text-left text-[12px] text-stone-600 hover:text-stone-900"
      title="Click to edit notes"
    >
      {value ? value : <span className="italic text-stone-400">add notes…</span>}
    </button>
  );
}

function ArchivedRow({ row, onUnarchive }) {
  const meta = metaFor(row.status);
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="min-w-0 flex-1 truncate">
        <span
          className={`mr-2 inline-block px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${meta.tone}`}
          style={{ backgroundColor: meta.swatch, border: "1px solid #57534e" }}
        >
          {meta.label}
        </span>
        <span className="font-semibold text-stone-800">{row.student_name || row.student_username}</span>
        <span className="ml-2 text-stone-600">· {row.university}</span>
        {row.program && <span className="ml-2 text-stone-500">· {row.program}</span>}
      </span>
      <button
        onClick={onUnarchive}
        className="text-[10px] uppercase tracking-[0.15em] text-[#cc785c] hover:text-[#b86a4f]"
      >
        Unarchive
      </button>
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
          <button onClick={onClose} className="text-stone-500 hover:text-stone-900" aria-label="Close">
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
            <div className="mb-1 flex items-center gap-3 text-[11px] uppercase tracking-[0.15em] text-stone-600">
              <span>Student</span>
              <span className="ml-auto inline-flex border border-stone-300">
                <button
                  type="button"
                  onClick={() => setMode("freetext")}
                  className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${
                    mode === "freetext" ? "bg-[#cc785c] text-white" : "bg-white text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  Type name
                </button>
                <button
                  type="button"
                  onClick={() => setMode("linked")}
                  className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] border-l border-stone-300 ${
                    mode === "linked" ? "bg-[#cc785c] text-white" : "bg-white text-stone-600 hover:bg-stone-50"
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
                    <div className="px-2 py-2 text-[12px] italic text-stone-500">
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
                          <span className="ml-1 text-[11px] text-stone-500">@{s.username}</span>
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
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">University *</label>
              <input
                type="text"
                value={university}
                onChange={(e) => setUniversity(e.target.value)}
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">Country</label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="e.g. India, UK, USA"
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">Program</label>
              <input
                type="text"
                value={program}
                onChange={(e) => setProgram(e.target.value)}
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">Deadline</label>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] tabular-nums focus:border-[#cc785c] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">Status</label>
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
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">Requirements</label>
            <textarea
              rows={2}
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder="SOP, portfolio, recommendations…"
              className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">Notes</label>
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
            className="border border-stone-300 bg-white px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-700 disabled:opacity-50"
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

function ReviewModal({ row, onClose, onPromote }) {
  const [deadline, setDeadline] = useState(row.deadline ? String(row.deadline).slice(0, 10) : "");
  const [requirements, setRequirements] = useState(row.requirements || "");
  const [notes, setNotes] = useState(row.notes || "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onPromote({
        deadline: deadline || null,
        requirements: requirements || null,
        notes: notes || null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg border border-stone-300 bg-[#faf9f5] shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-300 px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight">
            Review &amp; push to active workflow
          </h3>
          <button
            onClick={onClose}
            className="text-stone-500 hover:text-stone-900"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4 text-[13px]">
          <div className="grid grid-cols-[8rem_1fr] gap-2">
            <span className="text-stone-500">Student</span>
            <span className="font-semibold">{row.student_name || row.student_username}</span>
            <span className="text-stone-500">University</span>
            <span>{row.university}</span>
            {row.country && (<><span className="text-stone-500">Country</span><span>{row.country}</span></>)}
            {row.program && (<><span className="text-stone-500">Program</span><span>{row.program}</span></>)}
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">
              Deadline
            </label>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] tabular-nums focus:border-[#cc785c] focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">
              Requirements
            </label>
            <textarea
              rows={2}
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder="SOP, portfolio, recommendations…"
              className="w-full border border-stone-300 bg-white px-2 py-1 text-[13px] focus:border-[#cc785c] focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-stone-600">
              Notes
            </label>
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
            className="border border-stone-300 bg-white px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Push to active
          </button>
        </div>
      </div>
    </div>
  );
}
