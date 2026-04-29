import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  MessageCircle,
  Mail,
  Plus,
  RotateCcw,
  Loader2,
  UserPlus,
} from "lucide-react";
import { api } from "./api.js";
import { COUNTRIES, flagEmoji } from "./countries.js";
import {
  formatInIst,
  formatDateInIst,
  hoursUntil,
  localInputToUtcIso,
} from "../lib/time.js";

// Local aliases preserve the call sites; the helpers always render in IST so
// the dashboard, email, and WhatsApp body all show the same wall-clock time.
const fmtDateTime = formatInIst;
const fmtDate = formatDateInIst;

// ============================================================
// Main
// ============================================================
export default function LeadFollowup() {
  const [leads, setLeads] = useState([]);
  const [counsellors, setCounsellors] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [showNewLead, setShowNewLead] = useState(false);
  const [showNewCounsellor, setShowNewCounsellor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const genRef = useRef(0);

  const fetchAll = useCallback(async () => {
    genRef.current += 1;
    const myGen = genRef.current;
    try {
      const [l, c] = await Promise.all([api.listLeads(), api.listCounsellors()]);
      if (myGen === genRef.current) {
        setLeads(l);
        setCounsellors(c);
        setError(null);
      }
    } catch (e) {
      if (myGen === genRef.current) {
        setError(e.message);
      }
    } finally {
      if (myGen === genRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // After mutations that fire async notifications, refetch a couple of times
  // to capture the activity log entries as they're written server-side.
  // After mutations that fire async notifications, refetch a few times.
  // Twilio's WhatsApp delivery is polled server-side for ~25s, so spread the
  // refetches out to capture the final delivered/failed state.
  const refetchSoon = useCallback(() => {
    setTimeout(fetchAll, 2000);
    setTimeout(fetchAll, 8000);
    setTimeout(fetchAll, 18000);
    setTimeout(fetchAll, 30000);
  }, [fetchAll]);

  const resetData = async () => {
    if (!window.confirm("Reset to seed leads? This will discard all changes on the server.")) return;
    setBusy(true);
    try {
      await api.resetLeads();
      await fetchAll();
      setExpanded(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Sort: soonest upcoming event first; past events drop to the bottom
  // (keeping past events sorted most-recent-first so they're not totally lost).
  const now = Date.now();
  const sorted = [...leads].sort((a, b) => {
    const at = a.service_date ? new Date(a.service_date).getTime() : Infinity;
    const bt = b.service_date ? new Date(b.service_date).getTime() : Infinity;
    const aFuture = at >= now;
    const bFuture = bt >= now;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return aFuture ? at - bt : bt - at;
  });

  const stats = {
    total: leads.length,
    unassigned: leads.filter((l) => !l.counsellor_id).length,
    upcoming48: leads.filter(
      (l) =>
        l.counsellor_id &&
        hoursUntil(l.service_date) <= 48 &&
        hoursUntil(l.service_date) >= 0
    ).length,
    imminent12: leads.filter(
      (l) =>
        l.counsellor_id &&
        hoursUntil(l.service_date) <= 12 &&
        hoursUntil(l.service_date) >= 0
    ).length,
  };

  const assignLead = async (leadId, counsellorId) => {
    setBusy(true);
    try {
      const updated = await api.updateLead(leadId, { counsellor_id: counsellorId });
      setLeads((prev) => prev.map((l) => (l.id === leadId ? updated : l)));
      refetchSoon();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updateLead = async (leadId, patch) => {
    setBusy(true);
    try {
      const updated = await api.updateLead(leadId, patch);
      setLeads((prev) => prev.map((l) => (l.id === leadId ? updated : l)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addLead = async (data) => {
    setBusy(true);
    try {
      const created = await api.createLead(data);
      setLeads((prev) => [created, ...prev]);
      setShowNewLead(false);
      refetchSoon();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addCounsellor = async (data) => {
    setBusy(true);
    try {
      const created = await api.createCounsellor(data);
      setCounsellors((prev) =>
        [...prev, created].sort((a, b) => a.name.localeCompare(b.name))
      );
      setShowNewCounsellor(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-stone-600" />
        <span className="ml-3 text-sm text-stone-600">Loading leads…</span>
      </div>
    );
  }

  return (
    <>
      {/* Page heading */}
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-4xl leading-tight">
          Lead followup
        </h1>
        <div className="flex items-center gap-3">
          <button
            onClick={resetData}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-[12px] uppercase tracking-[0.2em] text-stone-600 hover:text-stone-900 disabled:opacity-30"
            title="Wipe leads on the server and restore seed data"
          >
            <RotateCcw className="h-3 w-3" /> reset
          </button>
          <button
            onClick={() => setShowNewCounsellor(true)}
            disabled={busy}
            className="inline-flex items-center gap-2 border border-[#cc785c] px-4 py-2 text-xs uppercase tracking-[0.2em] text-[#cc785c] transition hover:bg-[#cc785c]/10 disabled:opacity-50"
          >
            <UserPlus className="h-3.5 w-3.5" /> New counsellor
          </button>
          <button
            onClick={async () => {
              try {
                const c = await api.listCounsellors();
                setCounsellors(c);
              } catch {
                // fall back to cached list
              }
              setShowNewLead(true);
            }}
            disabled={busy}
            className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> New lead
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-3 text-[12px] uppercase tracking-wider underline"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="mt-6 grid grid-cols-4 gap-4 border-y border-stone-300 py-5">
        <Stat n={stats.total} label="Total leads" />
        <Stat n={stats.unassigned} label="Unassigned" tone={stats.unassigned > 0 ? "amber" : ""} />
        <Stat n={stats.upcoming48} label="≤ 48hr" />
        <Stat n={stats.imminent12} label="≤ 12hr (reminder)" tone={stats.imminent12 > 0 ? "red" : ""} />
      </div>

      {showNewCounsellor && (
        <NewCounsellorForm
          onCancel={() => setShowNewCounsellor(false)}
          onSave={addCounsellor}
        />
      )}

      {showNewLead && (
        <NewLeadForm
          counsellors={counsellors}
          onCancel={() => setShowNewLead(false)}
          onSave={addLead}
        />
      )}

      {/* Lead list */}
      <div className="mt-6 border border-stone-300 bg-white">
        {sorted.map((lead, idx) => (
          <LeadRow
            key={lead.id}
            idx={idx}
            lead={lead}
            counsellors={counsellors}
            expanded={expanded === lead.id}
            onToggle={() => setExpanded(expanded === lead.id ? null : lead.id)}
            onAssign={(cid) => assignLead(lead.id, cid)}
            onUpdate={(patch) => updateLead(lead.id, patch)}
          />
        ))}
        {sorted.length === 0 && (
          <p className="py-12 text-center text-sm italic text-stone-600">
            No leads yet. Click "+ New lead" to add one.
          </p>
        )}
      </div>
    </>
  );
}

function Stat({ n, label, tone = "" }) {
  const color =
    tone === "amber"
      ? "text-amber-700"
      : tone === "red"
      ? "text-red-700"
      : "text-[#cc785c]";
  return (
    <div>
      <p className={`font-serif text-5xl font-bold leading-none ${color}`}>{n}</p>
      <p className="mt-2 text-[12px] uppercase tracking-[0.2em] text-stone-600">
        {label}
      </p>
    </div>
  );
}

function LeadRow({ idx, lead, counsellors, expanded, onToggle, onAssign, onUpdate }) {
  const counsellor = lead.counsellor_id
    ? counsellors.find((c) => c.id === lead.counsellor_id)
    : null;
  const hrs = hoursUntil(lead.service_date);
  const dateClass =
    hrs < 0
      ? "text-stone-400"
      : hrs <= 12
      ? "text-red-700 font-medium"
      : hrs <= 48
      ? "text-amber-700"
      : "text-stone-700";

  return (
    <div className="border-b border-stone-300 last:border-b-0">
      <div
        className="grid items-center gap-3 px-4 py-4 hover:bg-stone-50"
        style={{ gridTemplateColumns: "2rem 1.2fr 9rem 1.4fr 1fr 9rem 4.5rem" }}
      >
        <span className="font-serif text-sm italic text-stone-600">
          {String(idx + 1).padStart(2, "0")}
        </span>
        <button onClick={onToggle} className="min-w-0 text-left">
          <p className="truncate text-base font-semibold hover:underline">
            {lead.name}
          </p>
          <p className="truncate text-xs text-stone-600">{lead.email || "—"}</p>
        </button>
        {lead.contact ? (
          <a
            href={`tel:+${lead.contact}`}
            className="font-mono text-sm text-stone-700 hover:text-stone-900 hover:underline"
            title="Call"
          >
            +{lead.contact}
          </a>
        ) : (
          <span className="font-mono text-sm text-stone-700">—</span>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-stone-700">{lead.purpose}</p>
          <p className={`truncate text-xl font-semibold leading-tight ${dateClass}`}>
            {fmtDateTime(lead.service_date)}
          </p>
        </div>
        <div className="min-w-0">
          {counsellor ? (
            <select
              value={lead.counsellor_id}
              onChange={(e) => onAssign(e.target.value)}
              className="w-full border-b border-stone-200 bg-transparent py-1 text-sm outline-none focus:border-stone-600"
            >
              {counsellors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <select
              defaultValue=""
              onChange={(e) => onAssign(e.target.value)}
              className="w-full border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm outline-none focus:border-amber-500"
            >
              <option value="" disabled>
                ⚠ Assign…
              </option>
              {counsellors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <span
          className={`inline-flex items-center justify-center border px-2 py-1 text-[13px] uppercase tracking-[0.15em] ${
            lead.status === "scheduled"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : lead.status === "completed"
              ? "border-stone-200 bg-stone-50 text-stone-600"
              : lead.status === "no_show"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {lead.status}
        </span>
        <button
          onClick={onToggle}
          className="inline-flex items-center justify-end gap-1 text-xs uppercase tracking-[0.15em] text-stone-600 hover:text-stone-900"
        >
          {expanded ? "Hide" : "Open"}
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {expanded && (
        <LeadDetail
          lead={lead}
          counsellor={counsellor}
          onUpdate={onUpdate}
        />
      )}
    </div>
  );
}

function LeadDetail({ lead, counsellor, onUpdate }) {
  const hrs = hoursUntil(lead.service_date);

  // For each (channel, recipient, kind) tuple there's at most one row
  // (Twilio webhook updates the same row over its lifecycle).
  const findStatus = (channel, recipient, kind) =>
    (lead.activity || []).find(
      (a) =>
        (a.type === "notification_sent" ||
          a.type === "notification_error" ||
          a.type === "notification_pending") &&
        a.channel === channel &&
        a.recipient === recipient &&
        a.kind === kind
    );

  return (
    <div className="border-t border-stone-300 bg-stone-100 p-5">
      <div className="grid gap-6 md:grid-cols-3">
        {/* Left: contact + purpose + notes */}
        <div className="md:col-span-1 space-y-4">
          <div className="border border-stone-200 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Contact
            </p>
            <p className="mt-1 text-sm font-medium">{lead.name}</p>
            <p className="text-xs text-stone-600">+{lead.contact}</p>
            <p className="text-xs text-stone-600">{lead.email || "—"}</p>
            <p className="mt-3 text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Inquiry date
            </p>
            <p className="text-xs text-stone-700">{fmtDate(lead.inquiry_date)}</p>
          </div>

          <div className="border border-stone-200 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Purpose
            </p>
            <p className="mt-1 text-sm font-medium">{lead.purpose}</p>
            <p className="mt-3 text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Scheduled for
            </p>
            <p className="text-xs text-stone-700">{fmtDateTime(lead.service_date)}</p>
            {hrs >= 0 && hrs <= 48 && (
              <p
                className={`mt-1 text-[12px] uppercase tracking-[0.15em] ${
                  hrs <= 12 ? "text-red-700" : "text-amber-700"
                }`}
              >
                {hrs <= 12 ? "🔴 reminder window" : `in ${hrs} hours`}
              </p>
            )}
          </div>

          {lead.notes && (
            <div className="border border-stone-200 bg-white p-4">
              <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
                Admin notes
              </p>
              <p className="mt-2 text-xs leading-snug text-stone-700">
                {lead.notes}
              </p>
            </div>
          )}
        </div>

        {/* Middle: notifications + status */}
        <div className="md:col-span-1 space-y-4">
          <div className="border border-stone-200 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Notifications
            </p>
            <p className="mt-1 text-[12px] italic text-stone-600">
              Auto-fired by the server. State below reflects what's been delivered.
            </p>

            <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.15em] text-stone-700">
              On assignment
            </p>
            {!counsellor ? (
              <p className="mt-2 text-xs italic text-stone-600">
                Assign a counsellor first to trigger.
              </p>
            ) : (
              <div className="mt-2 space-y-1.5">
                <NotifStatus
                  label="Lead · WhatsApp"
                  icon={<MessageCircle className="h-3 w-3" />}
                  entry={findStatus("whatsapp", "lead", "assignment")}
                />
                <NotifStatus
                  label="Lead · Email"
                  icon={<Mail className="h-3 w-3" />}
                  entry={findStatus("email", "lead", "assignment")}
                />
                <NotifStatus
                  label="Counsellor · WhatsApp"
                  icon={<MessageCircle className="h-3 w-3" />}
                  entry={findStatus("whatsapp", "counsellor", "assignment")}
                />
                <NotifStatus
                  label="Counsellor · Email"
                  icon={<Mail className="h-3 w-3" />}
                  entry={findStatus("email", "counsellor", "assignment")}
                />
              </div>
            )}

            <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.15em] text-stone-700">
              12 hours before service
            </p>
            {!counsellor ? (
              <p className="mt-2 text-xs italic text-stone-600">
                Available once assigned + scheduled.
              </p>
            ) : hrs > 12 ? (
              <p className="mt-2 text-xs italic text-stone-600">
                Will fire automatically when service is ≤12 hours away (currently{" "}
                {hrs}h).
              </p>
            ) : hrs < 0 ? (
              <p className="mt-2 text-xs italic text-stone-600">
                Service has passed.
              </p>
            ) : (
              <div className="mt-2 space-y-1.5">
                <NotifStatus
                  label="Lead · WhatsApp"
                  icon={<MessageCircle className="h-3 w-3" />}
                  entry={findStatus("whatsapp", "lead", "reminder")}
                />
                <NotifStatus
                  label="Lead · Email"
                  icon={<Mail className="h-3 w-3" />}
                  entry={findStatus("email", "lead", "reminder")}
                />
                <NotifStatus
                  label="Counsellor · WhatsApp"
                  icon={<MessageCircle className="h-3 w-3" />}
                  entry={findStatus("whatsapp", "counsellor", "reminder")}
                />
                <NotifStatus
                  label="Counsellor · Email"
                  icon={<Mail className="h-3 w-3" />}
                  entry={findStatus("email", "counsellor", "reminder")}
                />
              </div>
            )}
          </div>

          <div className="border border-stone-200 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Status
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => onUpdate({ status: "completed" })}
                disabled={lead.status === "completed"}
                className="border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[12px] uppercase tracking-[0.15em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
              >
                ✓ Mark completed
              </button>
              <button
                onClick={() => onUpdate({ status: "no_show" })}
                disabled={lead.status === "no_show"}
                className="border border-stone-300 bg-white px-3 py-1.5 text-[12px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-500 disabled:cursor-not-allowed disabled:opacity-30"
              >
                ✕ No-show
              </button>
            </div>
            <p className="mt-3 text-[12px] italic text-stone-600">
              Completed leads can later be converted into student records.
            </p>
          </div>
        </div>

        {/* Right: split log — Technical (notifications) + Staff workflow */}
        <div className="md:col-span-1 space-y-4">
          <TechnicalLog activity={lead.activity || []} />
          <StaffWorkflowLog lead={lead} />
        </div>
      </div>
    </div>
  );
}

function TechnicalLog({ activity }) {
  const technical = activity.filter(
    (a) =>
      a.type === "notification_sent" ||
      a.type === "notification_error" ||
      a.type === "notification_pending"
  );
  return (
    <div className="border border-stone-300 bg-white p-4">
      <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
        Technical · notifications
      </p>
      {technical.length === 0 ? (
        <p className="mt-2 text-xs italic text-stone-500">
          No notifications fired yet.
        </p>
      ) : (
        <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
          {technical.slice().reverse().map((a) => (
            <li key={a.id} className="flex gap-2 text-xs">
              <span
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                  a.type === "notification_sent"
                    ? "bg-emerald-500"
                    : a.type === "notification_error"
                    ? "bg-red-500"
                    : "bg-amber-400"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="leading-snug text-stone-700">{a.text}</p>
                <p className="mt-0.5 text-[11px] uppercase tracking-[0.1em] text-stone-500">
                  {fmtDateTime(a.ts)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StaffWorkflowLog({ lead }) {
  const activity = lead.activity || [];
  const assigned = activity.filter((a) => a.type === "assignment").slice(-1)[0];
  const viewed = activity.filter((a) => a.type === "viewed").slice(-1)[0];
  const calls = activity.filter((a) => a.type === "call_logged");
  const transcriptUpdates = activity.filter((a) => a.type === "transcript_attached");
  const actionables = lead.actionables || [];
  const done = actionables.filter((a) => a.completed).length;

  return (
    <div className="border border-stone-300 bg-white p-4">
      <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
        Staff workflow
      </p>

      <dl className="mt-3 space-y-2.5 text-xs">
        <Row label="Assigned" value={assigned ? `${fmtDateTime(assigned.ts)} — ${assigned.text}` : "—"} />
        <Row label="Viewed" value={viewed ? fmtDateTime(viewed.ts) : <em className="text-stone-500">not yet</em>} />
        <Row
          label={`Calls (${calls.length})`}
          value={
            calls.length === 0 ? (
              <em className="text-stone-500">none logged</em>
            ) : (
              <ul className="space-y-1">
                {calls.slice().reverse().slice(0, 3).map((c) => (
                  <li key={c.id} className="leading-snug text-stone-700">
                    <span className="text-[11px] uppercase tracking-[0.1em] text-stone-500">
                      {fmtDateTime(c.ts)}
                    </span>
                    <br />
                    {c.text}
                  </li>
                ))}
              </ul>
            )
          }
        />
        <Row
          label="Transcript"
          value={
            lead.transcript ? (
              <details className="text-stone-700">
                <summary className="cursor-pointer text-[#cc785c] hover:text-[#b86a4f]">
                  {lead.transcript.length} chars
                  {transcriptUpdates.length > 0
                    ? ` · last updated ${fmtDateTime(transcriptUpdates.slice(-1)[0].ts)}`
                    : ""}{" "}
                  — show
                </summary>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-[11px] leading-relaxed">
                  {lead.transcript}
                </p>
              </details>
            ) : (
              <em className="text-stone-500">not yet</em>
            )
          }
        />
        <Row
          label={`Actionables (${done}/${actionables.length})`}
          value={
            actionables.length === 0 ? (
              <em className="text-stone-500">none yet</em>
            ) : (
              <ul className="space-y-1">
                {actionables.map((a) => (
                  <li
                    key={a.id}
                    className={`flex items-start gap-1.5 ${
                      a.completed ? "text-stone-500 line-through" : "text-stone-800"
                    }`}
                  >
                    <span aria-hidden="true">{a.completed ? "✓" : "○"}</span>
                    <span className="flex-1 leading-snug">{a.text}</span>
                  </li>
                ))}
              </ul>
            )
          }
        />
      </dl>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.15em] text-stone-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-stone-700">{value}</dd>
    </div>
  );
}

function NotifStatus({ label, icon, entry }) {
  let cls = "border-stone-200 bg-white text-stone-600";
  let suffix = "not yet";
  if (entry) {
    if (entry.type === "notification_sent") {
      cls = "border-emerald-200 bg-emerald-50 text-emerald-700";
      suffix = `✓ ${fmtDateTime(entry.ts)}`;
    } else if (entry.type === "notification_error") {
      cls = "border-red-200 bg-red-50 text-red-700";
      suffix = `✕ failed`;
    } else if (entry.type === "notification_pending") {
      cls = "border-amber-200 bg-amber-50 text-amber-700";
      suffix = "sending…";
    }
  }
  return (
    <div className={`flex items-center justify-between gap-2 border px-2.5 py-1.5 text-[13px] ${cls}`}>
      <span className="flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="text-[13px] uppercase tracking-[0.15em]" title={entry?.text}>
        {suffix}
      </span>
    </div>
  );
}

function NewLeadForm({ counsellors, onCancel, onSave }) {
  const [name, setName] = useState("");
  const [countryIso, setCountryIso] = useState("IN");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [purpose, setPurpose] = useState("");
  const [serviceDate, setServiceDate] = useState("");
  const [counsellorId, setCounsellorId] = useState("");
  const [notes, setNotes] = useState("");

  const country =
    COUNTRIES.find((c) => c.iso === countryIso) ||
    COUNTRIES.find((c) => c.iso === "IN");
  const canSave = name && phone && email && purpose && serviceDate;
  const counsellor = counsellorId
    ? counsellors.find((c) => c.id === counsellorId)
    : null;

  const fillTestData = () => {
    // datetime-local needs YYYY-MM-DDTHH:mm in *local* time.
    // 12h + 1min lands the lead just outside the reminder window — the next
    // cron tick (≤5min) will pull it in and fire the live WA/email reminder.
    const t = new Date(Date.now() + (12 * 60 + 1) * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const iso = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
    setName("Jace (test lead)");
    setCountryIso("IN");
    setPhone("7973744625");
    setEmail("jace100233260@gmail.com");
    setPurpose("Test consult");
    setServiceDate(iso);
    setCounsellorId("ctest");
    setNotes("Auto-filled by 'Fill test data'. Both lead and counsellor route to Jace's phone + email.");
  };

  const submit = () =>
    onSave({
      name,
      contact: `${country.dial}${phone}`,
      email,
      purpose,
      service_date: localInputToUtcIso(serviceDate),
      counsellor_id: counsellorId || null,
      notes,
    });

  return (
    <div className="mt-6 border border-stone-300 bg-white">
      <div className="flex items-center justify-between border-b border-stone-300 px-6 py-4">
        <p className="font-serif text-2xl">Add a lead</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={fillTestData}
            className="inline-flex items-center gap-2 border-2 border-[#cc785c] bg-[#cc785c]/10 px-5 py-2.5 text-sm font-semibold uppercase tracking-[0.15em] text-[#cc785c] transition hover:bg-[#cc785c]/20"
            title="Pre-fill the form with Jace's test contact info + Jace counsellor"
          >
            ⚡ Fill test data
          </button>
          <button
            onClick={onCancel}
            className="text-xs uppercase tracking-[0.15em] text-stone-600 hover:text-stone-900"
          >
            ✕ Cancel
          </button>
        </div>
      </div>

      <div className="grid gap-6 px-6 py-5 md:grid-cols-3">
        <div className="space-y-4">
          <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
            ① Person
          </p>
          <FormField label="Name *">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="w-full border-b border-stone-300 bg-transparent py-2 text-base outline-none focus:border-stone-600"
            />
          </FormField>
          <FormField label="WhatsApp number *" hint="Pick the country, then enter the local number">
            <div className="flex items-center gap-2">
              <CountryCodeSelect value={countryIso} onChange={setCountryIso} />
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                placeholder="9876543210"
                className="min-w-0 flex-1 border-b border-stone-300 bg-transparent py-2 font-mono text-base outline-none focus:border-stone-600"
              />
            </div>
          </FormField>
          <FormField label="Email *" hint="Welcome + reminder emails go here">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full border-b border-stone-300 bg-transparent py-2 text-base outline-none focus:border-stone-600"
            />
          </FormField>
        </div>

        <div className="space-y-4">
          <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
            ② Service
          </p>
          <FormField label="Purpose *" hint="Free-fill — what they're coming in for">
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="STK aptitude test · SOP review · …"
              className="w-full border-b border-stone-300 bg-transparent py-2 text-base outline-none focus:border-stone-600"
            />
          </FormField>
          <FormField label="Date & time *">
            <input
              type="datetime-local"
              value={serviceDate}
              onChange={(e) => setServiceDate(e.target.value)}
              className="w-full border-b border-stone-300 bg-transparent py-2 text-base outline-none focus:border-stone-600"
            />
          </FormField>
          <FormField label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What did they say on the call? Any context for the counsellor…"
              className="w-full resize-none border border-stone-300 bg-stone-50 p-2 text-sm outline-none focus:border-stone-600"
            />
          </FormField>
        </div>

        <div className="space-y-4">
          <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
            ③ Routing
          </p>
          <FormField label="Counsellor" hint="Pick now, or assign later from the row">
            <select
              value={counsellorId}
              onChange={(e) => setCounsellorId(e.target.value)}
              className="w-full border-b border-stone-300 bg-transparent py-2 text-base outline-none focus:border-stone-600"
            >
              <option value="">— Leave unassigned —</option>
              {counsellors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormField>

          <div className="border border-stone-200 bg-stone-50 p-3">
            <p className="text-[12px] uppercase tracking-[0.2em] text-stone-600">
              On save, the server will send
            </p>
            <ul className="mt-2 space-y-1.5 text-xs">
              <NotifPreview
                label="Lead · WhatsApp + email"
                ready={!!counsellor}
                hint={counsellor ? "fires now" : "needs counsellor"}
              />
              <NotifPreview
                label="Counsellor · WhatsApp + email"
                ready={!!counsellor}
                hint={counsellor ? `to ${counsellor.name}` : "needs counsellor"}
              />
              <NotifPreview
                label="12-hr reminder (lead + counsellor)"
                ready={!!counsellor && !!serviceDate}
                hint="auto, 12hrs before"
              />
            </ul>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end border-t border-stone-300 bg-stone-100 px-6 py-4">
        <button
          onClick={submit}
          disabled={!canSave}
          title={canSave ? "" : "Fill name, phone, email, purpose, and date to save"}
          className="border border-[#cc785c] bg-[#cc785c] px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
        >
          Save lead →
        </button>
      </div>
    </div>
  );
}

function FormField({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-[12px] uppercase tracking-[0.15em] text-stone-600">
        {label}
      </span>
      {children}
      {hint && (
        <p className="mt-1 text-[12px] italic text-stone-600">{hint}</p>
      )}
    </label>
  );
}

function NewCounsellorForm({ onCancel, onSave }) {
  const [name, setName] = useState("");
  const [countryIso, setCountryIso] = useState("IN");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const country =
    COUNTRIES.find((c) => c.iso === countryIso) ||
    COUNTRIES.find((c) => c.iso === "IN");
  const hasContact = !!phone || !!email;
  const canSave = name.trim().length > 0 && hasContact;

  const submit = () =>
    onSave({
      name,
      whatsapp: phone ? `${country.dial}${phone}` : null,
      email: email || null,
    });

  return (
    <div className="mt-6 border border-stone-300 bg-white">
      <div className="flex items-center justify-between border-b border-stone-300 px-6 py-4">
        <p className="font-serif text-2xl">Add a counsellor</p>
        <button
          onClick={onCancel}
          className="text-xs uppercase tracking-[0.15em] text-stone-600 hover:text-stone-900"
        >
          ✕ Cancel
        </button>
      </div>

      <div className="grid gap-5 px-6 py-5 md:max-w-xl">
        <FormField label="Name *">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full border-b border-stone-300 bg-transparent py-2 text-base outline-none focus:border-stone-600"
          />
        </FormField>
        <FormField label="WhatsApp number" hint="Used for assignment + 12-hr reminder messages">
          <div className="flex items-center gap-2">
            <CountryCodeSelect value={countryIso} onChange={setCountryIso} />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              placeholder="9876543210"
              className="min-w-0 flex-1 border-b border-stone-300 bg-transparent py-2 font-mono text-base outline-none focus:border-stone-600"
            />
          </div>
        </FormField>
        <FormField label="Email" hint="At least one of WhatsApp or email is required">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="counsellor@example.com"
            className="w-full border-b border-stone-300 bg-transparent py-2 text-base outline-none focus:border-stone-600"
          />
        </FormField>
      </div>

      <div className="flex items-center justify-end border-t border-stone-300 bg-stone-100 px-6 py-4">
        <button
          onClick={submit}
          disabled={!canSave}
          title={canSave ? "" : "Enter a name and at least one of WhatsApp or email"}
          className="border border-[#cc785c] bg-[#cc785c] px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
        >
          Save counsellor →
        </button>
      </div>
    </div>
  );
}

function CountryCodeSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const activeBtnRef = useRef(null);

  const selected =
    COUNTRIES.find((c) => c.iso === value) ||
    COUNTRIES.find((c) => c.iso === "IN");

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Reset highlighted index when query changes or dropdown opens
  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? COUNTRIES.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.dial.includes(q) ||
          c.iso.toLowerCase().includes(q)
      )
    : COUNTRIES;

  // Keep the active button visible as the user navigates with arrow keys
  useEffect(() => {
    if (open && activeBtnRef.current) {
      activeBtnRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [activeIdx, open]);

  const onSearchKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[activeIdx]) {
        onChange(filtered[activeIdx].iso);
        setOpen(false);
        setQuery("");
      }
    }
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 border-b border-stone-300 py-2 pr-1 text-base outline-none hover:border-stone-500 focus:border-stone-600"
        title={selected.name}
      >
        <span aria-hidden="true">{flagEmoji(selected.iso)}</span>
        <span className="font-mono">+{selected.dial}</span>
        <ChevronDown className="h-3.5 w-3.5 text-stone-500" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 border border-stone-300 bg-white shadow-lg">
          <div className="border-b border-stone-200 p-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search country, code, or ISO…"
              className="w-full border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm outline-none focus:border-stone-500"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs italic text-stone-600">
                No matches.
              </li>
            ) : (
              filtered.map((c, idx) => (
                <li key={c.iso}>
                  <button
                    type="button"
                    ref={idx === activeIdx ? activeBtnRef : null}
                    onClick={() => {
                      onChange(c.iso);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-stone-100 ${
                      idx === activeIdx ? "bg-stone-100" : ""
                    } ${c.iso === value ? "bg-stone-50 font-medium" : ""}`}
                  >
                    <span aria-hidden="true">{flagEmoji(c.iso)}</span>
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="font-mono text-xs text-stone-600">
                      +{c.dial}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function NotifPreview({ label, ready, hint }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            ready ? "bg-emerald-500" : "bg-stone-300"
          }`}
        />
        <span className={ready ? "text-stone-800" : "text-stone-600"}>{label}</span>
      </span>
      <span
        className={`text-[12px] uppercase tracking-[0.1em] ${
          ready ? "text-emerald-700" : "text-stone-600"
        }`}
      >
        {hint}
      </span>
    </li>
  );
}
