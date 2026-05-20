// RequiredDocsPanel — staff workspace for LOR / Internship / NGO /
// Extracurricular / SOP rows. Upload-only flow now: the counsellor / admin
// uploads the Word draft, the student gets it signed on letterhead, then
// uploads the signed copy from their dashboard. This panel mirrors the
// compact chip layout used in StudentsAdmin → RecommendedDocsStep so the
// staff sees the same lifecycle everywhere.
//
// One section per student (collapsible header + per-kind sub-sections),
// each row shows: slot label · signed-status (red until the student has
// uploaded the stamped copy, opens the lifecycle popup) · admin-approve
// toggle · WhatsApp button · the student's email · Send. WhatsApp + Send
// are placeholders today — they will wire to the messaging stack once that
// lands.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2, AlertCircle, CheckCircle2, Clock,
  Send, ExternalLink, ClipboardList, MessageCircle, Mail, Phone, FileText,
} from "lucide-react";
import { api } from "./api.js";
import RecommendedDocPopup from "./RecommendedDocPopup.jsx";

// Doc kinds + section labels — the order here is the order rendered on
// every student panel. Matches StudentsAdmin's RecommendedDocsStep so a
// counsellor switching between the two surfaces sees the same shape.
const KINDS = [
  { kind: "lor",             label: "Letters of Recommendation", short: "LOR" },
  { kind: "internship",      label: "Internship certificates",   short: "Internship" },
  { kind: "ngo",             label: "NGO letters",               short: "NGO" },
  { kind: "extracurricular", label: "Extracurricular letters",   short: "Extracurricular" },
  { kind: "sop",             label: "Statement of Purpose",      short: "SOP" },
];

function slotLabel(doc) {
  if (doc.kind === "sop") return "SOP";
  const k = KINDS.find(k => k.kind === doc.kind);
  return `${k?.short || doc.kind} ${doc.seq}`;
}

function humanDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

// Pull email + phone out of the student's intake JSON. Either field can be
// missing; the WhatsApp / Send buttons gate themselves on these existing.
function studentContact(student) {
  const data = student?.data?.answers || student?.data || {};
  return {
    email: data.email || null,
    phone: data.phone || null,
  };
}

// Status pill copy + tone. Driven entirely by the upload state — the
// staff workflow is "draft uploaded by counsellor → student gets it signed
// → student uploads the signed copy". A row with no file at all is bright
// red because nothing has happened yet; a row with a draft but no signed
// copy is amber (chasing the student); a row with both is green.
function signedStatus(doc) {
  if (doc.signed_file_id) {
    return { label: "Signed received", tone: "bg-emerald-50 text-emerald-800 border-emerald-400" };
  }
  if (doc.final_file_id && doc.requested_at) {
    return { label: "Waiting on signed copy", tone: "bg-amber-50 text-amber-800 border-amber-400" };
  }
  if (doc.final_file_id) {
    return { label: "Draft ready — not sent", tone: "bg-amber-50 text-amber-800 border-amber-400" };
  }
  return { label: "Not signed", tone: "bg-red-50 text-red-800 border-red-400" };
}

// ─── main panel ────────────────────────────────────────────────────────────

export default function RequiredDocsPanel({ role, counsellors = [], onViewStudent, onViewTasks }) {
  const [students,   setStudents]   = useState(null);
  const [err,        setErr]        = useState(null);
  const [docsMap,    setDocsMap]    = useState({});       // { studentId: doc[] }
  const [bulkBusy,   setBulkBusy]   = useState({});       // { studentId: bool }
  const [actionErr,  setActionErr]  = useState(null);
  const [popup,      setPopup]      = useState(null);     // { studentId, doc }

  const mergeStudentDocs = useCallback((studentId, docs) => {
    setDocsMap(p => ({ ...p, [studentId]: docs }));
  }, []);

  const refreshStudent = useCallback(async (studentId) => {
    const docs = await api.listRequiredDocsForStudent(studentId);
    mergeStudentDocs(studentId, docs);
    setPopup(prev => {
      if (!prev || prev.studentId !== studentId) return prev;
      const fresh = docs.find(d => String(d.id) === String(prev.doc.id));
      return fresh ? { studentId, doc: fresh } : null;
    });
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

  const sendBulk = async (studentId, studentName) => {
    if (!confirm(
      `Send all uploaded LOR / Internship / NGO drafts to ${studentName}?\n\n` +
      `They will have 5 business days to collect signatures and upload the signed copies.`
    )) return;
    setBulkBusy(p => ({ ...p, [studentId]: true }));
    setActionErr(null);
    try {
      await api.sendRequiredDocRequests(studentId);
      await refreshStudent(studentId);
    } catch (e) { setActionErr(e.message); }
    finally     { setBulkBusy(p => ({ ...p, [studentId]: false })); }
  };

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
    <p className="text-sm text-black">No students have completed intake yet.</p>
  );

  return (
    <div className="space-y-5">
      <p className="text-sm text-stone-800">
        Upload a Word document of each LOR / Internship / NGO / Extracurricular letter / SOP — rather than a signed PDF or image.
        The student gets it printed on letterhead and signed, then uploads the stamped copy from their dashboard.
      </p>

      {actionErr && (
        <p className="flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4" /> {actionErr}
        </p>
      )}

      {students.map(student => {
        const sid  = student.student_id;
        const name = student.display_name || student.username;
        const docs = docsMap[sid];
        const contact = studentContact(student);

        const allReady     = (docs || []).filter(d => d.kind !== "sop").every(d => !!d.final_file_id);
        const anyUnsent    = (docs || []).some(d => d.kind !== "sop" && d.final_file_id && !d.requested_at);

        return (
          <div key={sid} className="border border-stone-300 bg-white">

            {/* ── Student header ─────────────────────────── */}
            <div className="border-b border-stone-300 bg-[#fdf8f4] px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">

                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xl font-bold text-black">{name}</span>
                    {!docs && <Loader2 className="h-4 w-4 animate-spin text-black" />}
                  </div>

                  {/* Counsellor row */}
                  <CounsellorAssign
                    student={student}
                    counsellors={counsellors}
                    role={role}
                    onAssigned={() => refreshStudent(sid).then(() =>
                      api.listStudents().then(list => {
                        const ready = list.filter(s => s.intake_complete);
                        setStudents(ready);
                      }).catch(() => {})
                    )}
                  />

                  {(contact.email || contact.phone) && (
                    <p className="text-sm text-black">
                      {contact.email && (
                        <span className="inline-flex items-center gap-1.5 mr-4">
                          <Mail className="h-3.5 w-3.5" /> {contact.email}
                        </span>
                      )}
                      {contact.phone && (
                        <span className="inline-flex items-center gap-1.5">
                          <Phone className="h-3.5 w-3.5" /> {contact.phone}
                        </span>
                      )}
                    </p>
                  )}
                </div>

                {/* Right: stacked action buttons */}
                <div className="flex flex-col items-end gap-2">
                  <button
                    type="button"
                    onClick={() => sendBulk(sid, name)}
                    disabled={!docs || !allReady || !anyUnsent || !!bulkBusy[sid]}
                    title={!allReady ? "Upload a draft for every LOR / Internship / NGO row first." : !anyUnsent ? "Every uploaded draft has already been sent." : ""}
                    className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-sm font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {bulkBusy[sid] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {bulkBusy[sid] ? "Sending…" : "Send all to student"}
                  </button>

                  {onViewStudent && (
                    <button
                      type="button"
                      onClick={() => onViewStudent(sid)}
                      className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:border-[#cc785c] hover:text-[#cc785c]"
                    >
                      <ExternalLink className="h-4 w-4" /> View student profile
                    </button>
                  )}
                  {onViewTasks && (
                    <button
                      type="button"
                      onClick={() => onViewTasks(sid, name)}
                      className="inline-flex items-center gap-2 border border-stone-400 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:border-[#cc785c] hover:text-[#cc785c]"
                    >
                      <ClipboardList className="h-4 w-4" /> View tasks for this student
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ── Per-kind sections ─────────────────────── */}
            {!docs ? (
              <div className="flex items-center gap-2 px-5 py-4 text-sm text-black">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading documents…
              </div>
            ) : docs.length === 0 ? (
              <p className="px-5 py-4 text-sm text-black">No required documents yet for this student.</p>
            ) : (
              <div className="space-y-6 px-5 py-5">
                {KINDS.map(group => {
                  const rows = docs.filter(d => d.kind === group.kind).sort((a, b) => a.seq - b.seq);
                  if (rows.length === 0) return null;
                  return (
                    <DocKindSection
                      key={group.kind}
                      label={group.label}
                      rows={rows}
                      contact={contact}
                      role={role}
                      onOpenDoc={(doc) => setPopup({ studentId: sid, doc })}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {popup && (
        <RecommendedDocPopup
          doc={popup.doc}
          studentId={popup.studentId}
          role={role}
          onClose={() => setPopup(null)}
          onRefresh={() => refreshStudent(popup.studentId)}
        />
      )}
    </div>
  );
}

// ─── per-kind section ──────────────────────────────────────────────────────

function DocKindSection({ label, rows, contact, role, onOpenDoc }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-black">{label}</h3>
        <WhatsappButton phone={contact.phone} compact label={`WhatsApp ${label.toLowerCase()}`} />
      </div>
      <div className="border border-stone-200 bg-white">
        {rows.map((row, i) => (
          <DocRow
            key={row.id}
            doc={row}
            contact={contact}
            role={role}
            onOpen={() => onOpenDoc(row)}
            isLast={i === rows.length - 1}
          />
        ))}
      </div>
    </section>
  );
}

// ─── one row ───────────────────────────────────────────────────────────────
// LOR1 · [Signed-status pill, red until uploaded] · [Approve] · [WhatsApp] · [email] · [Send]

function DocRow({ doc, contact, role, onOpen, isLast }) {
  const status   = signedStatus(doc);
  const approved = !!doc.approved_by_admin_at;
  const canApprove = role === "admin" && !!doc.final_file_id;

  return (
    <div className={`grid items-center gap-3 px-4 py-3 ${!isLast ? "border-b border-stone-100" : ""}`}
         style={{ gridTemplateColumns: "8rem minmax(0, 1fr) auto auto auto auto" }}>

      {/* Slot label */}
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 shrink-0 text-stone-600" />
        <span className="text-base font-semibold text-black">{slotLabel(doc)}</span>
      </div>

      {/* Signed-status pill — clickable, opens lifecycle popup */}
      <button
        type="button"
        onClick={onOpen}
        className={`inline-flex items-center justify-start gap-2 border-2 px-3 py-2 text-sm font-bold uppercase tracking-[0.12em] transition hover:brightness-95 ${status.tone}`}
        title="Open lifecycle: draft, signatures, signed copy, timestamps"
      >
        {doc.signed_file_id
          ? <CheckCircle2 className="h-4 w-4" />
          : doc.final_file_id
            ? <Clock className="h-4 w-4" />
            : <AlertCircle className="h-4 w-4" />}
        <span className="truncate">{status.label}</span>
      </button>

      {/* Approved-by-admin toggle */}
      <ApproveToggle doc={doc} canApprove={canApprove} approved={approved} onChanged={onOpen} />

      {/* WhatsApp — no-op for now (waiting on messaging stack) */}
      <WhatsappButton phone={contact.phone} />

      {/* Email (student's intake email) */}
      <span className="inline-flex items-center gap-1.5 border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-sm text-black">
        <Mail className="h-3.5 w-3.5 text-stone-600" />
        <span className="truncate max-w-[14rem]">{contact.email || "—"}</span>
      </span>

      {/* Send (no-op for now; gated on file + at least one channel) */}
      <SendButton doc={doc} contact={contact} />
    </div>
  );
}

// Approve toggle — admin-only; greyed for counsellor or when there is no
// uploaded draft yet. Read-only chip otherwise.
function ApproveToggle({ doc, canApprove, approved, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const toggle = async () => {
    if (!canApprove) return;
    setBusy(true); setErr(null);
    try {
      await api.approveRequiredDoc(doc.id, approved);
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Couldn't update approval");
    } finally {
      setBusy(false);
    }
  };

  const base = "inline-flex items-center gap-1.5 border-2 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.1em] transition";
  if (!canApprove) {
    return (
      <span className={`${base} ${approved ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-stone-300 bg-stone-100 text-stone-600"}`}>
        {approved ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
        {approved ? "Approved" : "Not approved"}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={err || (approved ? "Click to un-approve" : "Mark approved by admin")}
      className={`${base} ${approved ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800" : "border-stone-400 bg-white text-black hover:border-stone-700"} disabled:opacity-50`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : approved ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
      {approved ? "Approved" : "Approve"}
    </button>
  );
}

// WhatsApp button — no-op for now (the messaging integration isn't wired
// yet). Disabled if we don't have a phone number; otherwise a button that
// the staff can mentally point at while the backend lands.
function WhatsappButton({ phone, compact = false, label = "WhatsApp" }) {
  const onClick = () => {
    // Intentional placeholder. WhatsApp send is on the backlog — wiring
    // would post to a messaging route that templates the doc download
    // + a chase note. Keeping it inert until that endpoint exists.
  };
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={!phone}
        title={phone ? label : "No phone number on file"}
        className="inline-flex items-center gap-1.5 border border-emerald-600 bg-white px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!phone}
      title={phone ? `WhatsApp ${phone}` : "No phone number on file"}
      className="inline-flex items-center gap-1.5 border-2 border-emerald-600 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.1em] text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
    </button>
  );
}

// Send button — would dispatch the uploaded draft to the student's email
// and WhatsApp. Inert today; gated on having a file + at least one
// channel + an uploaded draft.
function SendButton({ doc, contact }) {
  const hasDraft = !!doc.final_file_id;
  const hasChannel = !!(contact.email || contact.phone);
  const disabled = !hasDraft || !hasChannel;
  const title = !hasDraft
    ? "Upload the Word draft first"
    : !hasChannel
      ? "No email or phone on file"
      : `Send draft to ${[contact.email, contact.phone].filter(Boolean).join(" · ")}`;
  return (
    <button
      type="button"
      onClick={() => { /* placeholder until messaging endpoint exists */ }}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 border-2 border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-xs font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Send className="h-3.5 w-3.5" /> Send
    </button>
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
