import { useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus, Copy, Check, ChevronDown, ChevronRight, AlertCircle, KeyRound, X, MessageCircle, Mail, Link2, Search, Download } from "lucide-react";
import { api } from "./api.js";

// Students tab — visible to admin (full roster) and counsellor (own only).
// Two purposes:
//   1. Sign new students up: type username + optional lead link, get back a
//      one-time generated password the counsellor copies and sends.
//   2. Browse the roster + drill into each student's intake data, uploaded
//      files, AI extractions, and (eventually) generated resumes.
export default function StudentsAdmin({ role, leads = [] }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  // Roster filter — case-insensitive substring match across the visible
  // metadata columns. Cheap client-side filter; server pagination is a
  // future concern (we only return the row count up to a few hundred).
  const [filter, setFilter] = useState("");
  const [credentialsModal, setCredentialsModal] = useState(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await api.listStudents();
      setStudents(list);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

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
          />
        ))}
      </div>

      {credentialsModal && (
        <CredentialsModal
          account={credentialsModal}
          onClose={() => setCredentialsModal(null)}
        />
      )}
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

// ============================================================
// StudentRow — collapsed roster row + expandable detail view.
// ============================================================
function StudentRow({ row, expanded, onToggle, onResetPassword }) {
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

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

  return (
    <div className="border border-stone-300 bg-white">
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
            {row.intake_complete ? "✓ intake complete" : "intake in progress"}
            {" · "}
            {row.file_count} files{" · "}
            {row.resume_count} resumes
            {row.lead_name && <> {" · "} from lead: <span className="text-stone-700">{row.lead_name}</span></>}
            {row.counsellor_name && <> {" · "} by: {row.counsellor_name}</>}
          </p>
        </div>
        <button
          onClick={resetPassword}
          className="ml-3 hidden shrink-0 border border-stone-300 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-600 hover:border-stone-700 hover:text-stone-900 sm:inline-block"
        >
          Reset pw
        </button>
      </button>

      {expanded && (
        <div className="border-t border-stone-200 bg-stone-50 p-4">
          {detailLoading && (
            <p className="text-xs italic text-stone-500">Loading…</p>
          )}
          {detail?.error && (
            <p className="text-xs text-red-700">{detail.error}</p>
          )}
          {detail && !detail.error && <StudentDetail detail={detail} />}
        </div>
      )}
    </div>
  );
}

// ============================================================
// StudentDetail — shows the raw data Gemini extracted + uploaded
// files + any generated resumes. Read-only for now; resume gen
// trigger lands in slice 3.
// ============================================================
function StudentDetail({ detail }) {
  const { student, files, extractions, resumes } = detail;
  return (
    <div className="space-y-5 text-xs">
      <Section title="Intake form data">
        {student?.data && Object.keys(student.data).length > 0 ? (
          <pre className="max-h-64 overflow-auto bg-white p-3 text-[10px] text-stone-800">
            {JSON.stringify(student.data, null, 2)}
          </pre>
        ) : (
          <p className="italic text-stone-500">Student hasn't started filling the form yet.</p>
        )}
      </Section>

      <Section title={`Uploaded files (${files?.length || 0})`}>
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

      <Section title={`AI extractions (${extractions?.length || 0})`}>
        {extractions?.length ? (
          <div className="space-y-2">
            {extractions.map((e) => (
              <details key={e.id} className="border border-stone-200 bg-white">
                <summary className="cursor-pointer px-3 py-2 hover:bg-stone-50">
                  <span className="font-mono text-[10px] text-stone-400">{e.extractor}</span>
                  {" "}
                  <span className={`text-[10px] uppercase tracking-[0.15em] ${
                    e.status === "succeeded" ? "text-emerald-700"
                    : e.status === "failed" ? "text-red-700"
                    : "text-stone-500"
                  }`}>{e.status}</span>
                  {e.error && <span className="ml-2 text-[10px] text-red-700">— {e.error}</span>}
                  {e.confirmed_at && <span className="ml-2 text-[10px] text-emerald-700">✓ confirmed</span>}
                </summary>
                <pre className="max-h-64 overflow-auto bg-stone-50 p-3 text-[10px] text-stone-800">
                  {JSON.stringify(e.confirmed_data || e.data, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        ) : (
          <p className="italic text-stone-500">No extractions yet.</p>
        )}
      </Section>

      <Section title={`Generated resumes (${resumes?.length || 0})`}>
        {resumes?.length ? (
          <div className="space-y-2">
            {resumes.map((r) => (
              <div key={r.id} className="border border-stone-200 bg-white px-3 py-2">
                <p className="text-stone-900">
                  {r.label || `Resume #${r.id}`}
                  <span className="ml-2 text-[10px] uppercase tracking-[0.15em] text-stone-500">
                    {r.length_pages ? `${r.length_pages}p` : ""} · {r.style || "—"} · {r.status}
                  </span>
                </p>
                {r.content_md && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-[0.15em] text-stone-500">
                      View Markdown
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto bg-stone-50 p-3 text-[10px] text-stone-800">
                      {r.content_md}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="italic text-stone-500">No resumes generated yet.</p>
        )}
      </Section>
    </div>
  );
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
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
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
