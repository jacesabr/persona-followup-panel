import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  X,
  Check,
  Archive,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Undo2,
  History,
  Pencil,
} from "lucide-react";
import { api } from "./api.js";
import {
  formatDateInIst,
  formatTimeInIst,
  localInputToUtcIso,
  utcIsoToIstInput,
} from "../lib/time.js";

const STATUS_LABEL = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  completed: "Completed",
  no_show: "No-show",
};
// When the calendar form needs a time-of-day to combine with a picked date.
const DEFAULT_TIME_IST = "10:00";

// Today's date in IST as "YYYY-MM-DD". Used as the default for inquiry_date
// when adding a new lead so the picker pre-fills with today.
function todayIstYmd() {
  return utcIsoToIstInput(new Date().toISOString()).slice(0, 10);
}

// Factory not constant — todayIstYmd() must be evaluated at the moment the
// user opens the new-lead row, not at module load. Otherwise the panel
// staying open across midnight pre-fills "yesterday".
function emptyNew() {
  return {
    name: "",
    email: "",
    contact: "",
    purpose: "",
    inquiryDate: todayIstYmd(),
    counsellorName: "",
  };
}

export default function SimpleFollowup({ role = "admin", scopedCounsellorId = null }) {
  // Counsellor scope: when set, the lead sheet filters to leads where
  // counsellor_id matches this id, and new leads created here auto-link
  // to that counsellor (FK + name display in one shot).
  const isScoped = role === "counsellor" && !!scopedCounsellorId;
  const [leads, setLeads] = useState([]);
  const [counsellors, setCounsellors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newLead, setNewLead] = useState(emptyNew());
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // The lead whose calendar popup is currently open (null = closed).
  const [calendarLead, setCalendarLead] = useState(null);
  // The lead whose history popup is currently open (null = closed).
  const [historyLead, setHistoryLead] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listLeads({ includeArchived: true }), api.listCounsellors()])
      .then(([l, c]) => {
        if (cancelled) return;
        setLeads(l);
        setCounsellors(c);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counsellorNameById = new Map(counsellors.map((c) => [c.id, c.name]));

  const cancelNew = () => {
    setShowNew(false);
    setNewLead(emptyNew());
    setError(null);
  };

  const submitNew = async () => {
    const name = newLead.name.trim();
    const contact = newLead.contact.trim();
    const purpose = newLead.purpose.trim();
    if (!name || !contact || !purpose) {
      setError("Name, phone, and purpose are required.");
      return;
    }
    // Counsellor-scoped users auto-link the lead to themselves via the FK
    // (so cron reminders fire and admin's view shows it under them).
    // Admin's new-lead flow stays free-text: they may type a name that
    // doesn't match a counsellors row, in which case it's stored as
    // counsellor_name only — no reminders, accepted trade-off.
    const payload = {
      name,
      contact,
      email: newLead.email.trim() || null,
      purpose,
      inquiry_date: newLead.inquiryDate || null,
    };
    if (isScoped) {
      payload.counsellor_id = scopedCounsellorId;
    } else {
      payload.counsellor_name = newLead.counsellorName.trim() || null;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await api.createLead(payload);
      setLeads((prev) => [created, ...prev]);
      setNewLead(emptyNew());
      setShowNew(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const archiveSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Archive ${ids.length} selected lead${ids.length === 1 ? "" : "s"}?`
      )
    )
      return;
    setBulkBusy(true);
    setError(null);
    // Promise.allSettled so a single failed archive doesn't leave the other
    // 29 in a hidden-but-not-archived limbo. Replace each succeeded lead in
    // place with the server's updated row (archived: true) — the archived
    // section below picks them up via the lead.archived filter.
    const results = await Promise.allSettled(
      ids.map((id) => api.archiveLead(id))
    );
    const updatedById = new Map();
    for (let i = 0; i < ids.length; i++) {
      if (results[i].status === "fulfilled" && results[i].value) {
        updatedById.set(ids[i], results[i].value);
      }
    }
    const firstError = results.find((r) => r.status === "rejected")?.reason;
    setLeads((prev) => prev.map((l) => updatedById.get(l.id) || l));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of updatedById.keys()) next.delete(id);
      return next;
    });
    if (updatedById.size < ids.length) {
      const failedCount = ids.length - updatedById.size;
      setError(
        `${failedCount} of ${ids.length} archives failed${firstError ? `: ${firstError.message}` : "."}`
      );
    }
    setBulkBusy(false);
  };

  const unarchiveLead = async (id) => {
    setError(null);
    try {
      const updated = await api.unarchiveLead(id);
      setLeads((prev) => prev.map((l) => (l.id === id ? updated : l)));
    } catch (e) {
      setError(e.message);
    }
  };

  // Called when CalendarPopup confirms a new appointment. Mirror the new
  // service_date onto the lead row so the sheet's tint + Next-follow cell
  // update without a refetch. lead.notes is intentionally untouched —
  // appointment notes live in lead_appointments only (general lead notes
  // and per-appointment notes are different concepts).
  const onAppointmentCreated = (leadId, scheduledFor) => {
    setLeads((prev) =>
      prev.map((l) =>
        l.id === leadId
          ? { ...l, service_date: scheduledFor, reminder_sent: false }
          : l
      )
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (error && leads.length === 0 && !showNew) {
    return (
      <div className="border border-red-300 bg-red-50 p-5 text-sm text-red-800">
        {error}
      </div>
    );
  }

  // 8 cols: select · date-of-query · contact · purpose · status · next follow · history · counsellor
  // Widths chosen so headers don't wrap with their content padding + letter-
  // spacing; "Next follow" needs ~8rem to fit a formatted date like
  // "29 Apr 2026" without truncation. History is icon-only, narrow.
  const gridCols = "1.75rem 6.5rem 1.5fr 1.2fr 6rem 8rem 4.5rem 7rem";

  // Counsellor scoping: hide leads not belonging to this counsellor.
  // Admin (role=admin) sees everything.
  const visibleLeads = isScoped
    ? leads.filter((l) => l.counsellor_id === scopedCounsellorId)
    : leads;

  // Split first: archived leads live in a separate collapsible section at
  // the bottom of the page; the main sheet is active leads only. Both sets
  // come from listLeads({ includeArchived: true }) on mount.
  const activeLeads = visibleLeads.filter((l) => !l.archived);
  const archivedLeads = visibleLeads
    .filter((l) => l.archived)
    .sort((a, b) => {
      const at = a.archived_at ? new Date(a.archived_at).getTime() : 0;
      const bt = b.archived_at ? new Date(b.archived_at).getTime() : 0;
      return bt - at; // most-recently-archived first
    });

  // Sort: most-urgent upcoming first, then increasingly distant future, then
  // past most-recent-first, then leads with no service_date last.
  const now = Date.now();
  const sortedLeads = [...activeLeads].sort((a, b) => {
    const at = a.service_date ? new Date(a.service_date).getTime() : null;
    const bt = b.service_date ? new Date(b.service_date).getTime() : null;
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    const aFuture = at >= now;
    const bFuture = bt >= now;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return aFuture ? at - bt : bt - at;
  });

  return (
    <>
      <div className="mb-4 flex items-baseline justify-between border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Lead sheet</h2>
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
            {activeLeads.length} {activeLeads.length === 1 ? "row" : "rows"}
          </span>
        </div>
        {!showNew && (
          <button
            onClick={() => {
              // Refresh the new-lead form state every time the row opens so
              // inquiryDate reflects the *current* IST day even if the user
              // left the page open across midnight.
              setNewLead(emptyNew());
              setShowNew(true);
            }}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f]"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
          {error}
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
              {bulkBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Archive className="h-3 w-3" />
              )}
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
          {/* Empty span (not sr-only) holds the grid cell for the
              checkbox column. sr-only uses position:absolute, which makes
              CSS Grid skip it during auto-placement — that was shifting
              every header one column to the left. Each row's checkbox
              already carries its own aria-label, so we don't need a
              header label for screen readers. */}
          {/* Empty span (not sr-only) holds the grid cell for the
              checkbox column. sr-only uses position:absolute, which makes
              CSS Grid skip it during auto-placement — that was shifting
              every header one column to the left. Each row's checkbox
              already carries its own aria-label, so we don't need a
              header label for screen readers. */}
          <span aria-hidden="true"></span>
          <span className="whitespace-nowrap">Query</span>
          <span className="whitespace-nowrap">Name / Email / Ph</span>
          <span className="whitespace-nowrap">Purpose</span>
          <span className="whitespace-nowrap">Status</span>
          <span className="whitespace-nowrap">Next follow</span>
          <span className="whitespace-nowrap">History</span>
          <span className="whitespace-nowrap">Counsellor</span>
        </div>

        {showNew && (
          <div
            className="grid items-start gap-3 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-3 py-2 text-[14px] text-stone-800"
            style={{ gridTemplateColumns: gridCols }}
          >
            {/* Status, Next-follow are no longer collected at lead-creation.
                Status defaults to 'unassigned' server-side; the upcoming
                appointment is set later via the calendar popup. The
                resulting form is just: query date, contact, purpose, and
                counsellor (free text). */}
            <span></span>
            <input
              type="date"
              value={newLead.inquiryDate}
              onChange={(e) =>
                setNewLead((p) => ({ ...p, inquiryDate: e.target.value }))
              }
              className="border border-stone-300 bg-white px-1.5 py-1 text-[12px] outline-none focus:border-[#cc785c]"
            />
            <span className="flex flex-col gap-1">
              <input
                type="text"
                placeholder="Name *"
                value={newLead.name}
                onChange={(e) =>
                  setNewLead((p) => ({ ...p, name: e.target.value }))
                }
                className="border border-stone-300 bg-white px-1.5 py-1 text-[13px] outline-none focus:border-[#cc785c]"
                autoFocus
              />
              <input
                type="email"
                placeholder="Email"
                value={newLead.email}
                onChange={(e) =>
                  setNewLead((p) => ({ ...p, email: e.target.value }))
                }
                className="border border-stone-300 bg-white px-1.5 py-1 text-[13px] outline-none focus:border-[#cc785c]"
              />
              <input
                type="tel"
                placeholder="Phone *"
                value={newLead.contact}
                onChange={(e) =>
                  setNewLead((p) => ({
                    ...p,
                    contact: e.target.value.replace(/\D/g, ""),
                  }))
                }
                className="border border-stone-300 bg-white px-1.5 py-1 text-[13px] tabular-nums outline-none focus:border-[#cc785c]"
              />
            </span>
            <input
              type="text"
              placeholder="Purpose *"
              value={newLead.purpose}
              onChange={(e) =>
                setNewLead((p) => ({ ...p, purpose: e.target.value }))
              }
              className="border border-stone-300 bg-white px-1.5 py-1 text-[13px] outline-none focus:border-[#cc785c]"
            />
            {/* Status + Next-follow columns: empty placeholders so the
                grid cells still exist for layout symmetry with rendered
                rows above/below. */}
            <span className="text-[11px] italic text-stone-400">auto</span>
            <span className="text-[11px] italic text-stone-400">later</span>
            {/* History column: nothing to view yet for an unsaved lead. */}
            <span></span>
            <span className="flex items-center gap-1">
              {isScoped ? (
                /* Scoped users always assign new leads to themselves;
                   the input would just be redundant. */
                <span className="min-w-0 flex-1 truncate px-1.5 py-1 text-[12px] italic text-stone-500">
                  you
                </span>
              ) : (
                <input
                  type="text"
                  list="simple-counsellors"
                  placeholder="Counsellor"
                  value={newLead.counsellorName}
                  onChange={(e) =>
                    setNewLead((p) => ({ ...p, counsellorName: e.target.value }))
                  }
                  className="min-w-0 flex-1 border border-stone-300 bg-white px-1.5 py-1 text-[13px] outline-none focus:border-[#cc785c]"
                />
              )}
              <button
                onClick={submitNew}
                disabled={creating}
                title="Save"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
              </button>
              <button
                onClick={cancelNew}
                disabled={creating}
                title="Cancel"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-stone-300 bg-white text-stone-600 hover:border-stone-500 hover:text-stone-900 disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
            {/* Datalist holds existing counsellor names so common entries
                auto-suggest as the user types — but anything goes. */}
            <datalist id="simple-counsellors">
              {counsellors.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </div>
        )}

        {sortedLeads.map((lead) => {
          const isSelected = selectedIds.has(lead.id);
          // Past/future row tinting was removed by request — the calendar
          // popup still color-codes individual days. Keeping the sheet
          // monochrome reads cleaner with only a handful of leads.
          return (
            <div
              key={lead.id}
              className="grid items-start gap-3 border-b border-stone-200 bg-white px-3 py-2 text-[14px] text-stone-800 last:border-b-0 hover:bg-stone-50"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span className="pt-0.5">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelected(lead.id)}
                  className="h-3.5 w-3.5 cursor-pointer accent-[#cc785c]"
                  aria-label={`Select ${lead.name}`}
                />
              </span>
              <span className="text-[13px] text-stone-600">
                {lead.inquiry_date ? formatDateInIst(lead.inquiry_date) : "—"}
              </span>
              <span className="flex flex-col leading-tight">
                <span className="font-semibold text-stone-900">
                  {lead.name || "—"}
                </span>
                <span
                  className="truncate text-[13px] text-stone-700"
                  title={lead.email || ""}
                >
                  {lead.email || "—"}
                </span>
                <span className="text-[13px] tabular-nums text-stone-700">
                  {lead.contact || "—"}
                </span>
              </span>
              <span className="truncate" title={lead.purpose || ""}>
                {lead.purpose || "—"}
              </span>
              <span className="text-[11px] uppercase tracking-[0.12em] text-stone-700">
                {STATUS_LABEL[lead.status] || lead.status || "—"}
              </span>
              <button
                onClick={() => setCalendarLead(lead)}
                title="Open calendar"
                className="w-full cursor-pointer border border-stone-300 bg-white px-1.5 py-1 text-left text-[13px] text-stone-800 outline-none hover:border-[#cc785c] hover:text-[#cc785c]"
              >
                {lead.service_date ? formatDateInIst(lead.service_date) : "Set…"}
              </button>
              <button
                onClick={() => setHistoryLead(lead)}
                title="View appointment history"
                className="inline-flex items-center justify-center gap-1 border border-stone-300 bg-white px-1.5 py-1 text-[11px] text-stone-700 outline-none hover:border-[#cc785c] hover:text-[#cc785c]"
              >
                <History className="h-3.5 w-3.5" /> View
              </button>
              <span className="text-[13px] text-stone-700">
                {counsellorNameById.get(lead.counsellor_id) ||
                  lead.counsellor_name ||
                  "—"}
              </span>
            </div>
          );
        })}

        {sortedLeads.length === 0 && !showNew && (
          <p className="py-10 text-center text-sm italic text-stone-600">
            No leads yet. Click "+ New" to add one.
          </p>
        )}
      </div>

      <ArchivedSection
        leads={archivedLeads}
        counsellors={counsellors}
        onUnarchive={unarchiveLead}
      />

      {calendarLead && (
        <CalendarPopup
          lead={calendarLead}
          onClose={() => setCalendarLead(null)}
          onCreated={(scheduledFor) => {
            onAppointmentCreated(calendarLead.id, scheduledFor);
          }}
        />
      )}

      {historyLead && (
        <HistoryPopup
          lead={historyLead}
          onClose={() => setHistoryLead(null)}
        />
      )}
    </>
  );
}

// ============================================================
// Archived section
// ============================================================
// Collapsible "Archived" panel below the main sheet. Hidden by default.
// Shows each archived lead on a single compact line with name · purpose ·
// counsellor · when-archived · Unarchive. Returning a lead to the active
// sheet is a one-click action so the user can quickly recover from a
// mis-archive without a refetch.
function ArchivedSection({ leads, counsellors, onUnarchive }) {
  const [open, setOpen] = useState(false);
  if (leads.length === 0) return null;
  const counsellorNameById = new Map(counsellors.map((c) => [c.id, c.name]));
  return (
    <div className="mt-4 border border-stone-300 bg-stone-50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.1em] text-stone-700 hover:bg-stone-100"
      >
        <span className="inline-flex items-center gap-1.5">
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Archived ({leads.length})
        </span>
        <span className="text-[10px] font-normal normal-case tracking-normal text-stone-500">
          {open ? "click to collapse" : "click to expand"}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-stone-200 border-t border-stone-200 bg-white">
          {leads.map((lead) => (
            <li
              key={lead.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-stone-700"
            >
              <div className="min-w-0 flex-1 truncate">
                <span className="font-semibold text-stone-900">
                  {lead.name || "—"}
                </span>
                {lead.purpose && (
                  <span className="ml-2 text-stone-600">— {lead.purpose}</span>
                )}
                {(lead.counsellor_id || lead.counsellor_name) && (
                  <span className="ml-2 text-[12px] text-stone-500">
                    ·{" "}
                    {counsellorNameById.get(lead.counsellor_id) ||
                      lead.counsellor_name}
                  </span>
                )}
                {lead.archived_at && (
                  <span className="ml-2 text-[11px] text-stone-400">
                    · archived {formatDateInIst(lead.archived_at)}
                  </span>
                )}
              </div>
              <button
                onClick={() => onUnarchive(lead.id)}
                className="inline-flex shrink-0 items-center gap-1 border border-stone-400 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-600 hover:text-stone-900"
              >
                <Undo2 className="h-3 w-3" /> Unarchive
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// History popup
// ============================================================
// Modal with a flat chronological list of every appointment (past +
// upcoming) for one lead. Each row shows the time + notes + an Edit
// button; clicking Edit reveals an inline textarea so the counsellor can
// fill in details for a session that just happened (or fix an upcoming
// one). Past sessions are typically empty until the meeting actually
// occurs and someone records what was discussed.
function HistoryPopup({ lead, onClose }) {
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [savingId, setSavingId] = useState(null);
  const [saveErr, setSaveErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listAppointments(lead.id)
      .then((rows) => {
        if (!cancelled) setAppointments(rows);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  // Stable refs so the keydown effect can register exactly once.
  const stateRef = useRef({});
  stateRef.current = { onClose, hasUnsaved: editingId != null };

  // Don't auto-close on unsaved edits — user might be typing notes.
  const tryClose = () => {
    if (
      stateRef.current.hasUnsaved &&
      !window.confirm("Discard the note you're editing?")
    )
      return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") stateRef.current.onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  const startEdit = (appt) => {
    setEditingId(appt.id);
    setEditText(appt.notes || "");
    setSaveErr(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
    setSaveErr(null);
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    setSavingId(editingId);
    setSaveErr(null);
    try {
      const updated = await api.updateAppointment(lead.id, editingId, {
        notes: editText.trim() || null,
      });
      setAppointments((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setEditingId(null);
      setEditText("");
    } catch (e) {
      setSaveErr(e.message);
    } finally {
      setSavingId(null);
    }
  };

  // Split into upcoming + past for clarity. Upcoming: soonest first; past:
  // most-recent first so the latest meeting reads at the top of its block.
  const now = Date.now();
  const upcoming = appointments
    .filter((a) => new Date(a.scheduled_for).getTime() >= now)
    .sort(
      (x, y) => new Date(x.scheduled_for).getTime() - new Date(y.scheduled_for).getTime()
    );
  const past = appointments
    .filter((a) => new Date(a.scheduled_for).getTime() < now)
    .sort(
      (x, y) => new Date(y.scheduled_for).getTime() - new Date(x.scheduled_for).getTime()
    );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-stone-900/30"
        onClick={savingId ? undefined : tryClose}
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col border border-stone-300 bg-white shadow-xl">
        <header className="flex items-start justify-between border-b border-stone-200 px-5 py-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-[#cc785c]">
              Appointment history
            </p>
            <h3 className="mt-0.5 text-xl font-semibold tracking-tight text-stone-900">
              {lead.name}
            </h3>
            <p className="text-[14px] text-stone-600">{lead.purpose}</p>
          </div>
          <button
            onClick={tryClose}
            disabled={!!savingId}
            className="text-stone-500 hover:text-stone-900 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {loadErr && (
          <div className="border-b border-red-300 bg-red-50 px-5 py-2 text-[14px] text-red-800">
            {loadErr}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : appointments.length === 0 ? (
            <p className="py-10 text-center text-[15px] italic text-stone-500">
              No appointments yet. Open the calendar to schedule one.
            </p>
          ) : (
            <>
              {upcoming.length > 0 && (
                <Section title="Upcoming">
                  {upcoming.map((a) => (
                    <HistoryRow
                      key={a.id}
                      appt={a}
                      isEditing={editingId === a.id}
                      isSaving={savingId === a.id}
                      editText={editText}
                      onEditTextChange={setEditText}
                      onStartEdit={() => startEdit(a)}
                      onCancel={cancelEdit}
                      onSave={saveEdit}
                      saveErr={saveErr}
                    />
                  ))}
                </Section>
              )}
              {past.length > 0 && (
                <Section title="Past">
                  {past.map((a) => (
                    <HistoryRow
                      key={a.id}
                      appt={a}
                      isEditing={editingId === a.id}
                      isSaving={savingId === a.id}
                      editText={editText}
                      onEditTextChange={setEditText}
                      onStartEdit={() => startEdit(a)}
                      onCancel={cancelEdit}
                      onSave={saveEdit}
                      saveErr={saveErr}
                    />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <p className="border-b border-stone-200 bg-stone-50 px-5 py-2 text-[12px] font-bold uppercase tracking-[0.18em] text-stone-600">
        {title}
      </p>
      <ul className="divide-y divide-stone-100">{children}</ul>
    </div>
  );
}

function HistoryRow({
  appt,
  isEditing,
  isSaving,
  editText,
  onEditTextChange,
  onStartEdit,
  onCancel,
  onSave,
  saveErr,
}) {
  // Past sessions where the counsellor never wrote notes get a loud red
  // "Session Missed" warning instead of the gentle "no notes yet" copy —
  // makes overdue documentation impossible to miss when scrolling history.
  const isPast = new Date(appt.scheduled_for).getTime() < Date.now();
  const sessionMissed = isPast && !appt.notes;

  return (
    <li className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[16px] font-semibold tabular-nums text-stone-900">
          {formatDateInIst(appt.scheduled_for)}
          <span className="ml-2 font-normal text-stone-500">
            {formatTimeInIst(appt.scheduled_for)}
          </span>
        </span>
        {!isEditing && (
          <button
            onClick={onStartEdit}
            className="inline-flex shrink-0 items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[11px] uppercase tracking-[0.15em] text-stone-700 hover:border-[#cc785c] hover:text-[#cc785c]"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
      </div>
      {isEditing ? (
        <div className="mt-2">
          <textarea
            value={editText}
            onChange={(e) => onEditTextChange(e.target.value)}
            rows={4}
            placeholder="What was discussed, or what to prepare…"
            className="w-full resize-none border border-stone-300 bg-white px-2.5 py-2 text-[15px] outline-none focus:border-[#cc785c]"
            autoFocus
          />
          {saveErr && (
            <p className="mt-1 text-[14px] text-red-700">{saveErr}</p>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={isSaving}
              className="text-[11px] uppercase tracking-[0.15em] text-stone-600 hover:text-stone-900 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={isSaving}
              className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
            >
              {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
            </button>
          </div>
        </div>
      ) : sessionMissed ? (
        <p className="mt-1 text-[18px] font-bold uppercase tracking-wide text-red-600">
          Session Missed: No Session Notes Created
        </p>
      ) : (
        <p className="mt-1 text-[15px] leading-relaxed text-stone-700">
          {appt.notes || (
            <span className="italic text-stone-400">
              No notes yet — upcoming session.
            </span>
          )}
        </p>
      )}
    </li>
  );
}

// ============================================================
// Calendar popup
// ============================================================
// Centered modal with a month grid + a form below the grid. Past appointments
// are tinted yellow, the current upcoming one is tinted green. Clicking a
// past day shows the notes from that day (read-only). Clicking today / a
// future day reveals a notes textarea + Confirm button.
function CalendarPopup({ lead, onClose, onCreated }) {
  const [appointments, setAppointments] = useState([]);
  const [loadingAppts, setLoadingAppts] = useState(true);
  const [viewMonth, setViewMonth] = useState(() => {
    // Default to the month of the lead's current service_date if any,
    // otherwise the current IST month — feels right when opening a row.
    const anchor = lead.service_date || new Date().toISOString();
    const istInput = utcIsoToIstInput(anchor);
    const ymd = istInput ? istInput.slice(0, 10) : todayIstYmd();
    const [y, m] = ymd.split("-").map(Number);
    return { y, m };
  });
  const [selectedYmd, setSelectedYmd] = useState(null);
  const [notes, setNotes] = useState("");
  const [time, setTime] = useState(DEFAULT_TIME_IST);
  // When set, the form is editing notes on an existing appointment via
  // PATCH /:apptId rather than creating a new one. Time is locked in edit
  // mode (rescheduling would mean creating a new appointment row).
  const [editingApptId, setEditingApptId] = useState(null);
  const [busy, setBusy] = useState(false);
  // Two error slots so a fetch failure at the top of the modal doesn't
  // collide with a validation error attached to the form action.
  const [loadErr, setLoadErr] = useState(null);
  const [submitErr, setSubmitErr] = useState(null);

  // Fetch the lead's appointment history once, when the popup opens.
  useEffect(() => {
    let cancelled = false;
    setLoadingAppts(true);
    api
      .listAppointments(lead.id)
      .then((rows) => {
        if (!cancelled) setAppointments(rows);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingAppts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  // Build a map: ymd -> Appointment[] sorted by scheduled_for ascending so
  // multiple appointments on the same calendar day all show up — earlier
  // versions silently dropped duplicates with Map.set overwrite. The lead's
  // current service_date gets a synthetic fallback entry so legacy leads
  // (created before this table existed) still tint their day on the
  // calendar; synthetic entries are flagged so the UI can hide them from
  // the per-day list (lead.notes is *general* lead context, not per-day).
  const apptByYmd = useMemo(() => {
    const map = new Map();
    for (const a of appointments) {
      const ymd = utcIsoToIstInput(a.scheduled_for).slice(0, 10);
      if (!map.has(ymd)) map.set(ymd, []);
      map.get(ymd).push(a);
    }
    for (const arr of map.values()) {
      arr.sort(
        (x, y) => new Date(x.scheduled_for).getTime() - new Date(y.scheduled_for).getTime()
      );
    }
    if (lead.service_date) {
      const ymd = utcIsoToIstInput(lead.service_date).slice(0, 10);
      if (!map.has(ymd)) {
        map.set(ymd, [
          {
            id: "synthetic",
            scheduled_for: lead.service_date,
            notes: null,
            synthetic: true,
          },
        ]);
      }
    }
    return map;
  }, [appointments, lead.service_date]);

  const todayYmd = todayIstYmd();

  // Generate the 6×7 grid of day cells for the current viewMonth. Pads with
  // adjacent-month days greyed out so the grid is always rectangular.
  const cells = useMemo(() => {
    const { y, m } = viewMonth;
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startWeekday = first.getUTCDay(); // 0=Sun
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out = [];
    for (let i = 0; i < startWeekday; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      out.push({ d, ymd });
    }
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [viewMonth]);

  const monthLabel = new Date(
    Date.UTC(viewMonth.y, viewMonth.m - 1, 1)
  ).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const navMonth = (delta) => {
    // If the user has typed notes for the current selection, switching months
    // would clear the form (selectedYmd resets) and silently lose their
    // input. Confirm before discarding so it's never a surprise.
    if (notes.trim() && !window.confirm("Discard typed notes and change month?")) {
      return;
    }
    setViewMonth(({ y, m }) => {
      const next = m + delta;
      if (next < 1) return { y: y - 1, m: 12 };
      if (next > 12) return { y: y + 1, m: 1 };
      return { y, m: next };
    });
    setSelectedYmd(null);
    setEditingApptId(null);
    setNotes("");
    setTime(DEFAULT_TIME_IST);
    setSubmitErr(null);
  };

  const onPickDay = (ymd) => {
    // No-op when the user clicks the already-selected day — preserves any
    // notes they were typing instead of silently clearing the form.
    if (!ymd || ymd === selectedYmd) return;
    setSelectedYmd(ymd);
    setSubmitErr(null);

    // If the day already has a real appointment, default to editing the
    // latest one's notes. This is the "fill in details after the session"
    // path: counsellor opens the calendar on the day a meeting just
    // happened, clicks the tile, types what was discussed, hits Save.
    // For days with multiple appointments, the History popup is the place
    // to pick a specific earlier one.
    const real = (apptByYmd.get(ymd) || []).filter((a) => !a.synthetic);
    if (real.length > 0) {
      const latest = real[real.length - 1];
      setEditingApptId(latest.id);
      setNotes(latest.notes || "");
      const ist = utcIsoToIstInput(latest.scheduled_for);
      setTime(ist ? ist.slice(11) : DEFAULT_TIME_IST);
    } else {
      setEditingApptId(null);
      setNotes("");
      setTime(DEFAULT_TIME_IST);
    }
  };

  const isPast = (ymd) => ymd < todayYmd;

  const confirm = async () => {
    if (!selectedYmd) return;

    // Edit mode — PATCH the existing appointment's notes. Time is locked
    // (rescheduling = create new), so we don't recompute the iso.
    if (editingApptId) {
      setBusy(true);
      setSubmitErr(null);
      try {
        const updated = await api.updateAppointment(lead.id, editingApptId, {
          notes: notes.trim() || null,
        });
        setAppointments((prev) =>
          prev.map((a) => (a.id === updated.id ? updated : a))
        );
        onClose();
      } catch (e) {
        setSubmitErr(e.message);
        setBusy(false);
      }
      return;
    }

    // Create mode — full date+time validation.
    const iso = localInputToUtcIso(`${selectedYmd}T${time}`);
    if (!iso) {
      setSubmitErr("Invalid date/time.");
      return;
    }
    // Full-datetime past check: the YMD-only check let users book today at
    // a time that already passed. Use the actual instant against now so
    // "today 8:00" gets rejected when it's already 10:00.
    if (new Date(iso).getTime() < Date.now()) {
      setSubmitErr("Pick a date/time in the future.");
      return;
    }
    setBusy(true);
    setSubmitErr(null);
    try {
      const created = await api.createAppointment(lead.id, {
        scheduled_for: iso,
        notes: notes.trim() || null,
      });
      setAppointments((prev) => [...prev, created]);
      onCreated(iso);
      onClose();
    } catch (e) {
      setSubmitErr(e.message);
      setBusy(false);
    }
  };

  // Appointments for the selected day, including synthetic fallback rows.
  // The synthetic row carries notes:null (set in apptByYmd above), so it
  // safely shows in the list as "scheduled time — no notes" — matching the
  // tile color the user just clicked. Without including it, a yellow past
  // tile rendered "No appointment on this day" which contradicted the
  // visual. Real entries are always rendered first because of the asc sort.
  const selectedDayAppts = useMemo(() => {
    if (!selectedYmd) return [];
    return apptByYmd.get(selectedYmd) || [];
  }, [apptByYmd, selectedYmd]);
  const selectedIsPast = selectedYmd && isPast(selectedYmd);

  // Stable refs so the keydown effect can register exactly once and still
  // see fresh `busy` / `onClose` values. With deps:[busy, onClose] the
  // effect re-ran on every parent re-render (onClose is a fresh arrow each
  // time), churning the body-overflow style and reattaching listeners.
  const stateRef = useRef({});
  stateRef.current = { busy, onClose };

  // Discard guard for typed notes: backdrop click + X button + month-nav all
  // share this. Escape skips the prompt — pressing Escape is an explicit
  // "I want to bail" gesture; asking for confirmation would feel hostile.
  const tryClose = () => {
    if (notes.trim() && !window.confirm("Discard typed notes?")) return;
    onClose();
  };

  // Modal a11y: Escape closes; body scroll locked while open. The cleanup
  // restores scroll even if the parent unmounts us (e.g. lead removed).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !stateRef.current.busy) {
        stateRef.current.onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-stone-900/30"
        onClick={busy ? undefined : tryClose}
      />
      <div className="relative z-10 w-full max-w-sm border border-stone-300 bg-white shadow-xl">
        <header className="flex items-start justify-between border-b border-stone-200 px-4 py-2.5">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-[#cc785c]">
              {lead.name}
            </p>
            <p className="text-[12px] text-stone-600">{lead.purpose}</p>
          </div>
          <button
            onClick={tryClose}
            disabled={busy}
            className="text-stone-500 hover:text-stone-900 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Modal-level error banner for fetch failures. Without this, an
            error from listAppointments showed an empty calendar grid with
            no explanation. Submit-time errors are shown inside the form
            below (closer to the action that produced them). */}
        {loadErr && (
          <div className="border-b border-red-300 bg-red-50 px-4 py-1.5 text-[12px] text-red-800">
            {loadErr}
          </div>
        )}

        <div className="px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => navMonth(-1)}
              disabled={busy}
              className="text-stone-500 hover:text-stone-900 disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-[13px] font-semibold tracking-tight">
              {monthLabel}
            </span>
            <button
              onClick={() => navMonth(1)}
              disabled={busy}
              className="text-stone-500 hover:text-stone-900 disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] uppercase tracking-[0.08em] text-stone-500">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => (
              <span key={i} className="py-0.5">{d}</span>
            ))}
          </div>

          {loadingAppts ? (
            <div className="flex items-center justify-center py-6 text-stone-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
          ) : (
            <div className="mt-1 grid grid-cols-7 gap-0.5">
              {cells.map((c, i) => {
                if (!c) return <span key={i} className="aspect-square" />;
                const hasAppt = (apptByYmd.get(c.ymd) || []).length > 0;
                const past = isPast(c.ymd);
                const isToday = c.ymd === todayYmd;
                const isSel = c.ymd === selectedYmd;
                let bg = "bg-white hover:bg-stone-100";
                if (hasAppt && past) bg = "bg-yellow-200 hover:bg-yellow-300";
                else if (hasAppt && !past) bg = "bg-green-200 hover:bg-green-300";
                if (isSel) bg += " ring-2 ring-[#cc785c]";
                // When the tile has its own bg color (yellow/green), the bold
                // orange "today" text fights with the tile color; switch to a
                // ring-inset for today on colored tiles instead.
                let todayClass = "";
                if (isToday) {
                  todayClass = hasAppt
                    ? "ring-1 ring-inset ring-[#cc785c]"
                    : "font-bold text-[#cc785c]";
                }
                return (
                  <button
                    key={i}
                    onClick={() => onPickDay(c.ymd)}
                    disabled={busy}
                    className={`aspect-square text-[12px] tabular-nums text-stone-800 outline-none ${bg} ${todayClass} disabled:opacity-50`}
                  >
                    {c.d}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedYmd && (
          <div className="border-t border-stone-200 px-4 py-3">
            <p className="mb-1.5 text-[11px] uppercase tracking-[0.18em] text-stone-600">
              {formatDateInIst(`${selectedYmd}T00:00:00Z`)}
              {selectedIsPast
                ? " · past"
                : selectedDayAppts.length > 0
                  ? ` · ${selectedDayAppts.length} scheduled`
                  : ""}
            </p>

            {selectedDayAppts.length > 0 && (
              <ul className="mb-2 space-y-1 border-l-2 border-stone-200 pl-2 text-[12px] leading-snug text-stone-700">
                {selectedDayAppts.map((a) => (
                  <li key={a.id}>
                    <span className="tabular-nums text-stone-600">
                      {formatTimeInIst(a.scheduled_for)}
                    </span>
                    {a.notes ? (
                      <span className="ml-2">— {a.notes}</span>
                    ) : (
                      <span className="ml-2 italic text-stone-400">
                        — no notes
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Form modes:
                - editingApptId set: editing notes on an existing appt (any
                  day, past or future). Time field hidden — locked.
                - empty future day: create-new form with time + notes.
                - empty past day: read-only "no appointment" copy. */}
            {!editingApptId && selectedIsPast ? (
              selectedDayAppts.length === 0 && (
                <p className="text-[13px] italic text-stone-500">
                  No appointment on this day.
                </p>
              )
            ) : (
              <>
                {!editingApptId && (
                  <div className="mb-2 flex items-center gap-2">
                    <label className="text-[11px] uppercase tracking-[0.15em] text-stone-600">
                      Time (IST)
                    </label>
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      className="border border-stone-300 bg-white px-1.5 py-0.5 text-[12px] outline-none focus:border-[#cc785c]"
                    />
                  </div>
                )}
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder={
                    editingApptId
                      ? "What was discussed, or what to prepare…"
                      : "Notes / details for this appointment…"
                  }
                  className="w-full resize-none border border-stone-300 bg-white px-2 py-1.5 text-[13px] outline-none focus:border-[#cc785c]"
                />
                {submitErr && (
                  <p className="mt-1.5 text-[12px] text-red-700">{submitErr}</p>
                )}
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button
                    onClick={() => {
                      setSelectedYmd(null);
                      setEditingApptId(null);
                      setNotes("");
                      setTime(DEFAULT_TIME_IST);
                      setSubmitErr(null);
                    }}
                    disabled={busy}
                    className="text-[11px] uppercase tracking-[0.18em] text-stone-600 hover:text-stone-900 disabled:opacity-50"
                  >
                    Clear
                  </button>
                  <button
                    onClick={confirm}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
                  >
                    {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                    {editingApptId ? "Save" : "Confirm"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
