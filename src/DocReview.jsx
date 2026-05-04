// Side-by-side document review: for each uploaded document, the
// student sees the doc on the left and the form fields whose values
// appear on that doc on the right. They type the values manually
// while looking at the doc — auto-extraction is dormant.
//
// Driven by DOC_REVIEW_GROUPS (defined in StudentIntake.jsx). Skips
// any group whose corresponding upload field has no uploaded file —
// students who didn't take a test don't see a "score" panel for it.

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, FileText, Check, Loader2 } from "lucide-react";
import { DOC_REVIEW_GROUPS } from "./StudentIntake.jsx";
import { isFileUploaded } from "./intakeFiles.js";

export default function DocReview({ answers, onChangeField, onSave, onBack, onFinish }) {
  // Filter to docs the student actually uploaded. A repeater item's
  // uploads aren't included today (activities_list[*].proof,
  // otherDocs_list[*].file) — the description the student typed during
  // intake stands as the doc's caption. Add repeater coverage in v2.
  const groups = useMemo(
    () => DOC_REVIEW_GROUPS.filter((g) => isFileUploaded(answers[g.docFieldId])),
    [answers]
  );

  const [activeIdx, setActiveIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (groups.length === 0) {
    // Edge case: student finished general intake without uploading any
    // docs (everything was optional). Skip the review step entirely.
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="font-serif text-3xl">No documents to review</h1>
        <p className="mt-3 text-sm text-stone-600">
          You didn't upload any documents during intake. We'll generate your
          resume from the information you typed.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 border border-stone-900/30 bg-white px-4 py-2 text-sm hover:border-stone-900"
          >
            <ArrowLeft className="h-4 w-4" /> Back to intake
          </button>
          <button
            type="button"
            onClick={() => handleFinish()}
            disabled={submitting}
            className="inline-flex items-center gap-2 bg-stone-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Finish & generate resume <ArrowRight className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  const active = groups[activeIdx];
  const isLast = activeIdx === groups.length - 1;
  const file = answers[active.docFieldId];

  async function handleFinish() {
    setError(null);
    setSubmitting(true);
    try {
      // Save any pending edits before transitioning. onSave is the
      // intake's persist() → blocks until the server returns the new
      // updatedAt so the phase transition that follows doesn't race
      // an in-flight save.
      if (onSave) await onSave();
      await onFinish();
    } catch (e) {
      setError(e?.message || "Couldn't finish — try again.");
      setSubmitting(false);
    }
  }

  async function handleNext() {
    setError(null);
    if (isLast) {
      await handleFinish();
      return;
    }
    if (onSave) {
      try { await onSave(); } catch {}
    }
    setActiveIdx((i) => i + 1);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      {/* Progress strip */}
      <div className="mb-4 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-stone-500">
        <span>
          Document {activeIdx + 1} of {groups.length}
        </span>
        <span className="font-mono text-[10px] text-stone-400">
          {active.docFieldId}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Left: document viewer (3/5 width on lg+) */}
        <section className="lg:col-span-3">
          <div className="border border-stone-900/15 bg-white">
            <header className="flex items-center justify-between border-b border-stone-900/10 px-4 py-2">
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-stone-500" />
                <span className="font-medium">{active.title}</span>
              </div>
              <a
                href={file.uploadedUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs uppercase tracking-[0.15em] text-stone-500 hover:text-stone-900"
              >
                Open in new tab ↗
              </a>
            </header>
            <DocViewer file={file} />
          </div>
        </section>

        {/* Right: form fields (2/5 width on lg+) */}
        <section className="lg:col-span-2">
          <div className="border border-stone-900/15 bg-white p-5">
            <h2 className="font-serif text-xl">{active.title}</h2>
            {active.helper && (
              <p className="mt-1 text-sm text-stone-600">{active.helper}</p>
            )}

            {active.fields.length === 0 ? (
              <p className="mt-6 text-sm text-stone-600">
                Nothing to type for this document — just confirm it's the right
                file.
              </p>
            ) : (
              <div className="mt-6 space-y-4">
                {active.fields.map((field) => (
                  <SimpleField
                    key={field.id}
                    field={field}
                    value={answers[field.id]}
                    onChange={(v) => onChangeField(field.id, v)}
                  />
                ))}
              </div>
            )}

            <div className="mt-8 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
                disabled={activeIdx === 0}
                className="inline-flex items-center gap-1 text-xs uppercase tracking-[0.15em] text-stone-500 hover:text-stone-900 disabled:opacity-30"
              >
                <ArrowLeft className="h-3 w-3" /> Previous
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={submitting}
                className="inline-flex items-center gap-2 bg-stone-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Finishing…
                  </>
                ) : isLast ? (
                  <>
                    <Check className="h-4 w-4" /> Finish & generate resume
                  </>
                ) : (
                  <>
                    Next document <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
            {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
          </div>

          {/* Group nav */}
          <nav className="mt-3 flex flex-wrap gap-1">
            {groups.map((g, i) => (
              <button
                key={g.docFieldId}
                type="button"
                onClick={() => setActiveIdx(i)}
                className={`px-2 py-1 text-[10px] uppercase tracking-[0.15em] ${
                  i === activeIdx
                    ? "bg-stone-900 text-white"
                    : "border border-stone-900/20 text-stone-600 hover:border-stone-900"
                }`}
                title={g.title}
              >
                {i + 1}
              </button>
            ))}
          </nav>

          <div className="mt-4">
            <button
              type="button"
              onClick={onBack}
              className="text-xs uppercase tracking-[0.2em] text-stone-500 hover:text-stone-900"
            >
              ← Back to intake form
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function DocViewer({ file }) {
  if (!file?.uploadedUrl) {
    return (
      <div className="flex h-[600px] items-center justify-center text-sm text-stone-500">
        File not available.
      </div>
    );
  }
  const url = file.uploadedUrl;
  const type = file.type || "";
  if (type.startsWith("image/")) {
    return (
      <img
        src={url}
        alt={file.name}
        className="block max-h-[800px] w-full object-contain"
      />
    );
  }
  // PDF (and anything else) — iframe. Browsers' built-in PDF viewer
  // handles application/pdf inline; for unsupported types the iframe
  // falls back to the file download / "open in new tab" link above.
  return (
    <iframe
      src={url}
      title={file.name}
      className="block h-[800px] w-full border-0"
    />
  );
}

function SimpleField({ field, value, onChange }) {
  const id = `dr_${field.id}`;
  const common = {
    id,
    value: value == null ? "" : String(value),
    onChange: (e) => onChange(e.target.value),
    className:
      "w-full border border-stone-900/30 bg-white px-3 py-2 text-sm font-serif text-stone-900 outline-none focus:border-stone-900",
    placeholder: field.placeholder || undefined,
  };
  return (
    <div>
      <label htmlFor={id} className="block text-xs uppercase tracking-[0.15em] text-stone-600">
        {field.label}{field.optional && <span className="ml-1 text-stone-400">(optional)</span>}
      </label>
      <div className="mt-1">
        {field.type === "number" ? (
          <input type="number" inputMode="decimal" {...common} />
        ) : field.type === "date" ? (
          <input type="date" {...common} />
        ) : (
          <input type="text" {...common} />
        )}
      </div>
    </div>
  );
}
