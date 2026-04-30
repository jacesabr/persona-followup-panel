import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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

// When a lead has no service_date, we still need a time-of-day to combine with
// the picked calendar date. 10:00 IST is a reasonable default for a follow-up.
const DEFAULT_TIME_IST = "10:00";

export default function SimpleFollowup() {
  const [leads, setLeads] = useState([]);
  const [counsellors, setCounsellors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);

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

  // Save a new "next follow" date for a lead. We preserve the existing
  // time-of-day so changing the date doesn't silently shift the appointment
  // time; if there's no existing service_date we fall back to 10:00 IST.
  const onPickNextFollow = async (lead, ymd) => {
    if (!ymd) return;
    const existing = utcIsoToIstInput(lead.service_date); // "YYYY-MM-DDTHH:mm" or ""
    const timePart = existing ? existing.slice(11) : DEFAULT_TIME_IST;
    const iso = localInputToUtcIso(`${ymd}T${timePart}`);
    if (!iso) return;
    setSavingId(lead.id);
    setError(null);
    try {
      const updated = await api.updateLead(lead.id, { service_date: iso });
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? updated : l)));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (error && leads.length === 0) {
    return (
      <div className="border border-red-300 bg-red-50 p-6 text-sm text-red-800">
        {error}
      </div>
    );
  }

  const gridCols = "9rem 1.2fr 9rem 1.4fr 1.2fr 8rem 9.5rem 1fr";

  return (
    <>
      <div className="mb-6 flex items-baseline justify-between border-b border-stone-300 pb-3">
        <h2 className="text-xl font-semibold tracking-tight">Lead sheet</h2>
        <span className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          {leads.length} {leads.length === 1 ? "row" : "rows"}
        </span>
      </div>

      {error && (
        <div className="mb-4 border border-red-300 bg-red-50 px-4 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.18em] text-stone-800"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span>Date of query</span>
          <span>Name</span>
          <span>Ph</span>
          <span>Email</span>
          <span>Purpose</span>
          <span>Status</span>
          <span>Next follow</span>
          <span>Counsellor</span>
        </div>

        {leads.map((lead) => {
          const istInput = utcIsoToIstInput(lead.service_date);
          const dateValue = istInput ? istInput.slice(0, 10) : "";
          const isSaving = savingId === lead.id;
          return (
            <div
              key={lead.id}
              className="grid items-center gap-3 border-b border-stone-200 px-4 py-3 text-[13px] text-stone-800 last:border-b-0 hover:bg-stone-50"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span className="text-stone-600">
                {lead.inquiry_date ? formatDateInIst(lead.inquiry_date) : "—"}
              </span>
              <span className="font-medium">{lead.name || "—"}</span>
              <span className="tabular-nums text-stone-700">
                {lead.contact || "—"}
              </span>
              <span className="truncate text-stone-700" title={lead.email || ""}>
                {lead.email || "—"}
              </span>
              <span className="truncate text-stone-700" title={lead.purpose || ""}>
                {lead.purpose || "—"}
              </span>
              <span className="text-[11px] uppercase tracking-[0.15em] text-stone-700">
                {STATUS_LABEL[lead.status] || lead.status || "—"}
              </span>
              <span className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={dateValue}
                  disabled={isSaving}
                  onChange={(e) => onPickNextFollow(lead, e.target.value)}
                  className="w-full cursor-pointer border border-stone-300 bg-white px-2 py-1 text-[12px] text-stone-800 outline-none hover:border-stone-500 focus:border-[#cc785c] disabled:opacity-50"
                />
                {isSaving && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-stone-500" />
                )}
              </span>
              <span className="text-stone-700">
                {counsellorNameById.get(lead.counsellor_id) || "—"}
              </span>
            </div>
          );
        })}

        {leads.length === 0 && (
          <p className="py-12 text-center text-sm italic text-stone-600">
            No leads yet.
          </p>
        )}
      </div>
    </>
  );
}
