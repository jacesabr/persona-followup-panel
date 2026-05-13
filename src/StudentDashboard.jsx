// Post-intake landing screen for the student. Shows everything the
// student submitted — intake answers grouped by chapter/page and every
// uploaded document with a title + description.
//
// The resume display + regenerate flow lives in the staff panel; the
// student-facing view is purely a recap of what they submitted.
//
// Always fetches from /me/* endpoints — there was previously a
// `staffPreview` mode that doubled this as the admin "View as student"
// surface, but that overlay was removed (clicking a student row in
// the Students tab now opens the canonical slide-by-slide review).
// The branch lived on as dead code and is gone now.

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  Loader2,
  AlertTriangle,
  LogOut,
  Paperclip,
  Clock,
  CheckCircle2,
  Upload,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Document, Page } from "react-pdf";
import { PhotoProvider, PhotoView } from "react-photo-view";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { loadRecord, listMyFiles, listResumes, uploadFile } from "./intakeFiles.js";
import { CHAPTERS, isFieldVisible } from "../lib/intakeSchema.js";
import ResumeMarkdown from "./ResumeMarkdown.jsx";
import ResumePdfPicker from "./resumePdf/index.jsx";
import { api } from "./api.js";
import { computeRequiredDocState } from "../lib/requiredDocStatus.js";

const POLL_INTERVAL_MS = 4000;

// Plain-English description shown beneath every uploaded document
// (admin or student view). Keyed by the leaf field id, so repeater
// uploads like "activities_list[3].proof" resolve to "proof". Use
// concise, jargon-light copy — counsellors / admins read these to
// remind themselves what each artifact is supposed to be.
const DOC_SUMMARIES = {
  aadharFile: "Government-issued 12-digit unique identity number (UIDAI). Used as proof of identity, address, and date of birth in India.",
  photoFile: "Recent passport-style photograph of the applicant. Universities use this for ID cards and admission packets.",
  panFile: "PAN card — Permanent Account Number issued by India's Income Tax Department. Used as a tax identifier.",
  passportFront: "Passport bio-data page (photo + personal info). Required for visa filing and university i20 paperwork.",
  passportBack: "Passport address page. Pairs with the front page in any international application packet.",
  marks10sheet: "Class 10 marksheet (CBSE / ICSE / State Board). Official secondary-examination transcript.",
  marks11sheet: "Class 11 report card. Universities use it to confirm progression into Class 12.",
  marks12sheet: "Class 12 marksheet — the qualifying transcript for undergraduate admissions.",
  cgpaSheet: "Undergraduate transcript / consolidated mark sheet, used for postgraduate applications.",
  ieltsCert: "IELTS Test Report Form (TRF). Confirms English-language proficiency for international universities.",
  testScore: "Standardised test score report (SAT / ACT / GRE / GMAT etc.) attached to the application.",
  proof: "Certificate or document evidencing this co-curricular activity, achievement, or course.",
};
function getDocSummary(fieldId) {
  if (!fieldId) return null;
  const leaf = String(fieldId).split(".").pop().split("[")[0];
  return DOC_SUMMARIES[leaf] || DOC_SUMMARIES[fieldId] || null;
}

// `section` restricts rendering to a single block (PanelTabs always
// sets it):
//   "summary"        — application summary only
//   "documents"      — uploaded-file previews only
//   "required-docs"  — LOR / internship / SOP lifecycle only
//   "resume"         — generated resume only
export default function StudentDashboard({ studentName, onExit, embedded = false, section = null }) {
  const [files, setFiles] = useState(null);
  const [answers, setAnswers] = useState(null);
  const [resumes, setResumes] = useState(null);
  const [requiredDocs, setRequiredDocs] = useState(null);
  const [myApplications, setMyApplications] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [fileList, record, resumeList, reqDocs, apps] = await Promise.all([
        listMyFiles(),
        loadRecord().catch(() => ({ data: {} })),
        listResumes().catch(() => []),
        api.listMyRequiredDocs().catch(() => []),
        api.listMyApplications().catch(() => []),
      ]);
      setFiles(fileList);
      setAnswers(extractAnswers(record?.data));
      setResumes(resumeList);
      setRequiredDocs(reqDocs);
      setMyApplications(apps);
      setError(null);
    } catch (e) {
      setError(e?.message || "Couldn't load your information.");
    }
  }, []);

  // Keep `resumes` reachable inside the polling tick without putting
  // it in the effect's deps. The previous version listed `resumes` in
  // the dep array; every load() call setResumes() with a new array
  // identity, which retore down + re-armed the interval (and called
  // load() again) on every tick — burning ~1 API call per second on
  // top of the intended 4s cadence. Now the interval owns the timer
  // for the lifetime of the component and just reads the latest value
  // from the ref each tick.
  const resumesRef = useRef(resumes);
  useEffect(() => { resumesRef.current = resumes; }, [resumes]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
    pollRef.current = setInterval(() => {
      const r = resumesRef.current;
      const inflight = (r || []).some(
        (x) => x.status === "pending" || x.status === "running"
      );
      if (r === null || inflight) load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [load]);

  const latestResume = (resumes || [])[0] || null;

  // Group every answered field under its chapter/page using the schema
  // so the rendered layout mirrors the order of the intake form.
  const grouped = useMemo(() => groupAnswersBySchema(answers || {}), [answers]);

  // Compact urgency strip: surface required-doc rows in their deadline
  // window (Day 3+ of 5) and application deadlines within 14 days. The
  // student would otherwise have to scroll past the full intake recap to
  // discover what's actually time-sensitive.
  const urgentItems = useMemo(
    () => collectUrgentItems({ requiredDocs, applications: myApplications }),
    [requiredDocs, myApplications]
  );

  // Field-id → field metadata, so the docs list can show a friendly
  // title (e.g. "Aadhar card scan" instead of "aadharFile") next to
  // the original filename.
  const fieldIndex = useMemo(() => buildFieldIndex(), []);

  const headerName = studentName || "student";

  // Embedded mode: rendered inside PanelTabsView (the post-intake tabs
  // wrapper). The wrapper supplies its own brand/sign-out/tabs header,
  // so we skip ours here and drop the page background.
  return (
    <div
      className={
        embedded
          ? "w-full font-serif text-black"
          : "min-h-screen w-full font-serif text-black"
      }
      style={embedded ? undefined : { backgroundColor: "#f4f0e6" }}
    >
      {!embedded && (
        <header className="border-b border-stone-900/10 bg-[#f4f0e6]/80 px-6 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-sm  text-black">the</span>
              <span className="text-lg font-semibold tracking-tight">Persona</span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-black">
                · {headerName}
              </span>
            </div>
            <button
              type="button"
              onClick={onExit}
              className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-black hover:text-black"
            >
              <LogOut className="h-3 w-3" /> Sign out
            </button>
          </div>
        </header>
      )}

      <main className={`mx-auto ${embedded ? "max-w-3xl px-0 py-2" : "max-w-3xl px-6 py-12"}`}>
        {!section && (
          <h1 className="font-serif text-3xl">{headerName}</h1>
        )}

        {error && (
          <p className="mt-6 inline-flex items-center gap-2 text-xs text-red-700">
            <AlertTriangle className="h-3 w-3" /> {error}
          </p>
        )}

        {!section && urgentItems.length > 0 && (
          <UrgentItemsStrip items={urgentItems} />
        )}

        {(!section || section === "summary") && (
          <section className={section ? "" : "mt-10"}>
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Your application — summary</h2>
            <p className="mt-1 text-sm text-stone-800">
              Everything you've submitted so far, grouped the way you filled it out.
            </p>
            <div className="mt-5 space-y-5">
              {answers === null ? (
                <div className="flex items-center gap-2 border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                </div>
              ) : grouped.length === 0 ? (
                <p className="border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">
                  No answers recorded yet.
                </p>
              ) : (
                grouped.map((chapter) => (
                  <ChapterSummaryBlock
                    key={chapter.id}
                    chapter={chapter}
                    studentId={null}
                  />
                ))
              )}
            </div>
          </section>
        )}

        {(!section || section === "documents") && (
          <section className={section ? "" : "mt-12"}>
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Your documents</h2>
            <p className="mt-1 text-sm text-stone-800">
              Every file you uploaded, rendered inline. Images appear as photos, PDFs render as readable previews.
            </p>
            <div className="mt-5 space-y-6">
              {files === null ? (
                <div className="flex items-center gap-2 border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                </div>
              ) : files.length === 0 ? (
                <p className="border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">
                  No documents uploaded.
                </p>
              ) : (
                files.map((f) => (
                  <DocumentPreview
                    key={f.id}
                    file={f}
                    fieldIndex={fieldIndex}
                    studentId={null}
                  />
                ))
              )}
            </div>
          </section>
        )}

        {(!section || section === "required-docs") && requiredDocs && requiredDocs.length > 0 && (
          <section className={section ? "" : "mt-10"}>
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Required documents</h2>
            <p className="mt-1 text-sm text-stone-800">
              Letters of recommendation, internship documents, and your statement of purpose. You'll see status updates here as your counsellor drafts each one.
            </p>
            <RequiredDocsBlock
              docs={requiredDocs}
              studentId={null}
              onAfterChange={load}
            />
          </section>
        )}

        {/* Show the LOR suggestions block even when the student has no
            other required-docs yet, so a freshly auto-filled student
            sees the proposed recommenders immediately. */}
        {(!section || section === "required-docs") && requiredDocs && requiredDocs.length === 0 && (
          <section className={section ? "" : "mt-10"}>
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Letters of recommendation</h2>
            <p className="mt-1 text-sm text-stone-800">
              Add the people you'd like to ask for a recommendation. Your counsellor takes it from there.
            </p>
            <RequiredDocsBlock
              docs={[]}
              studentId={null}
              onAfterChange={load}
              showAddCardWhenEmpty
            />
          </section>
        )}

        {(!section || section === "required-docs") && requiredDocs && requiredDocs.length === 0 && section === "required-docs" && (
          <section>
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Required documents</h2>
            <p className="mt-4 border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">
              Nothing's been requested yet — your counsellor will populate this list once they review your intake.
            </p>
          </section>
        )}

        {(!section || section === "resume") && (
          <section className={section ? "" : "mt-10"}>
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Your resume</h2>
            {latestResume ? (
              <div className="mt-4 border border-stone-200 bg-white p-6">
                <ResumeView latest={latestResume} studentName={headerName} />
              </div>
            ) : (
              <p className="mt-4 border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">
                Your resume hasn't been generated yet. Your counsellor will trigger it once your intake is complete.
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

// Compact strip surfacing the items the student should act on TODAY:
// - LOR / internship rows that are Day 3+ of the 5-business-day window
// - Application deadlines within 14 days
// Returns the items sorted by urgency (urgent first, then days remaining).
function collectUrgentItems({ requiredDocs, applications }) {
  const items = [];
  for (const d of requiredDocs || []) {
    if (d.kind === "sop") continue;
    if (d.final_file_id) continue;
    if (!d.requested_at || !d.deadline_at) continue;
    const badge = computeDayBadge(d.requested_at, d.deadline_at);
    if (!badge) continue;
    if (!badge.label.startsWith("Day 3") && !badge.label.startsWith("Day 4") && !badge.label.startsWith("Day 5")) continue;
    const label = d.kind === "lor"
      ? `LOR ${d.seq} — ${d.recipient_name || "recommender"}`
      : `Internship ${d.seq} — ${d.company_name || "company"}`;
    items.push({
      key: `doc_${d.id}`,
      label,
      urgency: badge.label,
      tone: badge.tone,
      sortKey: badge.label.startsWith("Day 5") ? 0 : badge.label.startsWith("Day 4") ? 1 : 2,
    });
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const a of applications || []) {
    if (!a.deadline) continue;
    if (a.pending) continue;
    if (a.status === "submitted" || a.status === "offer" || a.status === "cancelled") continue;
    const due = new Date(a.deadline);
    if (Number.isNaN(due.getTime())) continue;
    due.setHours(0, 0, 0, 0);
    const days = Math.round((due - today) / 86400000);
    if (days > 14 || days < 0) continue;
    items.push({
      key: `app_${a.id}`,
      label: `${a.university}${a.program ? ` · ${a.program}` : ""}`,
      urgency: days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days`,
      tone: days <= 3
        ? "bg-red-50 text-red-800 border-red-300"
        : days <= 7
        ? "bg-amber-50 text-amber-800 border-amber-300"
        : "bg-stone-100 text-black border-stone-300",
      sortKey: days,
    });
  }
  items.sort((a, b) => a.sortKey - b.sortKey);
  return items;
}

function UrgentItemsStrip({ items }) {
  return (
    <section className="mt-6 border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-sm font-bold uppercase tracking-[0.2em] text-amber-900">Action needed</p>
      <ul className="mt-2 space-y-1.5">
        {items.map((it) => (
          <li
            key={it.key}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-black"
          >
            <span className={`inline-flex shrink-0 items-center border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] ${it.tone}`}>
              {it.urgency}
            </span>
            <span className="break-words"><strong>{it.label}</strong></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ============================================================
// RequiredDocsBlock — splits the doc list into AI-suggested LOR rows
// (student_accepted_at IS NULL, kind='lor') and the regular accepted
// flow. Suggestions render as cards with check / X actions; accepted
// rows render as the existing RequiredDocRow. The "+ add another"
// button always trails the LOR section so the student can manually
// add a recommender at any time.
function RequiredDocsBlock({ docs, studentId, onAfterChange, showAddCardWhenEmpty = false }) {
  const suggestions = (docs || []).filter(
    (d) => d.kind === "lor" && !d.student_accepted_at
  );
  const accepted = (docs || []).filter(
    (d) => !(d.kind === "lor" && !d.student_accepted_at)
  );
  const hasAnyLor = (docs || []).some((d) => d.kind === "lor");
  const showAddCard = suggestions.length > 0 || hasAnyLor || showAddCardWhenEmpty;
  return (
    <div className="mt-4 space-y-3">
      {suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-orange-900">
            Suggested recommenders
          </p>
          {suggestions.map((d) => (
            <LorSuggestionCard
              key={d.id}
              doc={d}
              onAfterChange={onAfterChange}
            />
          ))}
        </div>
      )}
      {showAddCard && <AddLorCard onAfterChange={onAfterChange} />}
      {accepted.map((d) => (
        <RequiredDocRow
          key={d.id}
          doc={d}
          onAfterUpload={onAfterChange}
          studentId={studentId}
        />
      ))}
    </div>
  );
}

// LorSuggestionCard — one AI-suggested recommender. Filled with
// recipient_name + recipient_role + reason_brief from the dispatch
// payload. Student clicks the check to accept (the row enters the
// regular drafting lifecycle) or X to delete (the row is removed).
function LorSuggestionCard({ doc, onAfterChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const accept = async () => {
    setBusy(true); setErr(null);
    try {
      await api.acceptLorSuggestion(doc.id);
      onAfterChange?.();
    } catch (e) {
      setErr(e.message || "Couldn't accept this suggestion.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    try {
      await api.deleteLorSuggestion(doc.id);
      onAfterChange?.();
    } catch (e) {
      setErr(e.message || "Couldn't remove this suggestion.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-2 border-orange-300 bg-orange-50/50 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-bold text-black">{doc.recipient_name || "(name pending)"}</span>
        {doc.recipient_role && (
          <span className="text-sm text-stone-800">{doc.recipient_role}</span>
        )}
      </div>
      {doc.reason_brief && (
        <p className="mt-1 text-sm text-stone-800">
          <span className="text-stone-700">Why. </span>{doc.reason_brief}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={accept}
          disabled={busy}
          className="inline-flex items-center gap-1.5 border border-emerald-700 bg-emerald-700 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-white transition hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          Accept
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1.5 border border-stone-400 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-stone-800 transition hover:border-red-700 hover:text-red-700 disabled:opacity-50"
        >
          <AlertCircle className="h-3 w-3" />
          Remove
        </button>
        {err && <span className="text-xs text-red-700">{err}</span>}
      </div>
    </div>
  );
}

// AddLorCard — empty-shape card with a + button that expands an inline
// form. Student types recipient details, hits Save, the row is created
// as already-accepted (student_accepted_at = NOW()) and joins the
// regular lifecycle. Mirrors the visual language of LorSuggestionCard
// but in stone (neutral) tones since it's for manual entry, not AI
// proposals.
function AddLorCard({ onAfterChange }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const reset = () => { setName(""); setRole(""); setReason(""); setErr(null); };
  const cancel = () => { reset(); setOpen(false); };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.createLorSelf({
        recipient_name: name.trim(),
        recipient_role: role.trim(),
        reason_brief: reason.trim(),
      });
      reset();
      setOpen(false);
      onAfterChange?.();
    } catch (e) {
      setErr(e.message || "Couldn't add this recommender.");
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 border-2 border-dashed border-stone-300 bg-white px-4 py-4 text-sm font-semibold text-stone-700 transition hover:border-stone-700 hover:text-black"
      >
        <span className="text-lg leading-none">+</span> Add another recommender
      </button>
    );
  }
  return (
    <div className="border-2 border-stone-300 bg-white px-4 py-3">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-black">
        Add a recommender
      </p>
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-700">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Mr Rajiv Mehta"
            className="mt-1 w-full border-b border-stone-400 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-700">Role / relation</span>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Class XII Maths teacher"
            className="mt-1 w-full border-b border-stone-400 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          />
        </label>
      </div>
      <label className="mt-3 block">
        <span className="text-[10px] uppercase tracking-[0.15em] text-stone-700">Why this person (≤ 20 words)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. taught me Maths for 2 years; saw me build the classroom timetable tool"
          className="mt-1 w-full border-b border-stone-400 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
        />
      </label>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || (!name.trim() && !role.trim() && !reason.trim())}
          className="inline-flex items-center gap-1.5 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          Save
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 border border-stone-400 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-stone-800 transition hover:border-stone-700"
        >
          Cancel
        </button>
        {err && <span className="text-xs text-red-700">{err}</span>}
      </div>
    </div>
  );
}

// RequiredDocRow — one row per LOR / Internship / SOP item.
//
// Status state machine:
//   LOR / Internship:
//     awaiting_draft → drafted → requested (deadline ticking) → received
//   SOP:
//     awaiting_draft → drafted (pending admin) → approved
//
// "Day N of 5" pills are computed from requested_at + deadline_at.
// Day 5 — URGENT once we hit the deadline day. Reminders themselves
// (email / WhatsApp) aren't wired up — just the visual.
// ============================================================
function RequiredDocRow({ doc, onAfterUpload, studentId }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const kindLabel = doc.kind === "lor" ? `LOR ${doc.seq}` :
                    doc.kind === "internship" ? `Internship ${doc.seq}` :
                    "Statement of Purpose";

  const summary = doc.kind === "lor"
    ? `${doc.recipient_name || "—"} · ${doc.recipient_role || "—"}`
    : doc.kind === "internship"
    ? `${doc.company_name || "—"}${doc.company_website ? ` · ${doc.company_website}` : ""}`
    : "Drafted by your counsellor; approved by admin.";

  const status = computeRequiredDocState(doc);
  const pill = STATUS_PILL[status] || { label: status, tone: "bg-stone-100 text-black border-stone-300" };

  // Deadline countdown for requested-but-not-uploaded rows.
  let dayBadge = null;
  if (status === "requested" && doc.deadline_at) {
    dayBadge = computeDayBadge(doc.requested_at, doc.deadline_at);
  }

  const canUpload = status === "requested";
  const showStaffDraft = !!doc.staff_draft && (status === "requested" || status === "received" || status === "approved" || status === "drafted_sop");

  const onUpload = async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      const { fileId } = await uploadFile(file, {
        fieldId: `required_doc_${doc.id}`,
        accept: "image/jpeg,image/png,application/pdf",
      });
      await api.attachRequiredDocFinal(doc.id, fileId);
      onAfterUpload?.();
    } catch (e2) {
      setErr(e2.message || "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="border border-stone-900/15 bg-white px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] uppercase tracking-[0.2em] text-black">{kindLabel}</span>
        <span className="text-sm text-black">{summary}</span>
        <span className={`ml-auto inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] ${pill.tone}`}>
          {pill.label}
        </span>
        {dayBadge && (
          <span className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] ${dayBadge.tone}`}>
            <Clock className="h-3 w-3" /> {dayBadge.label}
          </span>
        )}
      </div>
      {showStaffDraft && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] uppercase tracking-[0.15em] text-black hover:text-black">
            View counsellor draft
          </summary>
          <pre className="mt-2 whitespace-pre-wrap border border-stone-900/10 bg-[#faf9f5] p-3 font-serif text-sm text-black">
{doc.staff_draft}
          </pre>
        </details>
      )}
      {doc.kind !== "sop" && doc.final_file_name && (
        <div className="mt-2">
          <p className="inline-flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3 w-3" />
            Uploaded: <span className="text-black">{doc.final_file_name}</span>
          </p>
          {doc.final_file_id && (
            <MiniFilePreview
              fileId={doc.final_file_id}
              fileName={doc.final_file_name}
              studentId={studentId}
            />
          )}
        </div>
      )}
      {canUpload && !doc.final_file_id && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={onUpload}
            disabled={busy}
            className="hidden"
            id={`upload_${doc.id}`}
          />
          <label
            htmlFor={`upload_${doc.id}`}
            className={`inline-flex cursor-pointer items-center gap-1 border border-stone-900/30 bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-black hover:border-stone-900 ${busy ? "opacity-50 pointer-events-none" : ""}`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            Upload stamped final
          </label>
          <span className="text-[11px]  text-black">
            Brightly lit photo or PDF, on a flat surface — this goes to your universities.
          </span>
        </div>
      )}
      {err && (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-red-700">
          <AlertCircle className="h-3 w-3" /> {err}
        </p>
      )}
    </div>
  );
}

// Student-facing label + tone for each canonical state from
// computeRequiredDocState. `draft_in_progress` collapses into the
// same pre-send copy as `awaiting_draft` — students don't need to
// distinguish "no draft yet" from "counsellor partway through";
// both feel like "your counsellor is working on it". Counsellors see
// the distinction in their own panel via COUNSELLOR_LABELS.
const STATUS_PILL = {
  awaiting_draft:    { label: "Counsellor drafting",   tone: "bg-stone-100 text-black border-stone-300" },
  draft_in_progress: { label: "Counsellor drafting",   tone: "bg-stone-100 text-black border-stone-300" },
  drafted:           { label: "Ready to send",         tone: "bg-amber-50 text-amber-800 border-amber-300" },
  drafted_sop:       { label: "Awaiting admin approval", tone: "bg-amber-50 text-amber-800 border-amber-300" },
  requested:         { label: "Print on letterhead",   tone: "bg-blue-50 text-blue-800 border-blue-300" },
  received:          { label: "Received",              tone: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  approved:          { label: "Approved",              tone: "bg-emerald-50 text-emerald-800 border-emerald-300" },
};

// "Day N of 5" / urgent badge. Counts elapsed business days since the
// request was sent (skips Sat/Sun, matches the deadline calculation
// in server/routes/required-docs.js).
function computeDayBadge(requestedAt, deadlineAt) {
  if (!requestedAt) return null;
  const start = new Date(requestedAt);
  const today = new Date();
  let elapsed = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  while (cur < today) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) elapsed++;
  }
  // Map to "Day N of 5". Day 1 = same business day as the request (or next).
  const day = Math.min(Math.max(elapsed + 1, 1), 5);
  if (day >= 5) return { label: "Day 5 — URGENT", tone: "bg-red-50 text-red-800 border-red-300" };
  if (day >= 3) return { label: `Day ${day} of 5`, tone: "bg-amber-50 text-amber-800 border-amber-300" };
  return { label: `Day ${day} of 5`, tone: "bg-stone-100 text-black border-stone-300" };
}

function ResumeView({ latest, studentName }) {
  if (!latest) return null;
  if (latest.status === "pending" || latest.status === "running") {
    return (
      <div className="flex items-center gap-3 text-sm text-black">
        <Loader2 className="h-4 w-4 animate-spin" />
        <div>
          Generating your resume… this usually takes 30–60 seconds.
          <div className="mt-1 text-xs text-black">Status: {latest.status}</div>
        </div>
      </div>
    );
  }
  if (latest.status === "failed") {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>Resume generation failed. Your counsellor has been notified — they can re-run it from their panel.</div>
        </div>
        {latest.error && (
          <details className="text-xs text-black">
            <summary className="cursor-pointer">Technical details</summary>
            <pre className="mt-2 overflow-auto bg-stone-50 p-2 text-[10px]">
              {String(latest.error).slice(0, 600)}
            </pre>
          </details>
        )}
      </div>
    );
  }
  // Succeeded → prefer the structured JSON payload (new pipeline,
  // designed single-column template) and fall back to legacy markdown
  // for older rows that haven't been regenerated. /me/resumes returns
  // camelCase (contentJson, contentMd); admin /api/students/:id uses
  // snake_case (content_json, content_md). Try both.
  const json = latest.contentJson || latest.content_json;
  if (json) {
    return (
      <ResumePdfPicker payload={json} studentName={studentName} />
    );
  }
  const md = latest.contentMd || latest.content_md || "(empty resume)";
  return <ResumeMarkdown>{md}</ResumeMarkdown>;
}

function ChapterBlock({ chapter }) {
  return (
    <div className="border border-stone-900/15 bg-white">
      <div className="border-b border-stone-200 px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black">
          {chapter.title}
        </p>
      </div>
      <div className="divide-y divide-stone-100">
        {chapter.pages.map((page) => (
          <PageBlock key={page.id} page={page} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// ChapterSummaryBlock — clean two-column read of one chapter.
// Each page is a heading + a dl of label/value pairs, so the
// reader can scan top-to-bottom in one column rather than
// parsing run-on sentences.
//
// `autofilledKeys` (optional) — a Set of field ids that were
// written by the AI autofill pass. When provided, fields whose
// id is in the set get an "AI autofilled" eyebrow next to their
// label. Only the staff slide-by-slide review passes this; the
// student-facing dashboard leaves it undefined so the badge is
// hidden.
// ============================================================
export function ChapterSummaryBlock({ chapter, studentId, headless = false, hideFilePreviews = false, hideFiles = false, autofilledKeys }) {
  return (
    <div className="border border-stone-200 bg-white">
      {!headless && (
        <div className="border-b border-stone-100 px-6 py-3">
          <h3 className="font-serif text-xl text-black">{chapter.title}</h3>
        </div>
      )}
      <div className="divide-y divide-stone-100">
        {chapter.pages.map((page) => (
          <PageSummary key={page.id} page={page} studentId={studentId} hidePageTitle={headless} hideFilePreviews={hideFilePreviews} hideFiles={hideFiles} autofilledKeys={autofilledKeys} />
        ))}
      </div>
    </div>
  );
}

// True when a value is an uploaded-file slot (object with a `status`
// key). Used to skip these rows on summary slides whose follow-up
// per-doc slides already render the file + AI analysis.
function isFileSlot(v) {
  return v && typeof v === "object" && !Array.isArray(v) && "status" in v;
}

function PageSummary({ page, studentId, hidePageTitle = false, hideFilePreviews = false, hideFiles = false, autofilledKeys }) {
  const fields = page.fields.filter((f) => {
    if (f.type === "info") return false;
    if (!isAnswered(f.value)) return false;
    if (hideFiles && isFileSlot(f.value)) return false;
    return true;
  });
  if (fields.length === 0) return null;
  return (
    <div className="px-6 py-5">
      {!hidePageTitle && (
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-600">
          {page.title}
        </p>
      )}
      <dl className={`${hidePageTitle ? "" : "mt-3 "}grid gap-x-8 gap-y-3 sm:grid-cols-[180px_1fr]`}>
        {fields.map((f) => (
          <SummaryFieldRow key={f.id} field={f} studentId={studentId} hideFilePreviews={hideFilePreviews} hideFiles={hideFiles} autofilledKeys={autofilledKeys} />
        ))}
      </dl>
    </div>
  );
}

function SummaryFieldRow({ field, studentId, hideFilePreviews = false, hideFiles = false, autofilledKeys }) {
  if (hideFiles && isFileSlot(field.value)) return null;
  const isAutofilled = autofilledKeys && autofilledKeys.has(field.id);
  return (
    <>
      <dt className="text-sm text-stone-700">
        {field.label}
        {isAutofilled && (
          <span className="ml-2 inline-flex items-center border border-[#cc785c] bg-[#fdf4ef] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#cc785c] align-middle">
            AI autofilled
          </span>
        )}
      </dt>
      <dd className="text-base text-black">
        <SummaryFieldValue value={field.value} field={field} studentId={studentId} hideFilePreviews={hideFilePreviews} hideFiles={hideFiles} />
      </dd>
    </>
  );
}

function SummaryFieldValue({ value, field, studentId, hideFilePreviews = false, hideFiles = false }) {
  if (value == null || value === "") {
    return <span className="text-stone-400">—</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>;
  }
  // File slot — filename + status pill, plus a mini preview of the
  // actual file (image inline, PDF link-card) so the student can read
  // each upload right where its values are summarised. In the staff
  // slide-by-slide review we suppress the preview because the next
  // slide (ExtractionStep) renders the same file alongside its AI
  // analysis — drawing it here too is a duplicate.
  if (isFileSlot(value)) {
    return (
      <div>
        <span className="inline-flex items-baseline gap-1.5">
          <Paperclip className="h-3.5 w-3.5 -translate-y-px text-stone-700" />
          <span>{value.name || "(file)"}</span>
          {value.status === "uploaded" ? (
            <span className="text-emerald-700">✓</span>
          ) : (
            <span className="text-stone-600">({value.status})</span>
          )}
        </span>
        {!hideFilePreviews && (
          <MiniFilePreview slot={value} studentId={studentId} fieldId={field?.id} />
        )}
      </div>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-stone-400">(none)</span>;
    }
    const itemFields = field?.itemFields || [];
    return (
      <ol className="list-decimal space-y-3 pl-5 marker:text-stone-500">
        {value.map((row, i) => (
          <li key={i}>
            <RepeaterRowSummary row={row} itemFields={itemFields} studentId={studentId} hideFilePreviews={hideFilePreviews} hideFiles={hideFiles} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object") {
    return (
      <pre className="overflow-auto whitespace-pre-wrap text-xs text-stone-700">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span>{String(value)}</span>;
}

function RepeaterRowSummary({ row, itemFields, studentId, hideFilePreviews = false, hideFiles = false }) {
  if (!row || typeof row !== "object") return <span>{String(row)}</span>;
  const subs = itemFields.length > 0
    ? itemFields
    : Object.keys(row).map((k) => ({ id: k, label: k }));
  const filled = subs
    .map((sub) => ({ sub, val: row[sub.id] }))
    .filter(({ val }) => isAnswered(val))
    .filter(({ val }) => !(hideFiles && isFileSlot(val)));
  if (filled.length === 0) return <span className="text-stone-400">(empty)</span>;
  return (
    <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[140px_1fr]">
      {filled.map(({ sub, val }) => (
        <SummaryFieldRow key={sub.id} field={{ ...sub, value: val }} studentId={studentId} hideFilePreviews={hideFilePreviews} hideFiles={hideFiles} />
      ))}
    </dl>
  );
}

// ============================================================
// MiniFilePreview — compact preview for an uploaded file slot.
// Image: inline <img> (max 240px tall, click to open full size).
// PDF:   link-card (iOS Safari renders <iframe src=*.pdf> blank,
//        so a tappable card is the only thing that works
//        cross-device).
// Used everywhere a "filename ✓" reference appears in the UI so
// the student / staff can verify the actual content next to its
// transcribed values without bouncing through the Documents tab.
// ============================================================
function MiniFilePreview({ slot, fileId, fileName, mimeType, studentId, fieldId }) {
  const docSummary = getDocSummary(fieldId);
  // Two callers: the answers-summary slot (has slot.{fileId,name,type})
  // and the required-docs row (has explicit fileId + filename, no mime
  // — inferred from the extension). Either path resolves to (id, name,
  // mime) so the render branch below stays uniform.
  let resolvedId = fileId ?? null;
  let resolvedName = fileName ?? null;
  let resolvedMime = mimeType ?? null;
  // Inline-URL fallback for autofill demo slots: those carry a data:
  // SVG in slot.uploadedUrl but no fileId, since they were never
  // round-tripped through the upload endpoint. Without this branch the
  // dashboard summary would show "filename ✓" with nothing under it
  // in demo mode — exactly the bare-reference look we want to avoid.
  let inlineUrl = null;
  if (slot && typeof slot === "object") {
    if (slot.status !== "uploaded") return null;
    resolvedId = slot.fileId ?? null;
    resolvedName = slot.name ?? null;
    resolvedMime = slot.type ?? null;
    if (!resolvedId && typeof slot.uploadedUrl === "string" && slot.uploadedUrl.startsWith("data:")) {
      inlineUrl = slot.uploadedUrl;
    }
  }
  if (!resolvedId && !inlineUrl) return null;
  // Mime fallback: infer from filename extension when we weren't given
  // an explicit mime (the required-doc rows don't carry one). Anything
  // else lands in the PDF link-card branch, which is the right default
  // for unknown uploads — never tries to <img> a non-image.
  if (!resolvedMime && resolvedName) {
    const ext = resolvedName.toLowerCase().split(".").pop();
    if (ext === "jpg" || ext === "jpeg") resolvedMime = "image/jpeg";
    else if (ext === "png") resolvedMime = "image/png";
    else if (ext === "pdf") resolvedMime = "application/pdf";
  }
  const url = inlineUrl
    ? inlineUrl
    : studentId
    ? `/api/students/${studentId}/files/${resolvedId}`
    : `/api/students/me/files/${resolvedId}`;
  const type = resolvedMime || "";
  const name = resolvedName || "uploaded file";
  // Demo data: SVGs always render inline as images regardless of the
  // slot's declared mime — same reasoning as FilePreview in the intake.
  const urlIsInlineImage = url.startsWith("data:image/");
  if (type.startsWith("image/") || urlIsInlineImage) {
    return (
      <div className="mt-2 max-w-sm">
        <LightboxImage src={url} alt={name} maxHeightClass="max-h-60" />
      </div>
    );
  }
  // PDF — full client-side render via react-pdf (pdf.js under the hood).
  // Replaces the previous <object> fallback, which Chrome/Edge handled
  // but iOS Safari + most Android browsers refused to render inline.
  // Now every device draws to a canvas, so the doc is readable without
  // bouncing through "Open in new tab".
  return (
    <div className="mt-2 max-w-2xl">
      <InlinePdf url={url} fileName={name} maxHeight={560} />
    </div>
  );
}

// ============================================================
// LightboxImage — wraps an <img> with react-photo-view so a click
// pops a full-screen lightbox with pinch/scroll zoom, drag-pan, and
// rotate (matters for sideways-phone-shot marksheets). The image
// honours its EXIF orientation tag via `image-orientation: from-image`
// so most rotated phone photos display correctly without the rotate
// button being needed at all.
// ============================================================
function LightboxImage({ src, alt, maxHeightClass = "max-h-60", className = "" }) {
  return (
    <PhotoProvider maskOpacity={0.85} bannerVisible={false}>
      <PhotoView src={src}>
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={`block w-full cursor-zoom-in object-contain border border-stone-200 bg-white ${maxHeightClass} ${className}`}
          style={{ imageOrientation: "from-image" }}
        />
      </PhotoView>
    </PhotoProvider>
  );
}

// ============================================================
// InlinePdf — page-by-page PDF viewer powered by react-pdf. Renders
// the current page to a canvas sized to the container width, with
// prev/next page nav and an "Open in new tab" escape hatch.
//
// `withCredentials` is set on the document fetch so the same cookie
// that authorised the JSON request authorises the binary fetch too —
// required for our auth-gated /api/students/.../files/:id route.
// ============================================================
function InlinePdf({ url, fileName, maxHeight = 560 }) {
  const [numPages, setNumPages] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [width, setWidth] = useState(null);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  // Same-origin file URLs are stable across renders for the same id; an
  // object literal `{ url, withCredentials }` would be a new reference
  // every render and trigger an infinite refetch loop in <Document>.
  const fileSpec = useMemo(() => ({ url, withCredentials: true }), [url]);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Reset page index whenever the source changes (a different file
  // may have a different page count; staying on page 7 of an old doc
  // would silently render blank).
  useEffect(() => {
    setPageNum(1);
    setError(null);
  }, [url]);

  const goPrev = () => setPageNum((p) => Math.max(1, p - 1));
  const goNext = () => setPageNum((p) => Math.min(numPages || 1, p + 1));

  return (
    <div className="border border-stone-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-3 py-1.5">
        <span className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-stone-700">
          <span className="inline-flex h-5 items-center border border-stone-300 bg-white px-1.5 font-semibold">
            PDF
          </span>
          <span className="truncate text-stone-800" title={fileName}>{fileName}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={goPrev}
            disabled={pageNum <= 1}
            className="inline-flex items-center border border-stone-300 bg-white p-1 text-stone-700 transition hover:border-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
            title="Previous page"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <span className="min-w-[44px] text-center text-[10px] uppercase tracking-[0.15em] text-stone-700">
            {numPages ? `${pageNum} / ${numPages}` : "…"}
          </span>
          <button
            type="button"
            onClick={goNext}
            disabled={!numPages || pageNum >= numPages}
            className="inline-flex items-center border border-stone-300 bg-white p-1 text-stone-700 transition hover:border-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
            title="Next page"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="ml-1 inline-flex items-center text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:text-[#cc785c]"
            title="Open in a new tab"
          >
            Open ↗
          </a>
        </span>
      </header>
      <div
        ref={containerRef}
        className="relative overflow-auto bg-stone-100"
        style={{ maxHeight }}
      >
        {error ? (
          <div className="px-3 py-6 text-center text-xs text-red-700">
            Couldn't render this PDF inline. <a href={url} target="_blank" rel="noreferrer" className="underline">Open it directly</a>.
          </div>
        ) : (
          <Document
            file={fileSpec}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            onLoadError={(e) => setError(e?.message || "load error")}
            loading={
              <div className="flex items-center justify-center px-3 py-10 text-xs text-stone-700">
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading PDF…
              </div>
            }
            error={
              <div className="px-3 py-6 text-center text-xs text-red-700">
                Couldn't load this PDF.
              </div>
            }
          >
            {width && (
              <Page
                pageNumber={pageNum}
                width={width}
                renderAnnotationLayer={false}
                loading={
                  <div className="flex items-center justify-center px-3 py-10 text-xs text-stone-700">
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Rendering page…
                  </div>
                }
              />
            )}
          </Document>
        )}
      </div>
    </div>
  );
}

function PageBlock({ page }) {
  return (
    <div className="px-4 py-3">
      <p className="text-[11px] font-medium text-black">{page.title}</p>
      {page.helper && (
        <p className="mt-0.5 text-[10px]  text-black">{page.helper}</p>
      )}
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[180px_1fr]">
        {page.fields.map((f) => (
          <FieldRow key={f.id} field={f} value={f.value} />
        ))}
      </dl>
    </div>
  );
}

function FieldRow({ field, value }) {
  return (
    <>
      <dt className="text-[11px] text-black">{field.label}</dt>
      <dd className="text-[12px] text-black">
        <FieldValue value={value} field={field} />
      </dd>
    </>
  );
}

function FieldValue({ value, field }) {
  if (value == null || value === "") {
    return <span className=" text-black">—</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>;
  }
  // File slot — surface filename + status. The actual download lives
  // in the "Your documents" section below; here we just confirm it
  // was uploaded against this field.
  if (value && typeof value === "object" && !Array.isArray(value) && "status" in value) {
    return (
      <span className="text-black">
        <Paperclip className="mr-1 inline-block h-3 w-3 -translate-y-px text-black" />
        {value.name || "(file)"}
        {value.status === "uploaded" ? (
          <span className="ml-1 text-emerald-700">✓</span>
        ) : (
          <span className="ml-1 text-black">({value.status})</span>
        )}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className=" text-black">(none)</span>;
    }
    // Repeater rows. Each item is a sub-object keyed by itemFields[].id.
    const itemFields = field?.itemFields || [];
    return (
      <ol className="list-decimal space-y-1 pl-4">
        {value.map((row, i) => (
          <li key={i}>
            {row && typeof row === "object" ? (
              <span className="text-black">
                {itemFields.length > 0
                  ? itemFields
                      .map((f) => {
                        const v = row[f.id];
                        if (v == null || v === "") return null;
                        if (typeof v === "object" && "status" in v) return `${f.label}: ${v.name}`;
                        return `${f.label}: ${v}`;
                      })
                      .filter(Boolean)
                      .join(" · ")
                  : Object.entries(row)
                      .filter(([, v]) => v != null && v !== "")
                      .map(([k, v]) => `${k}: ${typeof v === "object" ? "[object]" : v}`)
                      .join(" · ")}
              </span>
            ) : (
              <span>{String(row)}</span>
            )}
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object") {
    return (
      <pre className="overflow-auto whitespace-pre-wrap text-[10px] text-black">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span>{String(value)}</span>;
}

// ============================================================
// DocumentPreview — full inline render of one uploaded document.
// Images render as <img>, PDFs as <iframe>, anything else falls
// back to a download link. Shown in the Overview's "Your
// documents" section so the student (and staff in preview) can
// read every uploaded artifact without leaving the dashboard.
// ============================================================
export function DocumentPreview({ file, fieldIndex, studentId }) {
  const meta = fieldIndex.get(extractFieldRoot(file.field_id)) || null;
  const title = meta?.label || prettifyFieldId(file.field_id);
  const description =
    getDocSummary(file.field_id) ||
    meta?.pageHelper ||
    (meta?.pageTitle && meta?.chapterTitle
      ? `${meta.chapterTitle} · ${meta.pageTitle}`
      : meta?.placeholder || null);
  const href = studentId
    ? `/api/students/${studentId}/files/${file.id}`
    : `/api/students/me/files/${file.id}`;
  const isImg = isImage(file.mime_type);
  const isPdf = file.mime_type === "application/pdf";
  return (
    <div className="border border-stone-900/15 bg-white">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-stone-200 px-4 py-3">
        <p className="text-base font-medium text-black">{title}</p>
        {description && (
          <p className="text-sm text-stone-800">{description}</p>
        )}
        <p className="ml-auto text-sm text-stone-800">
          {file.original_name} · {humanSize(file.size)} · {friendlyMimeLabel(file.mime_type)}
        </p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[#cc785c] underline underline-offset-4 hover:text-[#b86a4f]"
        >
          Open in new tab
        </a>
      </div>
      {file.ai_description && !isPhotoOnlyField(file.field_id) && (
        <div className="border-b border-stone-200 bg-white px-4 py-4">
          <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-stone-700">
            AI extraction
          </p>
          <AiDescriptionRenderer markdown={file.ai_description} />
        </div>
      )}
      <div className="bg-stone-50">
        {isImg && (
          <PhotoProvider maskOpacity={0.85} bannerVisible={false}>
            <PhotoView src={href}>
              <img
                src={href}
                alt={title}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="mx-auto block max-h-[80vh] w-auto max-w-full cursor-zoom-in"
                style={{ imageOrientation: "from-image" }}
              />
            </PhotoView>
          </PhotoProvider>
        )}
        {isPdf && (
          <InlinePdf url={href} fileName={file.original_name} maxHeight="80vh" />
        )}
        {!isImg && !isPdf && (
          <div className="px-4 py-8 text-center text-sm text-stone-800">
            Inline preview isn't available for this file type. Use "Open in new tab" above.
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

// Pull the answers object out of either /me/record's `data` or the
// admin endpoint's `student.data`. Both wrap the answer map under a
// top-level "answers" key (with order/lastStep alongside it for the
// form's own bookkeeping).
export function extractAnswers(data) {
  if (!data || typeof data !== "object") return {};
  if (data.answers && typeof data.answers === "object") return data.answers;
  return data;
}

// Walk CHAPTERS and decorate each visible field with its current value.
// Skip pages where every field is empty so we don't render long blocks
// of dashes for sections the student deliberately skipped (optional
// chapters like "post-graduate university" for an undergrad applicant).
export function groupAnswersBySchema(answers) {
  const out = [];
  for (const chapter of CHAPTERS) {
    const pages = [];
    for (const page of chapter.pages) {
      const fields = page.fields
        .filter((f) => isFieldVisible(f, answers))
        .map((f) => ({ ...f, value: answers[f.id] }));
      const hasAny = fields.some((f) => isAnswered(f.value));
      if (!hasAny) continue;
      pages.push({ ...page, fields });
    }
    if (pages.length > 0) out.push({ ...chapter, pages });
  }
  return out;
}

function isAnswered(v) {
  if (v == null || v === "") return false;
  if (Array.isArray(v)) {
    return v.some((row) => row && typeof row === "object" && Object.values(row).some(isAnswered));
  }
  if (typeof v === "object" && "status" in v) return v.status === "uploaded";
  return true;
}

// Map field-id (including repeater item ids) to schema metadata —
// decorated with the parent page's title/helper and the chapter's
// title so the document tile can show useful "details" copy without
// the schema needing to repeat itself per-field.
export function buildFieldIndex() {
  const idx = new Map();
  for (const chapter of CHAPTERS) {
    for (const page of chapter.pages) {
      for (const f of page.fields) {
        idx.set(f.id, {
          ...f,
          pageTitle: page.title,
          pageHelper: page.helper,
          chapterTitle: chapter.title,
        });
        if (Array.isArray(f.itemFields)) {
          for (const item of f.itemFields) {
            // Use the item's own id; the upload field-id collision with
            // an item field-id (e.g. "proof") is acceptable — repeater
            // sub-uploads get a more specific suffix encoded in
            // field_id at upload time.
            if (!idx.has(item.id)) {
              idx.set(item.id, {
                ...item,
                pageTitle: page.title,
                pageHelper: page.helper,
                chapterTitle: chapter.title,
              });
            }
          }
        }
      }
    }
  }
  return idx;
}

// Returns the active file rows belonging to one schema page, in
// the order the page lists them. Used by the staff slideshow to
// follow each "page" slide with one focused AI-extraction slide
// per file, instead of dumping every extraction at the end.
//
// Direct file fields match by exact `field_id === f.id`. Repeater
// uploads (e.g. activities_list) land with `field_id` like
// "activities_list[3].proof" so we match the container by prefix
// and the sub-field by suffix.
export function filesForPage(page, files) {
  if (!page || !Array.isArray(files)) return [];
  const seen = new Set();
  const out = [];
  const push = (fr) => {
    if (fr && !seen.has(fr.id)) {
      seen.add(fr.id);
      out.push(fr);
    }
  };
  for (const f of page.fields || []) {
    const direct = files.filter(
      (fr) => !fr.superseded_at && fr.field_id === f.id
    );
    direct.forEach(push);
    if (Array.isArray(f.itemFields)) {
      for (const sub of f.itemFields) {
        const repeated = files.filter(
          (fr) =>
            !fr.superseded_at &&
            fr.field_id &&
            fr.field_id.startsWith(f.id + "[") &&
            fr.field_id.endsWith("." + sub.id)
        );
        repeated.forEach(push);
      }
    }
  }
  return out;
}

// AiDescriptionRenderer — renders the per-file AI extraction markdown
// (intake_files.ai_description) with the long Verbatim transcription
// section collapsed inside a <details> by default. Identification,
// Fields, Summary, and Conclusions stay visible because they are the
// scannable parts; Verbatim is the wall of text the user typically
// only opens when reconciling a discrepancy.
//
// Splitting strategy: the runbook
// (automation/instructions_autofill_plus_generate.md, Section 3b)
// guarantees the heading is exactly "### Verbatim". We slice from
// that heading to the next "### " heading (or end of string) and
// render the slice inside a closed <details>. If the heading isn't
// present (legacy file pre-dating the long-form spec), we render the
// whole markdown unchanged.
const PROSE_CLASSES = `prose prose-sm max-w-none text-stone-900
  prose-headings:text-black prose-headings:font-semibold
  prose-h3:mt-4 prose-h3:mb-2 prose-h3:text-sm prose-h3:uppercase prose-h3:tracking-[0.15em]
  prose-p:my-2
  prose-table:my-3 prose-th:bg-stone-100 prose-th:text-left prose-th:font-semibold
  prose-th:border prose-th:border-stone-300 prose-th:px-2 prose-th:py-1
  prose-td:border prose-td:border-stone-300 prose-td:px-2 prose-td:py-1
  prose-ul:my-2 prose-li:my-0.5
  prose-strong:text-black`;

function splitVerbatim(markdown) {
  if (!markdown) return { before: "", verbatim: "", after: "" };
  const re = /^###\s+verbatim\s*$/im;
  const m = re.exec(markdown);
  if (!m) return { before: markdown, verbatim: "", after: "" };
  const startVerbatim = m.index;
  const afterHeading = startVerbatim + m[0].length;
  // Find the next "### " heading after the Verbatim heading.
  const tail = markdown.slice(afterHeading);
  const next = /^###\s+/m.exec(tail);
  const endVerbatim = next ? afterHeading + next.index : markdown.length;
  return {
    before: markdown.slice(0, startVerbatim).trimEnd(),
    verbatim: markdown.slice(afterHeading, endVerbatim).trim(),
    after: markdown.slice(endVerbatim).trimStart(),
  };
}

function AiDescriptionRenderer({ markdown }) {
  const { before, verbatim, after } = splitVerbatim(markdown);
  return (
    <div className={PROSE_CLASSES}>
      {before && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{before}</ReactMarkdown>
      )}
      {verbatim && (
        <details className="mt-4 border border-stone-200 bg-stone-50/60">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-[0.15em] text-stone-800 hover:bg-stone-100">
            Verbatim transcription
          </summary>
          <div className={`${PROSE_CLASSES} px-3 pb-3`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{verbatim}</ReactMarkdown>
          </div>
        </details>
      )}
      {after && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{after}</ReactMarkdown>
      )}
    </div>
  );
}

// ExtractionStep — one slide showing only the AI extraction prose
// for a single file. Designed to be the slide *after* a page slide
// that has the file inline, so the reader sees the typed answers
// and the document on slide N, then the long-form extraction on
// slide N+1, instead of either being crammed onto the same slide.
// Field ids where the upload is just a picture for the application
// packet (student headshot today; future passport-style photo slots
// would belong here too). For these we skip the "AI analysis" header
// + body — there is nothing to extract beyond confirming it's a photo,
// and the analysis block (title repeat + bullets + conclusions) just
// pads the slide above the preview the reviewer actually wants to see.
const PHOTO_ONLY_FIELD_IDS = new Set(["photoFile"]);
function isPhotoOnlyField(fieldId) {
  return PHOTO_ONLY_FIELD_IDS.has(extractFieldRoot(fieldId));
}

export function ExtractionStep({ file, fieldIndex, studentId }) {
  const meta = fieldIndex.get(extractFieldRoot(file.field_id)) || null;
  const title = meta?.label || prettifyFieldId(file.field_id);
  const hasExtraction = !!file.ai_description && file.ai_description.trim().length > 0;
  const photoOnly = isPhotoOnlyField(file.field_id);
  const href = studentId
    ? `/api/students/${studentId}/files/${file.id}`
    : `/api/students/me/files/${file.id}`;
  const isImg = isImage(file.mime_type);
  const isPdf = file.mime_type === "application/pdf";
  return (
    <div className="border border-stone-900/15 bg-white">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-stone-200 px-4 py-3">
        <p className="text-base font-medium text-black">{title}</p>
        {!photoOnly && <p className="text-sm text-stone-800">AI analysis</p>}
        <a href={href} target="_blank" rel="noopener noreferrer"
            className="ml-auto text-sm text-[#cc785c] underline underline-offset-4 hover:text-[#b86a4f]">
            Open in new tab
          </a>
      </div>
      {!photoOnly && (
        <div className="px-4 py-5">
          {hasExtraction ? (
            <AiDescriptionRenderer markdown={file.ai_description} />
          ) : (
            <p className="text-sm text-stone-800">
              No AI analysis yet for this file. Run the automation pipeline to populate it.
            </p>
          )}
        </div>
      )}
      {isImg && (
        <div className="border-t border-stone-200 bg-stone-50 p-4">
          <PhotoProvider maskOpacity={0.85} bannerVisible={false}>
            <PhotoView src={href}>
              <img src={href} alt={title} loading="lazy" decoding="async"
                referrerPolicy="no-referrer"
                className="mx-auto block max-h-[60vh] w-auto max-w-full cursor-zoom-in"
                style={{ imageOrientation: "from-image" }} />
            </PhotoView>
          </PhotoProvider>
        </div>
      )}
      {isPdf && (
        <div className="border-t border-stone-200">
          <InlinePdf url={href} fileName={file.original_name} maxHeight={500} />
        </div>
      )}
    </div>
  );
}

// Repeater uploads land with a field_id like
// "activities_list[3].proof" — strip the suffix to look up the
// container field's label, then fall back to the leaf id.
function extractFieldRoot(fieldId) {
  if (!fieldId) return "";
  const idx = fieldId.indexOf("[");
  if (idx > 0) {
    const dotIdx = fieldId.indexOf(".", idx);
    if (dotIdx > 0) return fieldId.slice(dotIdx + 1);
  }
  return fieldId;
}

// Fallback for fields that aren't in the schema — turn snake_case or
// camelCase into title-case "Class 12 Marksheet" for display.
function prettifyFieldId(fieldId) {
  if (!fieldId) return "Document";
  return fieldId
    .replace(/[\[\]]/g, " ")
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function friendlyMimeLabel(mime) {
  if (!mime) return "";
  if (mime === "application/pdf") return "PDF";
  if (mime === "image/jpeg") return "JPG";
  if (mime === "image/png") return "PNG";
  return mime.split("/")[1]?.toUpperCase() || mime;
}

function isImage(mime) {
  return typeof mime === "string" && mime.startsWith("image/");
}

function humanSize(b) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

