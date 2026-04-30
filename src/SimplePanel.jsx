import { useState } from "react";
import SimpleFollowup from "./SimpleFollowup.jsx";
import CounsellorTasks from "./CounsellorTasks.jsx";
import CounsellorAdmin from "./CounsellorAdmin.jsx";

// Two-tab wrapper for the simple panel: "Followup" (the lead sheet) and
// "Counsellor tasks" (the to-do list across students).
//
// Visual: small folder-style tabs at the top whose active member sits flush
// against the horizontal divider below.
//
// role: "admin" → unscoped, sees all leads + all tasks, can assign tasks
//                 and pick the counsellor column.
// role: "counsellor" → scoped to their own leads (lead.counsellor_id) and
//                      their own tasks (task.assignee_id). New leads/tasks
//                      auto-assign to themselves.
export default function SimplePanel({
  role = "admin",
  scopedCounsellorId = null,
  onImpersonate,
}) {
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
          {role === "admin" && (
            /* Admin-only tab: list every counsellor + create new ones
               (with username/password) without diving into the Old
               admin view. Counsellors don't see this tab. */
            <FolderTab
              label="Counsellors"
              active={tab === "counsellors"}
              onClick={() => setTab("counsellors")}
            />
          )}
        </div>
        <div className="border-t border-stone-400" />
      </div>

      {tab === "followup" && (
        <SimpleFollowup role={role} scopedCounsellorId={scopedCounsellorId} />
      )}
      {tab === "tasks" && (
        <CounsellorTasks
          role={role}
          scopedCounsellorId={scopedCounsellorId}
          onImpersonate={onImpersonate}
        />
      )}
      {tab === "counsellors" && role === "admin" && <CounsellorAdmin />}
    </>
  );
}

function FolderTab({ label, active, onClick }) {
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
