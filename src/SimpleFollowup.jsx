import { useEffect, useState } from "react";
import { Loader2, Plus, X, Check, Archive } from "lucide-react";
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

// When a lead has no service_date, we still need a time-of-day to combine with
// the picked calendar date. 10:00 IST is a reasonable default for a follow-up.
const DEFAULT_TIME_IST = "10:00";

const EMPTY_NEW = {
  name: "",
  email: "",
  contact: "",
  purpose: "",
  serviceDate: "",
  counsellorId: "",
};

export default function SimpleFollowup() {
  const [leads, setLeads] = useState([]);
  const [counsellors, setCounsellors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newLead, setNewLead] = useState(EMPTY_NEW);
  const [creating, setCreating] = useState(false);
  // Multi-select for bulk archive. Stored as a Set for O(1) toggle.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // The lead currently open in the side detail panel (null = panel closed).
  const [detailLead, setDetailLead] = useState(null);

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

  // Submit the inline "new lead" row. Required by the API: name, contact,
  // purpose. Status is derived server-side from whether a counsellor is
  // assigned, and inquiry_date defaults to CURRENT_DATE in the DB — so we
  // only send what the user actually filled in.
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

  // Bulk-archive every selected lead. Confirms first; on success removes them
  // locally without a refetch (the server-truth row is enriched but we'd
  // strip it from the active sheet anyway).
  const archiveSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Archive ${ids.length} selected lead${ids.length === 1 ? "" : "s"}? They will be hidden from this sheet.`
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

  // Persist edits made inside the detail panel. The panel can update
  // service_date, notes, status, and counsellor — all in a single PATCH.
  const saveDetail = async (patch) => {
    if (!detailLead) return;
    setError(null);
    try {
      const updated = await api.updateLead(detailLead.id, patch);
      setLeads((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setDetailLead(null);
    } catch (e) {
      throw e; // let panel surface its own message
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (error && leads.length === 0 && !showNew) {
    return (
      <div className="border border-red-300 bg-red-50 p-6 text-sm text-red-800">
        {error}
      </div>
    );
  }

  // 7 columns: select · date · contact · purpose · status · next follow · counsellor
  const gridCols = "2.5rem 10rem 2fr 1.4fr 8rem 10rem 1fr";

  // Sort: most-urgent upcoming first, then increasingly distant future, then
  // past appointments most-recent-first, then leads with no service_date last.
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
      <div className="mb-6 flex items-baseline justify-between border-b border-stone-300 pb-3">
        <h2 className="text-xl font-semibold tracking-tight">Lead sheet</h2>
        <div className="flex items-center gap-4">
          <span className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            {leads.length} {leads.length === 1 ? "row" : "rows"}
          </span>
          {!showNew && (
            <button
              onClick={() => setShowNew(true)}
              className="inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[12px] uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f]"
            >
              <Plus className="h-3.5 w-3.5" /> New lead
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 border border-red-300 bg-red-50 px-4 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mb-3 flex items-center justify-between border border-[#cc785c] bg-[#cc785c]/10 px-4 py-2.5 text-[13px]">
          <span className="text-stone-800">
            <strong>{selectedIds.size}</strong> selected
          </span>
          <span className="flex items-center gap-3">
            <button
              onClick={clearSelection}
              disabled={bulkBusy}
              className="text-[12px] uppercase tracking-[0.18em] text-stone-600 hover:text-stone-900 disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={archiveSelected}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[12px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
            >
              {bulkBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              Archive selected
            </button>
          </span>
        </div>
      )}

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-4 py-3 text-[13px] font-bold uppercase tracking-[0.18em] text-stone-800"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span></span>
          <span>Date of query</span>
          <span>Name / Email / Ph</span>
          <span>Purpose</span>
          <span>Status</span>
          <span>Next follow</span>
          <span>Counsellor</span>
        </div>

        {showNew && (
          <div
            className="grid items-start gap-3 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-4 py-4 text-[16px] text-stone-800"
            style={{ gridTemplateColumns: gridCols }}
          >
            <span></span>
            <span className="text-[13px] italic text-stone-500">today</span>
            <span className="flex flex-col gap-1.5">
              <input
                type="text"
                placeholder="Full name *"
                value={newLead.name}
                onChange={(e) =>
                  setNewLead((p) => ({ ...p, name: e.target.value }))
                }
                className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
                autoFocus
              />
              <input
                type="email"
                placeholder="Email"
                value={newLead.email}
                onChange={(e) =>
                  setNewLead((p) => ({ ...p, email: e.target.value }))
                }
                className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
              />
              <input
                type="tel"
                placeholder="Phone (digits only) *"
                value={newLead.contact}
                onChange={(e) =>
                  setNewLead((p) => ({
                    ...p,
                    contact: e.target.value.replace(/\D/g, ""),
                  }))
                }
                className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] tabular-nums outline-none focus:border-[#cc785c]"
              />
            </span>
            <input
              type="text"
              placeholder="Purpose *"
              value={newLead.purpose}
              onChange={(e) =>
                setNewLead((p) => ({ ...p, purpose: e.target.value }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
            />
            <span className="text-[13px] italic text-stone-500">auto</span>
            <input
              type="date"
              value={newLead.serviceDate}
              onChange={(e) =>
                setNewLead((p) => ({ ...p, serviceDate: e.target.value }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
            />
            <span className="flex items-center gap-1.5">
              <select
                value={newLead.counsellorId}
                onChange={(e) =>
                  setNewLead((p) => ({ ...p, counsellorId: e.target.value }))
                }
                className="min-w-0 flex-1 border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
              >
                <option value="">Unassigned</option>
                {counsellors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                onClick={submitNew}
                disabled={creating}
                title="Save lead"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={cancelNew}
                disabled={creating}
                title="Cancel"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-stone-300 bg-white text-stone-600 hover:border-stone-500 hover:text-stone-900 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}

        {sortedLeads.map((lead) => {
          const sd = lead.service_date ? new Date(lead.service_date).getTime() : null;
          // Past = yellow, future = green, no date = neutral. Subtle bg so the
          // text stays readable on the cream page background.
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
              className={`grid items-start gap-3 border-b border-stone-200 px-4 py-4 text-[16px] text-stone-800 last:border-b-0 ${rowBg}`}
              style={{ gridTemplateColumns: gridCols }}
            >
              <span className="pt-1">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelected(lead.id)}
                  className="h-4 w-4 cursor-pointer accent-[#cc785c]"
                  aria-label={`Select ${lead.name}`}
                />
              </span>
              <span className="text-stone-600">
                {lead.inquiry_date ? formatDateInIst(lead.inquiry_date) : "—"}
              </span>
              <span className="flex flex-col gap-0.5 leading-snug">
                <span className="font-semibold text-stone-900">
                  {lead.name || "—"}
                </span>
                <span
                  className="truncate text-stone-700"
                  title={lead.email || ""}
                >
                  {lead.email || "—"}
                </span>
                <span className="tabular-nums text-stone-700">
                  {lead.contact || "—"}
                </span>
              </span>
              <span className="truncate text-stone-700" title={lead.purpose || ""}>
                {lead.purpose || "—"}
              </span>
              <span className="text-[13px] uppercase tracking-[0.15em] text-stone-700">
                {STATUS_LABEL[lead.status] || lead.status || "—"}
              </span>
              <button
                onClick={() => setDetailLead(lead)}
                title="Open appointment details"
                className="w-full cursor-pointer border border-stone-300 bg-white px-2 py-1.5 text-left text-[14px] text-stone-800 outline-none hover:border-[#cc785c] hover:text-[#cc785c]"
              >
                {lead.service_date ? formatDateInIst(lead.service_date, {
                  hour: undefined,
                  minute: undefined,
                }) : "Set date…"}
              </button>
              <span className="text-stone-700">
                {counsellorNameById.get(lead.counsellor_id) || "—"}
              </span>
            </div>
          );
        })}

        {sortedLeads.length === 0 && !showNew && (
          <p className="py-12 text-center text-sm italic text-stone-600">
            No leads yet. Click "+ New lead" to add one.
          </p>
        )}
      </div>

      {detailLead && (
        <DetailPanel
          lead={detailLead}
          counsellors={counsellors}
          onClose={() => setDetailLead(null)}
          onSave={saveDetail}
        />
      )}
    </>
  );
}

// Right-side slide-in panel for the appointment details. Renders a backdrop
// + drawer; closes via X, backdrop click, or after a successful save. Edits
// service_date, notes, status, and counsellor in a single PATCH.
function DetailPanel({ lead, counsellors, onClose, onSave }) {
  const initial = utcIsoToIstInput(lead.service_date) || "";
  const [dateTime, setDateTime] = useState(initial);
  const [notes, setNotes] = useState(lead.notes || "");
  const [status, setStatus] = useState(lead.status || "unassigned");
  const [counsellorId, setCounsellorId] = useState(lead.counsellor_id || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const patch = {
        service_date: dateTime ? localInputToUtcIso(dateTime) : null,
        notes: notes.trim() || null,
        status,
        counsellor_id: counsellorId || null,
      };
      await onSave(patch);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-stone-900/30"
        onClick={busy ? undefined : onClose}
      />
      <aside className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-stone-300 bg-white shadow-xl">
        <header className="flex items-start justify-between border-b border-stone-300 px-6 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.25em] text-[#cc785c]">
              Appointment
            </p>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-stone-900">
              {lead.name}
            </h3>
            <p className="mt-1 text-[13px] tabular-nums text-stone-600">
              {lead.contact} {lead.email ? `· ${lead.email}` : ""}
            </p>
            <p className="mt-1 text-[13px] text-stone-600">{lead.purpose}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-stone-500 hover:text-stone-900 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 px-6 py-5">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.2em] text-stone-600">
              Next follow (date &amp; time, IST)
            </span>
            <input
              type="datetime-local"
              value={dateTime}
              onChange={(e) => setDateTime(e.target.value)}
              className="mt-1.5 w-full border border-stone-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-[#cc785c]"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.2em] text-stone-600">
              Status
            </span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="mt-1.5 w-full border border-stone-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-[#cc785c]"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.2em] text-stone-600">
              Counsellor
            </span>
            <select
              value={counsellorId}
              onChange={(e) => setCounsellorId(e.target.value)}
              className="mt-1.5 w-full border border-stone-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-[#cc785c]"
            >
              <option value="">Unassigned</option>
              {counsellors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.2em] text-stone-600">
              Details / notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={6}
              placeholder="What was discussed, next steps, anything to remember…"
              className="mt-1.5 w-full resize-y border border-stone-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-[#cc785c]"
            />
          </label>

          {err && (
            <div className="border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-800">
              {err}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-stone-300 px-6 py-4">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-[12px] uppercase tracking-[0.2em] text-stone-600 hover:text-stone-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-[12px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </button>
        </footer>
      </aside>
    </div>
  );
}
