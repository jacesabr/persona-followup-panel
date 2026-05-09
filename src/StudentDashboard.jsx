// Post-intake landing screen for the student. Shows everything the
// student submitted — intake answers grouped by chapter/page and every
// uploaded document with a title + description.
//
// The resume display + regenerate flow lives in the staff panel; the
// student-facing view is purely a recap of what they submitted.
//
// Two render modes:
//   1) Default (student logged in) — fetches /me/* endpoints.
//   2) staffPreview (admin/counsellor "view as student") — receives the
//      data the staff endpoint already returned, so the same component
//      doubles as the staff-side preview without duplicating layout.

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  Loader2,
  AlertTriangle,
  LogOut,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Clock,
  CheckCircle2,
  Upload,
  AlertCircle,
} from "lucide-react";
import { loadRecord, listMyFiles, listResumes, uploadFile } from "./intakeFiles.js";
import { CHAPTERS, isFieldVisible } from "../lib/intakeSchema.js";
import ResumeMarkdown from "./ResumeMarkdown.jsx";
import { api } from "./api.js";

const POLL_INTERVAL_MS = 4000;

// `section` (optional) restricts rendering to a single block when set:
//   "summary"        — application summary only
//   "documents"      — uploaded-file previews only
//   "required-docs"  — LOR / internship / SOP lifecycle only
//   "resume"         — generated resume only
// Unset = render everything in sequence (used by staff preview).
export default function StudentDashboard({ studentName, onExit, staffPreview = null, embedded = false, section = null }) {
  const isStaffPreview = !!staffPreview;

  const [files, setFiles] = useState(() =>
    isStaffPreview ? staffPreview.files || [] : null
  );
  const [answers, setAnswers] = useState(() =>
    isStaffPreview ? extractAnswers(staffPreview.student?.data) : null
  );
  const [resumes, setResumes] = useState(() =>
    isStaffPreview ? normalizeStaffResumes(staffPreview.resumes) : null
  );
  const [requiredDocs, setRequiredDocs] = useState(null);
  const [myApplications, setMyApplications] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const studentId = staffPreview?.student?.student_id || null;

  const load = useCallback(async () => {
    try {
      if (isStaffPreview && studentId) {
        const [detail, reqDocs, appsData] = await Promise.all([
          api.getStudent(studentId),
          api.listRequiredDocsForStudent(studentId).catch(() => []),
          api.listApplications().catch(() => ({ pending: [], active: [], archived: [] })),
        ]);
        setFiles(detail.files || []);
        setAnswers(extractAnswers(detail.student?.data));
        setResumes(normalizeStaffResumes(detail.resumes));
        setRequiredDocs(reqDocs);
        const allApps = [...(appsData.pending || []), ...(appsData.active || [])];
        setMyApplications(allApps.filter((a) => a.student_id === studentId));
      } else {
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
      }
      setError(null);
    } catch (e) {
      setError(e?.message || "Couldn't load your information.");
    }
  }, [isStaffPreview, studentId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
    // Keep polling while a resume is mid-generation so the markdown
    // appears in place without the student needing to refresh.
    pollRef.current = setInterval(() => {
      const inflight = (resumes || []).some(
        (r) => r.status === "pending" || r.status === "running"
      );
      if (resumes === null || inflight) load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [resumes, load]);

  const latestResume = (resumes || [])[0] || null;

  // Group every answered field under its chapter/page using the schema
  // so the rendered layout mirrors the order of the intake form.
  const grouped = useMemo(() => groupAnswersBySchema(answers || {}), [answers]);

  // Field-id → field metadata, so the docs list can show a friendly
  // title (e.g. "Aadhar card scan" instead of "aadharFile") next to
  // the original filename.
  const fieldIndex = useMemo(() => buildFieldIndex(), []);

  const headerName = staffPreview?.student?.display_name
    || staffPreview?.student?.username
    || studentName
    || "student";

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
      {!isStaffPreview && !embedded && (
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

      <main className={`mx-auto ${isStaffPreview ? "max-w-4xl px-2 py-4" : embedded ? "max-w-3xl px-0 py-2" : "max-w-3xl px-6 py-12"}`}>
        {!isStaffPreview && !section && (
          <h1 className="font-serif text-3xl">{headerName}</h1>
        )}

        {error && (
          <p className="mt-6 inline-flex items-center gap-2 text-xs text-red-700">
            <AlertTriangle className="h-3 w-3" /> {error}
          </p>
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
                    studentId={isStaffPreview ? studentId : null}
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
                    studentId={isStaffPreview ? studentId : null}
                  />
                ))
              )}
            </div>
          </section>
        )}

        {/* Application status — read-only view of the student's school
            applications managed by their counsellor. Only rendered in
            the all-sections (staff-preview) path; PanelTabs has its
            own dedicated tab for this. */}
        {!section && myApplications && myApplications.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Application status</h2>
            <p className="mt-1 text-sm text-stone-800">
              Your school applications as tracked by your counsellor.
            </p>
            <div className="mt-3 space-y-2">
              {myApplications.map((app) => (
                <ApplicationStatusRow key={app.id} app={app} />
              ))}
            </div>
          </section>
        )}

        {(!section || section === "required-docs") && requiredDocs && requiredDocs.length > 0 && (
          <section className={section ? "" : "mt-10"}>
            <h2 className="text-xs uppercase tracking-[0.2em] text-black">Required documents</h2>
            <p className="mt-1 text-sm text-stone-800">
              Letters of recommendation, internship documents, and your statement of purpose. You'll see status updates here as your counsellor drafts each one.
            </p>
            <div className="mt-4 space-y-3">
              {requiredDocs.map((d) => (
                <RequiredDocRow
                  key={d.id}
                  doc={d}
                  isStaffPreview={isStaffPreview}
                  onAfterUpload={load}
                  studentId={isStaffPreview ? studentId : null}
                />
              ))}
            </div>
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
                <ResumeView latest={latestResume} />
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

// ============================================================
// ApplicationStatusRow — read-only card for one application.
// Colors mirror the operator's xlsx palette from ApplicationsPanel.jsx.
// ============================================================
const APP_STATUS_META = {
  active:    { label: "Active",                swatch: "#00FF00", tone: "#1c1917" },
  submitted: { label: "Application submitted", swatch: "#93C47D", tone: "#1c1917" },
  offer:     { label: "Offer received",        swatch: "#6AA84F", tone: "#ffffff" },
  ongoing:   { label: "Ongoing",               swatch: "#F5F5F0", tone: "#1c1917", border: "#d6d3d1" },
  on_hold:   { label: "On hold",               swatch: "#FF9900", tone: "#1c1917" },
  cancelled: { label: "Cancelled",             swatch: "#FF0000", tone: "#ffffff" },
};

function fmtAppDate(d) {
  if (!d) return null;
  try { return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return d; }
}

function ApplicationStatusRow({ app }) {
  const meta = APP_STATUS_META[app.status] || { label: app.status || "—", swatch: "#E7E5E4", tone: "#1c1917" };
  const isPending = app.pending;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-stone-900/10 bg-white px-4 py-3">
      {/* Status swatch */}
      <span
        className="shrink-0 rounded-sm px-2 py-0.5 text-xs font-medium"
        style={{
          background: meta.swatch,
          color: meta.tone,
          border: meta.border ? `1px solid ${meta.border}` : undefined,
        }}
      >
        {isPending ? "Awaiting review" : meta.label}
      </span>

      {/* School info — wraps inline; long names break to a new line
          rather than getting cut off. */}
      <span className="text-sm font-medium text-black break-words">{app.university}</span>
      {app.program && (
        <span className="text-xs text-black break-words">{app.program}</span>
      )}
      {app.country && (
        <span className="text-xs text-black">{app.country}</span>
      )}

      {/* Deadline */}
      {app.deadline && !isPending && (
        <span className="ml-auto shrink-0 text-xs text-black">
          Deadline: {fmtAppDate(app.deadline)}
        </span>
      )}
    </div>
  );
}

// ============================================================
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
function RequiredDocRow({ doc, isStaffPreview, onAfterUpload, studentId }) {
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

  const status = computeStatus(doc);
  const pill = STATUS_PILL[status] || { label: status, tone: "bg-stone-100 text-black border-stone-300" };

  // Deadline countdown for requested-but-not-uploaded rows.
  let dayBadge = null;
  if (status === "requested" && doc.deadline_at) {
    dayBadge = computeDayBadge(doc.requested_at, doc.deadline_at);
  }

  const canUpload = !isStaffPreview && status === "requested";
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
        <span className={`ml-auto inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${pill.tone}`}>
          {pill.label}
        </span>
        {dayBadge && (
          <span className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${dayBadge.tone}`}>
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

const STATUS_PILL = {
  awaiting_draft:   { label: "Counsellor drafting", tone: "bg-stone-100 text-black border-stone-300" },
  drafted:          { label: "Ready to send",       tone: "bg-amber-50 text-amber-800 border-amber-300" },
  drafted_sop:      { label: "Awaiting admin approval", tone: "bg-amber-50 text-amber-800 border-amber-300" },
  requested:        { label: "Print on letterhead", tone: "bg-blue-50 text-blue-800 border-blue-300" },
  received:         { label: "Received",            tone: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  approved:         { label: "Approved",            tone: "bg-emerald-50 text-emerald-800 border-emerald-300" },
};

function computeStatus(doc) {
  if (doc.kind === "sop") {
    if (doc.approved_by_admin_at) return "approved";
    if (doc.staff_draft) return "drafted_sop";
    return "awaiting_draft";
  }
  if (doc.final_file_id) return "received";
  if (doc.requested_at) return "requested";
  if (doc.marked_done_at) return "drafted";
  return "awaiting_draft";
}

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

function ResumeView({ latest }) {
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
  // Succeeded → render markdown. /me/resumes returns camelCase
  // (contentMd); admin /api/students/:id resumes use snake_case
  // (content_md). Try both.
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
// ============================================================
function ChapterSummaryBlock({ chapter, studentId }) {
  return (
    <div className="border border-stone-200 bg-white">
      <div className="border-b border-stone-100 px-6 py-3">
        <h3 className="font-serif text-xl text-black">{chapter.title}</h3>
      </div>
      <div className="divide-y divide-stone-100">
        {chapter.pages.map((page) => (
          <PageSummary key={page.id} page={page} studentId={studentId} />
        ))}
      </div>
    </div>
  );
}

function PageSummary({ page, studentId }) {
  const fields = page.fields.filter((f) => f.type !== "info" && isAnswered(f.value));
  if (fields.length === 0) return null;
  return (
    <div className="px-6 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-600">
        {page.title}
      </p>
      <dl className="mt-3 grid gap-x-8 gap-y-2.5 sm:grid-cols-[180px_1fr]">
        {fields.map((f) => (
          <SummaryFieldRow key={f.id} field={f} studentId={studentId} />
        ))}
      </dl>
    </div>
  );
}

function SummaryFieldRow({ field, studentId }) {
  return (
    <>
      <dt className="text-sm text-stone-700">{field.label}</dt>
      <dd className="text-base text-black">
        <SummaryFieldValue value={field.value} field={field} studentId={studentId} />
      </dd>
    </>
  );
}

function SummaryFieldValue({ value, field, studentId }) {
  if (value == null || value === "") {
    return <span className="text-stone-400">—</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>;
  }
  // File slot — filename + status pill, plus a mini preview of the
  // actual file (image inline, PDF link-card) so the student can read
  // each upload right where its values are summarised.
  if (value && typeof value === "object" && !Array.isArray(value) && "status" in value) {
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
        <MiniFilePreview slot={value} studentId={studentId} />
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
            <RepeaterRowSummary row={row} itemFields={itemFields} studentId={studentId} />
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

function RepeaterRowSummary({ row, itemFields, studentId }) {
  if (!row || typeof row !== "object") return <span>{String(row)}</span>;
  const subs = itemFields.length > 0
    ? itemFields
    : Object.keys(row).map((k) => ({ id: k, label: k }));
  const filled = subs
    .map((sub) => ({ sub, val: row[sub.id] }))
    .filter(({ val }) => isAnswered(val));
  if (filled.length === 0) return <span className="text-stone-400">(empty)</span>;
  return (
    <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[140px_1fr]">
      {filled.map(({ sub, val }) => (
        <SummaryFieldRow key={sub.id} field={{ ...sub, value: val }} studentId={studentId} />
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
function MiniFilePreview({ slot, fileId, fileName, mimeType, studentId }) {
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
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block max-w-sm border border-stone-200 bg-white"
        title="Open full size"
      >
        <img
          src={url}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="block max-h-60 w-full object-contain"
          style={{ imageOrientation: "from-image" }}
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-2 inline-flex max-w-sm items-center gap-3 border border-stone-200 bg-white px-3 py-2 transition hover:border-stone-900 hover:bg-stone-50"
      title="Open in a new tab"
    >
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-stone-300 bg-stone-50 text-[9px] font-semibold uppercase tracking-wider text-stone-700">
        PDF
      </span>
      <span className="min-w-0 truncate text-sm text-black">{name}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-[0.15em] text-stone-700">
        Open ↗
      </span>
    </a>
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
function DocumentPreview({ file, fieldIndex, studentId }) {
  const meta = fieldIndex.get(extractFieldRoot(file.field_id)) || null;
  const title = meta?.label || prettifyFieldId(file.field_id);
  const description =
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
      <div className="bg-stone-50">
        {isImg && (
          <img
            src={href}
            alt={title}
            className="mx-auto block max-h-[80vh] w-auto max-w-full"
          />
        )}
        {isPdf && (
          <iframe
            src={href}
            title={title}
            className="block h-[80vh] w-full border-0"
          />
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

function DocumentTile({ file, fieldIndex, studentId }) {
  const meta = fieldIndex.get(extractFieldRoot(file.field_id)) || null;
  // Title is the schema label (e.g. "Aadhar card scan"); falls back
  // to a prettified field id for files whose schema entry was renamed
  // since upload.
  const title = meta?.label || prettifyFieldId(file.field_id);
  // Description prefers the page's helper text (e.g. "Upload a photo
  // or scan, then type the number from it.") since that's where the
  // intake form actually says what this document is for. Otherwise
  // synthesise something useful from the page title + chapter.
  const description =
    meta?.pageHelper ||
    (meta?.pageTitle && meta?.chapterTitle
      ? `${meta.chapterTitle} · ${meta.pageTitle}`
      : meta?.placeholder || null);
  const Icon = isImage(file.mime_type) ? ImageIcon : FileText;
  // Default mode hits the student endpoint; staff preview hits the
  // admin endpoint so the cookie's role authorises the download.
  const href = studentId
    ? `/api/students/${studentId}/files/${file.id}`
    : `/api/students/me/files/${file.id}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-3 border border-stone-900/15 bg-white px-4 py-3 transition hover:border-stone-900/40"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-black group-hover:text-black" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-black">{title}</p>
        {description && (
          <p className="mt-1 text-[11px] text-black">{description}</p>
        )}
        <p className="mt-1 truncate text-[11px] text-black">
          <span className="text-black">File:</span> {file.original_name}
        </p>
        <p className="mt-0.5 text-[10px] text-black">
          {humanSize(file.size)} · {friendlyMimeLabel(file.mime_type)}
        </p>
      </div>
    </a>
  );
}

// ============================================================
// Helpers
// ============================================================

// Pull the answers object out of either /me/record's `data` or the
// admin endpoint's `student.data`. Both wrap the answer map under a
// top-level "answers" key (with order/lastStep alongside it for the
// form's own bookkeeping).
function extractAnswers(data) {
  if (!data || typeof data !== "object") return {};
  if (data.answers && typeof data.answers === "object") return data.answers;
  return data;
}

// Walk CHAPTERS and decorate each visible field with its current value.
// Skip pages where every field is empty so we don't render long blocks
// of dashes for sections the student deliberately skipped (optional
// chapters like "post-graduate university" for an undergrad applicant).
function groupAnswersBySchema(answers) {
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
function buildFieldIndex() {
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

// Admin endpoint returns resume rows in snake_case; the student-facing
// renderer prefers camelCase. Normalise once on entry so downstream
// code doesn't have to fork.
function normalizeStaffResumes(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    id: String(r.id),
    label: r.label,
    status: r.status,
    contentMd: r.content_md ?? r.contentMd ?? null,
    error: r.error,
    createdAt: r.created_at ?? r.createdAt,
    updatedAt: r.updated_at ?? r.updatedAt,
  }));
}
