// Popup for one row in the recommended-docs grid (LOR / Internship /
// NGO / SOP). Opens from the Documents-tab chip click on
// StudentDocumentsChecklist. Lets the counsellor:
//   1. Edit per-kind metadata (subject, recipient/company name, role,
//      reason/activity brief).
//   2. Set generation instructions + target word count.
//   3. Queue an AI fill request (writes a manual_ai_requests row tagged
//      with this doc id — does NOT inline-generate).
//   4. Read + edit the AI-produced staff_draft once it's been written.
//   5. Confirm (admin approval) or Delete the row.
//
// "Confirm" calls /approve and sets approved_by_admin_at, marking the
// draft as the final artifact (the recommended-docs flow no longer
// requires a stamped file upload for non-final review).
//
// Delete refuses on the server if the row has already been sent to the
// student (requested_at) or has an uploaded final. The button is hidden
// in those states so the counsellor doesn't see a dead control.

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Send, CheckCircle2, Trash2 } from "lucide-react";
import { api } from "./api.js";

const KIND_META = {
  lor: {
    title: "Letter of Recommendation",
    subjectLabel: "School subject",
    subjectPlaceholder: "e.g. Mathematics, Physics, English",
    defaultWords: 600,
    nameLabel: "Recommender name",
    roleLabel: "Recommender role / title",
    briefLabel: "Why this recommender (brief — ≤20 words)",
    briefField: "reason_brief",
    nameField: "recipient_name",
    roleField: "recipient_role",
  },
  internship: {
    title: "Internship certificate",
    subjectLabel: "Role / function",
    subjectPlaceholder: "e.g. Software Developer, Marketing Intern",
    defaultWords: 350,
    nameLabel: "Company name",
    roleLabel: "Company website",
    briefLabel: "Activity description (brief — ≤30 words)",
    briefField: "activity_brief",
    nameField: "company_name",
    roleField: "company_website",
  },
  ngo: {
    title: "NGO letter",
    subjectLabel: "Volunteer role",
    subjectPlaceholder: "e.g. Tutor, Event Organiser",
    defaultWords: 350,
    nameLabel: "Organisation name",
    roleLabel: "Organisation website",
    briefLabel: "Activity description (brief — ≤30 words)",
    briefField: "activity_brief",
    nameField: "company_name",
    roleField: "company_website",
  },
  extracurricular: {
    title: "Extracurricular letter",
    subjectLabel: "Activity / role",
    subjectPlaceholder: "e.g. Debate Captain, Choir Lead",
    defaultWords: 350,
    nameLabel: "Activity / club name",
    roleLabel: "Issuer website",
    briefLabel: "Activity description (brief — ≤30 words)",
    briefField: "activity_brief",
    nameField: "company_name",
    roleField: "company_website",
  },
  sop: {
    title: "Statement of Purpose",
    subjectLabel: "Programme / field of study",
    subjectPlaceholder: "e.g. MS Computer Science, MBA",
    defaultWords: 1000,
    nameLabel: null,
    roleLabel: null,
    briefLabel: null,
  },
};

export default function RecommendedDocPopup({ doc, studentId, role, onClose, onRefresh }) {
  const meta = KIND_META[doc.kind] || KIND_META.lor;
  const slotLabel = doc.kind === "sop"
    ? "SOP"
    : `${doc.kind.charAt(0).toUpperCase() + doc.kind.slice(1)} ${doc.seq}`;

  const [subject,      setSubject]      = useState(doc.subject || "");
  const [instructions, setInstructions] = useState(doc.instructions || "");
  const [targetWords,  setTargetWords]  = useState(doc.target_words ?? meta.defaultWords);
  const [name,         setName]         = useState(doc[meta.nameField || ""] || "");
  const [roleVal,      setRoleVal]      = useState(doc[meta.roleField || ""] || "");
  const [brief,        setBrief]        = useState(doc[meta.briefField || ""] || "");
  const [draft,        setDraft]        = useState(doc.staff_draft || "");
  const [saving,       setSaving]       = useState(false);
  const [generating,   setGenerating]   = useState(false);
  const [confirming,   setConfirming]   = useState(false);
  const [deleting,     setDeleting]     = useState(false);
  const [err,          setErr]          = useState(null);
  const [genMsg,       setGenMsg]       = useState(null);

  const approved = !!doc.approved_by_admin_at;
  const sent     = !!doc.requested_at;
  const hasFinal = !!doc.final_file;
  const canDelete = !sent && !hasFinal;
  const canApprove = role === "admin";

  const buildPatch = () => {
    const p = {
      subject: subject || null,
      instructions: instructions || null,
      target_words: targetWords ? Number(targetWords) : null,
      staff_draft: draft || null,
    };
    if (meta.nameField)  p[meta.nameField]  = name || null;
    if (meta.roleField)  p[meta.roleField]  = roleVal || null;
    if (meta.briefField) p[meta.briefField] = brief || null;
    return p;
  };

  async function handleSave() {
    setSaving(true); setErr(null);
    try {
      await api.updateRequiredDoc(doc.id, buildPatch());
      onRefresh && onRefresh();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerate() {
    setGenerating(true); setErr(null); setGenMsg(null);
    try {
      // Save current inputs first so the AI generator reads the latest
      // subject / instructions / target_words from the row.
      await api.updateRequiredDoc(doc.id, buildPatch());
      const r = await api.generateRequiredDoc(doc.id);
      setGenMsg(`Queued (request #${r.request_id}). Draft will appear here once the AI pipeline runs.`);
      onRefresh && onRefresh();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleConfirm() {
    setConfirming(true); setErr(null);
    try {
      if (draft !== (doc.staff_draft || "")) {
        await api.updateRequiredDoc(doc.id, { staff_draft: draft || null });
      }
      await api.approveRequiredDoc(doc.id, approved /* undo if already approved */);
      onRefresh && onRefresh();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setConfirming(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${slotLabel}? This removes the row entirely — does not affect uploaded intake files.`)) return;
    setDeleting(true); setErr(null);
    try {
      await api.deleteRequiredDoc(doc.id);
      onRefresh && onRefresh();
      onClose();
    } catch (e) {
      setErr(e.message || String(e));
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-3xl flex-col rounded-xl border border-stone-200 bg-white shadow-2xl"
        style={{ maxHeight: "92vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-stone-100 px-6 py-5">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-stone-400">{slotLabel}</p>
            <p className="text-lg font-semibold text-black">{meta.title}</p>
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

        {/* Body */}
        <div className="space-y-5 overflow-y-auto px-6 py-5">
          {/* Per-kind metadata */}
          {meta.nameField && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-stone-600">{meta.nameLabel}</span>
                <input
                  className="w-full rounded border border-stone-300 px-3 py-2 text-sm text-black focus:border-[#cc785c] focus:outline-none"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-stone-600">{meta.roleLabel}</span>
                <input
                  className="w-full rounded border border-stone-300 px-3 py-2 text-sm text-black focus:border-[#cc785c] focus:outline-none"
                  value={roleVal}
                  onChange={(e) => setRoleVal(e.target.value)}
                />
              </label>
            </div>
          )}

          {meta.briefField && (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-stone-600">{meta.briefLabel}</span>
              <input
                className="w-full rounded border border-stone-300 px-3 py-2 text-sm text-black focus:border-[#cc785c] focus:outline-none"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
            </label>
          )}

          {/* AI-generation inputs */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_140px]">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-stone-600">{meta.subjectLabel}</span>
              <input
                className="w-full rounded border border-stone-300 px-3 py-2 text-sm text-black focus:border-[#cc785c] focus:outline-none"
                placeholder={meta.subjectPlaceholder}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-stone-600">Word count</span>
              <input
                type="number"
                min="100" max="2000" step="50"
                className="w-full rounded border border-stone-300 px-3 py-2 text-sm text-black focus:border-[#cc785c] focus:outline-none"
                value={targetWords ?? ""}
                onChange={(e) => setTargetWords(e.target.value ? Number(e.target.value) : null)}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-stone-600">Instructions for the AI</span>
            <textarea
              className="w-full rounded border border-stone-300 px-3 py-2 text-sm text-black focus:border-[#cc785c] focus:outline-none"
              rows={4}
              placeholder={doc.kind === "lor"
                ? "Focus on the subject. If you mention any activity, use only school activities related to this subject. Other tone / structure preferences…"
                : "Tone, structure, things to emphasise…"}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>

          {/* Generate-AI button + status */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || saving}
              className="inline-flex items-center gap-2 rounded border-2 border-[#cc785c] bg-[#cc785c] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#b86a4f] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Generate AI fill
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || generating}
              className="inline-flex items-center gap-2 rounded border-2 border-stone-900 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save inputs
            </button>
            {genMsg && <span className="text-xs text-emerald-800">{genMsg}</span>}
          </div>

          {/* AI-produced draft */}
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-stone-600">AI-generated draft</p>
            {doc.staff_draft ? (
              <textarea
                className="w-full rounded border border-stone-300 px-3 py-2 font-serif text-sm leading-relaxed text-black focus:border-[#cc785c] focus:outline-none"
                rows={16}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <p className="rounded border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center text-sm text-stone-600">
                No draft yet. Click <span className="font-semibold text-black">Generate AI fill</span> to queue one — it will appear here after the AI pipeline runs.
              </p>
            )}
          </div>

          {err && (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>
          )}
        </div>

        {/* Footer: Confirm + Delete */}
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
              Delete
            </button>
          ) : (
            <span className="text-xs text-stone-500">
              {sent ? "Already sent to student — delete unavailable." : "Has uploaded final — delete unavailable."}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
