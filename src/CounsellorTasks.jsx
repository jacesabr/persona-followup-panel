import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X, Check, Star, Trash2 } from "lucide-react";
import { api } from "./api.js";
import { formatDateInIst, utcIsoToIstInput } from "../lib/time.js";

function todayIstYmd() {
  return utcIsoToIstInput(new Date().toISOString()).slice(0, 10);
}

const EMPTY_NEW = () => ({
  leadId: "",
  text: "",
  dueDate: todayIstYmd(),
});

export default function CounsellorTasks() {
  const [tasks, setTasks] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // sortBy: "date" (default) or "student". Within "student" we still sort
  // each student's group by date asc — the user's explicit ask: "sort
  // automatically by date even when sorted by student."
  const [sortBy, setSortBy] = useState("date");
  const [showNew, setShowNew] = useState(false);
  const [newTask, setNewTask] = useState(EMPTY_NEW());
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listTasks(), api.listLeads()])
      .then(([t, l]) => {
        if (cancelled) return;
        setTasks(t);
        setLeads(l);
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

  // Sorted view. Always priority-pinned items at the top, then either:
  //  - by date ascending (default), or
  //  - by student name (alphabetical), with each student's tasks ordered
  //    by date ascending — i.e. student grouping never overrides
  //    chronological order within a group.
  const sortedTasks = useMemo(() => {
    const cmpDate = (a, b) => {
      if (a.due_date < b.due_date) return -1;
      if (a.due_date > b.due_date) return 1;
      return a.id - b.id;
    };
    const cmpStudent = (a, b) => {
      const sa = (a.student_name || "").toLowerCase();
      const sb = (b.student_name || "").toLowerCase();
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return cmpDate(a, b);
    };
    const cmp = sortBy === "student" ? cmpStudent : cmpDate;
    return [...tasks].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      return cmp(a, b);
    });
  }, [tasks, sortBy]);

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

  const removeTask = async (task) => {
    if (!window.confirm(`Delete this task: "${task.text}"?`)) return;
    setBusyId(task.id);
    setError(null);
    try {
      await api.deleteTask(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
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
    if (!newTask.leadId) {
      setError("Pick a student.");
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
    setCreating(true);
    setError(null);
    try {
      const created = await api.createTask({
        lead_id: newTask.leadId,
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

  // Wider columns + larger text per the readability requirement.
  const gridCols = "3rem 8rem 1fr 2.5fr 5rem";
  const activeLeads = leads.filter((l) => !l.archived);

  return (
    <>
      <div className="mb-4 flex items-baseline justify-between border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Counsellor tasks</h2>
          <span className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            Sort by:
          </span>
          <SortChip
            label="Date"
            active={sortBy === "date"}
            onClick={() => setSortBy("date")}
          />
          <SortChip
            label="Student"
            active={sortBy === "student"}
            onClick={() => setSortBy("student")}
          />
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
            <select
              value={newTask.leadId}
              onChange={(e) =>
                setNewTask((p) => ({ ...p, leadId: e.target.value }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
              autoFocus
            >
              <option value="">Pick student…</option>
              {activeLeads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="What needs to happen?"
              value={newTask.text}
              onChange={(e) =>
                setNewTask((p) => ({ ...p, text: e.target.value }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
            />
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
          const overdue = !task.completed && task.due_date < todayYmd;
          const isToday = task.due_date === todayYmd;
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
                {formatDateInIst(`${task.due_date}T00:00:00Z`)}
              </span>
              <span className="text-[15px] font-semibold text-stone-900">
                {task.student_name || "—"}
              </span>
              <span
                className={`text-[15px] leading-snug ${
                  task.completed ? "line-through text-stone-500" : "text-stone-800"
                }`}
              >
                {task.text}
              </span>
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
                  onClick={() => removeTask(task)}
                  disabled={isBusy}
                  title="Delete task"
                  className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-stone-500 hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
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
    </>
  );
}

function SortChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-white"
          : "border border-stone-300 bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-stone-700 hover:border-stone-500 hover:text-stone-900"
      }
    >
      {label}
    </button>
  );
}
