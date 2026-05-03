import { useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus, Copy, Check, ChevronDown, ChevronRight, AlertCircle, KeyRound, X } from "lucide-react";
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

  return (
    <div>
      <CreateStudentForm role={role} leads={leads} onCreated={onCreated} />

      <div className="mt-8 mb-3 flex items-baseline justify-between border-b border-stone-300 pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-700">
          Students {students.length > 0 && (
            <span className="ml-2 text-xs font-normal text-stone-500">({students.length})</span>
          )}
        </h2>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-stone-400" />}
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

      <div className="space-y-2">
        {students.map((s) => (
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
// CredentialsModal — shows the one-time plaintext password after
// account creation or password reset. Counsellor copies + sends to
// the student. Cannot be retrieved again after the modal closes.
// ============================================================
function CredentialsModal({ account, onClose }) {
  const [copied, setCopied] = useState(null);
  const fullText = `Username: ${account.username}\nPassword: ${account.password}\nLogin at: ${window.location.origin}`;

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
        className="w-full max-w-lg border border-stone-300 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-700">
            <KeyRound className="mr-2 inline-block h-3 w-3" />
            Account credentials
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
          ⚠ Copy these now — the password is shown <strong>once</strong> and never again.
          Send them to the student through your usual channel.
        </p>

        <CredField label="Username" value={account.username} onCopy={() => copy(account.username, "username")} copied={copied === "username"} />
        <CredField label="Password" value={account.password} onCopy={() => copy(account.password, "password")} copied={copied === "password"} mono />
        <div className="mt-4">
          <button
            onClick={() => copy(fullText, "all")}
            className="inline-flex items-center gap-2 border border-stone-700 bg-stone-700 px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-stone-800"
          >
            {copied === "all" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied === "all" ? "Copied all" : "Copy username + password + login URL"}
          </button>
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full border border-stone-400 px-4 py-2 text-xs uppercase tracking-[0.2em] text-stone-600 hover:bg-stone-50"
        >
          I've saved them
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
