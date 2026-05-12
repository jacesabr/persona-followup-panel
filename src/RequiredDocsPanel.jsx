// RequiredDocsPanel — staff workspace for LOR / Internship / SOP drafts.
// Tab: "Required Documents" (admin + counsellor)
// Layout: accordion list — one collapsible row per document across all students.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2, AlertCircle, CheckCircle2, Clock,
  Send, Save, Check, ChevronDown, ExternalLink, ClipboardList,
} from "lucide-react";
import { api } from "./api.js";
import { computeRequiredDocState } from "../lib/requiredDocStatus.js";

// ─── helpers ───────────────────────────────────────────────────────────────

function humanDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function businessDaysLeft(deadlineIso) {
  if (!deadlineIso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end   = new Date(deadlineIso); end.setHours(0, 0, 0, 0);
  let count = 0, dir = end >= today ? 1 : -1, cur = new Date(today);
  while (cur.getTime() !== end.getTime()) {
    cur.setDate(cur.getDate() + dir);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count += dir;
  }
  return count;
}

// Counsellor-facing label + tone for each canonical state. Students
// see different labels for the same states (see STATUS_PILL in
// StudentDashboard.jsx) — that's intentional, both surfaces compute
// state from `computeRequiredDocState` so the underlying truth stays
// in sync.
const COUNSELLOR_LABELS = {
  awaiting_draft:    { label: "Awaiting draft",          cls: "bg-stone-100 text-black border-stone-300" },
  draft_in_progress: { label: "Draft in progress",       cls: "bg-stone-100 text-black border-stone-300" },
  drafted:           { label: "Ready to send",           cls: "bg-amber-50 text-amber-800 border-amber-300" },
  drafted_sop:       { label: "Awaiting admin approval", cls: "bg-amber-50 text-amber-800 border-amber-300" },
  received:          { label: "Complete",                cls: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  approved:          { label: "Approved",                cls: "bg-emerald-50 text-emerald-800 border-emerald-300" },
};

// Returns { label, cls } for the badge shown in both the row header and card.
// `requested` is the only state with a dynamic label (deadline countdown),
// so it's computed inline rather than living in the table above.
function docStatus(doc) {
  const state = computeRequiredDocState(doc);
  if (state === "requested") {
    const left   = businessDaysLeft(doc.deadline_at);
    const urgent = left !== null && left <= 1;
    const label  = left === null   ? `Sent — due ${humanDate(doc.deadline_at)}`
                 : left < 0        ? `Overdue ${Math.abs(left)}d`
                 : left === 0      ? "Due today"
                 :                   `Day ${5 - left} of 5`;
    return { label, cls: urgent ? "bg-red-50 text-red-800 border-red-300" : "bg-blue-50 text-blue-800 border-blue-300" };
  }
  return COUNSELLOR_LABELS[state] || { label: state, cls: "bg-stone-100 text-black border-stone-300" };
}

function docHeading(doc) {
  if (doc.kind === "lor")        return `Letter of Recommendation ${doc.seq}`;
  if (doc.kind === "internship") return `Internship Document ${doc.seq}`;
  return "Statement of Purpose";
}

function overallStatus(docs) {
  if (!docs?.length) return "pending";
  if (docs.every(d => (d.kind !== "sop" && d.final_file_id) || (d.kind === "sop" && d.approved_by_admin_at))) return "complete";
  if (docs.some(d => d.requested_at)) return "sent";
  if (docs.some(d => d.staff_draft))  return "drafting";
  return "pending";
}

const OVERALL_DOT = {
  complete: "bg-emerald-500", sent: "bg-blue-400", drafting: "bg-amber-400", pending: "bg-stone-300",
};
const OVERALL_LABEL = {
  complete: "Complete", sent: "Awaiting upload", drafting: "In progress", pending: "Not started",
};

// ─── auto-growing textarea ─────────────────────────────────────────────────

function AutoTextarea({ value, onChange, placeholder, minRows = 4, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea ref={ref} value={value || ""} onChange={onChange} placeholder={placeholder}
      rows={minRows} style={{ resize: "none", overflow: "hidden" }} className={className} />
  );
}

// ─── main panel ────────────────────────────────────────────────────────────

export default function RequiredDocsPanel({ role, counsellors = [], onViewStudent, onViewTasks }) {
  const [students,   setStudents]   = useState(null);
  const [err,        setErr]        = useState(null);
  const [docsMap,    setDocsMap]    = useState({});   // { studentId: doc[] }
  const [drafts,     setDrafts]     = useState({});   // { docId: string }
  const [expanded,   setExpanded]   = useState(new Set()); // set of docId
  const [busy,       setBusy]       = useState({});   // { docId: bool }
  const [bulkBusy,   setBulkBusy]   = useState({});   // { studentId: bool }
  const [actionErr,  setActionErr]  = useState(null);

  // ── load ──────────────────────────────────────────────────────────────────

  const mergeStudentDocs = useCallback((studentId, docs) => {
    setDocsMap(p  => ({ ...p, [studentId]: docs }));
    setDrafts(p => {
      const next = { ...p };
      for (const d of docs) if (next[d.id] === undefined) next[d.id] = d.staff_draft || "";
      return next;
    });
  }, []);

  const refreshStudent = useCallback(async (studentId) => {
    const docs = await api.listRequiredDocsForStudent(studentId);
    mergeStudentDocs(studentId, docs);
  }, [mergeStudentDocs]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list  = await api.listStudents();
        const ready = list.filter(s => s.intake_complete);
        if (cancelled) return;
        setStudents(ready);
        const results = await Promise.allSettled(
          ready.map(s => api.listRequiredDocsForStudent(s.student_id)
            .then(docs => ({ studentId: s.student_id, docs })))
        );
        if (cancelled) return;
        for (const r of results) {
          if (r.status === "fulfilled") mergeStudentDocs(r.value.studentId, r.value.docs);
        }
      } catch (e) { if (!cancelled) setErr(e.message || "Couldn't load students."); }
    }
    load();
    return () => { cancelled = true; };
  }, [mergeStudentDocs]);

  // ── actions ───────────────────────────────────────────────────────────────

  const saveDraft = async (studentId, docId) => {
    setBusy(p => ({ ...p, [docId]: true }));
    setActionErr(null);
    try {
      await api.updateRequiredDoc(docId, { staff_draft: drafts[docId] || "" });
      await refreshStudent(studentId);
    } catch (e) { setActionErr(e.message); }
    finally     { setBusy(p => ({ ...p, [docId]: false })); }
  };

  const toggleDone = async (studentId, doc) => {
    setBusy(p => ({ ...p, [doc.id]: true }));
    setActionErr(null);
    try {
      await api.markRequiredDocDone(doc.id, !!doc.marked_done_at);
      await refreshStudent(studentId);
    } catch (e) { setActionErr(e.message); }
    finally     { setBusy(p => ({ ...p, [doc.id]: false })); }
  };

  const toggleApprove = async (studentId, doc) => {
    setBusy(p => ({ ...p, [doc.id]: true }));
    setActionErr(null);
    try {
      await api.approveSop(doc.id, !!doc.approved_by_admin_at);
      await refreshStudent(studentId);
    } catch (e) { setActionErr(e.message); }
    finally     { setBusy(p => ({ ...p, [doc.id]: false })); }
  };

  const sendBulk = async (studentId, studentName) => {
    if (!confirm(
      `Send all marked-done LOR & Internship requests to ${studentName}?\n\n` +
      `They will have 5 business days to collect signatures and upload stamped copies.`
    )) return;
    setBulkBusy(p => ({ ...p, [studentId]: true }));
    setActionErr(null);
    try {
      await api.sendRequiredDocRequests(studentId);
      await refreshStudent(studentId);
    } catch (e) { setActionErr(e.message); }
    finally     { setBulkBusy(p => ({ ...p, [studentId]: false })); }
  };

  const toggleExpand = (docId) =>
    setExpanded(prev => { const n = new Set(prev); n.has(docId) ? n.delete(docId) : n.add(docId); return n; });

  // ── render ────────────────────────────────────────────────────────────────

  if (err) return (
    <p className="flex items-center gap-2 text-sm text-red-700">
      <AlertCircle className="h-4 w-4" /> {err}
    </p>
  );

  if (students === null) return (
    <div className="flex items-center gap-2 text-sm text-black">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );

  if (students.length === 0) return (
    <p className="text-sm  text-black">No students have completed intake yet.</p>
  );

  return (
    <div className="space-y-5">
      {actionErr && (
        <p className="flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4" /> {actionErr}
        </p>
      )}

      {students.map(student => {
        const sid  = student.student_id;
        const name = student.display_name || student.username;
        const docs = docsMap[sid];

        const lors    = docs?.filter(d => d.kind === "lor")        ?? [];
        const interns = docs?.filter(d => d.kind === "internship") ?? [];
        const allLIDone    = [...lors, ...interns].every(d => d.marked_done_at);
        const anyLIPending = [...lors, ...interns].some(d => d.marked_done_at && !d.requested_at);
        const status  = docs ? overallStatus(docs) : "pending";

        return (
          <div key={sid} className="border border-stone-300 bg-white">

            {/* ── Student header ─────────────────────────── */}
            <div className="border-b border-stone-300 bg-[#fdf8f4] px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">

                {/* Left: name + status + counsellor */}
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${OVERALL_DOT[status]}`} />
                    <span className="text-xl font-bold text-black">{name}</span>
                    <span className="rounded border border-[#cc785c]/40 bg-[#cc785c]/10 px-2.5 py-0.5 text-xs font-bold uppercase tracking-[0.15em] text-[#cc785c]">
                      {OVERALL_LABEL[status]}
                    </span>
                    {!docs && <Loader2 className="h-4 w-4 animate-spin text-black" />}
                  </div>

                  {/* Counsellor row */}
                  <CounsellorAssign
                    student={student}
                    counsellors={counsellors}
                    role={role}
                    onAssigned={() => refreshStudent(sid).then(() =>
                      // Re-fetch students list so the name updates in parent
                      api.listStudents().then(list => {
                        const ready = list.filter(s => s.intake_complete);
                        setStudents(ready);
                      }).catch(() => {})
                    )}
                  />
                </div>

                {/* Right: stacked action buttons + send */}
                <div className="flex flex-col items-end gap-2">
                  {(lors.length > 0 || interns.length > 0) && (
                    <button
                      type="button"
                      onClick={() => sendBulk(sid, name)}
                      disabled={!allLIDone || !anyLIPending || !!bulkBusy[sid]}
                      className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-sm font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      {bulkBusy[sid] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      {bulkBusy[sid] ? "Sending…" : "Send requests"}
                    </button>
                  )}

                  {onViewStudent && (
                    <button
                      type="button"
                      onClick={() => onViewStudent(sid)}
                      className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:border-[#cc785c] hover:text-[#cc785c]"
                    >
                      <ExternalLink className="h-4 w-4" /> View this student's profile
                    </button>
                  )}
                  {onViewTasks && (
                    <button
                      type="button"
                      onClick={() => onViewTasks(sid, name)}
                      className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:border-[#cc785c] hover:text-[#cc785c]"
                    >
                      <ClipboardList className="h-4 w-4" /> View tasks related to this student
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ── Column headers ─────────────────────────── */}
            {docs && docs.length > 0 && (
              <div
                className="grid items-center border-b border-stone-200 bg-stone-100 px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] text-black"
                style={{ gridTemplateColumns: "1fr 160px 200px 24px" }}
              >
                <span>Document</span>
                <span>Date Submitted</span>
                <span>Status</span>
                <span />
              </div>
            )}

            {/* ── Document rows ──────────────────────────── */}
            {!docs ? (
              <div className="flex items-center gap-2 px-5 py-4 text-xs text-black">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading documents…
              </div>
            ) : docs.length === 0 ? (
              <p className="px-5 py-4 text-xs  text-black">No required documents.</p>
            ) : (
              docs.map((doc, idx) => {
                const isOpen = expanded.has(doc.id);
                const { label, cls } = docStatus(doc);
                const heading = docHeading(doc);
                const isLast  = idx === docs.length - 1;

                return (
                  <div key={doc.id} className={!isLast ? "border-b border-stone-200" : ""}>

                    {/* Row header — always visible */}
                    <button
                      type="button"
                      onClick={() => toggleExpand(doc.id)}
                      className="grid w-full items-center px-5 py-4 text-left transition hover:bg-stone-50"
                      style={{ gridTemplateColumns: "1fr 160px 200px 24px" }}
                    >
                      {/* Doc type */}
                      <span className="text-base font-semibold text-black">
                        {heading}
                      </span>

                      {/* Date submitted */}
                      <span className="text-base font-medium text-black">
                        {humanDate(doc.created_at)}
                      </span>

                      {/* Status badge */}
                      <span className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-sm font-semibold ${cls}`}>
                        {(doc.final_file_id || doc.approved_by_admin_at) && <CheckCircle2 className="h-3.5 w-3.5" />}
                        {doc.requested_at && !doc.final_file_id          && <Clock         className="h-3.5 w-3.5" />}
                        {label}
                      </span>

                      {/* Chevron */}
                      <ChevronDown className={`h-4 w-4 shrink-0 text-black transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
                    </button>

                    {/* Expanded detail */}
                    {isOpen && (
                      <div className="border-t border-stone-100 px-5 pb-5 pt-4">
                        <DocCardBody
                          doc={doc}
                          draft={drafts[doc.id] ?? ""}
                          onDraftChange={v => setDrafts(p => ({ ...p, [doc.id]: v }))}
                          onSave={() => saveDraft(sid, doc.id)}
                          onToggleDone={() => toggleDone(sid, doc)}
                          onToggleApprove={() => toggleApprove(sid, doc)}
                          canApprove={role === "admin"}
                          busy={!!busy[doc.id]}
                          role={role}
                        />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── counsellor assignment row (admin: dropdown + save; counsellor: read-only) ─

function CounsellorAssign({ student, counsellors, role, onAssigned }) {
  const currentId   = student.counsellor_id;
  const currentName = counsellors.find(c => c.id === currentId)?.name;
  const [selected,  setSelected]  = useState(currentId || "");
  const [busy,      setBusy]      = useState(false);
  const [assignErr, setAssignErr] = useState(null);

  const changed = selected !== (currentId || "");

  const assign = async () => {
    setBusy(true);
    setAssignErr(null);
    try {
      await api.assignStudentCounsellor(student.student_id, selected || null);
      onAssigned?.();
    } catch (e) {
      setAssignErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (role !== "admin") {
    return (
      <p className="text-sm text-black">
        Counsellor:{" "}
        <span className="font-semibold text-black">{currentName || "None assigned"}</span>
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {currentName ? (
        <span className="text-sm text-black">
          Counsellor: <span className="font-semibold text-black">{currentName}</span>
        </span>
      ) : (
        <span className="text-base font-semibold text-black">No counsellor assigned</span>
      )}
      <select
        value={selected}
        onChange={e => setSelected(e.target.value)}
        className="border border-stone-300 bg-white px-3 py-1.5 text-sm text-black outline-none focus:border-[#cc785c]"
      >
        <option value="">— Assign counsellor —</option>
        {counsellors.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {changed && (
        <button
          type="button"
          onClick={assign}
          disabled={busy}
          className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          Save
        </button>
      )}
      {assignErr && <span className="text-xs text-red-700">{assignErr}</span>}
    </div>
  );
}

// ─── doc card body (no outer border / heading — those live in the row) ─────

function DocCardBody({ doc, draft, onDraftChange, onSave, onToggleDone, onToggleApprove, canApprove, busy }) {
  const isSop  = doc.kind === "sop";
  const dirty  = (draft || "") !== (doc.staff_draft || "");
  const words  = draft ? draft.trim().split(/\s+/).filter(Boolean).length : 0;
  const heading = docHeading(doc);

  return (
    <div className="space-y-5">

      {/* Student brief — LOR */}
      {doc.kind === "lor" && (
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-black">
            Context from student
          </p>
          <div className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 border border-stone-200 bg-stone-50 px-5 py-4 text-sm">
            <span className="text-black">Recommender</span>
            <span className="text-black">{doc.recipient_name || "—"}</span>
            <span className="text-black">Position / Subject</span>
            <span className="text-black">{doc.recipient_role || "—"}</span>
            <span className="text-black">Student's reason</span>
            <span className="text-black">{doc.reason_brief   || "—"}</span>
          </div>
        </div>
      )}

      {/* Student brief — Internship */}
      {doc.kind === "internship" && (
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-black">
            Context from student
          </p>
          <div className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 border border-stone-200 bg-stone-50 px-5 py-4 text-sm">
            <span className="text-black">Company</span>
            <span className="text-black">{doc.company_name    || "—"}</span>
            <span className="text-black">Website</span>
            <span className="text-black">{doc.company_website || "—"}</span>
            <span className="text-black">What they did</span>
            <span className="text-black">{doc.activity_brief  || "—"}</span>
          </div>
        </div>
      )}

      {/* SOP note */}
      {isSop && (
        <p className="border-l-4 border-stone-300 pl-4 text-sm  text-black">
          Use the student's academic record, activities, internships, and personal summary from their intake to draft a complete Statement of Purpose. Admin approval is required before this is shown to the student.
        </p>
      )}

      {/* Draft area */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-black">
            {isSop ? "SOP draft" : "Document draft"}
          </p>
          {words > 0 && <span className="text-[10px] text-black">{words} words</span>}
        </div>
        <AutoTextarea
          value={draft}
          onChange={e => onDraftChange(e.target.value)}
          minRows={5}
          placeholder={
            isSop
              ? "Write the full Statement of Purpose here. Admin must approve before it is shown to the student."
              : `Write the full ${heading} here. The student will have this printed on official letterhead and signed.`
          }
          className="w-full border border-stone-300 bg-[#faf9f5] px-4 py-3 font-serif text-sm leading-relaxed text-black outline-none focus:border-stone-700"
        />
        {dirty && <p className="mt-1 text-[11px]  text-amber-700">Unsaved changes</p>}
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
        <button
          type="button" onClick={onSave} disabled={!dirty || busy}
          className="inline-flex items-center gap-2 border border-stone-700 bg-white px-4 py-2 text-xs uppercase tracking-[0.15em] text-black transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save draft
        </button>

        {!isSop && (
          <button
            type="button" onClick={onToggleDone}
            disabled={busy || !!doc.requested_at}
            title={doc.requested_at ? "Already sent — cannot undo" : ""}
            className={`inline-flex items-center gap-2 border px-4 py-2 text-xs uppercase tracking-[0.15em] transition disabled:cursor-not-allowed disabled:opacity-40 ${
              doc.marked_done_at
                ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                : "border-stone-400 bg-white text-black hover:border-stone-700"
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {doc.marked_done_at ? "Done — click to undo" : "Mark done"}
          </button>
        )}

        {isSop && canApprove && (
          <button
            type="button" onClick={onToggleApprove}
            disabled={busy || !doc.staff_draft}
            title={!doc.staff_draft ? "Save a draft first" : ""}
            className={`inline-flex items-center gap-2 border px-4 py-2 text-xs uppercase tracking-[0.15em] transition disabled:cursor-not-allowed disabled:opacity-40 ${
              doc.approved_by_admin_at
                ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                : "border-stone-400 bg-white text-black hover:border-stone-700"
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {doc.approved_by_admin_at ? "Approved — click to un-approve" : "Approve SOP"}
          </button>
        )}

        {isSop && !canApprove && (
          <span className="text-xs  text-black">
            Admin must approve this SOP before it appears on the student's profile.
          </span>
        )}

        {doc.final_file_id && (
          <span className="ml-auto flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Final document uploaded by student
          </span>
        )}
      </div>
    </div>
  );
}
