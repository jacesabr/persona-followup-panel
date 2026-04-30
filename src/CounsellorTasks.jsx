import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Plus,
  X,
  Check,
  Star,
  Archive,
  ChevronDown,
  ChevronRight,
  Undo2,
} from "lucide-react";
import { api } from "./api.js";
import { formatDateInIst, utcIsoToIstInput } from "../lib/time.js";

function todayIstYmd() {
  return utcIsoToIstInput(new Date().toISOString()).slice(0, 10);
}

const EMPTY_NEW = () => ({
  studentName: "",
  text: "",
  dueDate: todayIstYmd(),
  assigneeId: "",
});

export default function CounsellorTasks({
  role = "admin",
  scopedCounsellorId = null,
  onImpersonate,
}) {
  // When scoped, hide other counsellors' tasks and auto-assign new tasks
  // to this counsellor. Admin sees everything and picks the assignee.
  const isScoped = role === "counsellor" && !!scopedCounsellorId;
  const [tasks, setTasks] = useState([]);
  const [leads, setLeads] = useState([]);
  const [counsellors, setCounsellors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // sortBy: "date" (default) or "student". Within "student" we still sort
  // each student's group by date asc — the user's explicit ask: "sort
  // automatically by date even when sorted by student."
  // Multi-select sort: array of keys in click order, primary first.
  // Default is ["date"] so the list always opens with the most-urgent
  // dates at the top.
  const [sortBy, setSortBy] = useState(["date"]);
  const [showNew, setShowNew] = useState(false);
  const [newTask, setNewTask] = useState(EMPTY_NEW());
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listTasks({ includeArchived: true }),
      api.listLeads(),
      api.listCounsellors(),
    ])
      .then(([t, l, c]) => {
        if (cancelled) return;
        setTasks(t);
        setLeads(l);
        setCounsellors(c);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Counsellor scoping. Admin sees everything; counsellors see a task if
  // EITHER:
  //   (1) it's directly assigned to them via assignee_id, OR
  //   (2) it's about a student whose lead.counsellor_id is them.
  // The OR-of-two-conditions ensures tasks stay integrated even when the
  // assignee is missing/mismatched (e.g. admin created a Neha-student
  // task without setting assignee, or assignee+lead-counsellor diverge
  // for some reason).
  const visibleTasks = useMemo(() => {
    if (!isScoped) return tasks;
    const myLeadIds = new Set(
      leads
        .filter((l) => l.counsellor_id === scopedCounsellorId)
        .map((l) => l.id)
    );
    return tasks.filter(
      (t) =>
        t.assignee_id === scopedCounsellorId ||
        (t.lead_id && myLeadIds.has(t.lead_id))
    );
  }, [tasks, leads, isScoped, scopedCounsellorId]);

  // Split active vs archived. Archived rows live in a collapsible section
  // at the bottom; the main list is active-only, sorted/grouped by the
  // selected sort key. Both sets come from listTasks({ includeArchived }).
  const { activeTasks, archivedTasks } = useMemo(() => {
    const active = visibleTasks.filter((t) => !t.archived);
    const archived = visibleTasks
      .filter((t) => t.archived)
      .sort((a, b) => {
        const at = a.archived_at ? new Date(a.archived_at).getTime() : 0;
        const bt = b.archived_at ? new Date(b.archived_at).getTime() : 0;
        return bt - at; // most-recently-archived first
      });
    return { activeTasks: active, archivedTasks: archived };
  }, [visibleTasks]);

  // Sorted view of active tasks. sortBy is an array of keys in click
  // order; the primary key is sortBy[0]. Priority position depends on
  // whether any non-date key is active:
  //  - Only "date" in chain → priority is OUTERMOST (top of list),
  //    matching the "Priority button moves to top" rule.
  //  - Any non-date key in chain → that key (or chain) groups first,
  //    then priority within the group, then date as tiebreaker.
  // Final stable tiebreaker: id, so equal-key rows keep insertion order.
  const sortedTasks = useMemo(() => {
    const cmpKey = (a, b, key) => {
      if (key === "date") {
        const ad = (a.due_date || "").slice(0, 10);
        const bd = (b.due_date || "").slice(0, 10);
        return ad < bd ? -1 : ad > bd ? 1 : 0;
      }
      if (key === "student") {
        const sa = (a.lead_name || a.student_name || "").toLowerCase();
        const sb = (b.lead_name || b.student_name || "").toLowerCase();
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      }
      if (key === "counsellor") {
        const ca = (a.assignee_name || "").toLowerCase();
        const cb = (b.assignee_name || "").toLowerCase();
        return ca < cb ? -1 : ca > cb ? 1 : 0;
      }
      return 0;
    };
    const chain = sortBy.length > 0 ? sortBy : ["date"];
    const explicitNonDate = chain.filter((k) => k !== "date");
    return [...activeTasks].sort((a, b) => {
      if (explicitNonDate.length === 0) {
        // pure date sort — priority pinned globally
        if (a.priority !== b.priority) return a.priority ? -1 : 1;
        return cmpKey(a, b, "date") || a.id - b.id;
      }
      for (const key of explicitNonDate) {
        const c = cmpKey(a, b, key);
        if (c !== 0) return c;
      }
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      return cmpKey(a, b, "date") || a.id - b.id;
    });
  }, [activeTasks, sortBy]);

  const toggleSort = (key) => {
    setSortBy((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      return [key, ...prev]; // newest click becomes primary
    });
  };
  const sortPosition = (key) => {
    const idx = sortBy.indexOf(key);
    return idx >= 0 ? idx + 1 : null; // 1-indexed badge for active chips
  };

  const todayYmd = todayIstYmd();

  const togglePriority = async (task) => {
    setBusyId(task.id);
    setError(null);
    try {
      const updated = await api.updateTask(task.id, { priority: !task.priority });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const toggleCompleted = async (task) => {
    setBusyId(task.id);
    setError(null);
    try {
      const updated = await api.updateTask(task.id, { completed: !task.completed });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  // Soft-delete: the task moves to the Archived section instead of
  // disappearing entirely, mirroring the lead-archive flow on the
  // Followup tab. Recoverable via Unarchive.
  const archiveTask = async (task) => {
    setBusyId(task.id);
    setError(null);
    try {
      const updated = await api.archiveTask(task.id);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const unarchiveTask = async (task) => {
    setBusyId(task.id);
    setError(null);
    try {
      const updated = await api.unarchiveTask(task.id);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const cancelNew = () => {
    setShowNew(false);
    setNewTask(EMPTY_NEW());
    setError(null);
  };

  const submitNew = async () => {
    const text = newTask.text.trim();
    const studentName = newTask.studentName.trim();
    if (!studentName) {
      setError("Type a student name.");
      return;
    }
    if (!text) {
      setError("Type a task.");
      return;
    }
    if (!newTask.dueDate) {
      setError("Pick a due date.");
      return;
    }
    // Assignee resolution:
    //   counsellor (scoped): always self.
    //   admin: must pick a counsellor in the dropdown.
    const assigneeId = isScoped ? scopedCounsellorId : (newTask.assigneeId || null);
    if (!isScoped && !assigneeId) {
      setError("Pick a counsellor to assign.");
      return;
    }
    // If the typed name matches an existing active lead exactly, link by
    // FK so the task cascades on lead delete; otherwise store as free text.
    const matchedLead = leads.find(
      (l) => !l.archived && l.name.trim().toLowerCase() === studentName.toLowerCase()
    );
    setCreating(true);
    setError(null);
    try {
      const created = await api.createTask({
        lead_id: matchedLead ? matchedLead.id : null,
        student_name: matchedLead ? null : studentName,
        assignee_id: assigneeId,
        text,
        due_date: newTask.dueDate,
      });
      setTasks((prev) => [...prev, created]);
      setNewTask(EMPTY_NEW());
      setShowNew(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (error && tasks.length === 0 && !showNew) {
    return (
      <div className="border border-red-300 bg-red-50 p-5 text-base text-red-800">
        {error}
      </div>
    );
  }

  // Column widths sized so the actual rendered button widths fit.
  //   - counsellor (scoped): no Counsellor column, 5 cols
  //   - admin:               extra Counsellor column between Task and Actions
  const gridCols = isScoped
    ? "6.5rem 7rem 1fr 2fr 5rem"
    : "6.5rem 7rem 1fr 2fr 8rem 5rem";

  return (
    <>
      <div className="mb-4 flex items-center justify-between border-b border-stone-300 pb-2">
        {/* Left: title + count. Middle: sort chips. Right: + New task. */}
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Counsellor tasks</h2>
          <span className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            {activeTasks.length} {activeTasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            Sort by:
          </span>
          <SortChip
            label="Date"
            position={sortPosition("date")}
            onClick={() => toggleSort("date")}
          />
          <SortChip
            label="Student"
            position={sortPosition("student")}
            onClick={() => toggleSort("student")}
          />
          {!isScoped && (
            <SortChip
              label="Counsellor"
              position={sortPosition("counsellor")}
              onClick={() => toggleSort("counsellor")}
            />
          )}
        </div>
        <div>
          {!showNew && (
            <button
              onClick={() => {
                setNewTask(EMPTY_NEW());
                setShowNew(true);
              }}
              className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f]"
            >
              <Plus className="h-3 w-3" /> New task
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-700"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span className="whitespace-nowrap">Priority</span>
          <span className="whitespace-nowrap">Date</span>
          <span className="whitespace-nowrap">Student</span>
          <span className="whitespace-nowrap">Task</span>
          {!isScoped && <span className="whitespace-nowrap">Counsellor</span>}
          <span className="whitespace-nowrap text-right">Actions</span>
        </div>

        {showNew && (
          <div
            className="grid items-start gap-3 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-4 py-3 text-[15px] text-stone-800"
            style={{ gridTemplateColumns: gridCols }}
          >
            <span></span>
            <input
              type="date"
              value={newTask.dueDate}
              onChange={(e) =>
                setNewTask((p) => ({ ...p, dueDate: e.target.value }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
            />
            <input
              type="text"
              list="task-students"
              placeholder="Student name"
              value={newTask.studentName}
              onChange={(e) =>
                setNewTask((p) => ({ ...p, studentName: e.target.value }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
              autoFocus
            />
            {/* Datalist holds existing active lead names so autocomplete
                offers them, but the user can type anything (e.g. a
                student we haven't created a lead row for yet). */}
            <datalist id="task-students">
              {leads
                .filter((l) => !l.archived)
                .map((l) => (
                  <option key={l.id} value={l.name} />
                ))}
            </datalist>
            <input
              type="text"
              placeholder="What needs to happen?"
              value={newTask.text}
              onChange={(e) =>
                setNewTask((p) => ({ ...p, text: e.target.value }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
            />
            {!isScoped && (
              /* Admin's task creation requires picking the responsible
                 counsellor. Counsellors auto-assign to themselves so
                 their form skips this column entirely. */
              <select
                value={newTask.assigneeId}
                onChange={(e) =>
                  setNewTask((p) => ({ ...p, assigneeId: e.target.value }))
                }
                className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
              >
                <option value="">Pick counsellor…</option>
                {counsellors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <span className="flex items-center justify-end gap-1.5">
              <button
                onClick={submitNew}
                disabled={creating}
                title="Save"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={cancelNew}
                disabled={creating}
                title="Cancel"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-stone-300 bg-white text-stone-600 hover:border-stone-500 hover:text-stone-900 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}

        {sortedTasks.map((task) => {
          // Postgres DATE columns deserialize as a full ISO timestamp
          // (e.g. "2026-04-29T00:00:00.000Z"), not "YYYY-MM-DD" — slice
          // the first 10 chars for string comparisons against todayYmd.
          // Pass the original ISO straight to formatDateInIst since it
          // already handles both shapes.
          const dueYmd = (task.due_date || "").slice(0, 10);
          const overdue = !task.completed && dueYmd < todayYmd;
          const isToday = dueYmd === todayYmd;
          const isBusy = busyId === task.id;
          return (
            <div
              key={task.id}
              className={`grid items-center gap-3 border-b border-stone-200 px-4 py-3 last:border-b-0 hover:bg-stone-50 ${
                task.completed ? "opacity-60" : ""
              }`}
              style={{ gridTemplateColumns: gridCols }}
            >
              <span>
                <button
                  onClick={() => togglePriority(task)}
                  disabled={isBusy}
                  title={task.priority ? "Unpin from top" : "Pin to top"}
                  className={`inline-flex items-center gap-1 border px-1.5 py-1 text-[11px] uppercase tracking-[0.12em] disabled:opacity-50 ${
                    task.priority
                      ? "border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f]"
                      : "border-stone-300 bg-white text-stone-700 hover:border-[#cc785c] hover:text-[#cc785c]"
                  }`}
                >
                  <Star
                    className={`h-3 w-3 ${task.priority ? "fill-white" : ""}`}
                  />
                  Priority
                </button>
              </span>
              <span
                className={`tabular-nums text-[15px] ${
                  overdue
                    ? "font-bold text-red-700"
                    : isToday
                      ? "font-bold text-[#cc785c]"
                      : "text-stone-700"
                }`}
              >
                {formatDateInIst(task.due_date)}
              </span>
              <span className="text-[15px] font-semibold text-stone-900">
                {task.lead_name || task.student_name || "—"}
              </span>
              <span
                className={`text-[15px] leading-snug ${
                  task.completed ? "line-through text-stone-500" : "text-stone-800"
                }`}
              >
                {task.text}
              </span>
              {!isScoped && (
                <span className="text-[14px] text-stone-700">
                  {task.assignee_id && task.assignee_name && onImpersonate ? (
                    /* Click the counsellor name to "view as" them — opens
                       their scoped SimplePanel via the impersonation flow.
                       Underline + accent color signals it's clickable. */
                    <button
                      onClick={() => onImpersonate(task.assignee_id)}
                      title={`View as ${task.assignee_name}`}
                      className="underline decoration-dotted underline-offset-2 hover:text-[#cc785c]"
                    >
                      {task.assignee_name}
                    </button>
                  ) : task.assignee_name ? (
                    task.assignee_name
                  ) : (
                    <span className="italic text-stone-400">Unassigned</span>
                  )}
                </span>
              )}
              <span className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => toggleCompleted(task)}
                  disabled={isBusy}
                  title={task.completed ? "Mark incomplete" : "Mark done"}
                  className={`inline-flex h-7 w-7 items-center justify-center border disabled:opacity-50 ${
                    task.completed
                      ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600"
                      : "border-stone-300 bg-white text-stone-600 hover:border-emerald-500 hover:text-emerald-600"
                  }`}
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  onClick={() => archiveTask(task)}
                  disabled={isBusy}
                  title="Archive task"
                  className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-stone-500 hover:border-[#cc785c] hover:text-[#cc785c] disabled:opacity-50"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          );
        })}

        {sortedTasks.length === 0 && !showNew && (
          <p className="py-10 text-center text-base italic text-stone-600">
            No tasks yet. Click "+ New task" to add one.
          </p>
        )}
      </div>

      <ArchivedTasksSection
        tasks={archivedTasks}
        onUnarchive={unarchiveTask}
        busyId={busyId}
      />
    </>
  );
}

// Collapsible "Archived" panel mirroring the lead-archive pattern: hidden
// by default, click to expand. Each archived task shows its date, student,
// task body, and an Unarchive button to restore it to the active list.
function ArchivedTasksSection({ tasks, onUnarchive, busyId }) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;
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
          Archived ({tasks.length})
        </span>
        <span className="text-[10px] font-normal normal-case tracking-normal text-stone-500">
          {open ? "click to collapse" : "click to expand"}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-stone-200 border-t border-stone-200 bg-white">
          {tasks.map((task) => {
            const isBusy = busyId === task.id;
            return (
              <li
                key={task.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-[14px] text-stone-700"
              >
                <div className="min-w-0 flex-1">
                  <span className="tabular-nums text-[13px] text-stone-500">
                    {formatDateInIst(task.due_date)}
                  </span>
                  <span className="ml-2 font-semibold text-stone-900">
                    {task.lead_name || task.student_name || "—"}
                  </span>
                  <span className="ml-2 text-stone-700">— {task.text}</span>
                  {task.archived_at && (
                    <span className="ml-2 text-[11px] text-stone-400">
                      · archived {formatDateInIst(task.archived_at)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => onUnarchive(task)}
                  disabled={isBusy}
                  className="inline-flex shrink-0 items-center gap-1 border border-stone-400 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-600 hover:text-stone-900 disabled:opacity-50"
                >
                  {isBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Undo2 className="h-3 w-3" />
                  )}
                  Unarchive
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SortChip({ label, position, onClick }) {
  // Multi-select sort: chips can be on/off, and active chips show their
  // position number (1 = primary, 2 = secondary, ...) so the user can
  // tell at a glance which key dominates the sort.
  const active = position != null;
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-white"
          : "border border-stone-300 bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-stone-700 hover:border-stone-500 hover:text-stone-900"
      }
    >
      {label}
      {active && (
        <span className="rounded-full bg-white/30 px-1.5 text-[10px] font-bold leading-tight">
          {position}
        </span>
      )}
    </button>
  );
}
