import { useState } from "react";
import { Plus, Trash2, ArrowRight, ArrowLeft, FileText } from "lucide-react";

// ResumeConfig — student picks how many resumes they want and the
// length / style / domain for each. Posts the config to the resume
// generator (next push). For now this is a UI-only stub: when the
// student clicks "Generate", we just hand the config back to the
// parent so the next phase (generation) can fire.
//
// Each resume row is independent — same source profile, different
// "shapes". The hierarchical Plan→Allocate→Section pipeline (per
// the audit research) will share one Plan call across all rows and
// fan out section calls per row.

const DEFAULT_ROW = () => ({
  id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  label: "",
  length_pages: 1,
  style: "formal_compact",
  domain: "",
});

const STYLE_OPTIONS = [
  { value: "formal_compact", label: "Formal · compact (most common)" },
  { value: "narrative",      label: "Narrative · prose-heavy" },
  { value: "bullet_heavy",   label: "Bullet-heavy · ATS-friendly" },
  { value: "minimalist",     label: "Minimalist" },
  { value: "creative",       label: "Creative" },
];

const DOMAIN_OPTIONS = [
  { value: "",              label: "— let the system pick —" },
  { value: "cs",            label: "Computer science / engineering" },
  { value: "engineering",   label: "Engineering (other)" },
  { value: "business",      label: "Business / commerce" },
  { value: "liberal_arts",  label: "Liberal arts / humanities" },
  { value: "medicine",      label: "Medicine / health sciences" },
  { value: "law",           label: "Law" },
  { value: "mixed",         label: "Mixed / interdisciplinary" },
];

const PRESETS = [
  { label: "1 page only",                    rows: [{ length_pages: 1, label: "1-page" }] },
  { label: "1-page + 2-page",                rows: [{ length_pages: 1, label: "1-page" }, { length_pages: 2, label: "2-page" }] },
  { label: "All three (1, 2, 3 pages)",      rows: [{ length_pages: 1, label: "1-page" }, { length_pages: 2, label: "2-page" }, { length_pages: 3, label: "3-page CV" }] },
];

export default function ResumeConfig({ onBack, onGenerate }) {
  const [rows, setRows] = useState(() => [DEFAULT_ROW()]);
  const [busy, setBusy] = useState(false);

  const addRow = () => {
    if (rows.length >= 5) return;
    setRows((p) => [...p, { ...DEFAULT_ROW() }]);
  };
  const removeRow = (id) => {
    if (rows.length <= 1) return;
    setRows((p) => p.filter((r) => r.id !== id));
  };
  const updateRow = (id, patch) =>
    setRows((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const applyPreset = (preset) => {
    setRows(preset.rows.map((r, i) => ({
      ...DEFAULT_ROW(),
      ...r,
      id: `r_${Date.now()}_${i}`,
    })));
  };

  const submit = async () => {
    // Hand back the config to the parent. In the next push the parent
    // will hit POST /api/students/me/resumes/generate with this
    // payload and transition to a "generating…" phase.
    setBusy(true);
    try {
      await onGenerate(rows.map(({ id: _, ...r }) => ({
        label: r.label || `${r.length_pages}-page`,
        length_pages: r.length_pages,
        length_words: defaultWordsFor(r.length_pages),
        style: r.style,
        domain: r.domain || null,
      })));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-fadeUp py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
        Step · Resume setup
      </p>
      <h2 className="mt-2 font-serif text-3xl leading-tight md:text-4xl">
        How many resumes do you want — and how long?
      </h2>
      <p className="mt-3 max-w-2xl text-sm italic text-stone-500">
        Same source data, different shapes. Pick a preset or build your own list.
        Each one gets its own generation run.
      </p>

      {/* Presets */}
      <div className="mt-6 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => applyPreset(p)}
            className="border border-stone-300 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700 hover:bg-stone-50"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Row list */}
      <div className="mt-8 space-y-3">
        {rows.map((r, i) => (
          <ResumeRow
            key={r.id}
            index={i + 1}
            row={r}
            canRemove={rows.length > 1}
            onUpdate={(patch) => updateRow(r.id, patch)}
            onRemove={() => removeRow(r.id)}
          />
        ))}
      </div>

      <div className="mt-3">
        <button
          onClick={addRow}
          disabled={rows.length >= 5}
          className="inline-flex items-center gap-1.5 border border-stone-300 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Plus className="h-3 w-3" /> Add another resume
          {rows.length >= 5 && (
            <span className="ml-1 italic text-stone-400 normal-case tracking-normal">(max 5)</span>
          )}
        </button>
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-stone-200 pt-6">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 border border-stone-300 bg-transparent px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-stone-600 transition hover:border-stone-700 hover:text-stone-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to review
        </button>
        <button
          onClick={submit}
          disabled={busy || rows.length === 0}
          className="inline-flex items-center gap-2 border border-[#cc785c] bg-[#cc785c] px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {busy ? "Submitting…" : `Generate ${rows.length} resume${rows.length === 1 ? "" : "s"}`}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function ResumeRow({ index, row, canRemove, onUpdate, onRemove }) {
  return (
    <div className="border border-stone-300 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-700">
          <FileText className="mr-1.5 inline-block h-3 w-3" />
          Resume #{index}
        </p>
        <button
          onClick={onRemove}
          disabled={!canRemove}
          className="text-stone-400 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Remove resume"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">Label (optional)</span>
          <input
            type="text"
            value={row.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
            placeholder={`${row.length_pages}-page · ${row.style}`}
            className="mt-1 w-full border-b border-stone-300 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">Length (pages)</span>
          <select
            value={row.length_pages}
            onChange={(e) => onUpdate({ length_pages: Number(e.target.value) })}
            className="mt-1 w-full border-b border-stone-300 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          >
            <option value={1}>1 page (~250 words)</option>
            <option value={2}>2 pages (~750 words)</option>
            <option value={3}>3 pages (~1100 words) · CV</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">Style</span>
          <select
            value={row.style}
            onChange={(e) => onUpdate({ style: e.target.value })}
            className="mt-1 w-full border-b border-stone-300 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          >
            {STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[10px] uppercase tracking-[0.15em] text-stone-500">Domain (matches a style example)</span>
          <select
            value={row.domain}
            onChange={(e) => onUpdate({ domain: e.target.value })}
            className="mt-1 w-full border-b border-stone-300 bg-transparent py-1 text-sm outline-none focus:border-stone-700"
          >
            {DOMAIN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

const defaultWordsFor = (pages) => {
  if (pages <= 1) return 250;
  if (pages === 2) return 750;
  return 1100;
};
