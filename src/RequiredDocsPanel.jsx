// RequiredDocsPanel — staff workspace for LOR / Internship / SOP drafts.
// Tab: "Student Document To Process" (admin + counsellor)
// Layout: accordion list — one collapsible row per document across all students.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2, AlertCircle, CheckCircle2, Clock,
  Send, Save, Check, ChevronDown, ExternalLink, ClipboardList,
} from "lucide-react";
import { api } from "./api.js";

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

// Returns { label, cls } for the badge shown in both the row header and card.
function docStatus(doc) {
  if (doc.kind === "sop") {
    if (doc.approved_by_admin_at) return { label: "Approved",               cls: "bg-emerald-50 text-emerald-800 border-emerald-300" };
    if (doc.staff_draft)          return { label: "Awaiting admin approval", cls: "bg-amber-50 text-amber-800 border-amber-300" };
    return                               { label: "Awaiting draft",          cls: "bg-stone-100 text-stone-500 border-stone-300" };
  }
  if (doc.final_file_id)   return { label: "Complete",               cls: "bg-emerald-50 text-emerald-800 border-emerald-300" };
  if (doc.requested_at) {
    const left   = businessDaysLeft(doc.deadline_at);
    const urgent = left !== null && left <= 1;
    const label  = left === null   ? `Sent — due ${humanDate(doc.deadline_at)}`
                 : left < 0        ? `Overdue ${Math.abs(left)}d`
                 : left === 0      ? "Due today"
                 :                   `Day ${5 - left} of 5`;
    return { label, cls: urgent ? "bg-red-50 text-red-800 border-red-300" : "bg-blue-50 text-blue-800 border-blue-300" };
  }
  if (doc.marked_done_at) return { label: "Ready to send",   cls: "bg-amber-50 text-amber-800 border-amber-300" };
  if (doc.staff_draft)    return { label: "Draft in progress", cls: "bg-stone-100 text-stone-500 border-stone-300" };
  return                         { label: "Awaiting draft",   cls: "bg-stone-100 text-stone-500 border-stone-300" };
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

export default function RequiredDocsPanel({ role, onViewStudent, onViewTasks }) {
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
    <div className="flex items-center gap-2 text-sm text-stone-400">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );

  if (students.length === 0) return (
    <p className="text-sm italic text-stone-500">No students have completed intake yet.</p>
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
              {/* Top row: name + status + send button */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${OVERALL_DOT[status]}`} />
                  <span className="text-lg font-bold text-stone-900">{name}</span>
                  <span className="rounded border border-[#cc785c]/40 bg-[#cc785c]/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.15em] text-[#cc785c]">
                    {OVERALL_LABEL[status]}
                  </span>
                  {!docs && <Loader2 className="h-3.5 w-3.5 animate-spin text-stone-400" />}
                </div>

                {(lors.length > 0 || interns.length > 0) && (
                  <button
                    type="button"
                    onClick={() => sendBulk(sid, name)}
                    disabled={!allLIDone || !anyLIPending || !!bulkBusy[sid]}
                    className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-1.5 text-xs uppercase tracking-[0.15em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {bulkBusy[sid] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    {bulkBusy[sid] ? "Sending…" : "Send requests"}
                  </button>
                )}
              </div>

              {/* Bottom row: counsellor + quick links */}
              <div className="mt-2.5 flex flex-wrap items-center gap-4">
                {student.counsellor_name && (
                  <span className="text-sm text-stone-700">
                    <span className="font-semibold text-stone-500 uppercase tracking-wide text-[11px]">Counsellor: </span>
                    <span className="font-semibold text-stone-900">{student.counsellor_name}</span>
                  </span>
                )}
                {!student.counsellor_name && (
                  <span className="text-xs italic text-stone-400">No counsellor assigned</span>
                )}

                <div className="ml-auto flex items-center gap-2">
                  {onViewStudent && (
                    <button
                      type="button"
                      onClick={() => onViewStudent(sid)}
                      className="inline-flex items-center gap-1.5 border border-stone-300 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-700 transition hover:border-[#cc785c] hover:text-[#cc785c]"
                    >
                      <ExternalLink className="h-3 w-3" /> View profile
                    </button>
                  )}
                  {onViewTasks && (
                    <button
                      type="button"
                      onClick={() => onViewTasks(sid)}
                      className="inline-flex items-center gap-1.5 border border-stone-300 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-700 transition hover:border-[#cc785c] hover:text-[#cc785c]"
                    >
                      <ClipboardList className="h-3 w-3" /> View tasks
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ── Column headers ─────────────────────────── */}
            {docs && docs.length > 0 && (
              <div
                className="grid items-center border-b border-stone-200 bg-stone-100 px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] text-stone-700"
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
              <div className="flex items-center gap-2 px-5 py-4 text-xs text-stone-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading documents…
              </div>
            ) : docs.length === 0 ? (
              <p className="px-5 py-4 text-xs italic text-stone-400">No required documents.</p>
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
                      <span className="text-base font-semibold text-stone-900">
                        {heading}
                      </span>

                      {/* Date submitted */}
                      <span className="text-sm font-medium text-stone-700">
                        {humanDate(doc.created_at)}
                      </span>

                      {/* Status badge */}
                      <span className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-semibold ${cls}`}>
                        {(doc.final_file_id || doc.approved_by_admin_at) && <CheckCircle2 className="h-3.5 w-3.5" />}
                        {doc.requested_at && !doc.final_file_id          && <Clock         className="h-3.5 w-3.5" />}
                        {label}
                      </span>

                      {/* Chevron */}
                      <ChevronDown className={`h-4 w-4 shrink-0 text-stone-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
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
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
            Context from student
          </p>
          <div className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 border border-stone-200 bg-stone-50 px-5 py-4 text-sm">
            <span className="text-stone-400">Recommender</span>
            <span className="text-stone-800">{doc.recipient_name || <em className="text-stone-400">—</em>}</span>
            <span className="text-stone-400">Position / Subject</span>
            <span className="text-stone-800">{doc.recipient_role || <em className="text-stone-400">—</em>}</span>
            <span className="text-stone-400">Student's reason</span>
            <span className="text-stone-800">{doc.reason_brief   || <em className="text-stone-400">—</em>}</span>
          </div>
        </div>
      )}

      {/* Student brief — Internship */}
      {doc.kind === "internship" && (
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
            Context from student
          </p>
          <div className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 border border-stone-200 bg-stone-50 px-5 py-4 text-sm">
            <span className="text-stone-400">Company</span>
            <span className="text-stone-800">{doc.company_name    || <em className="text-stone-400">—</em>}</span>
            <span className="text-stone-400">Website</span>
            <span className="text-stone-800">{doc.company_website || <em className="text-stone-400">—</em>}</span>
            <span className="text-stone-400">What they did</span>
            <span className="text-stone-800">{doc.activity_brief  || <em className="text-stone-400">—</em>}</span>
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
          {words > 0 && <span className="text-[10px] text-stone-400">{words} words</span>}
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
          className="w-full border border-stone-300 bg-[#faf9f5] px-4 py-3 font-serif text-sm leading-relaxed text-stone-900 outline-none focus:border-stone-700"
        />
        {dirty && <p className="mt-1 text-[11px] italic text-amber-700">Unsaved changes</p>}
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
        <button
          type="button" onClick={onSave} disabled={!dirty || busy}
          className="inline-flex items-center gap-2 border border-stone-700 bg-white px-4 py-2 text-xs uppercase tracking-[0.15em] text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
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
                : "border-stone-400 bg-white text-stone-700 hover:border-stone-700"
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
            <CheckCircle2 className="h-3.5 w-3.5" /> Final document uploaded by student
          </span>
        )}
      </div>
    </div>
  );
}
