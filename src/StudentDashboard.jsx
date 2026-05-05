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
} from "lucide-react";
import { loadRecord, listMyFiles, listResumes } from "./intakeFiles.js";
import { CHAPTERS, isFieldVisible } from "../lib/intakeSchema.js";
import ResumeMarkdown from "./ResumeMarkdown.jsx";
import { api } from "./api.js";

const POLL_INTERVAL_MS = 4000;

export default function StudentDashboard({ studentName, onExit, staffPreview = null }) {
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
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const studentId = staffPreview?.student?.student_id || null;

  const load = useCallback(async () => {
    try {
      if (isStaffPreview && studentId) {
        const detail = await api.getStudent(studentId);
        setFiles(detail.files || []);
        setAnswers(extractAnswers(detail.student?.data));
        setResumes(normalizeStaffResumes(detail.resumes));
      } else {
        const [fileList, record, resumeList] = await Promise.all([
          listMyFiles(),
          loadRecord().catch(() => ({ data: {} })),
          listResumes().catch(() => []),
        ]);
        setFiles(fileList);
        setAnswers(extractAnswers(record?.data));
        setResumes(resumeList);
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

  return (
    <div className="min-h-screen w-full font-serif text-stone-900" style={{ backgroundColor: "#f4f0e6" }}>
      {!isStaffPreview && (
        <header className="border-b border-stone-900/10 bg-[#f4f0e6]/80 px-6 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-sm italic text-stone-500">the</span>
              <span className="text-lg font-semibold tracking-tight">Persona</span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-stone-500">
                · {headerName}
              </span>
            </div>
            <button
              type="button"
              onClick={onExit}
              className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-stone-500 hover:text-stone-900"
            >
              <LogOut className="h-3 w-3" /> Sign out
            </button>
          </div>
        </header>
      )}

      <main className={`mx-auto ${isStaffPreview ? "max-w-4xl px-2 py-4" : "max-w-3xl px-6 py-12"}`}>
        {!isStaffPreview && (
          <h1 className="font-serif text-3xl">{headerName}</h1>
        )}

        {error && (
          <p className="mt-6 inline-flex items-center gap-2 text-xs text-red-700">
            <AlertTriangle className="h-3 w-3" /> {error}
          </p>
        )}

        <section className="mt-10">
          <h2 className="text-xs uppercase tracking-[0.2em] text-stone-500">Your information</h2>
          <p className="mt-1 text-xs text-stone-500">
            Everything you submitted on the intake form, grouped the same way you filled it out.
          </p>
          <div className="mt-3 space-y-4">
            {answers === null ? (
              <div className="flex items-center gap-2 border border-stone-900/15 bg-white px-4 py-3 text-xs text-stone-500">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : grouped.length === 0 ? (
              <p className="border border-stone-900/15 bg-white px-4 py-3 text-xs italic text-stone-500">
                No answers recorded yet.
              </p>
            ) : (
              grouped.map((chapter) => (
                <ChapterBlock key={chapter.id} chapter={chapter} />
              ))
            )}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-xs uppercase tracking-[0.2em] text-stone-500">Your documents</h2>
          <p className="mt-1 text-xs text-stone-500">
            Everything you uploaded — marksheets, passport pages, photos, certificates. Click any tile to open the file.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {files === null ? (
              <div className="flex items-center gap-2 border border-stone-900/15 bg-white px-4 py-3 text-xs text-stone-500 sm:col-span-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : files.length === 0 ? (
              <p className="border border-stone-900/15 bg-white px-4 py-3 text-xs italic text-stone-500 sm:col-span-2">
                No documents uploaded.
              </p>
            ) : (
              files.map((f) => (
                <DocumentTile
                  key={f.id}
                  file={f}
                  fieldIndex={fieldIndex}
                  studentId={isStaffPreview ? studentId : null}
                />
              ))
            )}
          </div>
        </section>

        {/* Generated resume — read-only. The regenerate flow lives on
            the staff side; the student just sees the latest output. */}
        {latestResume && (
          <section className="mt-10">
            <h2 className="text-xs uppercase tracking-[0.2em] text-stone-500">Your resume</h2>
            <div className="mt-3 border border-stone-900/15 bg-white p-6">
              <ResumeView latest={latestResume} />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function ResumeView({ latest }) {
  if (!latest) return null;
  if (latest.status === "pending" || latest.status === "running") {
    return (
      <div className="flex items-center gap-3 text-sm text-stone-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        <div>
          Generating your resume… this usually takes 30–60 seconds.
          <div className="mt-1 text-xs text-stone-400">Status: {latest.status}</div>
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
          <details className="text-xs text-stone-500">
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
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-700">
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

function PageBlock({ page }) {
  return (
    <div className="px-4 py-3">
      <p className="text-[11px] font-medium text-stone-700">{page.title}</p>
      {page.helper && (
        <p className="mt-0.5 text-[10px] italic text-stone-400">{page.helper}</p>
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
      <dt className="text-[11px] text-stone-500">{field.label}</dt>
      <dd className="text-[12px] text-stone-900">
        <FieldValue value={value} field={field} />
      </dd>
    </>
  );
}

function FieldValue({ value, field }) {
  if (value == null || value === "") {
    return <span className="italic text-stone-400">—</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>;
  }
  // File slot — surface filename + status. The actual download lives
  // in the "Your documents" section below; here we just confirm it
  // was uploaded against this field.
  if (value && typeof value === "object" && !Array.isArray(value) && "status" in value) {
    return (
      <span className="text-stone-600">
        <Paperclip className="mr-1 inline-block h-3 w-3 -translate-y-px text-stone-400" />
        {value.name || "(file)"}
        {value.status === "uploaded" ? (
          <span className="ml-1 text-emerald-700">✓</span>
        ) : (
          <span className="ml-1 text-stone-400">({value.status})</span>
        )}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="italic text-stone-400">(none)</span>;
    }
    // Repeater rows. Each item is a sub-object keyed by itemFields[].id.
    const itemFields = field?.itemFields || [];
    return (
      <ol className="list-decimal space-y-1 pl-4">
        {value.map((row, i) => (
          <li key={i}>
            {row && typeof row === "object" ? (
              <span className="text-stone-700">
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
      <pre className="overflow-auto whitespace-pre-wrap text-[10px] text-stone-600">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span>{String(value)}</span>;
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
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-stone-500 group-hover:text-stone-900" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-stone-900">{title}</p>
        {description && (
          <p className="mt-1 text-[11px] text-stone-600">{description}</p>
        )}
        <p className="mt-1 truncate text-[11px] text-stone-500">
          <span className="text-stone-400">File:</span> {file.original_name}
        </p>
        <p className="mt-0.5 text-[10px] text-stone-400">
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
