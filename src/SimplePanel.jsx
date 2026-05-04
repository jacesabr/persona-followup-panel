import { useCallback, useEffect, useState } from "react";
import SimpleFollowup from "./SimpleFollowup.jsx";
import CounsellorTasks from "./CounsellorTasks.jsx";
import CounsellorAdmin from "./CounsellorAdmin.jsx";
import StudentsAdmin from "./StudentsAdmin.jsx";
import { api } from "./api.js";
import useAutoRefresh from "./useAutoRefresh.js";

const TAB_KEY = "persona_simple_tab";

function loadTab(role) {
  if (typeof window === "undefined") return "followup";
  try {
    const t = sessionStorage.getItem(TAB_KEY);
    if (t === "followup" || t === "tasks" || t === "students") return t;
    if (t === "counsellors" && role === "admin") return t;
  } catch {
    /* ignore */
  }
  return "followup";
}

// Two-tab wrapper for the simple panel: "Followup" (the lead sheet) and
// "Counsellor tasks" (the to-do list across students). Admin gets a third
// "Counsellors" tab.
//
// Visual: small folder-style tabs at the top whose active member sits flush
// against the horizontal divider below.
//
// role: "admin" → unscoped, sees all leads + all tasks, can assign tasks
//                 and pick the counsellor column.
// role: "counsellor" → scoped to their own leads (lead.counsellor_id) and
//                      their own tasks (task.assignee_id). New leads/tasks
//                      auto-assign to themselves.
//
// Tab choice persists in sessionStorage so a hard refresh OR an admin
// impersonation switch (which unmounts the previous SimplePanel) lands
// the user back on the same tab.
//
// counsellors/onCounsellorsChanged are admin-only props sourced from
// AdminPanel. When omitted (counsellor view), CounsellorTasks falls back
// to its own fetch and CounsellorAdmin isn't rendered at all.
export default function SimplePanel({
  role = "admin",
  scopedCounsellorId = null,
  onImpersonate = () => {},
  counsellors = null,
  counsellorsLoading = false,
  counsellorsError = null,
  onCounsellorsChanged,
}) {
  const [tab, setTab] = useState(() => loadTab(role));
  // Leads list piggybacks here so the Students tab's signup form can show
  // a "link to lead" dropdown — counsellor sees only their own leads,
  // admin sees all (handled server-side in /api/leads).
  const [leadsForLink, setLeadsForLink] = useState([]);

  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore quota/private mode */
    }
  }, [tab]);

  const refreshLeadsForLink = useCallback(() => {
    if (tab !== "students") return Promise.resolve();
    return api
      .listLeads({ counsellorId: role === "counsellor" ? scopedCounsellorId : null })
      .then(setLeadsForLink)
      .catch(() => setLeadsForLink([]));
  }, [tab, role, scopedCounsellorId]);

  useEffect(() => {
    refreshLeadsForLink();
  }, [refreshLeadsForLink]);

  // Keep the signup form's lead dropdown fresh while the Students tab is
  // open — another admin adding a lead elsewhere should appear here too.
  useAutoRefresh(refreshLeadsForLink);

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
          <FolderTab
            label="Students"
            active={tab === "students"}
            onClick={() => setTab("students")}
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
          counsellors={counsellors}
        />
      )}
      {tab === "students" && (
        <StudentsAdmin role={role} leads={leadsForLink} />
      )}
      {tab === "counsellors" && role === "admin" && (
        <CounsellorAdmin
          counsellors={counsellors || []}
          loading={counsellorsLoading}
          error={counsellorsError}
          onCounsellorsChanged={onCounsellorsChanged}
        />
      )}
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
