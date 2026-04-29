import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  MessageCircle,
  Mail,
  Loader2,
  Phone,
  Mic,
  CheckSquare,
  Square,
  Trash2,
  Plus,
} from "lucide-react";
import { api } from "./api.js";
import {
  formatInIst,
  formatDateInIst,
  hoursUntil,
  localInputToUtcIso,
} from "../lib/time.js";

// Returns the reminder-delivery status for a given lead, derived from
// the activity log. See LeadFollowup.jsx for the full doc.
function reminderStatusFor(lead) {
  const reminders = (lead.activity || []).filter(
    (a) => a.kind === "reminder" && a.recipient === "lead"
  );
  if (reminders.length === 0) return "not_yet";
  if (reminders.some((a) => a.type === "notification_sent")) return "sent";
  if (reminders.some((a) => a.type === "notification_pending")) return "pending";
  return "failed";
}

function buildReminderSublabel(b, total) {
  if (total === 0) return "Appointments";
  const parts = [];
  if (b.sent > 0) parts.push(`${b.sent} sent`);
  if (b.pending > 0) parts.push(`${b.pending} pending`);
  if (b.failed > 0) parts.push(`${b.failed} failed ⚠`);
  if (b.not_yet > 0) parts.push(`${b.not_yet} not yet`);
  return parts.join(" · ");
}

function reminderTone(b, total) {
  if (total === 0) return "";
  if (b.failed > 0) return "red";
  if (b.pending > 0 || b.not_yet > 0) return "amber";
  return "";
}

// ============================================================
// StaffDashboard — filtered, write-restricted view of leads.
//
// Props:
//   counsellorId   — the counsellor whose pipeline we're viewing
//   counsellors    — full counsellor roster (for name lookup)
//   isImpersonation — true when admin is viewing-as; tweaks header copy
// ============================================================
export default function StaffDashboard({
  counsellorId,
  counsellors = [],
  isImpersonation = false,
}) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const viewedRef = useRef(new Set()); // dedupe view-pings per session
  const genRef = useRef(0); // gate stale fetches, mirrors LeadFollowup

  const counsellor = counsellors.find((c) => c.id === counsellorId);

  const fetchAll = useCallback(async () => {
    genRef.current += 1;
    const myGen = genRef.current;
    try {
      const all = await api.listLeads();
      if (myGen === genRef.current) {
        setLeads(all);
        setError(null);
      }
    } catch (e) {
      if (myGen === genRef.current) setError(e.message);
    } finally {
      if (myGen === genRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const myLeads = leads.filter((l) => l.counsellor_id === counsellorId);

  const now = Date.now();
  const sorted = [...myLeads].sort((a, b) => {
    const at = a.service_date ? new Date(a.service_date).getTime() : Infinity;
    const bt = b.service_date ? new Date(b.service_date).getTime() : Infinity;
    const aFuture = at >= now;
    const bFuture = bt >= now;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return aFuture ? at - bt : bt - at;
  });

  // Mutually exclusive buckets: a lead 6h away counts only in imminent12.
  const myLeadHours = myLeads.map((l) => ({ lead: l, hrs: hoursUntil(l.service_date) }));
  const upcoming48Leads = myLeadHours.filter(
    ({ hrs }) => hrs > 12 && hrs <= 48
  );
  const imminent12Leads = myLeadHours.filter(
    ({ hrs }) => hrs >= 0 && hrs <= 12
  );

  // Verify the lead actually received the reminder for each ≤12hr lead —
  // fail visibly (red flag) if any channels errored.
  const reminderBreakdown = { sent: 0, pending: 0, failed: 0, not_yet: 0 };
  for (const { lead } of imminent12Leads) {
    reminderBreakdown[reminderStatusFor(lead)]++;
  }

  const stats = {
    myLeads: myLeads.length,
    upcoming48: upcoming48Leads.length,
    imminent12: imminent12Leads.length,
    reminderBreakdown,
  };

  const onToggleExpand = async (lead) => {
    if (expanded === lead.id) {
      setExpanded(null);
      return;
    }
    setExpanded(lead.id);
    // Fire the view ping once per lead per session.
    if (counsellorId && !viewedRef.current.has(lead.id)) {
      viewedRef.current.add(lead.id);
      try {
        await api.markViewed(lead.id, counsellorId);
        // Refresh so the activity log surfaces the viewed event.
        fetchAll();
      } catch {
        // Non-blocking: viewing was already logged or network hiccup
      }
    }
  };

  const updateStatus = async (leadId, status) => {
    setBusy(true);
    try {
      await api.updateLead(leadId, { status });
      await fetchAll();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onWorkflowChange = () => fetchAll();

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-stone-600" />
        <span className="ml-3 text-sm text-stone-600">Loading your leads…</span>
      </div>
    );
  }

  return (
    <>
      {/* Heading */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
            Counsellor
          </p>
          <h1 className="mt-1 font-serif text-4xl leading-tight">
            {counsellor ? counsellor.name : "—"}
          </h1>
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
      <div className="mt-6 grid grid-cols-3 gap-4 border-y border-stone-300 py-5">
        <Stat n={stats.myLeads} label="My leads" />
        <Stat
          n={stats.upcoming48}
          label="12 – 48 hr"
          sublabel="Appointments"
        />
        <Stat
          n={stats.imminent12}
          label="≤ 12 hr (reminder)"
          sublabel={buildReminderSublabel(stats.reminderBreakdown, stats.imminent12)}
          tone={reminderTone(stats.reminderBreakdown, stats.imminent12)}
        />
      </div>

      {/* Lead list */}
      <div className="mt-6 border border-stone-300 bg-white">
        {sorted.length === 0 ? (
          <p className="py-12 text-center text-sm italic text-stone-600">
            No leads assigned to {counsellor?.name || "this counsellor"} yet.
          </p>
        ) : (
          sorted.map((lead, idx) => (
            <StaffLeadRow
              key={lead.id}
              idx={idx}
              lead={lead}
              counsellor={counsellor}
              counsellorId={counsellorId}
              expanded={expanded === lead.id}
              onToggle={() => onToggleExpand(lead)}
              onUpdateStatus={updateStatus}
              onWorkflowChange={onWorkflowChange}
              busy={busy}
            />
          ))
        )}
      </div>
    </>
  );
}

function Stat({ n, label, sublabel, tone = "" }) {
  const color = tone === "red" ? "text-red-700" : "text-[#cc785c]";
  return (
    <div>
      <p className={`font-serif text-5xl font-bold leading-none ${color}`}>{n}</p>
      {sublabel && (
        <p className="mt-1 text-[11px] italic text-stone-500">{sublabel}</p>
      )}
      <p className="mt-2 text-[12px] uppercase tracking-[0.2em] text-stone-600">
        {label}
      </p>
    </div>
  );
}

function StaffLeadRow({
  idx,
  lead,
  counsellor,
  counsellorId,
  expanded,
  onToggle,
  onUpdateStatus,
  onWorkflowChange,
  busy,
}) {
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
        style={{ gridTemplateColumns: "2rem 1.4fr 9rem 1.6fr 9rem 4.5rem" }}
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
            {formatInIst(lead.service_date)}
          </p>
        </div>
        <span
          className={`inline-flex items-center justify-center border px-2 py-1 text-[13px] uppercase tracking-[0.15em] ${
            lead.status === "scheduled"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : lead.status === "completed"
              ? "border-stone-300 bg-stone-50 text-stone-600"
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
        <StaffLeadDetail
          lead={lead}
          counsellor={counsellor}
          counsellorId={counsellorId}
          onUpdateStatus={onUpdateStatus}
          onWorkflowChange={onWorkflowChange}
          busy={busy}
        />
      )}
    </div>
  );
}

function StaffLeadDetail({
  lead,
  counsellor,
  counsellorId,
  onUpdateStatus,
  onWorkflowChange,
  busy,
}) {
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
        {/* Left: contact + purpose */}
        <div className="md:col-span-1 space-y-4">
          <div className="border border-stone-300 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Contact
            </p>
            <p className="mt-1 text-sm font-medium">{lead.name}</p>
            <p className="text-xs text-stone-600">+{lead.contact}</p>
            <p className="text-xs text-stone-600">{lead.email || "—"}</p>
            <p className="mt-3 text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Inquiry date
            </p>
            <p className="text-xs text-stone-700">{formatDateInIst(lead.inquiry_date)}</p>
          </div>

          <div className="border border-stone-300 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Purpose
            </p>
            <p className="mt-1 text-sm font-medium">{lead.purpose}</p>
            <p className="mt-3 text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Scheduled for
            </p>
            <p className="text-xs text-stone-700">{formatInIst(lead.service_date)}</p>
          </div>

          <div className="border border-stone-300 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Outcome
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => onUpdateStatus(lead.id, "completed")}
                disabled={busy || lead.status === "completed"}
                className="border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[12px] uppercase tracking-[0.15em] text-white hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
              >
                ✓ Completed
              </button>
              <button
                onClick={() => onUpdateStatus(lead.id, "no_show")}
                disabled={busy || lead.status === "no_show"}
                className="border border-stone-400 bg-white px-3 py-1.5 text-[12px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-600 disabled:cursor-not-allowed disabled:opacity-30"
              >
                ✕ No-show
              </button>
            </div>
          </div>
        </div>

        {/* Middle: notification status (compact) */}
        <div className="md:col-span-1 space-y-4">
          <div className="border border-stone-300 bg-white p-4">
            <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
              Notifications (auto-fired)
            </p>

            <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-500">
              To student
            </p>
            <div className="mt-1.5 space-y-1.5">
              <NotifPill
                label="Welcome WA"
                icon={<MessageCircle className="h-3.5 w-3.5" />}
                entry={findStatus("whatsapp", "lead", "assignment")}
              />
              <NotifPill
                label="Welcome email"
                icon={<Mail className="h-3.5 w-3.5" />}
                entry={findStatus("email", "lead", "assignment")}
              />
              <NotifPill
                label="12hr reminder WA"
                icon={<MessageCircle className="h-3.5 w-3.5" />}
                entry={findStatus("whatsapp", "lead", "reminder")}
              />
              <NotifPill
                label="12hr reminder email"
                icon={<Mail className="h-3.5 w-3.5" />}
                entry={findStatus("email", "lead", "reminder")}
              />
            </div>

            <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-500">
              To counsellor (you)
            </p>
            <div className="mt-1.5 space-y-1.5">
              <NotifPill
                label="Welcome WA"
                icon={<MessageCircle className="h-3.5 w-3.5" />}
                entry={findStatus("whatsapp", "counsellor", "assignment")}
              />
              <NotifPill
                label="Welcome email"
                icon={<Mail className="h-3.5 w-3.5" />}
                entry={findStatus("email", "counsellor", "assignment")}
              />
              <NotifPill
                label="12hr reminder WA"
                icon={<MessageCircle className="h-3.5 w-3.5" />}
                entry={findStatus("whatsapp", "counsellor", "reminder")}
              />
              <NotifPill
                label="12hr reminder email"
                icon={<Mail className="h-3.5 w-3.5" />}
                entry={findStatus("email", "counsellor", "reminder")}
              />
            </div>
          </div>

        </div>

        {/* Right: call-student uploader + workflow box */}
        <div className="md:col-span-1 space-y-4">
          <AudioUploader lead={lead} onChange={onWorkflowChange} />
          <WorkflowBox
            lead={lead}
            counsellorId={counsellorId}
            onChange={onWorkflowChange}
          />
        </div>
      </div>
    </div>
  );
}

function NotifPill({ label, icon, entry }) {
  let cls = "border-stone-300 bg-white text-stone-600";
  let suffix = "not yet";
  if (entry) {
    if (entry.type === "notification_sent") {
      cls = "border-emerald-200 bg-emerald-50 text-emerald-700";
      suffix = `✓ ${formatInIst(entry.ts)}`;
    } else if (entry.type === "notification_error") {
      cls = "border-red-200 bg-red-50 text-red-700";
      suffix = "✕ failed";
    } else if (entry.type === "notification_pending") {
      cls = "border-amber-200 bg-amber-50 text-amber-700";
      suffix = "sending…";
    }
  }
  return (
    <div className={`flex items-center justify-between gap-2 border px-3 py-2 text-[14px] ${cls}`}>
      <span className="flex items-center gap-2 font-medium">
        {icon}
        {label}
      </span>
      <span className="text-[13px] uppercase tracking-[0.1em]">{suffix}</span>
    </div>
  );
}

function AudioUploader({ lead, onChange }) {
  const [state, setState] = useState("idle"); // idle | uploading | success | error
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setState("uploading");
    setErr(null);
    setResult(null);
    try {
      const r = await api.uploadAudio(lead.id, file);
      setResult(r);
      setState("success");
      onChange();
    } catch (e) {
      setErr(e.message);
      setState("error");
    } finally {
      // Reset the input so the same file can be re-uploaded
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="border-2 border-dashed border-[#cc785c] bg-[#cc785c]/5 p-4">
      <div className="flex items-start gap-2">
        <Mic className="mt-0.5 h-4 w-4 shrink-0 text-[#cc785c]" />
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#cc785c]">
            Call student
          </p>
          <p className="text-[10px] uppercase tracking-[0.15em] text-[#cc785c]/70">
            [ only audio record until WhatsApp Business number is added ]
          </p>
        </div>
      </div>

      {state === "idle" && (
        <>
          <p className="mt-3 text-xs leading-snug text-stone-700">
            Upload a recording — Whisper will transcribe it (translates any
            language to English) and Gemini auto-extracts actionables. Same
            pipeline a live WhatsApp call will hit once the Business number
            is enabled. Max 10 MB (~10 min audio); mp3 / m4a / wav / webm / ogg.
          </p>
          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 border border-[#cc785c] bg-white px-3 py-2 text-[12px] uppercase tracking-[0.15em] text-[#cc785c] hover:bg-[#cc785c]/10">
            🎙️ Upload recording
            <input
              ref={inputRef}
              type="file"
              accept="audio/*"
              onChange={onPick}
              className="hidden"
            />
          </label>
        </>
      )}

      {state === "uploading" && (
        <div className="mt-3 flex items-center gap-2 text-xs text-stone-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#cc785c]" />
          <span>Transcribing + extracting actionables… (~10–30s)</span>
        </div>
      )}

      {state === "success" && result && (
        <div className="mt-3 space-y-1 text-xs text-stone-700">
          <p>
            ✓ Transcript saved ({result.transcript_chars.toLocaleString()} chars).
          </p>
          <p>
            ✓ {result.actionables_count} actionable
            {result.actionables_count === 1 ? "" : "s"} extracted.
          </p>
          {result.extract_error && (
            <p className="text-amber-700">
              Note: extractor warning — {result.extract_error}
            </p>
          )}
          <button
            onClick={() => setState("idle")}
            className="mt-1 text-[11px] uppercase tracking-[0.15em] text-[#cc785c] underline underline-offset-2 hover:text-[#b86a4f]"
          >
            Upload another
          </button>
        </div>
      )}

      {state === "error" && (
        <div className="mt-3 space-y-1 text-xs">
          <p className="text-red-700">✕ {err}</p>
          <button
            onClick={() => setState("idle")}
            className="text-[11px] uppercase tracking-[0.15em] text-[#cc785c] underline underline-offset-2 hover:text-[#b86a4f]"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// WorkflowBox: call logger + transcript editor + actionables
// ============================================================
function WorkflowBox({ lead, counsellorId, onChange }) {
  return (
    <div className="space-y-4">
      <CallLogger lead={lead} counsellorId={counsellorId} onChange={onChange} />
      <ActionablesList lead={lead} onChange={onChange} />
    </div>
  );
}

function CallLogger({ lead, counsellorId, onChange }) {
  const [open, setOpen] = useState(false);
  const [calledAt, setCalledAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.logCall(lead.id, {
        counsellor_id: counsellorId,
        called_at: calledAt ? localInputToUtcIso(calledAt) : null,
        note: note || null,
      });
      setOpen(false);
      setCalledAt("");
      setNote("");
      onChange();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const calls = (lead.activity || []).filter((a) => a.type === "call_logged");

  return (
    <div className="border border-stone-300 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
          Calls ({calls.length})
        </p>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1 text-[12px] uppercase tracking-[0.15em] text-[#cc785c] hover:text-[#b86a4f]"
          >
            <Phone className="h-3 w-3" /> Log a call
          </button>
        )}
      </div>

      {calls.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-xs text-stone-700">
          {calls.slice().reverse().slice(0, 5).map((c) => (
            <li key={c.id} className="border-l-2 border-stone-300 pl-2">
              {c.text}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form onSubmit={submit} className="mt-3 space-y-2">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.15em] text-stone-600">
              When (defaults to now)
            </span>
            <input
              type="datetime-local"
              value={calledAt}
              onChange={(e) => setCalledAt(e.target.value)}
              className="mt-1 w-full border border-stone-300 bg-white px-2 py-1 text-sm outline-none focus:border-stone-600"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.15em] text-stone-600">
              Note (optional)
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Lead picked up · talked for 6 min · keen on Cornell SOP review"
              className="mt-1 w-full border border-stone-300 bg-stone-50 p-2 text-sm outline-none focus:border-stone-600"
            />
          </label>
          {err && <p className="text-xs text-red-700">{err}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[12px] uppercase tracking-[0.15em] text-white hover:bg-[#b86a4f] disabled:opacity-30"
            >
              Save call
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[12px] uppercase tracking-[0.15em] text-stone-600 hover:text-stone-900"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ActionablesList({ lead, onChange }) {
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [extracting, setExtracting] = useState(false);

  // Auto-extract is available whenever a transcript exists. Audio upload
  // populates it; otherwise this stays hidden.
  const canExtract =
    !!lead.transcript && lead.transcript.trim().length >= 20;

  const addOne = async (e) => {
    e.preventDefault();
    if (!newText.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addActionable(lead.id, newText.trim());
      setNewText("");
      onChange();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const extract = async () => {
    setExtracting(true);
    setErr(null);
    try {
      const result = await api.extractActionables(lead.id);
      onChange();
      if (result.count === 0) {
        setErr("Gemini didn't find any clear actionables in the transcript.");
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setExtracting(false);
    }
  };

  const toggle = async (a) => {
    setBusy(true);
    try {
      await api.updateActionable(lead.id, a.id, { completed: !a.completed });
      onChange();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`Delete actionable "${a.text}"?`)) return;
    setBusy(true);
    try {
      await api.deleteActionable(lead.id, a.id);
      onChange();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const items = lead.actionables || [];
  const done = items.filter((a) => a.completed).length;

  return (
    <div className="border border-stone-300 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
          Actionables ({done}/{items.length})
        </p>
        {canExtract && (
          <button
            onClick={extract}
            disabled={busy || extracting}
            title="Use Gemini to extract actionables from the transcript"
            className="inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.15em] text-[#cc785c] hover:text-[#b86a4f] disabled:opacity-40"
          >
            {extracting ? "Extracting…" : "✨ Auto-extract"}
          </button>
        )}
      </div>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {items.map((a) => (
            <li
              key={a.id}
              className={`flex items-start gap-2 text-xs ${
                a.completed ? "text-stone-500 line-through" : "text-stone-800"
              }`}
            >
              <button
                onClick={() => toggle(a)}
                disabled={busy}
                className="mt-0.5 shrink-0 text-[#cc785c] hover:text-[#b86a4f]"
                title={a.completed ? "Mark incomplete" : "Mark complete"}
              >
                {a.completed ? (
                  <CheckSquare className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </button>
              <span className="flex-1 leading-snug">{a.text}</span>
              <button
                onClick={() => remove(a)}
                disabled={busy}
                className="shrink-0 text-stone-400 hover:text-red-700"
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={addOne} className="mt-3 flex items-center gap-2">
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="Add an actionable…"
          className="min-w-0 flex-1 border-b border-stone-300 bg-transparent py-1 text-sm outline-none focus:border-stone-600"
        />
        <button
          type="submit"
          disabled={busy || !newText.trim()}
          className="inline-flex items-center gap-1 border border-[#cc785c] px-2 py-1 text-[11px] uppercase tracking-[0.15em] text-[#cc785c] hover:bg-[#cc785c]/10 disabled:opacity-30"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      </form>
      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
    </div>
  );
}
