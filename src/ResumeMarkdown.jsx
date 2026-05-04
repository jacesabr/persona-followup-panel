import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Single renderer for resume markdown. Used by the student dashboard
// and the staff student-detail panel so the formatted resume looks
// the same everywhere.
//
// Tailwind's typography plugin styles every block element under .prose;
// the serif override matches the rest of the app's body type. max-w-none
// because the parent already controls the column width.

// Allow only safe URL schemes in links + images. The resume markdown
// is LLM-authored — without this, `[click](javascript:alert(1))` would
// render as a clickable script-link. react-markdown 9 escapes raw HTML
// by default but doesn't filter URL schemes; this closes that gap.
// Relative URLs (no scheme) and `mailto:` pass through as-is for the
// rare case the resume cites a portfolio or contact email.
const SAFE_URL = /^(https?:|mailto:)/i;
function safeUrl(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  if (trimmed === "") return "";
  // No-scheme URLs (e.g. "github.com/foo") are treated as safe; the
  // browser resolves them relative to the current origin.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return SAFE_URL.test(trimmed) ? trimmed : "";
}

export default function ResumeMarkdown({ children }) {
  return (
    <div className="prose prose-sm max-w-none font-serif prose-headings:font-serif prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-base prose-h2:uppercase prose-h2:tracking-[0.15em] prose-h2:text-stone-700 prose-h2:mt-6 prose-h2:mb-2 prose-h2:border-b prose-h2:border-stone-200 prose-h2:pb-1 prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-strong:text-stone-900 prose-a:text-stone-700">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl}>
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
