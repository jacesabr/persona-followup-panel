// Popup for one row in the recommended-docs grid (LOR / Internship /
// NGO / Extracurricular / SOP). Opens from a chip click on the
// Documents-tab StudentDocumentsChecklist OR from the per-student slide
// flow. Behaviour is now upload-only — there is no in-app drafting any
// more. The counsellor (or the student via the dashboard) uploads the
// signed PDF / image of the final letter; this popup is just the file
// preview + upload widget + admin Confirm + row Delete.
//
// Lifecycle:
//   - empty row  → "Upload" button only
//   - uploaded   → file preview + filename + "Replace" + "Remove file"
//   - confirmed  → green "Approved" badge in the header; Un-confirm in footer
//
// Server enforces that Delete refuses to remove a row that's already
// been sent to the student or has an uploaded final.

import { useRef, useState } from "react";
import { X, Loader2, Upload, CheckCircle2, Trash2 } from "lucide-react";
import { api } from "./api.js";

const KIND_TITLE = {
  lor: "Letter of Recommendation",
  internship: "Internship certificate",
  ngo: "NGO letter",
  extracurricular: "Extracurricular letter",
  sop: "Statement of Purpose",
};

export default function RecommendedDocPopup({ doc, studentId, role, onClose, onRefresh }) {
  const slotLabel = doc.kind === "sop"
    ? "SOP"
    : `${doc.kind.charAt(0).toUpperCase() + doc.kind.slice(1)} ${doc.seq}`;
  const title = KIND_TITLE[doc.kind] || "Document";

  const [uploading, setUploading] = useState(false);
  const [clearing,  setClearing]  = useState(false);
  const [confirming,setConfirming]= useState(false);
  const [deleting,  setDeleting]  = useState(false);
  const [err,       setErr]       = useState(null);
  const fileInputRef = useRef(null);

  const approved = !!doc.approved_by_admin_at;
  const sent     = !!doc.requested_at;
  const file     = doc.final_file || null;
  const fileUrl  = file && studentId ? `/api/students/${studentId}/files/${file.id}` : null;
  const isImage  = file && file.mime_type?.startsWith("image/");
  const isPdf    = file && file.mime_type === "application/pdf";
  const canDelete  = !sent && !file;
  const canApprove = role === "admin";

  async function handleUpload(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true); setErr(null);
    try {
      await api.uploadRequiredDocFile(doc.id, f);
      onRefresh && (await onRefresh());
    } catch (ex) {
      setErr(ex.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleClearFile() {
    if (!window.confirm(`Remove the uploaded file from ${slotLabel}? The row stays so you can upload a replacement.`)) return;
    setClearing(true); setErr(null);
    try {
      await api.clearRequiredDocFinal(doc.id);
      onRefresh && (await onRefresh());
    } catch (ex) {
      setErr(ex.message || "Couldn't remove file");
    } finally {
      setClearing(false);
    }
  }

  async function handleConfirm() {
    setConfirming(true); setErr(null);
    try {
      await api.approveRequiredDoc(doc.id, approved);
      onRefresh && (await onRefresh());
    } catch (ex) {
      setErr(ex.message || "Couldn't update approval");
    } finally {
      setConfirming(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${slotLabel}? This removes the row entirely.`)) return;
    setDeleting(true); setErr(null);
    try {
      await api.deleteRequiredDoc(doc.id);
      onRefresh && (await onRefresh());
      onClose();
    } catch (ex) {
      setErr(ex.message || "Couldn't delete row");
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="relative flex w-full max-w-2xl flex-col rounded-xl border border-stone-200 bg-white shadow-2xl"
        style={{ maxHeight: "92vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-stone-100 px-6 py-5">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-stone-400">{slotLabel}</p>
            <p className="text-lg font-semibold text-black">{title}</p>
            {approved && (
              <span className="mt-2 inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                <CheckCircle2 className="h-3 w-3" /> Approved
              </span>
            )}
          </div>
          <button className="text-stone-400 hover:text-stone-700" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto px-6 py-5">
          {file ? (
            <>
              {fileUrl && isImage && (
                <img src={fileUrl} alt={file.original_name}
                  className="w-full rounded border border-stone-200 object-contain"
                  style={{ maxHeight: 480 }} />
              )}
              {fileUrl && isPdf && (
                <iframe src={fileUrl} title={file.original_name}
                  className="w-full rounded border border-stone-200"
                  style={{ height: 480 }} />
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
                <span className="break-all font-medium text-black">{file.original_name}</span>
                {fileUrl && (
                  <a href={fileUrl} target="_blank" rel="noreferrer"
                    className="text-sm font-semibold text-[#cc785c] hover:underline">
                    Open in new tab ↗
                  </a>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || clearing}
                  className="inline-flex items-center gap-2 rounded border-2 border-stone-900 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Replace file
                </button>
                <button
                  type="button"
                  onClick={handleClearFile}
                  disabled={clearing || uploading}
                  className="inline-flex items-center gap-2 rounded border-2 border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Remove file
                </button>
              </div>
            </>
          ) : (
            <div className="rounded border border-dashed border-stone-300 bg-stone-50 px-6 py-10 text-center">
              <Upload className="mx-auto mb-3 h-8 w-8 text-stone-400" />
              <p className="mb-1 text-base font-semibold text-black">No file uploaded yet</p>
              <p className="mb-5 text-sm text-stone-800">
                Upload the signed PDF or a clear photo (JPG / PNG) of the {title.toLowerCase()}.
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-2 rounded border-2 border-[#cc785c] bg-[#cc785c] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload file
              </button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={handleUpload}
            className="hidden"
          />

          {err && (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 px-6 py-4">
          <div className="flex gap-2">
            {canApprove && (
              <button
                type="button"
                onClick={handleConfirm}
                disabled={confirming}
                className={`inline-flex items-center gap-2 rounded border-2 px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50
                  ${approved
                    ? "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                    : "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"}`}
              >
                {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {approved ? "Un-confirm" : "Confirm"}
              </button>
            )}
          </div>
          {canDelete ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex items-center gap-2 rounded border-2 border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete row
            </button>
          ) : (
            <span className="text-xs text-stone-500">
              {sent ? "Already sent to student — delete unavailable." : "Remove the uploaded file first to delete the row."}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
