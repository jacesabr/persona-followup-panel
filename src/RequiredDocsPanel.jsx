// RequiredDocsPanel — dedicated staff workspace for reviewing student briefs
// and writing LOR / Internship / SOP drafts.
//
// Tab: "Student Document To Process" (admin + counsellor)
// Left: intake-complete students with a status dot
// Right: per-student workspace — one card per doc, auto-expanding draft
//        textarea, procedure summary, bulk send button

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  Send,
  Save,
  Check,
  Users,
} from "lucide-react";
import { api } from "./api.js";

// ─── helpers ───────────────────────────────────────────────────────────────

function humanDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Counts how many business days remain until deadline_at (from today).
// Negative means overdue.
function businessDaysLeft(deadlineIso) {
  if (!deadlineIso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(deadlineIso);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  let dir = end >= today ? 1 : -1;
  let cur = new Date(today);
  while (cur.getTime() !== end.getTime()) {
    cur.setDate(cur.getDate() + dir);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count += dir;
  }
  return count;
}

function overallStatus(docs) {
  if (!docs || docs.length === 0) return "pending";
  const allFinished = docs.every(
    (d) =>
      (d.kind !== "sop" && d.final_file_id) ||
      (d.kind === "sop" && d.approved_by_admin_at)
  );
  if (allFinished) return "complete";
  if (docs.some((d) => d.requested_at)) return "sent";
  if (docs.some((d) => d.staff_draft)) return "drafting";
  return "pending";
}

const STATUS_DOT = {
  complete: "bg-emerald-500",
  sent:     "bg-blue-400",
  drafting: "bg-amber-400",
  pending:  "bg-stone-300",
};
const STATUS_TEXT = {
  complete: "Complete",
  sent:     "Awaiting upload",
  drafting: "In progress",
  pending:  "Not started",
};

// ─── auto-growing textarea ─────────────────────────────────────────────────
// Starts at `minRows` of natural line height and grows with content.
// Never shows a scrollbar — height always matches content exactly.

function AutoTextarea({ value, onChange, placeholder, minRows = 4, className = "" }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value || ""}
      onChange={onChange}
      placeholder={placeholder}
      rows={minRows}
      style={{ resize: "none", overflow: "hidden" }}
      className={className}
    />
  );
}

// ─── main panel ────────────────────────────────────────────────────────────

export default function RequiredDocsPanel({ role }) {
  const [students, setStudents] = useState(null);
  const [err, setErr] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [cachedDocs, setCachedDocs] = useState({});

  const loadStudents = useCallback(async () => {
    try {
      const list = await api.listStudents();
      const ready = list.filter((s) => s.intake_complete);
      setStudents(ready);
      if (ready.length && !selectedId) setSelectedId(ready[0].student_id);
      setErr(null);
    } catch (e) {
      setErr(e.message || "Couldn't load students.");
    }
  }, [selectedId]);

  useEffect(() => { loadStudents(); }, [loadStudents]);

  const refreshDocs = useCallback(async (studentId) => {
    try {
      const docs = await api.listRequiredDocsForStudent(studentId);
      setCachedDocs((p) => ({ ...p, [studentId]: docs }));
    } catch { /* workspace surfaces its own error */ }
  }, []);

  useEffect(() => {
    if (selectedId && !cachedDocs[selectedId]) refreshDocs(selectedId);
  }, [selectedId, cachedDocs, refreshDocs]);

  const selectedStudent = students?.find((s) => s.student_id === selectedId);

  return (
    <div className="flex min-h-[500px] gap-8">

      {/* ── Left: student list ─────────────────────────────── */}
      <aside className="w-52 shrink-0">
        <p className="mb-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
          <Users className="h-3 w-3" /> Students
        </p>

        {err && (
          <p className="mb-3 flex items-center gap-1 text-xs text-red-700">
            <AlertCircle className="h-3 w-3" /> {err}
          </p>
        )}

        {students === null && (
          <div className="flex items-center gap-2 text-xs text-stone-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {students?.length === 0 && (
          <p className="text-xs italic text-stone-500">
            No students have completed intake yet.
          </p>
        )}

        <div className="space-y-1">
          {students?.map((s) => {
            const docs   = cachedDocs[s.student_id] ?? null;
            const status = docs ? overallStatus(docs) : "pending";
            const active = s.student_id === selectedId;
            return (
              <button
                key={s.student_id}
                onClick={() => setSelectedId(s.student_id)}
                className={`w-full border px-3 py-2.5 text-left transition ${
                  active
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-300 bg-white text-stone-800 hover:border-stone-600 hover:bg-stone-50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-white/60" : STATUS_DOT[status]}`} />
                  <span className="truncate text-sm font-medium leading-snug">
                    {s.display_name || s.username}
                  </span>
                </div>
                {!active && (
                  <p className="mt-0.5 pl-4 text-[10px] uppercase tracking-[0.1em] text-stone-400">
                    {STATUS_TEXT[status]}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Right: workspace ───────────────────────────────── */}
      <div className="min-w-0 flex-1">
        {!selectedId ? (
          <p className="mt-6 text-sm italic text-stone-500">Select a student to begin.</p>
        ) : (
          <StudentDocWorkspace
            key={selectedId}
            studentId={selectedId}
            studentName={selectedStudent?.display_name || selectedStudent?.username || "Student"}
            role={role}
            initialDocs={cachedDocs[selectedId] ?? null}
            onDocsChanged={() => refreshDocs(selectedId)}
          />
        )}
      </div>
    </div>
  );
}

// ─── per-student workspace ─────────────────────────────────────────────────

function StudentDocWorkspace({ studentId, studentName, role, initialDocs, onDocsChanged }) {
  const [docs,      setDocs]      = useState(initialDocs);
  const [loadErr,   setLoadErr]   = useState(null);
  const [drafts,    setDrafts]    = useState({});
  const [busy,      setBusy]      = useState({});
  const [actionErr, setActionErr] = useState(null);
  const [bulkBusy,  setBulkBusy]  = useState(false);

  const loadDocs = useCallback(async () => {
    try {
      const list = await api.listRequiredDocsForStudent(studentId);
      setDocs(list);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const d of list) {
          if (next[d.id] === undefined) next[d.id] = d.staff_draft || "";
        }
        return next;
      });
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e.message || "Couldn't load documents.");
    }
  }, [studentId]);

  useEffect(() => {
    if (initialDocs) {
      setDocs(initialDocs);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const d of initialDocs) {
          if (next[d.id] === undefined) next[d.id] = d.staff_draft || "";
        }
        return next;
      });
    } else {
      loadDocs();
    }
  }, [initialDocs, loadDocs]);

  const refresh = useCallback(async () => {
    await loadDocs();
    onDocsChanged?.();
  }, [loadDocs, onDocsChanged]);

  const saveDraft = async (id) => {
    setBusy((p) => ({ ...p, [id]: true }));
    setActionErr(null);
    try {
      await api.updateRequiredDoc(id, { staff_draft: drafts[id] || "" });
      await refresh();
    } catch (e) { setActionErr(e.message); }
    finally     { setBusy((p) => ({ ...p, [id]: false })); }
  };

  const toggleDone = async (doc) => {
    setBusy((p) => ({ ...p, [doc.id]: true }));
    setActionErr(null);
    try {
      await api.markRequiredDocDone(doc.id, !!doc.marked_done_at);
      await refresh();
    } catch (e) { setActionErr(e.message); }
    finally     { setBusy((p) => ({ ...p, [doc.id]: false })); }
  };

  const toggleApprove = async (doc) => {
    setBusy((p) => ({ ...p, [doc.id]: true }));
    setActionErr(null);
    try {
      await api.approveSop(doc.id, !!doc.approved_by_admin_at);
      await refresh();
    } catch (e) { setActionErr(e.message); }
    finally     { setBusy((p) => ({ ...p, [doc.id]: false })); }
  };

  const sendBulk = async () => {
    if (!confirm(
      `Send all marked-done LOR & Internship requests to ${studentName}?\n\n` +
      `They will have 5 business days to collect signatures and upload stamped copies.`
    )) return;
    setBulkBusy(true);
    setActionErr(null);
    try {
      await api.sendRequiredDocRequests(studentId);
      await refresh();
    } catch (e) { setActionErr(e.message); }
    finally     { setBulkBusy(false); }
  };

  if (loadErr) return (
    <p className="flex items-center gap-2 text-sm text-red-700">
      <AlertCircle className="h-4 w-4" /> {loadErr}
    </p>
  );

  if (!docs) return (
    <div className="flex items-center gap-2 text-sm text-stone-400">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading documents…
    </div>
  );

  if (docs.length === 0) return (
    <div className="border border-stone-300 bg-white px-6 py-8">
      <p className="text-stone-500">No required documents found for {studentName}.</p>
      <p className="mt-1 text-xs text-stone-400">
        These are created automatically when the student submits their intake form.
      </p>
    </div>
  );

  const lors   = docs.filter((d) => d.kind === "lor");
  const interns = docs.filter((d) => d.kind === "internship");
  const sop    = docs.find((d) => d.kind === "sop");

  const allLIDone  = [...lors, ...interns].every((d) => d.marked_done_at);
  const anyLIPending = [...lors, ...interns].some((d) => d.marked_done_at && !d.requested_at);

  return (
    <div className="space-y-8">

      {/* Student heading */}
      <div className="border-b border-stone-300 pb-5">
        <h2 className="font-serif text-2xl text-stone-900">{studentName}</h2>
        <p className="mt-0.5 text-[10px] uppercase tracking-[0.25em] text-stone-400">
          Student Documents to Process
        </p>
      </div>

      {/* Procedure summary */}
      <div className="border-l-4 border-stone-400 bg-stone-50 px-5 py-4 text-sm text-stone-600 leading-relaxed space-y-1.5">
        <p className="font-semibold text-stone-700">How this works</p>
        <p>1. Read the student's brief for each document below, then write your draft in the text area.</p>
        <p>2. Save your draft, then click <strong>Mark done</strong> on each LOR and Internship document.</p>
        <p>3. Once all are marked done, use <strong>Send requests</strong> — the student gets 5 business days to collect signatures and upload stamped copies.</p>
        <p>4. The SOP must be <strong>approved by an admin</strong> before it appears on the student's dashboard.</p>
      </div>

      {actionErr && (
        <p className="flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4" /> {actionErr}
        </p>
      )}

      {/* ── Letters of Recommendation ─────────────────────── */}
      {lors.length > 0 && (
        <section className="space-y-5">
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">
            Letters of Recommendation
          </h3>
          {lors.map((doc) => (
            <DocCard
              key={doc.id}
              doc={doc}
              draft={drafts[doc.id] ?? ""}
              onDraftChange={(v) => setDrafts((p) => ({ ...p, [doc.id]: v }))}
              onSave={() => saveDraft(doc.id)}
              onToggleDone={() => toggleDone(doc)}
              busy={!!busy[doc.id]}
              role={role}
            />
          ))}
        </section>
      )}

      {/* ── Internship Documents ───────────────────────────── */}
      {interns.length > 0 && (
        <section className="space-y-5">
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">
            Internship Documents
          </h3>
          {interns.map((doc) => (
            <DocCard
              key={doc.id}
              doc={doc}
              draft={drafts[doc.id] ?? ""}
              onDraftChange={(v) => setDrafts((p) => ({ ...p, [doc.id]: v }))}
              onSave={() => saveDraft(doc.id)}
              onToggleDone={() => toggleDone(doc)}
              busy={!!busy[doc.id]}
              role={role}
            />
          ))}
        </section>
      )}

      {/* ── Statement of Purpose ──────────────────────────── */}
      {sop && (
        <section>
          <h3 className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">
            Statement of Purpose
          </h3>
          <DocCard
            doc={sop}
            draft={drafts[sop.id] ?? ""}
            onDraftChange={(v) => setDrafts((p) => ({ ...p, [sop.id]: v }))}
            onSave={() => saveDraft(sop.id)}
            onToggleApprove={() => toggleApprove(sop)}
            canApprove={role === "admin"}
            busy={!!busy[sop.id]}
            role={role}
          />
        </section>
      )}

      {/* ── Bulk send ─────────────────────────────────────── */}
      {(lors.length > 0 || interns.length > 0) && (
        <div className="border-t border-stone-300 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-stone-700">
                {allLIDone
                  ? anyLIPending
                    ? "All drafts are marked done — ready to send requests."
                    : "All requests have already been sent."
                  : "Mark every LOR and Internship as done before sending."}
              </p>
              <p className="mt-0.5 text-xs text-stone-400">
                Student will have 5 business days to collect signatures and upload stamped copies.
              </p>
            </div>
            <button
              type="button"
              onClick={sendBulk}
              disabled={!allLIDone || !anyLIPending || bulkBusy}
              className="inline-flex items-center gap-2 border border-stone-900 bg-stone-900 px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {bulkBusy ? "Sending…" : "Send requests"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── document card ─────────────────────────────────────────────────────────

function DocCard({ doc, draft, onDraftChange, onSave, onToggleDone, onToggleApprove, canApprove, busy }) {
  const isSop  = doc.kind === "sop";
  const dirty  = (draft || "") !== (doc.staff_draft || "");
  const words  = draft ? draft.trim().split(/\s+/).filter(Boolean).length : 0;

  // Heading
  const heading =
    doc.kind === "lor"        ? `Letter of Recommendation ${doc.seq}` :
    doc.kind === "internship" ? `Internship Document ${doc.seq}`       :
                                "Statement of Purpose";

  // Status badge
  let statusLabel, statusClass;
  if (isSop) {
    if (doc.approved_by_admin_at) {
      statusLabel = "Approved by admin";
      statusClass = "bg-emerald-50 text-emerald-800 border-emerald-300";
    } else if (doc.staff_draft) {
      statusLabel = "Draft saved — awaiting admin approval";
      statusClass = "bg-amber-50 text-amber-800 border-amber-300";
    } else {
      statusLabel = "Awaiting your draft";
      statusClass = "bg-stone-100 text-stone-500 border-stone-300";
    }
  } else {
    if (doc.final_file_id) {
      statusLabel = "Final document received";
      statusClass = "bg-emerald-50 text-emerald-800 border-emerald-300";
    } else if (doc.requested_at) {
      const left = businessDaysLeft(doc.deadline_at);
      const urgent = left !== null && left <= 1;
      statusLabel = left === null
        ? `Request sent — deadline ${humanDate(doc.deadline_at)}`
        : left < 0
        ? `Overdue by ${Math.abs(left)} business day${Math.abs(left) !== 1 ? "s" : ""}`
        : left === 0
        ? "Deadline is today — urgent"
        : `Day ${5 - left} of 5 — deadline ${humanDate(doc.deadline_at)}`;
      statusClass = urgent
        ? "bg-red-50 text-red-800 border-red-300"
        : "bg-blue-50 text-blue-800 border-blue-300";
    } else if (doc.marked_done_at) {
      statusLabel = "Draft done — ready to send";
      statusClass = "bg-amber-50 text-amber-800 border-amber-300";
    } else if (doc.staff_draft) {
      statusLabel = "Draft in progress";
      statusClass = "bg-stone-100 text-stone-500 border-stone-300";
    } else {
      statusLabel = "Awaiting your draft";
      statusClass = "bg-stone-100 text-stone-500 border-stone-300";
    }
  }

  return (
    <div className="border border-stone-300 bg-white">

      {/* Card header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-6 py-4">
        <h4 className="font-serif text-xl text-stone-900">{heading}</h4>
        <span className={`inline-flex items-center gap-1.5 border px-3 py-1 text-xs font-medium ${statusClass}`}>
          {(doc.final_file_id || doc.approved_by_admin_at) && <CheckCircle2 className="h-3.5 w-3.5" />}
          {doc.requested_at && !doc.final_file_id && <Clock className="h-3.5 w-3.5" />}
          {statusLabel}
        </span>
      </div>

      <div className="px-6 py-5 space-y-6">

        {/* Student brief — LOR */}
        {doc.kind === "lor" && (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
              Context from student
            </p>
            <div className="grid grid-cols-[160px_1fr] gap-y-2 gap-x-4 border border-stone-200 bg-stone-50 px-5 py-4 text-sm">
              <span className="text-stone-400">Recommender</span>
              <span className="text-stone-800">{doc.recipient_name || <em className="text-stone-400">—</em>}</span>
              <span className="text-stone-400">Position / Subject</span>
              <span className="text-stone-800">{doc.recipient_role || <em className="text-stone-400">—</em>}</span>
              <span className="text-stone-400">Student's reason</span>
              <span className="text-stone-800">{doc.reason_brief || <em className="text-stone-400">—</em>}</span>
            </div>
          </div>
        )}

        {/* Student brief — Internship */}
        {doc.kind === "internship" && (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
              Context from student
            </p>
            <div className="grid grid-cols-[160px_1fr] gap-y-2 gap-x-4 border border-stone-200 bg-stone-50 px-5 py-4 text-sm">
              <span className="text-stone-400">Company</span>
              <span className="text-stone-800">{doc.company_name || <em className="text-stone-400">—</em>}</span>
              <span className="text-stone-400">Website</span>
              <span className="text-stone-800">{doc.company_website || <em className="text-stone-400">—</em>}</span>
              <span className="text-stone-400">What they did</span>
              <span className="text-stone-800">{doc.activity_brief || <em className="text-stone-400">—</em>}</span>
            </div>
          </div>
        )}

        {/* SOP note */}
        {isSop && (
          <p className="border-l-4 border-stone-300 pl-4 text-sm italic text-stone-500">
            Use the student's academic record, activities, internships, and personal summary from their intake to draft a complete Statement of Purpose. Admin approval is required before this is shown to the student.
          </p>
        )}

        {/* Draft area */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
              {isSop ? "SOP draft" : "Document draft"}
            </p>
            {words > 0 && (
              <span className="text-[10px] text-stone-400">{words} words</span>
            )}
          </div>
          <AutoTextarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            minRows={5}
            placeholder={
              isSop
                ? "Write the full Statement of Purpose here. Admin must approve before it is shown to the student."
                : `Write the full ${heading} here. The student will have this printed on official letterhead and signed.`
            }
            className="w-full border border-stone-300 bg-[#faf9f5] px-4 py-3 font-serif text-sm leading-relaxed text-stone-900 outline-none focus:border-stone-700"
          />
          {dirty && (
            <p className="mt-1 text-[11px] italic text-amber-700">Unsaved changes</p>
          )}
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || busy}
            className="inline-flex items-center gap-2 border border-stone-700 bg-white px-4 py-2 text-xs uppercase tracking-[0.15em] text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save draft
          </button>

          {!isSop && (
            <button
              type="button"
              onClick={onToggleDone}
              disabled={busy || !!doc.requested_at}
              title={doc.requested_at ? "Already sent — cannot undo" : ""}
              className={`inline-flex items-center gap-2 border px-4 py-2 text-xs uppercase tracking-[0.15em] transition disabled:cursor-not-allowed disabled:opacity-40 ${
                doc.marked_done_at
                  ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                  : "border-stone-400 bg-white text-stone-700 hover:border-stone-700"
              }`}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {doc.marked_done_at ? "Done — click to undo" : "Mark done"}
            </button>
          )}

          {isSop && canApprove && (
            <button
              type="button"
              onClick={onToggleApprove}
              disabled={busy || !doc.staff_draft}
              title={!doc.staff_draft ? "Save a draft first" : ""}
              className={`inline-flex items-center gap-2 border px-4 py-2 text-xs uppercase tracking-[0.15em] transition disabled:cursor-not-allowed disabled:opacity-40 ${
                doc.approved_by_admin_at
                  ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                  : "border-stone-400 bg-white text-stone-700 hover:border-stone-700"
              }`}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {doc.approved_by_admin_at ? "Approved — click to un-approve" : "Approve SOP"}
            </button>
          )}

          {isSop && !canApprove && (
            <span className="text-xs italic text-stone-400">
              Admin must approve this SOP before it appears on the student's profile.
            </span>
          )}

          {doc.final_file_id && (
            <span className="ml-auto flex items-center gap-1 text-xs text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Final document uploaded by student
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
