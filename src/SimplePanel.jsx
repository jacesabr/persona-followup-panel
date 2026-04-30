import { useState } from "react";
import SimpleFollowup from "./SimpleFollowup.jsx";
import CounsellorTasks from "./CounsellorTasks.jsx";

// Two-tab wrapper for the simple panel: "Followup" (the lead sheet) and
// "Counsellor tasks" (the to-do list across students). State lives here so
// switching tabs preserves each child's component-local state.
export default function SimplePanel() {
  const [tab, setTab] = useState("followup");

  return (
    <>
      <div className="mb-5 flex items-center gap-2 border-b border-stone-300 pb-3">
        <TabButton
          label="Followup"
          active={tab === "followup"}
          onClick={() => setTab("followup")}
        />
        <TabButton
          label="Counsellor tasks"
          active={tab === "tasks"}
          onClick={() => setTab("tasks")}
        />
      </div>

      {tab === "followup" ? <SimpleFollowup /> : <CounsellorTasks />}
    </>
  );
}

function TabButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "border border-[#cc785c] bg-[#cc785c] px-4 py-2 text-[12px] uppercase tracking-[0.2em] text-white"
          : "border border-stone-300 bg-white px-4 py-2 text-[12px] uppercase tracking-[0.2em] text-stone-700 hover:border-stone-500 hover:text-stone-900"
      }
    >
      {label}
    </button>
  );
}
