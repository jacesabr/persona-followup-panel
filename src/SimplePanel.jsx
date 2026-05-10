import { useEffect, useMemo, useState } from "react";
import SimpleFollowup from "./SimpleFollowup.jsx";
import CounsellorTasks from "./CounsellorTasks.jsx";
import CounsellorAdmin from "./CounsellorAdmin.jsx";
import StudentsAdmin from "./StudentsAdmin.jsx";
import IeltsPanel from "./IeltsPanel.jsx";
import ApplicationsPanel from "./ApplicationsPanel.jsx";
import RequiredDocsPanel from "./RequiredDocsPanel.jsx";
import OutstandingMarksheetsPanel from "./OutstandingMarksheetsPanel.jsx";
import AiQueuePanel from "./AiQueuePanel.jsx";
import { api } from "./api.js";

const TAB_KEY = "persona_simple_tab";

function loadTab(role) {
  if (typeof window === "undefined") return "followup";
  try {
    const t = sessionStorage.getItem(TAB_KEY);
    if (t === "followup" || t === "tasks" || t === "students" || t === "ielts" || t === "applications" || t === "documents" || t === "marksheets") return t;
    if ((t === "counsellors" || t === "ai-queue") && role === "admin") return t;
    // team-{counsellorId} tabs for supervisor views
    if (typeof t === "string" && t.startsWith("team-")) return t;
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
  adminUsername = "",
  adminUsernameRaw = "",
  adminMirrors = [],
}) {
  const [tab, setTab] = useState(() => loadTab(role));
  // Counsellor-session roster: self + any counsellors this user supervises.
  // Fetched once on mount so we know whether to show a team tab.
  // Admin passes its own roster down via the counsellors prop; this state is
  // only used when role === "counsellor".
  const [counsellorsForCounsellor, setCounsellorsForCounsellor] = useState([]);
  useEffect(() => {
    if (role !== "counsellor") return;
    api.listCounsellors().then(setCounsellorsForCounsellor).catch(() => {});
  }, [role]);

  // Counsellors that the current user supervises (supervisor_id = me).
  const mySupervised = useMemo(
    () => counsellorsForCounsellor.filter(
      (c) => c.supervisor_id === scopedCounsellorId && c.id !== scopedCounsellorId
    ),
    [counsellorsForCounsellor, scopedCounsellorId]
  );

  // Cross-tab navigation: IELTS panel's "View" button sets this so the
  // Students tab knows which row to auto-expand on mount. Cleared once
  // the Students tab has consumed it.
  const [pendingStudentId, setPendingStudentId] = useState(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore quota/private mode */
    }
  }, [tab]);

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
            label="Tasks"
            active={tab === "tasks"}
            onClick={() => setTab("tasks")}
          />
          <FolderTab
            label="Students"
            active={tab === "students"}
            onClick={() => setTab("students")}
          />
          <FolderTab
            label="IELTS"
            active={tab === "ielts"}
            onClick={() => setTab("ielts")}
          />
          <FolderTab
            label="Applications"
            active={tab === "applications"}
            onClick={() => setTab("applications")}
          />
          <FolderTab
            label="Required Documents"
            active={tab === "documents"}
            onClick={() => setTab("documents")}
          />
          <FolderTab
            label="Outstanding Marksheets"
            active={tab === "marksheets"}
            onClick={() => setTab("marksheets")}
          />
          {role === "admin" && (
            <FolderTab
              label="Automation runs"
              active={tab === "ai-queue"}
              onClick={() => setTab("ai-queue")}
            />
          )}
          {role === "admin" && (
            <FolderTab
              label="Counsellors"
              active={tab === "counsellors"}
              onClick={() => setTab("counsellors")}
            />
          )}
          {/* One tab per supervised counsellor — only visible to supervisors (e.g. Simran sees Himani's Tasks) */}
          {mySupervised.map((sub) => (
            <FolderTab
              key={sub.id}
              label={`${sub.name}'s Tasks`}
              active={tab === `team-${sub.id}`}
              onClick={() => setTab(`team-${sub.id}`)}
            />
          ))}
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
          adminUsername={adminUsername}
          adminUsernameRaw={adminUsernameRaw}
          adminMirrors={adminMirrors}
        />
      )}
      {tab === "students" && (
        <StudentsAdmin
          role={role}
          counsellors={role === "admin" ? (counsellors || []) : counsellorsForCounsellor}
          autoExpandStudentId={pendingStudentId}
          onAutoExpandConsumed={() => setPendingStudentId(null)}
        />
      )}
      {tab === "ielts" && (
        <IeltsPanel
          role={role}
          onViewStudent={(id) => {
            setPendingStudentId(id);
            setTab("students");
          }}
        />
      )}
      {tab === "applications" && (
        <ApplicationsPanel
          role={role}
          counsellors={role === "admin" ? (counsellors || []) : counsellorsForCounsellor}
          onViewStudent={(id) => { setPendingStudentId(id); setTab("students"); }}
          onViewTasks={() => setTab("tasks")}
        />
      )}
      {tab === "documents" && (
        <RequiredDocsPanel
          role={role}
          counsellors={counsellors || []}
          onViewStudent={(id) => { setPendingStudentId(id); setTab("students"); }}
          onViewTasks={() => setTab("tasks")}
        />
      )}
      {tab === "marksheets" && (
        <OutstandingMarksheetsPanel
          role={role}
          onViewStudent={(id) => { setPendingStudentId(id); setTab("students"); }}
        />
      )}
      {tab === "ai-queue" && role === "admin" && (
        <AiQueuePanel
          onViewStudent={(id) => { setPendingStudentId(id); setTab("students"); }}
        />
      )}
      {tab === "counsellors" && role === "admin" && (
        <CounsellorAdmin
          counsellors={counsellors || []}
          loading={counsellorsLoading}
          error={counsellorsError}
          onCounsellorsChanged={onCounsellorsChanged}
        />
      )}
      {/* Subordinate task panels — Simran viewing Himani's board */}
      {mySupervised.map((sub) =>
        tab === `team-${sub.id}` ? (
          <CounsellorTasks
            key={sub.id}
            role="counsellor"
            scopedCounsellorId={sub.id}
          />
        ) : null
      )}
    </>
  );
}

function FolderTab({ label, active, onClick }) {
  if (active) {
    return (
      <button
        onClick={onClick}
        className="relative z-10 -mb-px border border-stone-400 border-b-transparent px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-black"
        style={{ backgroundColor: "#faf9f5" }}
      >
        {label}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="border border-stone-300 bg-stone-100 px-5 py-1.5 text-[11px] uppercase tracking-[0.2em] text-black hover:bg-stone-50 hover:text-black"
    >
      {label}
    </button>
  );
}
