import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// Generic collapsible "Archived (N)" section used by both the lead sheet
// and the counsellor tasks list. Hidden by default; click the header to
// expand. Each item is rendered via the caller's `renderRow(item)` so the
// section stays layout-agnostic — it owns the chrome (collapse, header,
// item count, divider list) and the parent owns the row content.
export default function ArchivedSection({ items, renderRow }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-4 border border-stone-300 bg-stone-50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.1em] text-stone-700 hover:bg-stone-100"
      >
        <span className="inline-flex items-center gap-1.5">
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Archived ({items.length})
        </span>
        <span className="text-[10px] font-normal normal-case tracking-normal text-stone-500">
          {open ? "click to collapse" : "click to expand"}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-stone-200 border-t border-stone-200 bg-white">
          {items.map((item) => renderRow(item))}
        </ul>
      )}
    </div>
  );
}
