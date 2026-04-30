import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X, Check, Archive, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "./api.js";
import {
  formatDateInIst,
  localInputToUtcIso,
  utcIsoToIstInput,
} from "../lib/time.js";

const STATUS_LABEL = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  completed: "Completed",
  no_show: "No-show",
};
const STATUS_OPTIONS = Object.keys(STATUS_LABEL);

// When the calendar form needs a time-of-day to combine with a picked date.
const DEFAULT_TIME_IST = "10:00";

const EMPTY_NEW = {
  name: "",
  email: "",
  contact: "",
  purpose: "",
  inquiryDate: todayIstYmd(),
  status: "unassigned",
  serviceDate: "",
  counsellorId: "",
};

// Today's date in IST as "YYYY-MM-DD". Used as the default for inquiry_date
// when adding a new lead so the picker pre-fills with today.
function todayIstYmd() {
  return utcIsoToIstInput(new Date().toISOString()).slice(0, 10);
}

export default function SimpleFollowup() {
  const [leads, setLeads] = useState([]);
  const [counsellors, setCounsellors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newLead, setNewLead] = useState(EMPTY_NEW);
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // The lead whose calendar popup is currently open (null = closed).
  const [calendarLead, setCalendarLead] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listLeads(), api.listCounsellors()])
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
    setNewLead(EMPTY_NEW);
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
    const payload = {
      name,
      contact,
      email: newLead.email.trim() || null,
      purpose,
      inquiry_date: newLead.inquiryDate || null,
      status: newLead.status,
      service_date: newLead.serviceDate
        ? localInputToUtcIso(`${newLead.serviceDate}T${DEFAULT_TIME_IST}`)
        : null,
      counsellor_id: newLead.counsellorId || null,
    };
    setCreating(true);
    setError(null);
    try {
      const created = await api.createLead(payload);
      setLeads((prev) => [created, ...prev]);
      setNewLead(EMPTY_NEW);
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
    try {
      await Promise.all(ids.map((id) => api.archiveLead(id)));
      setLeads((prev) => prev.filter((l) => !selectedIds.has(l.id)));
      clearSelection();
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkBusy(false);
    }
  };

  // Called when CalendarPopup confirms a new appointment. Mirror the new
  // service_date+notes onto the lead row in our local state so the sheet
  // updates without a refetch.
  const onAppointmentCreated = (leadId, scheduledFor, notes) => {
    setLeads((prev) =>
      prev.map((l) =>
        l.id === leadId
          ? { ...l, service_date: scheduledFor, notes, reminder_sent: false }
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

  // 7 cols: select · date-of-query · contact · purpose · status · next follow · counsellor
  const gridCols = "2rem 7.5rem 1.6fr 1.2fr 6.5rem 8.5rem 1fr";

  // Sort: most-urgent upcoming first, then increasingly distant future, then
  // past most-recent-first, then leads with no service_date last.
  const now = Date.now();
  const sortedLeads = [...leads].sort((a, b) => {
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
            {leads.length} {leads.length === 1 ? "row" : "rows"}
          </span>
        </div>
        {!showNew && (
          <button
            onClick={() => setShowNew(true)}
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
          className="grid items-center gap-2 border-b border-stone-300 bg-stone-100 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span></span>
          <span>Query</span>
          <span>Name / Email / Ph</span>
          <span>Purpose</span>
          <span>Status</span>
          <span>Next follow</span>
          <span>Counsellor</span>
        </div>

        {showNew && (
          <div
            className="grid items-start gap-2 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-3 py-2 text-[14px] text-stone-800"
            style={{ gridTemplateColumns: gridCols }}
          >
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
            <select
              value={newLead.status}
              onChange={(e) =>
                setNewLead((p) => ({ ...p, status: e.target.value }))
              }
              className="border border-stone-300 bg-white px-1.5 py-1 text-[12px] outline-none focus:border-[#cc785c]"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={newLead.serviceDate}
              onChange={(e) =>
                setNewLead((p) => ({ ...p, serviceDate: e.target.value }))
              }
              className="border border-stone-300 bg-white px-1.5 py-1 text-[12px] outline-none focus:border-[#cc785c]"
            />
            <span className="flex items-center gap-1">
              <select
                value={newLead.counsellorId}
                onChange={(e) =>
                  setNewLead((p) => ({ ...p, counsellorId: e.target.value }))
                }
                className="min-w-0 flex-1 border border-stone-300 bg-white px-1.5 py-1 text-[12px] outline-none focus:border-[#cc785c]"
              >
                <option value="">—</option>
                {counsellors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
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
          </div>
        )}

        {sortedLeads.map((lead) => {
          const sd = lead.service_date ? new Date(lead.service_date).getTime() : null;
          const rowBg =
            sd == null
              ? "bg-white hover:bg-stone-50"
              : sd < now
                ? "bg-yellow-50 hover:bg-yellow-100"
                : "bg-green-50 hover:bg-green-100";
          const isSelected = selectedIds.has(lead.id);
          return (
            <div
              key={lead.id}
              className={`grid items-start gap-2 border-b border-stone-200 px-3 py-2 text-[14px] text-stone-800 last:border-b-0 ${rowBg}`}
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
                {lead.service_date
                  ? formatDateInIst(lead.service_date, { hour: undefined, minute: undefined })
                  : "Set…"}
              </button>
              <span className="text-[13px] text-stone-700">
                {counsellorNameById.get(lead.counsellor_id) || "—"}
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

      {calendarLead && (
        <CalendarPopup
          lead={calendarLead}
          onClose={() => setCalendarLead(null)}
          onCreated={(scheduledFor, notes) => {
            onAppointmentCreated(calendarLead.id, scheduledFor, notes);
          }}
        />
      )}
    </>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

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
        if (!cancelled) setErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingAppts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  // Build a map: ymd -> appointment row (latest wins if there are dupes for
  // the same calendar day — rare in practice). The lead's current
  // service_date is always considered, even if not yet in the appointments
  // table (e.g. a lead created via admin without going through this panel).
  const apptByYmd = useMemo(() => {
    const map = new Map();
    for (const a of appointments) {
      const ymd = utcIsoToIstInput(a.scheduled_for).slice(0, 10);
      map.set(ymd, a);
    }
    if (lead.service_date) {
      const ymd = utcIsoToIstInput(lead.service_date).slice(0, 10);
      // Only add the lead's own service_date if no appointment row covers it
      // — the appointments table is the source of truth when both exist.
      if (!map.has(ymd)) {
        map.set(ymd, {
          id: "lead",
          scheduled_for: lead.service_date,
          notes: lead.notes || null,
        });
      }
    }
    return map;
  }, [appointments, lead.service_date, lead.notes]);

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
    setViewMonth(({ y, m }) => {
      const next = m + delta;
      if (next < 1) return { y: y - 1, m: 12 };
      if (next > 12) return { y: y + 1, m: 1 };
      return { y, m: next };
    });
    setSelectedYmd(null);
  };

  const onPickDay = (ymd) => {
    if (!ymd) return;
    setSelectedYmd(ymd);
    const existing = apptByYmd.get(ymd);
    if (existing) {
      const ist = utcIsoToIstInput(existing.scheduled_for);
      setTime(ist ? ist.slice(11) : DEFAULT_TIME_IST);
      setNotes(existing.notes || "");
    } else {
      setTime(DEFAULT_TIME_IST);
      setNotes("");
    }
    setErr(null);
  };

  const isPast = (ymd) => ymd < todayYmd;

  const confirm = async () => {
    if (!selectedYmd) return;
    if (isPast(selectedYmd)) return; // safety: button is hidden anyway
    const iso = localInputToUtcIso(`${selectedYmd}T${time}`);
    if (!iso) {
      setErr("Invalid date/time.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createAppointment(lead.id, {
        scheduled_for: iso,
        notes: notes.trim() || null,
      });
      setAppointments((prev) => [...prev, created]);
      onCreated(iso, notes.trim() || null);
      onClose();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const selectedAppt = selectedYmd ? apptByYmd.get(selectedYmd) : null;
  const selectedIsPast = selectedYmd && isPast(selectedYmd);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-stone-900/30"
        onClick={busy ? undefined : onClose}
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
            onClick={onClose}
            disabled={busy}
            className="text-stone-500 hover:text-stone-900 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

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

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] uppercase tracking-[0.1em] text-stone-500">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
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
                const appt = apptByYmd.get(c.ymd);
                const past = isPast(c.ymd);
                const isToday = c.ymd === todayYmd;
                const isSel = c.ymd === selectedYmd;
                let bg = "bg-white hover:bg-stone-100";
                if (appt && past) bg = "bg-yellow-200 hover:bg-yellow-300";
                else if (appt && !past) bg = "bg-green-200 hover:bg-green-300";
                if (isSel) bg += " ring-2 ring-[#cc785c]";
                return (
                  <button
                    key={i}
                    onClick={() => onPickDay(c.ymd)}
                    disabled={busy}
                    className={`aspect-square text-[12px] tabular-nums outline-none ${bg} ${
                      isToday ? "font-bold text-[#cc785c]" : "text-stone-800"
                    } disabled:opacity-50`}
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
              {selectedIsPast ? " · past" : selectedAppt ? " · scheduled" : ""}
            </p>

            {selectedIsPast ? (
              <div className="text-[13px] leading-snug text-stone-700">
                {selectedAppt
                  ? selectedAppt.notes || (
                      <span className="italic text-stone-500">
                        No notes were entered for this day.
                      </span>
                    )
                  : (
                    <span className="italic text-stone-500">
                      No appointment on this day.
                    </span>
                  )}
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <label className="text-[11px] uppercase tracking-[0.15em] text-stone-600">
                    Time
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
                  placeholder="Notes / details for this appointment…"
                  className="w-full resize-none border border-stone-300 bg-white px-2 py-1.5 text-[13px] outline-none focus:border-[#cc785c]"
                />
                {err && (
                  <p className="mt-1.5 text-[12px] text-red-700">{err}</p>
                )}
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setSelectedYmd(null)}
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
                    Confirm
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
