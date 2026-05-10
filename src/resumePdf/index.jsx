// Resume PDF picker — three style alternatives the student can
// choose between, all consuming the same content_json payload the
// AI pipeline writes.
//
// Architecture: each style is a self-contained Document component
// that renders the normalised payload via @react-pdf/renderer. The
// picker shows three style cards + one download button (for the
// selected style) + an "open in new tab" preview button. PDF
// generation runs client-side on demand; nothing is persisted to
// the server, so style choice is per-download and free to iterate.
//
// Bundle note: @react-pdf/renderer is heavy (~600KB gz). The whole
// resumePdf/ folder is reachable only from the resume tab so Vite
// naturally code-splits it; opening the resume tab pays the cost
// once per session.

import { useMemo, useState } from "react";
import { PDFDownloadLink, usePDF } from "@react-pdf/renderer";
import { Loader2, Download, ExternalLink } from "lucide-react";
import EditorialClassic from "./EditorialClassic.jsx";
import ModernConfident from "./ModernConfident.jsx";
import ConfidentBold from "./ConfidentBold.jsx";

const STYLES = [
  {
    id: "editorial",
    label: "Editorial Classic",
    tagline: "Garamond serif · scholarly authority",
    description:
      "Centered name block, hairline rules, italic accents. Best for Ivy League and Oxbridge applications, research roles, and traditional fields.",
    Component: EditorialClassic,
  },
  {
    id: "modern",
    label: "Modern Confident",
    tagline: "Inter sans · navy and sage",
    description:
      "Left-aligned, contemporary humanist sans, navy section headings with sage rules. Best for tech, consulting, and finance internships, and US undergrad applications.",
    Component: ModernConfident,
  },
  {
    id: "bold",
    label: "Confident Bold",
    tagline: "Roboto and Lato · terracotta accent",
    description:
      "Distinctive without being loud. Bold display name, terracotta section bars, cream lede block. Best for design, creative, and startup roles where standing out matters.",
    Component: ConfidentBold,
  },
];

// Slugify the student's name into something safe for a filename:
//   "Riya Sharma"  →  "riya-sharma"
//   ""             →  "resume"
function slugifyName(name) {
  if (!name) return "resume";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "resume";
}

export default function ResumePdfPicker({ payload, studentName }) {
  const [selectedId, setSelectedId] = useState("editorial");
  const selected = STYLES.find((s) => s.id === selectedId) || STYLES[0];
  const SelectedComponent = selected.Component;

  // Memoise the document element so PDFDownloadLink and usePDF don't
  // re-render the PDF on every parent re-render — react-pdf rebuilds
  // the entire document tree from scratch each time the `document`
  // prop identity changes, which on a typical resume is ~300ms.
  const document = useMemo(
    () => <SelectedComponent payload={payload} />,
    [SelectedComponent, payload]
  );

  // Separate usePDF for the "open in new tab" path so we get a Blob
  // URL we can window.open() without forcing a download. PDFDownloadLink
  // doesn't expose the underlying Blob, so we run the generator twice
  // (cheap; both share react-pdf's internal cache via document identity).
  const [previewInstance] = usePDF({ document });

  const fileName = `${slugifyName(studentName)}-${selected.id}.pdf`;

  const openPreview = () => {
    if (!previewInstance.url) return;
    window.open(previewInstance.url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="border border-stone-200 bg-white">
      <div className="border-b border-stone-200 bg-stone-50 px-5 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black">
          Download as PDF
        </p>
        <p className="mt-1 text-sm text-stone-800">
          Pick a style. The same résumé content renders differently in each.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 p-5 md:grid-cols-3">
        {STYLES.map((s) => {
          const isSelected = s.id === selectedId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelectedId(s.id)}
              className={`flex flex-col items-start border px-4 py-3 text-left transition ${
                isSelected
                  ? "border-stone-900 bg-stone-50"
                  : "border-stone-300 bg-white hover:border-stone-700"
              }`}
            >
              <span className="text-base font-medium text-black">{s.label}</span>
              <span className="mt-0.5 text-xs uppercase tracking-[0.15em] text-stone-700">
                {s.tagline}
              </span>
              <span className="mt-2 text-sm text-stone-800">{s.description}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-stone-200 bg-white px-5 py-4">
        <PDFDownloadLink
          document={document}
          fileName={fileName}
          className="inline-flex items-center gap-2 bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700"
        >
          {({ loading, error }) =>
            error ? (
              <>
                <span>Couldn't build PDF</span>
              </>
            ) : loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Preparing {selected.label}…</span>
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                <span>Download {selected.label}</span>
              </>
            )
          }
        </PDFDownloadLink>

        <button
          type="button"
          onClick={openPreview}
          disabled={previewInstance.loading || !previewInstance.url || !!previewInstance.error}
          className="inline-flex items-center gap-2 border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-black transition hover:border-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {previewInstance.loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading preview…</span>
            </>
          ) : (
            <>
              <ExternalLink className="h-4 w-4" />
              <span>Open preview in new tab</span>
            </>
          )}
        </button>

        {previewInstance.error && (
          <p className="text-sm text-red-700">
            Preview failed: {String(previewInstance.error.message || previewInstance.error).slice(0, 200)}
          </p>
        )}
      </div>
    </div>
  );
}
