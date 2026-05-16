import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  X,
  Check,
  Archive,
  ChevronLeft,
  ChevronRight,
  Undo2,
  History,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { api } from "./api.js";
import ArchivedSection from "./ArchivedSection.jsx";
import useAutoRefresh from "./useAutoRefresh.js";
import {
  formatDateInIst,
  formatTimeInIst,
  localInputToUtcIso,
  utcIsoToIstInput,
} from "../lib/time.js";

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
    studentClass: "",
    contact: "",
    purpose: "",
    inquiryDate: todayIstYmd(),
    // Admin must pick a counsellor from the roster (no free text). Empty
    // string means "not yet picked" — the form blocks submit until it's
    // a real counsellor id.
    counsellorId: "",
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
  // Sort mode for the active lead sheet. "newest" is the default — the
  // closest-to-now appointment first, then increasingly distant future,
  // then most-recent past. The other modes are explicit overrides for
  // when a counsellor wants to scan by recency-of-creation, alphabetic
  // grouping, or phone-prefix grouping.
  const [sortMode, setSortMode] = useState("created_desc");
  // The lead whose calendar popup is currently open (null = closed).
  const [calendarLead, setCalendarLead] = useState(null);
  // The lead whose history popup is currently open (null = closed).
  const [historyLead, setHistoryLead] = useState(null);
  // The lead whose Session popup is open. _allAppointments carries the
  // full list so the popup's dropdown can switch between appointments.
  const [sessionLead, setSessionLead] = useState(null);
  // The lead whose Followup popup is open (null = closed).
  const [followupLead, setFollowupLead] = useState(null);
  // Inline name editing: id of the lead being edited + the draft value.
  const [editingNameId, setEditingNameId] = useState(null);
  const [editingNameVal, setEditingNameVal] = useState("");

  // counsellorId scopes server-side when admin is impersonating so the
  // wire response only carries that counsellor's leads. For a counsellor
  // session the server already enforces the same scope; the param is
  // redundant but harmless. For unscoped admin (null) we get every lead.
  const refresh = useCallback(async () => {
    try {
      const [l, c] = await Promise.all([
        api.listLeads({
          includeArchived: true,
          counsellorId: isScoped ? scopedCounsellorId : null,
        }),
        api.listCounsellors(),
      ]);
      setLeads(l);
      setCounsellors(c);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [isScoped, scopedCounsellorId]);

  useEffect(() => {
    let active = true;
    refresh().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  useAutoRefresh(refresh);

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
    // Counsellor-scoped users auto-link to themselves. Admin must pick
    // an existing counsellor from the dropdown — free text is no longer
    // accepted because it produced "ghost" leads invisible to every
    // counsellor's scoped view. The server validates the FK too, but
    // we surface a friendly error here first.
    const payload = {
      name,
      contact,
      student_class: newLead.studentClass.trim() || null,
      purpose,
      inquiry_date: newLead.inquiryDate || null,
    };
    if (isScoped) {
      payload.counsellor_id = scopedCounsellorId;
    } else {
      if (!newLead.counsellorId) {
        setError("Pick a counsellor — leads can't be unassigned.");
        return;
      }
      payload.counsellor_id = newLead.counsellorId;
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

  const saveEditedName = async (lead) => {
    const trimmed = editingNameVal.trim();
    setEditingNameId(null);
    setEditingNameVal("");
    if (!trimmed || trimmed === lead.name) return;
    try {
      const updated = await api.updateLead(lead.id, { name: trimmed });
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, ...updated } : l)));
    } catch (e) {
      setError(e.message);
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
    // Clear the entire selection after a bulk run. Leaving the failed
    // rows ticked was visually ambiguous ("3 of 5 failed" plus still-
    // checked rows looked like nothing happened); the error banner
    // above already conveys what failed.
    clearSelection();
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

  // Per-row archive — sibling to the bulk archiveSelected flow above,
  // for the common case of archiving one lead without first ticking
  // the checkbox. Same confirm prompt + error handling as the bulk
  // path so behavior stays predictable.
  const archiveOne = async (lead) => {
    if (!window.confirm(`Archive lead "${lead.name || lead.id}"?`)) return;
    setError(null);
    try {
      const updated = await api.archiveLead(lead.id);
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? updated : l)));
      // Drop the row from selection if it was ticked, so the bulk-action
      // banner count doesn't include a now-archived lead.
      setSelectedIds((prev) => {
        if (!prev.has(lead.id)) return prev;
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    } catch (e) {
      setError(e.message);
    }
  };

  // Admin-only: hard-delete an archived lead. The server checks both
  // the role and the archived flag; we still gate the button visually
  // so counsellors never see it. Student intake data is preserved by
  // the FK (intake_students.lead_id ON DELETE SET NULL).
  const deleteLead = async (id) => {
    if (
      !window.confirm(
        "Delete this lead's followup history permanently? This removes appointments and tasks for this lead. Student intake data is NOT affected."
      )
    )
      return;
    setError(null);
    try {
      await api.deleteLead(id);
      setLeads((prev) => prev.filter((l) => l.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  // Mirror the server-recomputed service_date (passed from CalendarPopup)
  // onto the lead row after a new appointment is inserted, so the sheet's
  // "Next follow" cell + sort order match the server's truth without a
  // refetch. We deliberately use the server's recomputed value here, not
  // the user's input — the server picks "next upcoming, else most recent
  // past", which differs from the typed time when an out-of-order
  // appointment was just inserted.
  const onAppointmentCreated = (leadId, leadServiceDate) => {
    setLeads((prev) =>
      prev.map((l) =>
        l.id === leadId ? { ...l, service_date: leadServiceDate } : l
      )
    );
  };

  // Load appointments then open SessionPopup directly. If there are no
  // existing appointments, create a non-scheduled row immediately so the
  // popup has an apptId to bind notes to.
  const openSession = async (lead) => {
    try {
      const appointments = await api.listAppointments(lead.id);
      if (appointments.length === 0) {
        const { appointment } = await api.createAppointment(lead.id, {
          scheduled_for: new Date().toISOString(),
          ad_hoc: true,
        });
        setLeads((prev) =>
          prev.map((l) =>
            l.id === lead.id
              ? { ...l, next_appointment_id: appointment.id, next_appointment_scheduled_for: appointment.scheduled_for }
              : l
          )
        );
        setSessionLead({
          ...lead,
          next_appointment_id: appointment.id,
          next_appointment_scheduled_for: appointment.scheduled_for,
          next_appointment_ad_hoc: true,
          _allAppointments: [appointment],
        });
      } else {
        // Open directly — dropdown inside the popup handles appointment selection.
        setSessionLead({ ...lead, _allAppointments: appointments });
      }
    } catch (e) {
      setError(e.message || "Couldn't load appointments.");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-black">
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

  // 10 cols: select · date created · contact · purpose · appointment date · next followup · history · make notes · counsellor · archive
  const gridCols = "1.75rem 7.5rem 1.5fr 1.2fr 10rem 8rem 4.5rem 5.5rem 7rem 3rem";

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

  // Sort dispatch. The four modes:
  //   newest — default. Soonest upcoming first, then distant future,
  //            then most-recent past. Leads without a service_date sink.
  //            "Newest" reads as "closest to today, leaning forward" —
  //            what a counsellor scanning the day's work wants by default.
  //   oldest — strict ascending by service_date (oldest past first).
  //            Useful for clearing missed-notes backlog.
  //   name   — alphabetical by lead name. Group-by-name effectively
  //            since duplicates cluster.
  //   phone  — by digits of contact, then name as a stable tiebreaker.
  //            Group-by-phone for catching duplicate contacts.
  const now = Date.now();
  const sortedLeads = [...activeLeads];
  if (sortMode === "newest") {
    sortedLeads.sort((a, b) => {
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
  } else if (sortMode === "oldest") {
    sortedLeads.sort((a, b) => {
      const at = a.service_date ? new Date(a.service_date).getTime() : null;
      const bt = b.service_date ? new Date(b.service_date).getTime() : null;
      if (at == null && bt == null) return 0;
      if (at == null) return 1;
      if (bt == null) return -1;
      return at - bt;
    });
  } else if (sortMode === "name") {
    sortedLeads.sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
    );
  } else if (sortMode === "phone") {
    sortedLeads.sort((a, b) => {
      const ap = (a.contact || "").replace(/\D/g, "");
      const bp = (b.contact || "").replace(/\D/g, "");
      if (ap === bp) {
        return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
      }
      if (!ap) return 1;
      if (!bp) return -1;
      return ap.localeCompare(bp);
    });
  } else if (sortMode === "created_desc") {
    sortedLeads.sort((a, b) => {
      const ad = a.inquiry_date || "";
      const bd = b.inquiry_date || "";
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return bd.localeCompare(ad);
    });
  } else if (sortMode === "created_asc") {
    sortedLeads.sort((a, b) => {
      const ad = a.inquiry_date || "";
      const bd = b.inquiry_date || "";
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return ad.localeCompare(bd);
    });
  }

  return (
    <>
      <div className="mb-4 flex items-baseline justify-between border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Lead sheet</h2>
          <span className="text-[10px] uppercase tracking-[0.2em] text-black">
            {activeLeads.length} {activeLeads.length === 1 ? "row" : "rows"}
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.18em] text-black">Sort</span>
            <button
              onClick={() => setSortMode("created_desc")}
              className={`border px-2.5 py-0.5 text-[11px] uppercase tracking-[0.18em] transition ${sortMode === "created_desc" ? "border-[#cc785c] bg-[#cc785c] text-white" : "border-stone-300 bg-white text-black hover:border-[#cc785c]"}`}
            >
              Newest first
            </button>
            <button
              onClick={() => setSortMode("created_asc")}
              className={`border px-2.5 py-0.5 text-[11px] uppercase tracking-[0.18em] transition ${sortMode === "created_asc" ? "border-[#cc785c] bg-[#cc785c] text-white" : "border-stone-300 bg-white text-black hover:border-[#cc785c]"}`}
            >
              Oldest first
            </button>
          </span>
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
      </div>

      {error && (
        <div className="mb-3 border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
          {error}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mb-2 flex items-center justify-between border border-[#cc785c] bg-[#cc785c]/10 px-3 py-1.5 text-[12px]">
          <span className="text-black">
            <strong>{selectedIds.size}</strong> selected
          </span>
          <span className="flex items-center gap-2">
            <button
              onClick={clearSelection}
              disabled={bulkBusy}
              className="text-[11px] uppercase tracking-[0.18em] text-black hover:text-black disabled:opacity-50"
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
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-3 py-2 text-[12px] font-bold uppercase tracking-[0.08em] text-black"
          style={{ gridTemplateColumns: gridCols }}
        >
          {/* Empty span (not sr-only) holds the grid cell for the
              checkbox column. sr-only uses position:absolute which CSS
              Grid skips during auto-placement, shifting every header one
              column left. Per-row checkbox has its own aria-label. */}
          <span aria-hidden="true"></span>
          <span className="whitespace-nowrap">Date Created</span>
          <span className="whitespace-nowrap">Name / Ph / Class</span>
          <span className="whitespace-nowrap">Purpose</span>
          <span className="whitespace-nowrap">Appointment Date</span>
          <span className="whitespace-nowrap">Follow-up</span>
          <span className="whitespace-nowrap">History</span>
          <span className="whitespace-nowrap">Make Notes</span>
          <span className="whitespace-nowrap">Counsellor</span>
          <span className="whitespace-nowrap text-right">Archive</span>
        </div>

        {showNew && (
          <div
            className="grid items-start gap-3 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-3 py-2 text-[14px] text-black"
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
              <input
                type="text"
                placeholder="Class"
                value={newLead.studentClass}
                onChange={(e) =>
                  setNewLead((p) => ({ ...p, studentClass: e.target.value }))
                }
                className="border border-stone-300 bg-white px-1.5 py-1 text-[13px] outline-none focus:border-[#cc785c]"
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
            {/* Appointment Date + Follow-up: placeholders for layout symmetry. */}
            <span className="text-[11px] text-black">—</span>
            <span className="text-[11px] text-black">—</span>
            {/* History + Make Notes columns: nothing to view / write
                yet on an unsaved lead, so both stay empty. */}
            <span></span>
            <span></span>
            <span className="flex items-center gap-1">
              {isScoped ? (
                /* Scoped users always assign new leads to themselves;
                   the picker would just be redundant. */
                <span className="min-w-0 flex-1 truncate px-1.5 py-1 text-[12px]  text-black">
                  you
                </span>
              ) : (
                /* Required <select> — admin must pick from the roster.
                   Free text is no longer accepted because it produced
                   "ghost" leads invisible to every counsellor's scoped
                   view. If no counsellors exist yet, the dropdown
                   surfaces an empty-state hint and the form refuses to
                   submit (server enforces this too). */
                <select
                  value={newLead.counsellorId}
                  onChange={(e) =>
                    setNewLead((p) => ({ ...p, counsellorId: e.target.value }))
                  }
                  required
                  className="min-w-0 flex-1 border border-stone-300 bg-white px-1.5 py-1 text-[13px] outline-none focus:border-[#cc785c]"
                  title={
                    counsellors.length === 0
                      ? "Add a counsellor first (Counsellors tab)"
                      : "Pick a counsellor"
                  }
                >
                  <option value="">
                    {counsellors.length === 0
                      ? "No counsellors yet…"
                      : "Pick counsellor…"}
                  </option>
                  {counsellors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={submitNew}
                disabled={creating || (!isScoped && !newLead.counsellorId)}
                title={
                  !isScoped && !newLead.counsellorId
                    ? "Pick a counsellor first"
                    : "Save"
                }
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-50"
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
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-stone-300 bg-white text-black hover:border-stone-500 hover:text-black disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
            {/* Placeholder for the per-row Archive column — the new-lead
                row hasn't been saved yet, so there's nothing to archive. */}
            <span aria-hidden="true"></span>
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
              className="grid items-start gap-3 border-b border-stone-200 bg-white px-3 py-2.5 text-[15px] text-black last:border-b-0 hover:bg-stone-50"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span className="pt-1">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelected(lead.id)}
                  className="h-3.5 w-3.5 cursor-pointer accent-[#cc785c]"
                  aria-label={`Select ${lead.name}`}
                />
              </span>
              <span className="text-[14px] text-black">
                {lead.inquiry_date ? formatDateInIst(lead.inquiry_date) : "—"}
              </span>
              <span className="flex flex-col leading-tight gap-0.5">
                {editingNameId === lead.id ? (
                  <input
                    type="text"
                    value={editingNameVal}
                    autoFocus
                    onChange={(e) => setEditingNameVal(e.target.value)}
                    onBlur={() => saveEditedName(lead)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEditedName(lead);
                      if (e.key === "Escape") { setEditingNameId(null); setEditingNameVal(""); }
                    }}
                    className="border border-[#cc785c] bg-white px-1 py-0.5 text-[15px] font-semibold text-black outline-none"
                  />
                ) : (
                  <span
                    className="cursor-text text-[16px] font-semibold text-black hover:underline"
                    title="Click to edit name"
                    onClick={() => { setEditingNameId(lead.id); setEditingNameVal(lead.name || ""); }}
                  >
                    {lead.name || "—"}
                  </span>
                )}
                <span className="text-[14px] tabular-nums text-black">
                  {lead.contact || "—"}
                </span>
                <span className="text-[13px] text-stone-600">
                  {lead.student_class || ""}
                </span>
              </span>
              {/* Purpose wraps onto multiple lines so admins can read
                  long entries in full instead of seeing "Call and fix
                  a slot with Jyo…". Row uses items-start so other
                  cells anchor at the top when this one grows. */}
              <span className="whitespace-pre-wrap break-words" title={lead.purpose || ""}>
                {lead.purpose || "—"}
              </span>
              <button
                onClick={() => setCalendarLead(lead)}
                title="Open calendar"
                className="w-full cursor-pointer border border-stone-300 bg-white px-1.5 py-1.5 text-left text-[14px] text-black outline-none hover:border-[#cc785c] hover:text-[#cc785c]"
              >
                {lead.service_date ? formatDateInIst(lead.service_date) : "Set…"}
              </button>
              <button
                onClick={() => setFollowupLead(lead)}
                title="Set follow-up date"
                className="w-full cursor-pointer border border-stone-300 bg-white px-1.5 py-1.5 text-left text-[14px] text-black outline-none hover:border-[#cc785c] hover:text-[#cc785c]"
              >
                {lead.followup_date ? formatDateInIst(lead.followup_date) : "Set…"}
              </button>
              <span>
                <button
                  onClick={() => setHistoryLead(lead)}
                  title="View appointment history"
                  className="inline-flex w-full items-center justify-center gap-1 border border-stone-300 bg-white px-1.5 py-1 text-[12px] text-black outline-none hover:border-[#cc785c] hover:text-[#cc785c]"
                >
                  <History className="h-3.5 w-3.5" /> View
                </button>
              </span>
              {/* Make Notes button — always shown, lives in its own
                  column. If the lead has an official (non-ad_hoc)
                  upcoming or recent appointment, the popup opens against
                  that one so the notes attach to it. Otherwise we POST
                  a new ad_hoc=true row at NOW() and open against it, so
                  the counsellor can log notes from any conversation
                  that happens before the formal session is even booked.
                  HistoryPopup labels each entry "Note created before
                  appointment #N" so the relative ordering reads at a
                  glance. */}
              <span>
                <button
                  onClick={() => openSession(lead)}
                  title="Make notes for the current conversation"
                  className="inline-flex w-full items-center justify-center gap-1 border border-[#cc785c] bg-[#cc785c]/10 px-1.5 py-1 text-[12px] text-[#cc785c] outline-none hover:bg-[#cc785c] hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" /> Make Notes
                </button>
              </span>
              <span className="text-[14px] text-black">
                {counsellorNameById.get(lead.counsellor_id) ||
                  lead.counsellor_name ||
                  "—"}
              </span>
              <span className="flex justify-end">
                <button
                  onClick={() => archiveOne(lead)}
                  title="Archive this lead"
                  className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c]"
                  aria-label={`Archive ${lead.name || "lead"}`}
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          );
        })}

        {sortedLeads.length === 0 && !showNew && (
          <p className="py-10 text-center text-sm  text-black">
            No leads yet. Click "+ New" to add one.
          </p>
        )}
      </div>

      <ArchivedLeads
        role={role}
        leads={archivedLeads}
        counsellors={counsellors}
        onUnarchive={unarchiveLead}
        onDelete={deleteLead}
      />

      {calendarLead && (
        <CalendarPopup
          lead={calendarLead}
          onClose={() => setCalendarLead(null)}
          onCreated={(leadServiceDate) => {
            onAppointmentCreated(calendarLead.id, leadServiceDate);
          }}
        />
      )}

      {historyLead && (
        <HistoryPopup
          lead={historyLead}
          onClose={() => setHistoryLead(null)}
        />
      )}

      {followupLead && (
        <FollowupPopup
          lead={followupLead}
          onClose={() => setFollowupLead(null)}
          onSaved={(updatedLead) => {
            setLeads((prev) =>
              prev.map((l) => (l.id === updatedLead.id ? { ...l, ...updatedLead } : l))
            );
            setFollowupLead(null);
          }}
        />
      )}

      {sessionLead && (
        <SessionPopup
          lead={sessionLead}
          onClose={() => setSessionLead(null)}
          onAppointmentPatched={(appointment, updatedLead) => {
            // The counsellor moved this appointment. Two pieces of
            // state to reconcile:
            //   1) the parent lead-list cache, whose "Appointment Date"
            //      column reads lead.service_date (recomputed server-
            //      side as next-upcoming non-ad-hoc, else most-recent);
            //   2) the popup's own copy of the lead, whose date display
            //      reads next_appointment_scheduled_for — that field
            //      tracks the *specific* appointment open in the popup
            //      and may diverge from service_date if the row is past.
            if (updatedLead) {
              setLeads((prev) =>
                prev.map((l) => (l.id === updatedLead.id ? { ...l, ...updatedLead } : l))
              );
            }
            setSessionLead((prev) =>
              prev && prev.id === sessionLead.id
                ? {
                    ...prev,
                    next_appointment_scheduled_for: appointment.scheduled_for,
                    service_date: updatedLead?.service_date ?? prev.service_date,
                  }
                : prev
            );
          }}
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
// counsellor · when-archived · Unarchive. Admin role additionally gets
// a Delete button that hard-removes the lead (and its appointments +
// tasks via FK CASCADE); the FK on intake_students.lead_id is
// ON DELETE SET NULL so student intake data is preserved. Each row
// renders via the generic ArchivedSection's renderRow callback so the
// chrome stays shared with the tasks-archive panel.
function ArchivedLeads({ role, leads, counsellors, onUnarchive, onDelete }) {
  const counsellorNameById = new Map(counsellors.map((c) => [c.id, c.name]));
  const isAdmin = role === "admin";
  return (
    <ArchivedSection
      items={leads}
      renderRow={(lead) => (
        <li
          key={lead.id}
          className="flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-black"
        >
          <div className="min-w-0 flex-1 truncate">
            <span className="font-semibold text-black">
              {lead.name || "—"}
            </span>
            {lead.purpose && (
              <span className="ml-2 text-black">— {lead.purpose}</span>
            )}
            {(lead.counsellor_id || lead.counsellor_name) && (
              <span className="ml-2 text-[12px] text-black">
                ·{" "}
                {counsellorNameById.get(lead.counsellor_id) ||
                  lead.counsellor_name}
              </span>
            )}
            {lead.archived_at && (
              <span className="ml-2 text-[11px] text-black">
                · archived {formatDateInIst(lead.archived_at)}
              </span>
            )}
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => onUnarchive(lead.id)}
              className="inline-flex items-center gap-1 border border-stone-400 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-black hover:border-stone-600 hover:text-black"
            >
              <Undo2 className="h-3 w-3" /> Unarchive
            </button>
            {isAdmin && (
              <button
                onClick={() => onDelete(lead.id)}
                title="Delete this lead's followup history. Student intake data is not affected."
                className="inline-flex items-center gap-1 border border-red-400 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-red-700 hover:border-red-600 hover:bg-red-50 hover:text-red-800"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            )}
          </span>
        </li>
      )}
    />
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
      // PATCH now returns { appointment, lead } so the caller can patch
      // the parent lead-list cache when scheduled_for changes. Notes-
      // only edits leave lead=null and we just swap the appointment row.
      const { appointment } = await api.updateAppointment(lead.id, editingId, {
        notes: editText.trim() || null,
      });
      setAppointments((prev) => prev.map((a) => (a.id === appointment.id ? appointment : a)));
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

  // Number the lead's official (non-ad-hoc) appointments chronologically.
  // Each row's header reads "Note created before appointment #N" — N is
  // resolved against the row's created_at timestamp by walking this list.
  // Ad-hoc rows are excluded from numbering: they're notes-only, not
  // formal appointments, and including them would shift the numbering
  // every time a counsellor logs a quick call.
  const officialAppts = appointments
    .filter((a) => !a.ad_hoc)
    .sort(
      (x, y) => new Date(x.scheduled_for).getTime() - new Date(y.scheduled_for).getTime()
    );
  // For a given note-creation timestamp, return the 1-indexed position
  // of the next-upcoming official appointment in officialAppts. null if
  // no official appointment was scheduled in the future relative to that
  // moment — caller renders "before next appointment date set".
  const nextApptIndexFor = (createdAt) => {
    const ms = new Date(createdAt).getTime();
    for (let i = 0; i < officialAppts.length; i++) {
      if (new Date(officialAppts[i].scheduled_for).getTime() > ms) return i + 1;
    }
    return null;
  };

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
            <h3 className="mt-0.5 text-xl font-semibold tracking-tight text-black">
              {lead.name}
            </h3>
            <p className="text-[14px] text-black">{lead.purpose}</p>
          </div>
          <button
            onClick={tryClose}
            disabled={!!savingId}
            className="text-black hover:text-black disabled:opacity-50"
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
            <div className="flex items-center justify-center py-8 text-black">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : appointments.length === 0 ? (
            <p className="py-10 text-center text-[15px]  text-black">
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
                      nextApptIndex={nextApptIndexFor(a.created_at)}
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
                      nextApptIndex={nextApptIndexFor(a.created_at)}
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
      <p className="border-b border-stone-200 bg-stone-50 px-5 py-2 text-[12px] font-bold uppercase tracking-[0.18em] text-black">
        {title}
      </p>
      <ul className="divide-y divide-stone-100">{children}</ul>
    </div>
  );
}

function HistoryRow({
  appt,
  nextApptIndex,
  isEditing,
  isSaving,
  editText,
  onEditTextChange,
  onStartEdit,
  onCancel,
  onSave,
  saveErr,
}) {
  // Formal past appointments with no notes → loud "Session Missed" warning.
  // Non-scheduled rows without notes → quieter message (they weren't formal sessions).
  const isPast = new Date(appt.scheduled_for).getTime() < Date.now();
  const sessionMissed = isPast && !appt.notes && !appt.ad_hoc;
  const nonScheduledNoNotes = isPast && !appt.notes && appt.ad_hoc;

  // The row's primary header is the moment the note was created (i.e.,
  // when the appointment row was inserted). Per request: every history
  // row reads "Note created … — before appointment #N", anchored to the
  // next-upcoming official appointment relative to the note's creation
  // time. nextApptIndex is null when no upcoming appointment was on the
  // books at that moment, in which case the label falls back to "before
  // next appointment date set".
  const noteRelative =
    nextApptIndex != null
      ? `Note created before appointment #${nextApptIndex}`
      : "Note created before next appointment date set";

  return (
    <li className="px-5 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block text-[16px] font-semibold tabular-nums text-black">
            {formatDateInIst(appt.created_at)}
            <span className="ml-2 font-normal text-black">
              {formatTimeInIst(appt.created_at)}
            </span>
          </span>
          <span className="mt-0.5 block text-[12px] font-semibold uppercase tracking-[0.14em] text-[#cc785c]">
            {noteRelative}
          </span>
          {/* Ad-hoc rows have scheduled_for == created_at by construction
              (the row is created at NOW() with no formal appointment to
              anchor to), so showing scheduled_for again would just be the
              same timestamp twice. Only non-ad-hoc rows surface the
              appointment's actual scheduled time as a secondary line. */}
          {!appt.ad_hoc && (
            <span className="mt-1 block text-[12px] tabular-nums text-stone-700">
              Appointment scheduled for {formatDateInIst(appt.scheduled_for)}
              <span className="ml-1.5">{formatTimeInIst(appt.scheduled_for)}</span>
            </span>
          )}
        </div>
        {!isEditing && (
          <button
            onClick={onStartEdit}
            className="inline-flex shrink-0 items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[11px] uppercase tracking-[0.15em] text-black hover:border-[#cc785c] hover:text-[#cc785c]"
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
              className="text-[11px] uppercase tracking-[0.15em] text-black hover:text-black disabled:opacity-50"
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
      ) : nonScheduledNoNotes ? (
        <p className="mt-1 text-[14px] text-black">
          No notes added for this non-scheduled appointment.
        </p>
      ) : (
        <p className="mt-1 text-[15px] leading-relaxed text-black">
          {appt.notes || (
            <span className=" text-black">
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
// ============================================================
// Followup popup
// ============================================================
// Lightweight "next check-in" date setter. Not tied to the appointment
// calendar — saves directly to leads.followup_date + leads.followup_notes.
// Notes are required (server enforces, UI validates first).
function FollowupPopup({ lead, onClose, onSaved }) {
  const [viewMonth, setViewMonth] = useState(() => {
    const anchor = lead.followup_date || new Date().toISOString();
    const istInput = utcIsoToIstInput(anchor);
    const ymd = istInput ? istInput.slice(0, 10) : todayIstYmd();
    const [y, m] = ymd.split("-").map(Number);
    return { y, m };
  });
  const [selectedYmd, setSelectedYmd] = useState(() => {
    if (!lead.followup_date) return null;
    const ist = utcIsoToIstInput(lead.followup_date);
    return ist ? ist.slice(0, 10) : null;
  });
  const [time, setTime] = useState(() => {
    if (!lead.followup_date) return DEFAULT_TIME_IST;
    const ist = utcIsoToIstInput(lead.followup_date);
    return ist ? ist.slice(11) : DEFAULT_TIME_IST;
  });
  const [notes, setNotes] = useState(lead.followup_notes || "");
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState(null);

  const todayYmd = todayIstYmd();
  const isPast = (ymd) => ymd < todayYmd;

  const monthLabel = new Date(
    Date.UTC(viewMonth.y, viewMonth.m - 1, 1)
  ).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const cells = useMemo(() => {
    const { y, m } = viewMonth;
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startWeekday = first.getUTCDay();
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

  const navMonth = (delta) => {
    if (notes.trim() && !window.confirm("Discard typed notes and change month?")) return;
    setViewMonth(({ y, m }) => {
      const next = m + delta;
      if (next < 1) return { y: y - 1, m: 12 };
      if (next > 12) return { y: y + 1, m: 1 };
      return { y, m: next };
    });
    setSelectedYmd(null);
    setNotes("");
    setTime(DEFAULT_TIME_IST);
    setSubmitErr(null);
  };

  const onPickDay = (ymd) => {
    if (!ymd || isPast(ymd)) return;
    if (ymd === selectedYmd) return;
    setSelectedYmd(ymd);
    setSubmitErr(null);
  };

  const tryClose = () => {
    if (notes.trim() && !window.confirm("Discard typed notes?")) return;
    onClose();
  };

  const stateRef = useRef({});
  stateRef.current = { busy, onClose };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !stateRef.current.busy) stateRef.current.onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  const confirm = async () => {
    if (!selectedYmd) return;
    if (!notes.trim()) {
      setSubmitErr("A note is required — describe why you're following up.");
      return;
    }
    const iso = localInputToUtcIso(`${selectedYmd}T${time}`);
    if (!iso) { setSubmitErr("Invalid date/time."); return; }
    if (new Date(iso).getTime() <= Date.now()) {
      setSubmitErr("Pick a date/time in the future.");
      return;
    }
    setBusy(true);
    setSubmitErr(null);
    try {
      const updated = await api.setFollowup(lead.id, {
        followup_date: iso,
        followup_notes: notes.trim(),
      });
      onSaved(updated);
    } catch (e) {
      setSubmitErr(e.message);
      setBusy(false);
    }
  };

  const clearFollowup = async () => {
    if (!window.confirm("Clear the follow-up date and note?")) return;
    setBusy(true);
    try {
      const updated = await api.setFollowup(lead.id, { followup_date: null });
      onSaved(updated);
    } catch (e) {
      setSubmitErr(e.message);
      setBusy(false);
    }
  };

  const existingFollowupYmd = lead.followup_date
    ? utcIsoToIstInput(lead.followup_date).slice(0, 10)
    : null;

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
            <p className="text-[12px] text-black">Set Follow-up</p>
          </div>
          <button
            onClick={tryClose}
            disabled={busy}
            className="text-black hover:text-black disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <button onClick={() => navMonth(-1)} disabled={busy} className="text-black hover:text-black disabled:opacity-50">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-[13px] font-semibold tracking-tight">{monthLabel}</span>
            <button onClick={() => navMonth(1)} disabled={busy} className="text-black hover:text-black disabled:opacity-50">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] uppercase tracking-[0.08em] text-black">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => (
              <span key={i} className="py-0.5">{d}</span>
            ))}
          </div>

          <div className="mt-1 grid grid-cols-7 gap-0.5">
            {cells.map((c, i) => {
              if (!c) return <span key={i} className="aspect-square" />;
              const past = isPast(c.ymd);
              const isToday = c.ymd === todayYmd;
              const isSel = c.ymd === selectedYmd;
              const isExisting = c.ymd === existingFollowupYmd;
              let bg = past
                ? "bg-stone-100 text-stone-400 cursor-not-allowed"
                : "bg-white hover:bg-stone-100 cursor-pointer";
              if (!past && isExisting) bg = "bg-green-200 hover:bg-green-300 cursor-pointer";
              if (isSel) bg += " ring-2 ring-[#cc785c]";
              let todayClass = "";
              if (isToday && !past) {
                todayClass = isExisting ? "ring-1 ring-inset ring-[#cc785c]" : "font-bold text-[#cc785c]";
              }
              return (
                <button
                  key={i}
                  onClick={() => onPickDay(c.ymd)}
                  disabled={busy || past}
                  className={`aspect-square text-[12px] tabular-nums text-black outline-none ${bg} ${todayClass} disabled:opacity-50`}
                >
                  {c.d}
                </button>
              );
            })}
          </div>
        </div>

        {selectedYmd && (
          <div className="border-t border-stone-200 px-4 py-3">
            <p className="mb-1.5 text-[11px] uppercase tracking-[0.18em] text-black">
              {formatDateInIst(`${selectedYmd}T00:00:00Z`)}
            </p>

            <div className="mb-2 flex items-center gap-2">
              <label className="text-[11px] uppercase tracking-[0.15em] text-black">
                Time (IST)
              </label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="border border-stone-300 bg-white px-1.5 py-0.5 text-[12px] outline-none focus:border-[#cc785c]"
              />
            </div>

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Why are you following up? What to discuss…"
              className="w-full resize-none border border-stone-300 bg-white px-2 py-1.5 text-[13px] outline-none focus:border-[#cc785c]"
            />
            <p className="mt-0.5 text-[11px] text-stone-800">Note required</p>

            {submitErr && (
              <p className="mt-1.5 text-[12px] text-red-700">{submitErr}</p>
            )}

            <div className="mt-2 flex items-center justify-between">
              {lead.followup_date ? (
                <button
                  onClick={clearFollowup}
                  disabled={busy}
                  className="text-[11px] uppercase tracking-[0.18em] text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  Clear
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setSelectedYmd(null); setNotes(""); setTime(DEFAULT_TIME_IST); setSubmitErr(null); }}
                  disabled={busy}
                  className="text-[11px] uppercase tracking-[0.18em] text-black hover:text-black disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirm}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}

        {!selectedYmd && lead.followup_date && (
          <div className="border-t border-stone-200 px-4 py-3">
            <p className="mb-1 text-[12px] text-black">
              Currently set to{" "}
              <span className="font-semibold">{formatDateInIst(lead.followup_date)}</span>
            </p>
            {lead.followup_notes && (
              <p className="mb-2 text-[12px] text-stone-800">{lead.followup_notes}</p>
            )}
            {submitErr && (
              <p className="mb-1.5 text-[12px] text-red-700">{submitErr}</p>
            )}
            <button
              onClick={clearFollowup}
              disabled={busy}
              className="text-[11px] uppercase tracking-[0.18em] text-red-600 hover:text-red-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Clear follow-up"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

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

  // Build a map: ymd -> Appointment[] sorted by scheduled_for ascending,
  // so multiple appointments on the same calendar day all show up. The
  // lead's current service_date gets a synthetic fallback entry so leads
  // that haven't yet been booked through this calendar still tint their
  // upcoming day; synthetic entries are flagged so the UI can mark them
  // distinctly when needed.
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
      // Server returns { appointment, lead }: the inserted row plus the
      // lead row whose service_date has been recomputed to "next upcoming
      // else most recent past". Mirror that recomputed value into parent
      // state so the sheet's "Next follow" cell is always the same value
      // the server would return on a refetch.
      const { appointment, lead: updatedLead } = await api.createAppointment(
        lead.id,
        { scheduled_for: iso, notes: notes.trim() || null }
      );
      setAppointments((prev) => [...prev, appointment]);
      onCreated(updatedLead.service_date);
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
            <p className="text-[12px] text-black">{lead.purpose}</p>
          </div>
          <button
            onClick={tryClose}
            disabled={busy}
            className="text-black hover:text-black disabled:opacity-50"
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
              className="text-black hover:text-black disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-[13px] font-semibold tracking-tight">
              {monthLabel}
            </span>
            <button
              onClick={() => navMonth(1)}
              disabled={busy}
              className="text-black hover:text-black disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] uppercase tracking-[0.08em] text-black">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => (
              <span key={i} className="py-0.5">{d}</span>
            ))}
          </div>

          {loadingAppts ? (
            <div className="flex items-center justify-center py-6 text-black">
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
                    className={`aspect-square text-[12px] tabular-nums text-black outline-none ${bg} ${todayClass} disabled:opacity-50`}
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
            <p className="mb-1.5 text-[11px] uppercase tracking-[0.18em] text-black">
              {formatDateInIst(`${selectedYmd}T00:00:00Z`)}
              {selectedIsPast
                ? " · past"
                : selectedDayAppts.length > 0
                  ? ` · ${selectedDayAppts.length} scheduled`
                  : ""}
            </p>

            {selectedDayAppts.length > 0 && (
              <ul className="mb-2 space-y-1 border-l-2 border-stone-200 pl-2 text-[12px] leading-snug text-black">
                {selectedDayAppts.map((a) => (
                  <li key={a.id}>
                    <span className="tabular-nums text-black">
                      {formatTimeInIst(a.scheduled_for)}
                    </span>
                    {a.notes ? (
                      <span className="ml-2">— {a.notes}</span>
                    ) : (
                      <span className="ml-2  text-black">
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
                - past day with no real appt (zero entries OR only the
                  synthetic fallback): read-only copy. The create form is
                  hidden because the API enforces future-only times — no
                  point showing a form whose Confirm is guaranteed to fail.
                  Synthetic-only is a legacy state (lead.service_date set
                  without a corresponding appointment row), so the message
                  has to spell that out so the user isn't stuck wondering. */}
            {!editingApptId && selectedIsPast ? (
              selectedDayAppts.length === 0 ? (
                <p className="text-[13px]  text-black">
                  No appointment on this day.
                </p>
              ) : selectedDayAppts.every((a) => a.synthetic) ? (
                <p className="text-[13px]  text-black">
                  Scheduled time on this day, but no appointment record to
                  edit. Schedule a new appointment in the future to add notes.
                </p>
              ) : null
            ) : (
              <>
                {!editingApptId && (
                  <div className="mb-2 flex items-center gap-2">
                    <label className="text-[11px] uppercase tracking-[0.15em] text-black">
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
                    className="text-[11px] uppercase tracking-[0.18em] text-black hover:text-black disabled:opacity-50"
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

// ============================================================
// Appointment picker overlay
// ============================================================
// Shown before SessionPopup when a lead has multiple appointments so the
// counsellor can choose which session they're making notes for.
// ============================================================
// Session popup
// ============================================================
// Opens directly (no picker overlay). lead._allAppointments carries the
// full list so the dropdown in the header can switch between any scheduled
// appointment or a new non-scheduled one. On switch the notes + tasks
// sections reload for the newly selected appointment.
function SessionPopup({ lead, onClose, onAppointmentPatched }) {
  const now = Date.now();
  const [localAppts, setLocalAppts] = useState(lead._allAppointments || []);
  const [creatingAdhoc, setCreatingAdhoc] = useState(false);

  // Default selection: server-computed next appt, else first upcoming, else first past.
  const [selectedId, setSelectedId] = useState(() => {
    const appts = lead._allAppointments || [];
    if (lead.next_appointment_id) return String(lead.next_appointment_id);
    const upcoming = appts
      .filter((a) => !a.ad_hoc && new Date(a.scheduled_for).getTime() >= now)
      .sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));
    if (upcoming.length) return String(upcoming[0].id);
    const past = appts
      .filter((a) => !a.ad_hoc)
      .sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for));
    if (past.length) return String(past[0].id);
    if (appts.length) return String(appts[0].id);
    return "";
  });

  // Derive the currently-selected appointment object.
  const currentAppt = localAppts.find((a) => String(a.id) === selectedId) || null;
  const apptId = currentAppt ? currentAppt.id : lead.next_appointment_id;
  const apptDate = currentAppt ? currentAppt.scheduled_for : lead.next_appointment_scheduled_for;
  const isNonScheduled = currentAppt ? !!currentAppt.ad_hoc : !!lead.next_appointment_ad_hoc;
  const isPastSession = apptDate && new Date(apptDate).getTime() < now;

  const [notes, setNotes] = useState("");
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesErr, setNotesErr] = useState(null);

  const [dateInput, setDateInput] = useState(apptDate ? utcIsoToIstInput(apptDate) : "");
  const [savingDate, setSavingDate] = useState(false);
  const [dateErr, setDateErr] = useState(null);

  // Re-sync date input whenever the selected appointment changes.
  useEffect(() => {
    setDateInput(apptDate ? utcIsoToIstInput(apptDate) : "");
  }, [apptDate]);

  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksErr, setTasksErr] = useState(null);

  const [newText, setNewText] = useState("");
  const [newDue, setNewDue] = useState(() =>
    utcIsoToIstInput(new Date().toISOString()).slice(0, 10)
  );
  const [newPriority, setNewPriority] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [createErr, setCreateErr] = useState(null);

  // Reload notes + tasks whenever the selected appointment changes.
  useEffect(() => {
    if (!apptId) return;
    let cancelled = false;
    setNotesLoaded(false);
    setNotes("");
    setTasksLoading(true);
    setTasksErr(null);
    Promise.all([api.listAppointments(lead.id), api.listTasks({ appointmentId: apptId })])
      .then(([appts, ts]) => {
        if (cancelled) return;
        const me = appts.find((a) => String(a.id) === String(apptId));
        setNotes(me?.notes || "");
        setNotesLoaded(true);
        setTasks(ts);
      })
      .catch((e) => {
        if (cancelled) return;
        setNotesErr(e.message);
        setTasksErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id, apptId]);

  // When the user picks "Non-scheduled appointment" from the dropdown, create
  // (or reuse) an adhoc row immediately so notes have an apptId to bind to.
  const handleSelectChange = async (val) => {
    if (val === "__adhoc__") {
      setCreatingAdhoc(true);
      try {
        const { appointment } = await api.createAppointment(lead.id, {
          scheduled_for: new Date().toISOString(),
          ad_hoc: true,
        });
        setLocalAppts((prev) => [...prev, appointment]);
        setSelectedId(String(appointment.id));
      } catch (e) {
        setNotesErr(e.message || "Couldn't create appointment.");
      } finally {
        setCreatingAdhoc(false);
      }
    } else {
      setSelectedId(val);
    }
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    setNotesErr(null);
    try {
      await api.updateAppointment(lead.id, apptId, { notes: notes.trim() || null });
    } catch (e) {
      setNotesErr(e.message);
    } finally {
      setSavingNotes(false);
    }
  };

  const saveDate = async () => {
    setDateErr(null);
    const utc = localInputToUtcIso(dateInput);
    if (!utc) { setDateErr("Pick a valid date and time."); return; }
    setSavingDate(true);
    try {
      const { appointment, lead: updatedLead } = await api.updateAppointment(
        lead.id, apptId, { scheduled_for: utc }
      );
      onAppointmentPatched?.(appointment, updatedLead);
    } catch (e) {
      setDateErr(e.message);
    } finally {
      setSavingDate(false);
    }
  };

  const submitTask = async () => {
    const text = newText.trim();
    if (!text) { setCreateErr("Task text is required."); return; }
    setCreatingTask(true);
    setCreateErr(null);
    try {
      const created = await api.createTask({
        lead_id: lead.id,
        appointment_id: apptId,
        text,
        due_date: newDue,
        priority: newPriority,
        assignee_id: lead.counsellor_id || undefined,
      });
      setTasks((p) => [...p, created]);
      setNewText("");
      setNewPriority(false);
    } catch (e) {
      setCreateErr(e.message);
    } finally {
      setCreatingTask(false);
    }
  };

  // Build dropdown options: scheduled appointments first (upcoming then past),
  // then existing non-scheduled ones, then the option to create a new one.
  const scheduled = [...localAppts]
    .filter((a) => !a.ad_hoc)
    .sort((a, b) => {
      const aFuture = new Date(a.scheduled_for).getTime() >= now ? 0 : 1;
      const bFuture = new Date(b.scheduled_for).getTime() >= now ? 0 : 1;
      if (aFuture !== bFuture) return aFuture - bFuture;
      return new Date(a.scheduled_for) - new Date(b.scheduled_for);
    });
  const nonScheduled = localAppts.filter((a) => a.ad_hoc);

  const apptLabel = (a) => {
    const isFuture = new Date(a.scheduled_for).getTime() >= now;
    const prefix = a.ad_hoc ? "Non-scheduled" : isFuture ? "Upcoming" : "Past";
    return `${prefix} — ${formatDateInIst(a.scheduled_for)}`;
  };

  const showDropdown = localAppts.length > 0;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-stone-900/30"
        onClick={savingNotes || creatingTask || creatingAdhoc ? undefined : onClose}
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-xl flex-col border border-stone-300 bg-white shadow-xl">
        <header className="flex items-start justify-between border-b border-stone-200 px-5 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-[0.22em] text-[#cc785c]">Make Notes</p>
            <h3 className="mt-0.5 text-xl font-semibold tracking-tight text-black">
              {lead.name}
            </h3>

            {/* Appointment selector — shown when there are existing appointments */}
            {showDropdown && (
              <div className="mt-2">
                <label className="text-[10px] uppercase tracking-[0.18em] text-stone-600">
                  This note is for
                </label>
                <select
                  value={selectedId}
                  onChange={(e) => handleSelectChange(e.target.value)}
                  disabled={creatingAdhoc || savingNotes || savingDate}
                  className="mt-1 block w-full border border-stone-300 bg-white px-2 py-1.5 text-[13px] outline-none focus:border-[#cc785c] disabled:opacity-50"
                >
                  {scheduled.length > 0 && (
                    <optgroup label="Scheduled appointments">
                      {scheduled.map((a) => (
                        <option key={a.id} value={String(a.id)}>
                          {apptLabel(a)}{a.notes ? " (has notes)" : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {nonScheduled.length > 0 && (
                    <optgroup label="Non-scheduled">
                      {nonScheduled.map((a) => (
                        <option key={a.id} value={String(a.id)}>
                          {apptLabel(a)}{a.notes ? " (has notes)" : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value="__adhoc__">
                    {creatingAdhoc ? "Creating…" : "+ New non-scheduled appointment"}
                  </option>
                </select>
              </div>
            )}

            {/* Status badge (only when no dropdown, or for context) */}
            {!showDropdown && isNonScheduled && (
              <p className="mt-1 text-[11px] text-stone-600">Non-scheduled appointment</p>
            )}
            {!showDropdown && !isNonScheduled && isPastSession && (
              <p className="mt-1 text-[11px] text-stone-600">Past session — awaiting notes</p>
            )}

            {/* Editable appointment date/time */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="datetime-local"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                disabled={savingDate || creatingAdhoc}
                className="border border-stone-300 bg-white px-2 py-1 text-[13px] tabular-nums outline-none focus:border-[#cc785c] disabled:opacity-50"
              />
              <button
                onClick={saveDate}
                disabled={
                  savingDate ||
                  creatingAdhoc ||
                  !dateInput ||
                  (apptDate && dateInput === utcIsoToIstInput(apptDate))
                }
                className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-40"
              >
                {savingDate && <Loader2 className="h-3 w-3 animate-spin" />}
                Save date
              </button>
              <span className="text-[11px] text-stone-700">IST</span>
            </div>
            {dateErr && <p className="mt-1 text-[12px] text-red-700">{dateErr}</p>}
          </div>
          <button
            onClick={onClose}
            disabled={savingNotes || creatingTask || creatingAdhoc}
            className="ml-3 shrink-0 text-black hover:text-black disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <section>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-black">
              Notes
            </p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was discussed, next steps, anything to remember…"
              rows={5}
              maxLength={2000}
              disabled={!notesLoaded || creatingAdhoc}
              className="w-full resize-y border border-stone-300 bg-white px-3 py-2 text-[14px] outline-none focus:border-[#cc785c] disabled:opacity-50"
            />
            {notesErr && <p className="mt-1 text-xs text-red-700">{notesErr}</p>}
            <div className="mt-2 flex justify-end">
              <button
                onClick={saveNotes}
                disabled={!notesLoaded || savingNotes || creatingAdhoc}
                className="inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
              >
                {savingNotes && <Loader2 className="h-3 w-3 animate-spin" />}
                Save notes
              </button>
            </div>
          </section>

          <section className="mt-6 border-t border-stone-200 pt-5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-black">
              Tasks from this session
            </p>
            {tasksLoading ? (
              <div className="flex items-center justify-center py-4 text-black">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : tasksErr ? (
              <p className="text-xs text-red-700">{tasksErr}</p>
            ) : tasks.length === 0 ? (
              <p className="text-[13px] text-black">None yet — add the first one below.</p>
            ) : (
              <ul className="space-y-1.5">
                {tasks.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-start gap-2 border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-[13px]"
                  >
                    {t.priority && (
                      <Star className="mt-0.5 h-3 w-3 shrink-0 text-[#cc785c]" fill="currentColor" />
                    )}
                    <span className="flex-1 text-black">{t.text}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-black">
                      due {formatDateInIst(t.due_date)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 border border-stone-200 bg-white px-3 py-2.5">
              <input
                type="text"
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Add a task from this session…"
                maxLength={1000}
                className="w-full border-b border-stone-300 bg-transparent py-1 text-[14px] outline-none focus:border-[#cc785c]"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.15em] text-black">
                  Due
                  <input
                    type="date"
                    value={newDue}
                    onChange={(e) => setNewDue(e.target.value)}
                    className="border border-stone-300 bg-white px-2 py-1 text-[12px] tabular-nums outline-none focus:border-[#cc785c]"
                  />
                </label>
                <label className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.15em] text-black">
                  <input
                    type="checkbox"
                    checked={newPriority}
                    onChange={(e) => setNewPriority(e.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer accent-[#cc785c]"
                  />
                  Priority
                </label>
                <button
                  onClick={submitTask}
                  disabled={creatingTask || !newText.trim()}
                  className="ml-auto inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
                >
                  {creatingTask ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  Add task
                </button>
              </div>
              {createErr && <p className="mt-1 text-xs text-red-700">{createErr}</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
