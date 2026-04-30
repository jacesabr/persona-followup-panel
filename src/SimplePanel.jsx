import { useState } from "react";
import SimpleFollowup from "./SimpleFollowup.jsx";
import CounsellorTasks from "./CounsellorTasks.jsx";

// Two-tab wrapper for the simple panel: "Followup" (the lead sheet) and
// "Counsellor tasks" (the to-do list across students). State lives here so
// switching tabs preserves each child's component-local state.
//
// Visual: small folder-style tabs at the top whose active member sits flush
// against the horizontal divider below — i.e. the active tab's bottom edge
// merges with the divider, the inactive tab is recessed below it.
export default function SimplePanel() {
  const [tab, setTab] = useState("followup");

  return (
    <>
      <div className="relative mb-5">
        <div className="flex items-end gap-1">
          <FolderTab
            label="Followup"
            active={tab === "followup"}
            onClick={() => setTab("followup")}
          />
          <FolderTab
            label="Counsellor tasks"
            active={tab === "tasks"}
            onClick={() => setTab("tasks")}
          />
        </div>
        <div className="border-t border-stone-400" />
      </div>

      {tab === "followup" ? <SimpleFollowup /> : <CounsellorTasks />}
    </>
  );
}

function FolderTab({ label, active, onClick }) {
  // Active tab: full top + side borders, missing bottom border, sits one
  // pixel below its container so its bottom edge overlaps the horizontal
  // divider. Page-bg matches the cream so the tab "is" the page.
  // Inactive tab: full border, slightly muted background, sits ABOVE the
  // divider with its own bottom edge visible.
  if (active) {
    return (
      <button
        onClick={onClick}
        className="relative z-10 -mb-px border border-stone-400 border-b-transparent px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-900"
        style={{ backgroundColor: "#faf9f5" }}
      >
        {label}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="border border-stone-300 bg-stone-100 px-5 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-500 hover:bg-stone-50 hover:text-stone-700"
    >
      {label}
    </button>
  );
}
