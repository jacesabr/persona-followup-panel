import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Plus,
  X,
  Check,
  Star,
  Archive,
  Undo2,
  Pencil,
  MessageSquare,
  Lock,
} from "lucide-react";
import { api } from "./api.js";
import { dateOnlyYmd, formatDateInIst, utcIsoToIstInput } from "../lib/time.js";
import ArchivedSection from "./ArchivedSection.jsx";
import useAutoRefresh from "./useAutoRefresh.js";

function todayIstYmd() {
  return utcIsoToIstInput(new Date().toISOString()).slice(0, 10);
}

// Strip the "admin" prefix when followed by a letter — converts the
// stored raw form ("adminSuhas") into the display form ("Suhas") used
// throughout the UI. "admin123" stays as-is (rest doesn't start with a
// letter), and a NULL/empty input rounds back to itself. Mirror of
// `adminDisplayName` in server/admins.js — kept terse and duplicated to
// avoid pulling a server module into the client bundle.
function adminDisplay(u) {
  if (!u) return u;
  const rest = u.replace(/^admin/i, "");
  return rest && /^[a-zA-Z]/.test(rest)
    ? rest.charAt(0).toUpperCase() + rest.slice(1)
    : u;
}

// assigneeValues is an array of "kind:value" strings — multi-assignee
// support. Each entry is "counsellor:{id}" or "admin:{username}". Default
// is a single-element array with the scoped counsellor (self) when in
// counsellor view, or an empty array for admin so they pick explicitly.
const EMPTY_NEW = (defaultAssigneeValue = "") => ({
  studentName: "",
  text: "",
  dueDate: todayIstYmd(),
  assigneeValues: defaultAssigneeValue ? [defaultAssigneeValue] : [],
});

export default function CounsellorTasks({
  role = "admin",
  scopedCounsellorId = null,
  onImpersonate = () => {},
  counsellors: counsellorsProp = null,
  adminUsername = "",
  adminUsernameRaw = "",
  adminMirrors = [],
  // Optional per-student filter applied on top of the assignee scope.
  // Set by SimplePanel when staff clicks "View tasks related to this
  // student" from the Documents tab — before this prop existed, that
  // button just jumped to the unfiltered Tasks tab.
  scopedStudentName = null,
  onClearStudentScope = () => {},
}) {
  // When scoped, hide other counsellors' tasks and auto-assign new tasks
  // to this counsellor. Admin sees everything and picks the assignee.
  const isScoped = role === "counsellor" && !!scopedCounsellorId;
  const [tasks, setTasks] = useState([]);
  const [leads, setLeads] = useState([]);
  // Local counsellors cache only used when no shared roster prop was
  // passed (i.e. counsellor view, where nobody mutates counsellors).
  const [counsellorsLocal, setCounsellorsLocal] = useState([]);
  const counsellors = counsellorsProp ?? counsellorsLocal;
  // Named admin accounts for the assignee picker (e.g. adminSuhas, adminJyoti).
  const [adminAccounts, setAdminAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // sortBy: array of keys in click order, primary first. Supported keys
  // are "recent" (newest task first), "date" (earliest due first),
  // "student" (alphabetical), "counsellor" (alphabetical). Default is
  // ["recent"] so a freshly created task lands at the TOP of the list —
  // the old default ("date") could bury a new task far below if its
  // due date was further out than the existing rows. Clicking Date /
  // Student / Assignee swaps the primary key the same way it did before.
  const [mySortBy, setMySortBy] = useState(["recent"]);
  const [otherSortBy, setOtherSortBy] = useState(["recent"]);
  const [selectedPeople, setSelectedPeople] = useState(new Set());
  const [showNewMy, setShowNewMy] = useState(false);
  const [newMyTask, setNewMyTask] = useState(EMPTY_NEW(""));
  const [creatingMy, setCreatingMy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newTask, setNewTask] = useState(EMPTY_NEW(isScoped ? `counsellor:${scopedCounsellorId}` : ""));
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // Admin-only inline edit. editingId holds the task id whose row is
  // currently in edit mode; editDraft mirrors the editable fields so the
  // user can cancel without polluting the row data. Counsellors never
  // open this — the pencil button is hidden for them.
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({ text: "", due_date: "", student_name: "", assigneeValues: [] });
  const [savingEdit, setSavingEdit] = useState(false);
  // Per-task comment thread. expandedCommentsId tracks which row is
  // showing its thread (only one open at a time keeps the page calm);
  // commentsByTask caches loaded threads so re-opening doesn't re-fetch.
  const [expandedCommentsId, setExpandedCommentsId] = useState(null);
  const [commentsByTask, setCommentsByTask] = useState({});
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  // Skip the counsellors fetch when AdminPanel already supplies the
  // shared roster — saves a round trip and keeps the assignee dropdown
  // in sync with admin's "+ New counsellor" automatically.
  //
  // includeArchived: true on listLeads is load-bearing for the
  // visibility filter below: a task pinned to a student whose lead has
  // since been archived must still surface for the counsellor. Without
  // the archived row in `leads`, myLeadIds would miss it and the task
  // would silently vanish.
  //
  // counsellorId scopes server-side when an admin is impersonating so
  // the wire response only carries that counsellor's leads. For a
  // counsellor session the server already scopes; the param is
  // redundant but harmless.
  const refresh = useCallback(async () => {
    try {
      const fetches = [
        api.listTasks({ includeArchived: true }),
        api.listLeads({
          includeArchived: true,
          counsellorId: isScoped ? scopedCounsellorId : null,
        }),
        api.listAdminAccounts(),
      ];
      if (counsellorsProp == null) fetches.push(api.listCounsellors());
      const [t, l, admins, c] = await Promise.all(fetches);
      setTasks(t);
      setLeads(l);
      setAdminAccounts(admins || []);
      if (c) setCounsellorsLocal(c);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [isScoped, scopedCounsellorId, counsellorsProp]);

  useEffect(() => {
    let active = true;
    refresh().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  useAutoRefresh(refresh);

  // Helpers to read the multi-assignee array off a task with safe fallback
  // to the legacy single-assignee fields (so rows pre-junction-backfill
  // still display correctly during the rollout window).
  const taskAssignees = (t) =>
    Array.isArray(t.assignees) && t.assignees.length > 0
      ? t.assignees
      : (t.assignee_kind === "admin" && t.assignee_admin_username)
        ? [{ kind: "admin", admin_username: t.assignee_admin_username, name: t.assignee_admin_username }]
        : (t.assignee_id)
          ? [{ kind: "counsellor", counsellor_id: t.assignee_id, name: t.assignee_name || t.assignee_id }]
          : [];
  const taskHasCounsellor = (t, cid) =>
    taskAssignees(t).some((a) => a.kind === "counsellor" && a.counsellor_id === cid);
  const taskHasAdminMatch = (t, uname, mirrors) =>
    taskAssignees(t).some((a) => {
      if (a.kind !== "admin") return false;
      const d = adminDisplay(a.admin_username);
      return d === uname || mirrors.includes(d);
    });

  // Counsellor scoping. Admin sees everything; counsellors see a task if
  // ANY of:
  //   (1) they appear in the multi-assignee list (covers self + multi),
  //   (2) the task is about a lead they own,
  //   (3) they created the task (covers admin-targeted tasks they raised).
  const visibleTasks = useMemo(() => {
    let base;
    if (!isScoped) {
      base = tasks;
    } else {
      const myLeadIds = new Set(
        leads
          .filter((l) => l.counsellor_id === scopedCounsellorId)
          .map((l) => l.id)
      );
      base = tasks.filter(
        (t) =>
          taskHasCounsellor(t, scopedCounsellorId) ||
          (t.lead_id && myLeadIds.has(t.lead_id)) ||
          (t.creator_id === scopedCounsellorId)
      );
    }
    if (!scopedStudentName) return base;
    const needle = scopedStudentName.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((t) => {
      const s = (t.lead_name || t.student_name || "").trim().toLowerCase();
      return s === needle;
    });
  }, [tasks, leads, isScoped, scopedCounsellorId, scopedStudentName]);

  // Split active vs archived. Archived rows live in a collapsible section
  // at the bottom; the main list is active-only, sorted/grouped by the
  // selected sort key. Both sets come from listTasks({ includeArchived }).
  const { myActiveTasks, otherPeopleActiveTasks, myArchivedTasks, otherPeopleArchivedTasks } = useMemo(() => {
    const active = visibleTasks.filter((t) => !t.archived);
    const archived = visibleTasks
      .filter((t) => t.archived)
      .sort((a, b) => {
        const at = a.archived_at ? new Date(a.archived_at).getTime() : 0;
        const bt = b.archived_at ? new Date(b.archived_at).getTime() : 0;
        return bt - at;
      });
    // "My Tasks" rule:
    //   Counsellor session — I'm an assignee, OR I created an admin-only task.
    //   Admin session — any assignee is me (or one of my mirror partners).
    const isMine = (t) =>
      isScoped
        ? taskHasCounsellor(t, scopedCounsellorId) ||
          (t.creator_id === scopedCounsellorId &&
            taskAssignees(t).every((a) => a.kind === "admin"))
        : taskHasAdminMatch(t, adminUsername, adminMirrors);
    return {
      myActiveTasks: active.filter(isMine),
      otherPeopleActiveTasks: isScoped ? [] : active.filter((t) => !isMine(t)),
      myArchivedTasks: archived.filter(isMine),
      otherPeopleArchivedTasks: isScoped ? [] : archived.filter((t) => !isMine(t)),
    };
  }, [visibleTasks, isScoped, scopedCounsellorId, adminUsername, adminMirrors]);

  // Sorted view of active tasks. sortBy is an array of keys in click
  // order; the primary key is sortBy[0]. Priority position depends on
  // whether any non-date key is active:
  //  - Only "date" in chain → priority is OUTERMOST (top of list),
  //    matching the "Priority button moves to top" rule.
  //  - Any non-date key in chain → that key (or chain) groups first,
  //    then priority within the group, then date as tiebreaker.
  // Final stable tiebreaker: id, so equal-key rows keep insertion order.
  const buildSorted = (list, sb) => {
    const cmpKey = (a, b, key) => {
      if (key === "recent") {
        // BIGSERIAL ids increase with insert time, so id DESC is a
        // reliable "newest first" sort without needing created_at on
        // every row. Equal ids are impossible (PK).
        return b.id - a.id;
      }
      if (key === "date") {
        const ad = dateOnlyYmd(a.due_date);
        const bd = dateOnlyYmd(b.due_date);
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
    const chain = sb.length > 0 ? sb : ["date"];
    const explicitNonDate = chain.filter((k) => k !== "date");
    return [...list].sort((a, b) => {
      if (explicitNonDate.length === 0) {
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
  };

  const sortedMyTasks = useMemo(
    () => buildSorted(myActiveTasks, mySortBy),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [myActiveTasks, mySortBy]
  );
  const sortedOtherTasks = useMemo(
    () => buildSorted(otherPeopleActiveTasks, otherSortBy),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [otherPeopleActiveTasks, otherSortBy]
  );

  // People keys available in the filter (all counsellors + other admins).
  // Exclude self and mirror partners — mirrors share our inbox so showing
  // them as separate filter options would just duplicate "My Tasks".
  const otherAdmins = useMemo(
    () => adminAccounts.filter((a) => {
      const display = a.name || a.username;
      return display !== adminUsername && !adminMirrors.includes(display);
    }),
    [adminAccounts, adminUsername, adminMirrors]
  );

  const allPeopleKeys = useMemo(() => {
    const keys = new Set();
    counsellors.forEach((c) => keys.add(`counsellor:${c.id}`));
    otherAdmins.forEach((a) => keys.add(`admin:${a.username}`));
    return keys;
  }, [counsellors, otherAdmins]);

  const isEveryone = allPeopleKeys.size > 0 && [...allPeopleKeys].every((k) => selectedPeople.has(k));

  const filteredOtherTasks = useMemo(() => {
    if (selectedPeople.size === 0) return [];
    return sortedOtherTasks.filter((t) => {
      const key = t.assignee_kind === "admin"
        ? `admin:${t.assignee_admin_username}`
        : `counsellor:${t.assignee_id}`;
      return selectedPeople.has(key);
    });
  }, [sortedOtherTasks, selectedPeople]);

  const toggleMySort = (key) => {
    setMySortBy((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      return [key, ...prev];
    });
  };
  const mySortPosition = (key) => {
    const idx = mySortBy.indexOf(key);
    return idx >= 0 ? idx + 1 : null;
  };
  const toggleOtherSort = (key) => {
    setOtherSortBy((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      return [key, ...prev];
    });
  };
  const otherSortPosition = (key) => {
    const idx = otherSortBy.indexOf(key);
    return idx >= 0 ? idx + 1 : null;
  };
  const togglePerson = (key) => {
    setSelectedPeople((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  // Admin-only edit-mode handlers. The assignee picker is now part of
  // the editable surface — open the row, swap assignees, save. Hydrates
  // from task.assignees (multi) and falls back to the legacy single-
  // assignee fields when the array is missing (older rows, transient).
  const beginEdit = (task) => {
    const list = Array.isArray(task.assignees) && task.assignees.length > 0
      ? task.assignees
      : (task.assignee_kind === "admin" && task.assignee_admin_username)
        ? [{ kind: "admin", admin_username: task.assignee_admin_username }]
        : (task.assignee_id)
          ? [{ kind: "counsellor", counsellor_id: task.assignee_id }]
          : [];
    const initialValues = list.map((a) =>
      a.kind === "admin" ? `admin:${a.admin_username}` : `counsellor:${a.counsellor_id}`
    );
    setEditingId(task.id);
    setEditDraft({
      text: task.text || "",
      due_date: dateOnlyYmd(task.due_date),
      student_name: task.lead_id ? "" : (task.student_name || ""),
      assigneeValues: initialValues,
    });
    setError(null);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft({ text: "", due_date: "", student_name: "", assigneeValues: [] });
  };
  const saveEdit = async (task) => {
    const text = editDraft.text.trim();
    if (!text) {
      setError("Task text can't be empty.");
      return;
    }
    if (!editDraft.due_date) {
      setError("Pick a due date.");
      return;
    }
    if (!editDraft.assigneeValues || editDraft.assigneeValues.length === 0) {
      setError("Pick at least one assignee.");
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      // Only send student_name when the task is a free-text student
      // (no lead FK). Editing the linked student name would require
      // re-resolving against the leads table — out of scope here.
      const assignees = editDraft.assigneeValues.map((v) => {
        const colonIdx = v.indexOf(":");
        const kind = colonIdx >= 0 ? v.slice(0, colonIdx) : "counsellor";
        const target = colonIdx >= 0 ? v.slice(colonIdx + 1) : v;
        return kind === "admin"
          ? { kind: "admin", admin_username: target }
          : { kind: "counsellor", counsellor_id: target };
      });
      const patch = { text, due_date: editDraft.due_date, assignees };
      if (!task.lead_id) patch.student_name = editDraft.student_name.trim() || null;
      const updated = await api.updateTask(task.id, patch);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      cancelEdit();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingEdit(false);
    }
  };

  // Comment thread handlers. Lazy-load on first open and cache the
  // result; subsequent opens read from cache without a round trip.
  const toggleComments = async (task) => {
    if (expandedCommentsId === task.id) {
      setExpandedCommentsId(null);
      setCommentDraft("");
      return;
    }
    setExpandedCommentsId(task.id);
    setCommentDraft("");
    if (commentsByTask[task.id] !== undefined) return;
    setCommentsLoading(true);
    try {
      const list = await api.listTaskComments(task.id);
      setCommentsByTask((prev) => ({ ...prev, [task.id]: list }));
    } catch (e) {
      setError(e.message);
    } finally {
      setCommentsLoading(false);
    }
  };
  const submitComment = async (task) => {
    const body = commentDraft.trim();
    if (!body) return;
    setPostingComment(true);
    try {
      const created = await api.addTaskComment(task.id, body);
      setCommentsByTask((prev) => ({
        ...prev,
        [task.id]: [...(prev[task.id] || []), created],
      }));
      // Bump the badge count on the task without a full refetch.
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t
        )
      );
      setCommentDraft("");
    } catch (e) {
      setError(e.message);
    } finally {
      setPostingComment(false);
    }
  };

  const defaultAssigneeValue = isScoped ? `counsellor:${scopedCounsellorId}` : "";
  const cancelNew = () => {
    setShowNew(false);
    setNewTask(EMPTY_NEW(defaultAssigneeValue));
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
    if (!newTask.assigneeValues || newTask.assigneeValues.length === 0) {
      setError("Pick at least one person to assign this to.");
      return;
    }

    // Convert "kind:value" strings into the canonical assignees payload.
    const assignees = newTask.assigneeValues.map((v) => {
      const colonIdx = v.indexOf(":");
      const kind = colonIdx >= 0 ? v.slice(0, colonIdx) : "counsellor";
      const target = colonIdx >= 0 ? v.slice(colonIdx + 1) : v;
      return kind === "admin"
        ? { kind: "admin", admin_username: target }
        : { kind: "counsellor", counsellor_id: target };
    });

    const matchedLead = leads.find(
      (l) => !l.archived && l.name.trim().toLowerCase() === studentName.toLowerCase()
    );
    setCreating(true);
    setError(null);
    try {
      const payload = {
        lead_id: matchedLead ? matchedLead.id : null,
        student_name: matchedLead ? null : studentName,
        text,
        due_date: newTask.dueDate,
        assignees,
      };
      const created = await api.createTask(payload);
      setTasks((prev) => [...prev, created]);
      setNewTask(EMPTY_NEW(defaultAssigneeValue));
      setShowNew(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const cancelNewMy = () => {
    setShowNewMy(false);
    setNewMyTask(EMPTY_NEW(""));
    setError(null);
  };

  const submitNewMy = async () => {
    const text = newMyTask.text.trim();
    const studentName = newMyTask.studentName.trim();
    if (!studentName) { setError("Type a student name."); return; }
    if (!text) { setError("Type a task."); return; }
    if (!newMyTask.dueDate) { setError("Pick a due date."); return; }
    const matchedLead = leads.find((l) => !l.archived && l.name.trim().toLowerCase() === studentName.toLowerCase());
    setCreatingMy(true);
    setError(null);
    try {
      const payload = {
        lead_id: matchedLead ? matchedLead.id : null,
        student_name: matchedLead ? null : studentName,
        text,
        due_date: newMyTask.dueDate,
      };
      if (isScoped) {
        payload.assignee_id = scopedCounsellorId;
      } else {
        // Server validates against the raw lowercased form
        // (`adminUsernameSet` from EXTRA_ADMINS), not the stripped
        // display name — so for adminSuhas/adminJyoti the display name
        // ("Suhas") would 400 with "unknown admin username". Use the
        // raw form when threaded through; fall back to display so the
        // legacy ADMIN_USERNAME=admin123 path still works.
        payload.assignee_admin_username = adminUsernameRaw || adminUsername;
      }
      const created = await api.createTask(payload);
      setTasks((prev) => [...prev, created]);
      setNewMyTask(EMPTY_NEW(""));
      setShowNewMy(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreatingMy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-black">
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
  //   - counsellor (scoped): no Assigned-to column. Actions: complete +
  //                          archive + comment = 3 icons → 7.5rem
  //   - admin:               extra Assigned-to column. Actions: edit +
  //                          complete + archive + comment = 4 icons → 10rem
  const gridCols = isScoped
    ? "6.5rem 7rem 1fr 2fr 7.5rem"
    : "6.5rem 7rem 1fr 2fr 8rem 10rem";

  return (
    <>
      {scopedStudentName && (
        <div className="mb-4 flex items-center justify-between gap-3 border border-[#cc785c] bg-[#fdf4ef] px-4 py-3">
          <p className="text-sm text-black">
            Showing tasks for student: <span className="font-semibold">{scopedStudentName}</span>
          </p>
          <button
            type="button"
            onClick={onClearStudentScope}
            className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-black hover:border-stone-700"
          >
            <X className="h-3 w-3" /> Clear filter
          </button>
        </div>
      )}

      {/* ── My Tasks section ─────────────────────────────────── */}
      <div className="mb-4 flex items-center justify-between border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">My Tasks</h2>
          <span className="text-[11px] uppercase tracking-[0.2em] text-black">
            {myActiveTasks.length} {myActiveTasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.2em] text-black">Sort by:</span>
          <SortChip label="Recent" position={mySortPosition("recent")} onClick={() => toggleMySort("recent")} />
          <SortChip label="Date" position={mySortPosition("date")} onClick={() => toggleMySort("date")} />
          <SortChip label="Student" position={mySortPosition("student")} onClick={() => toggleMySort("student")} />
        </div>
        <div>
          {!showNewMy && (
            <button
              onClick={() => { setNewMyTask(EMPTY_NEW("")); setShowNewMy(true); }}
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

      <div className="mb-8 border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-black"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span className="whitespace-nowrap">Priority</span>
          <span className="whitespace-nowrap">Date</span>
          <span className="whitespace-nowrap">Student</span>
          <span className="whitespace-nowrap">Task</span>
          {!isScoped && <span className="whitespace-nowrap">Assigned to</span>}
          <span className="whitespace-nowrap text-right">Actions</span>
        </div>

        {showNewMy && (
          <div
            className="grid items-start gap-3 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-4 py-3 text-[15px] text-black"
            style={{ gridTemplateColumns: gridCols }}
          >
            <span></span>
            <input
              type="date"
              value={newMyTask.dueDate}
              onChange={(e) => setNewMyTask((p) => ({ ...p, dueDate: e.target.value }))}
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
            />
            <input
              type="text"
              list="my-task-students"
              placeholder="Student name"
              value={newMyTask.studentName}
              onChange={(e) => setNewMyTask((p) => ({ ...p, studentName: e.target.value }))}
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
              autoFocus
            />
            <datalist id="my-task-students">
              {leads.filter((l) => !l.archived).map((l) => <option key={l.id} value={l.name} />)}
            </datalist>
            <input
              type="text"
              placeholder="What needs to happen?"
              value={newMyTask.text}
              onChange={(e) => setNewMyTask((p) => ({ ...p, text: e.target.value }))}
              className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
            />
            {/* Auto-assigned to self — no picker needed */}
            <span className="text-[13px]  text-black">Assigned to you</span>
            <span className="flex items-center justify-end gap-1.5">
              <button
                onClick={submitNewMy}
                disabled={creatingMy}
                title="Save"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50"
              >
                {creatingMy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={cancelNewMy}
                disabled={creatingMy}
                title="Cancel"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-stone-300 bg-white text-black hover:border-stone-500 hover:text-black disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}

        {sortedMyTasks.map((task) => {
          const dueYmd = dateOnlyYmd(task.due_date);
          const overdue = !task.completed && dueYmd < todayYmd;
          const isToday = dueYmd === todayYmd;
          const isBusy = busyId === task.id;
          const isEditing = !isScoped && editingId === task.id;
          const commentsOpen = expandedCommentsId === task.id;
          const commentCount = task.comment_count || 0;
          return (
            <div key={task.id} className="border-b border-stone-200 last:border-b-0">
              <div
                className={`grid items-center gap-3 px-4 py-3 hover:bg-stone-50 ${task.completed ? "opacity-60" : ""} ${isEditing ? "bg-[#cc785c]/5" : ""}`}
                style={{ gridTemplateColumns: gridCols }}
              >
                <span>
                  <button
                    onClick={() => togglePriority(task)}
                    disabled={isBusy || isEditing}
                    title={task.priority ? "Unpin from top" : "Pin to top"}
                    className={`inline-flex items-center gap-1 border px-1.5 py-1 text-[11px] uppercase tracking-[0.12em] disabled:opacity-50 ${
                      task.priority
                        ? "border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f]"
                        : "border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c]"
                    }`}
                  >
                    <Star className={`h-3 w-3 ${task.priority ? "fill-white" : ""}`} />
                    Priority
                  </button>
                </span>
                {isEditing ? (
                  <input
                    type="date"
                    value={editDraft.due_date}
                    onChange={(e) => setEditDraft((p) => ({ ...p, due_date: e.target.value }))}
                    className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
                  />
                ) : (
                  <span className={`tabular-nums text-[15px] ${overdue ? "font-bold text-red-700" : isToday ? "font-bold text-[#cc785c]" : "text-black"}`}>
                    {formatDateInIst(task.due_date)}
                  </span>
                )}
                {isEditing && !task.lead_id ? (
                  <input
                    type="text"
                    value={editDraft.student_name}
                    onChange={(e) => setEditDraft((p) => ({ ...p, student_name: e.target.value }))}
                    placeholder="Student name"
                    className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
                  />
                ) : (
                  <span className="text-[15px] font-semibold text-black">
                    {task.lead_name || task.student_name || "—"}
                  </span>
                )}
                {isEditing ? (
                  <input
                    type="text"
                    value={editDraft.text}
                    onChange={(e) => setEditDraft((p) => ({ ...p, text: e.target.value }))}
                    className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
                    autoFocus
                  />
                ) : (
                  <span className={`flex flex-col text-[15px] leading-snug ${task.completed ? "line-through text-black" : "text-black"}`}>
                    <span>{task.text}</span>
                    {task.appointment_scheduled_for && (
                      <span className="mt-0.5 inline-flex items-center gap-1 self-start border border-[#cc785c]/40 bg-[#cc785c]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[#cc785c]">
                        from session · {formatDateInIst(task.appointment_scheduled_for)}
                      </span>
                    )}
                    {commentCount > 0 && !commentsOpen && task.latest_comment_body && (
                      <button
                        type="button"
                        onClick={() => toggleComments(task)}
                        className="mt-1 flex max-w-full items-baseline gap-1.5 self-start text-left text-[12px]  text-black hover:text-[#cc785c]"
                        title="Click to expand the full thread"
                      >
                        <MessageSquare className="h-3 w-3 shrink-0 not-italic" />
                        <span className="font-semibold not-italic text-black">
                          {task.latest_comment_author_kind === "admin"
                            ? (adminDisplay(task.latest_comment_author_admin_username) || "Admin")
                            : (task.latest_comment_author_name || "—")}:
                        </span>
                        <span className="truncate">{task.latest_comment_body}</span>
                        {commentCount > 1 && (
                          <span className="shrink-0 text-[11px] not-italic text-black">+{commentCount - 1} more</span>
                        )}
                      </button>
                    )}
                  </span>
                )}
                {!isScoped && (
                  <span className="flex flex-wrap items-center gap-1 text-[14px] text-black">
                    {isEditing ? (
                      <AssigneePicker
                        values={editDraft.assigneeValues}
                        onChange={(next) => setEditDraft((p) => ({ ...p, assigneeValues: next }))}
                        counsellors={counsellors}
                        adminAccounts={adminAccounts}
                        isScoped={isScoped}
                        scopedCounsellorId={scopedCounsellorId}
                      />
                    ) : (
                      <AssigneeChips task={task} onImpersonate={onImpersonate} />
                    )}
                  </span>
                )}
                <span className="flex items-center justify-end gap-1.5">
                  {isEditing ? (
                    <>
                      <button onClick={() => saveEdit(task)} disabled={savingEdit} title="Save changes"
                        className="inline-flex h-7 w-7 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50">
                        {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </button>
                      <button onClick={cancelEdit} disabled={savingEdit} title="Cancel edit"
                        className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-black hover:border-stone-500 hover:text-black disabled:opacity-50">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      {!isScoped && (
                        <button onClick={() => beginEdit(task)} disabled={isBusy} title="Edit task"
                          className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c] disabled:opacity-50">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button onClick={() => toggleCompleted(task)} disabled={isBusy}
                        title={task.completed ? "Mark incomplete" : "Mark done"}
                        className={`inline-flex h-7 w-7 items-center justify-center border disabled:opacity-50 ${task.completed ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600" : "border-stone-300 bg-white text-black hover:border-emerald-500 hover:text-emerald-600"}`}>
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </button>
                      {!(isScoped && task.assignee_kind === "admin") && (
                        <button onClick={() => archiveTask(task)} disabled={isBusy} title="Archive task"
                          className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c] disabled:opacity-50">
                          <Archive className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button onClick={() => toggleComments(task)} disabled={isBusy}
                        title={commentsOpen ? "Hide comments" : "Show comments"}
                        className={`relative inline-flex h-7 w-7 items-center justify-center border disabled:opacity-50 ${commentsOpen ? "border-[#cc785c] bg-[#cc785c] text-white" : "border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c]"}`}>
                        <MessageSquare className="h-3.5 w-3.5" />
                        {commentCount > 0 && (
                          <span className={`absolute -right-1.5 -top-1.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-tight ${commentsOpen ? "bg-white text-[#cc785c]" : "bg-[#cc785c] text-white"}`}>
                            {commentCount}
                          </span>
                        )}
                      </button>
                    </>
                  )}
                </span>
              </div>
              {commentsOpen && (
                <CommentsPanel
                  task={task}
                  comments={commentsByTask[task.id]}
                  loading={commentsLoading && commentsByTask[task.id] === undefined}
                  draft={commentDraft}
                  onDraftChange={setCommentDraft}
                  onSubmit={() => submitComment(task)}
                  posting={postingComment}
                />
              )}
            </div>
          );
        })}

        {sortedMyTasks.length === 0 && !showNewMy && (
          <p className="py-8 text-center text-base  text-black">
            No tasks assigned to you yet.
          </p>
        )}
      </div>

      <ArchivedTasksSection tasks={myArchivedTasks} onUnarchive={unarchiveTask} busyId={busyId} />

      {/* ── Other People's Tasks section (admin only) ──────────── */}
      {!isScoped && (
        <>
          <div className="mb-2 flex items-center justify-between border-b border-stone-300 pb-2">
            <div className="flex items-baseline gap-3">
              <h2 className="text-lg font-semibold tracking-tight">Other People's Tasks</h2>
              <span className="text-[11px] uppercase tracking-[0.2em] text-black">
                {filteredOtherTasks.length} {filteredOtherTasks.length === 1 ? "task" : "tasks"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.2em] text-black">Sort by:</span>
              <SortChip label="Recent" position={otherSortPosition("recent")} onClick={() => toggleOtherSort("recent")} />
              <SortChip label="Date" position={otherSortPosition("date")} onClick={() => toggleOtherSort("date")} />
              <SortChip label="Student" position={otherSortPosition("student")} onClick={() => toggleOtherSort("student")} />
              <SortChip label="Assignee" position={otherSortPosition("counsellor")} onClick={() => toggleOtherSort("counsellor")} />
            </div>
            <div>
              {!showNew && (
                <button
                  onClick={() => { setNewTask(EMPTY_NEW(defaultAssigneeValue)); setShowNew(true); }}
                  className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f]"
                >
                  <Plus className="h-3 w-3" /> New task
                </button>
              )}
            </div>
          </div>

          {/* "View Tasks Of" filter chips */}
          <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-stone-200 pb-3">
            <span className="text-[11px] uppercase tracking-[0.15em] text-black">View Tasks Of:</span>
            {counsellors.map((c) => (
              <FilterChip
                key={c.id}
                label={c.name}
                active={selectedPeople.has(`counsellor:${c.id}`)}
                onClick={() => togglePerson(`counsellor:${c.id}`)}
              />
            ))}
            {otherAdmins.map((a) => (
              <FilterChip
                key={a.username}
                label={a.name || a.username}
                active={selectedPeople.has(`admin:${a.username}`)}
                onClick={() => togglePerson(`admin:${a.username}`)}
              />
            ))}
            {allPeopleKeys.size > 0 && (
              <FilterChip
                label="Everyone"
                active={isEveryone}
                onClick={() => isEveryone ? setSelectedPeople(new Set()) : setSelectedPeople(new Set(allPeopleKeys))}
              />
            )}
          </div>

          {error && (
            <div className="mb-3 border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800">
              {error}
            </div>
          )}

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-black"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span className="whitespace-nowrap">Priority</span>
          <span className="whitespace-nowrap">Date</span>
          <span className="whitespace-nowrap">Student</span>
          <span className="whitespace-nowrap">Task</span>
          {!isScoped && <span className="whitespace-nowrap">Assigned to</span>}
          <span className="whitespace-nowrap text-right">Actions</span>
        </div>

        {showNew && (
          <div
            className="grid items-start gap-3 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-4 py-3 text-[15px] text-black"
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
            {/* Unified assignee picker: always shown.
                Admin sees all counsellors + named admins.
                Counsellor sees self + supervised counsellors + named admins. */}
            <AssigneePicker
              values={newTask.assigneeValues}
              onChange={(next) => setNewTask((p) => ({ ...p, assigneeValues: next }))}
              counsellors={counsellors}
              adminAccounts={adminAccounts}
              isScoped={isScoped}
              scopedCounsellorId={scopedCounsellorId}
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
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-stone-300 bg-white text-black hover:border-stone-500 hover:text-black disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}

        {filteredOtherTasks.map((task) => {
          // Postgres DATE columns deserialize as a full ISO timestamp
          // (e.g. "2026-04-29T00:00:00.000Z"), not "YYYY-MM-DD" — slice
          // the first 10 chars for string comparisons against todayYmd.
          // Pass the original ISO straight to formatDateInIst since it
          // already handles both shapes.
          const dueYmd = dateOnlyYmd(task.due_date);
          const overdue = !task.completed && dueYmd < todayYmd;
          const isToday = dueYmd === todayYmd;
          const isBusy = busyId === task.id;
          const isEditing = !isScoped && editingId === task.id;
          const commentsOpen = expandedCommentsId === task.id;
          const commentCount = task.comment_count || 0;
          return (
            <div key={task.id} className="border-b border-stone-200 last:border-b-0">
              <div
                className={`grid items-center gap-3 px-4 py-3 hover:bg-stone-50 ${
                  task.completed ? "opacity-60" : ""
                } ${isEditing ? "bg-[#cc785c]/5" : ""}`}
                style={{ gridTemplateColumns: gridCols }}
              >
                <span>
                  <button
                    onClick={() => togglePriority(task)}
                    disabled={isBusy || isEditing}
                    title={task.priority ? "Unpin from top" : "Pin to top"}
                    className={`inline-flex items-center gap-1 border px-1.5 py-1 text-[11px] uppercase tracking-[0.12em] disabled:opacity-50 ${
                      task.priority
                        ? "border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f]"
                        : "border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c]"
                    }`}
                  >
                    <Star
                      className={`h-3 w-3 ${task.priority ? "fill-white" : ""}`}
                    />
                    Priority
                  </button>
                </span>
                {isEditing ? (
                  <input
                    type="date"
                    value={editDraft.due_date}
                    onChange={(e) => setEditDraft((p) => ({ ...p, due_date: e.target.value }))}
                    className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
                  />
                ) : (
                  <span
                    className={`tabular-nums text-[15px] ${
                      overdue
                        ? "font-bold text-red-700"
                        : isToday
                          ? "font-bold text-[#cc785c]"
                          : "text-black"
                    }`}
                  >
                    {formatDateInIst(task.due_date)}
                  </span>
                )}
                {isEditing && !task.lead_id ? (
                  <input
                    type="text"
                    value={editDraft.student_name}
                    onChange={(e) => setEditDraft((p) => ({ ...p, student_name: e.target.value }))}
                    placeholder="Student name"
                    className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
                  />
                ) : (
                  <span className="text-[15px] font-semibold text-black">
                    {task.lead_name || task.student_name || "—"}
                  </span>
                )}
                {isEditing ? (
                  <input
                    type="text"
                    value={editDraft.text}
                    onChange={(e) => setEditDraft((p) => ({ ...p, text: e.target.value }))}
                    className="border border-stone-300 bg-white px-2 py-1.5 text-[15px] outline-none focus:border-[#cc785c]"
                    autoFocus
                  />
                ) : (
                  <span
                    className={`flex flex-col text-[15px] leading-snug ${
                      task.completed ? "line-through text-black" : "text-black"
                    }`}
                  >
                    <span>{task.text}</span>
                    {/* Provenance pill — appears when the task was logged
                        inside a Session popup. */}
                    {task.appointment_scheduled_for && (
                      <span className="mt-0.5 inline-flex items-center gap-1 self-start border border-[#cc785c]/40 bg-[#cc785c]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[#cc785c]">
                        from session · {formatDateInIst(task.appointment_scheduled_for)}
                      </span>
                    )}
                    {/* Admin-target pill — counsellor-created tasks sent to
                        an admin account. Read-only (no archive/delete). */}
                    {task.assignee_kind === "admin" && (
                      <span className="mt-0.5 inline-flex items-center gap-1 self-start border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-black">
                        <Lock className="h-2.5 w-2.5 shrink-0" />
                        for {adminDisplay(task.assignee_admin_username)}
                      </span>
                    )}
                    {/* Latest-comment preview. Hidden once the thread is
                        expanded so the same line doesn't appear twice.
                        Click jumps straight to the open thread. The
                        author label falls back to "Admin" when no
                        counsellor name is joined (admin authorship has
                        no counsellor row by design). */}
                    {commentCount > 0 && !commentsOpen && task.latest_comment_body && (
                      <button
                        type="button"
                        onClick={() => toggleComments(task)}
                        className="mt-1 flex max-w-full items-baseline gap-1.5 self-start text-left text-[12px]  text-black hover:text-[#cc785c]"
                        title="Click to expand the full thread"
                      >
                        <MessageSquare className="h-3 w-3 shrink-0 not-italic" />
                        <span className="font-semibold not-italic text-black">
                          {task.latest_comment_author_kind === "admin"
                            ? (adminDisplay(task.latest_comment_author_admin_username) || "Admin")
                            : (task.latest_comment_author_name || "—")}
                          :
                        </span>
                        <span className="truncate">{task.latest_comment_body}</span>
                        {commentCount > 1 && (
                          <span className="shrink-0 text-[11px] not-italic text-black">
                            +{commentCount - 1} more
                          </span>
                        )}
                      </button>
                    )}
                  </span>
                )}
                {!isScoped && (
                  <span className="flex flex-wrap items-center gap-1 text-[14px] text-black">
                    {isEditing ? (
                      <AssigneePicker
                        values={editDraft.assigneeValues}
                        onChange={(next) => setEditDraft((p) => ({ ...p, assigneeValues: next }))}
                        counsellors={counsellors}
                        adminAccounts={adminAccounts}
                        isScoped={isScoped}
                        scopedCounsellorId={scopedCounsellorId}
                      />
                    ) : (
                      <AssigneeChips task={task} onImpersonate={onImpersonate} />
                    )}
                  </span>
                )}
                <span className="flex items-center justify-end gap-1.5">
                  {isEditing ? (
                    <>
                      <button
                        onClick={() => saveEdit(task)}
                        disabled={savingEdit}
                        title="Save changes"
                        className="inline-flex h-7 w-7 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50"
                      >
                        {savingEdit ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        onClick={cancelEdit}
                        disabled={savingEdit}
                        title="Cancel edit"
                        className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-black hover:border-stone-500 hover:text-black disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Admin-only edit button. Counsellors can't edit
                          task text/date — they comment instead. */}
                      {!isScoped && (
                        <button
                          onClick={() => beginEdit(task)}
                          disabled={isBusy}
                          title="Edit task"
                          className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c] disabled:opacity-50"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => toggleCompleted(task)}
                        disabled={isBusy}
                        title={task.completed ? "Mark incomplete" : "Mark done"}
                        className={`inline-flex h-7 w-7 items-center justify-center border disabled:opacity-50 ${
                          task.completed
                            ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600"
                            : "border-stone-300 bg-white text-black hover:border-emerald-500 hover:text-emerald-600"
                        }`}
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                      </button>
                      {/* Hide archive for counsellor-created admin tasks —
                          the counsellor can view but not remove them. */}
                      {!(isScoped && task.assignee_kind === "admin") && (
                        <button
                          onClick={() => archiveTask(task)}
                          disabled={isBusy}
                          title="Archive task"
                          className="inline-flex h-7 w-7 items-center justify-center border border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c] disabled:opacity-50"
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => toggleComments(task)}
                        disabled={isBusy}
                        title={commentsOpen ? "Hide comments" : "Show comments"}
                        className={`relative inline-flex h-7 w-7 items-center justify-center border disabled:opacity-50 ${
                          commentsOpen
                            ? "border-[#cc785c] bg-[#cc785c] text-white"
                            : "border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c]"
                        }`}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        {commentCount > 0 && (
                          <span
                            className={`absolute -right-1.5 -top-1.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-tight ${
                              commentsOpen
                                ? "bg-white text-[#cc785c]"
                                : "bg-[#cc785c] text-white"
                            }`}
                          >
                            {commentCount}
                          </span>
                        )}
                      </button>
                    </>
                  )}
                </span>
              </div>
              {commentsOpen && (
                <CommentsPanel
                  task={task}
                  comments={commentsByTask[task.id]}
                  loading={commentsLoading && commentsByTask[task.id] === undefined}
                  draft={commentDraft}
                  onDraftChange={setCommentDraft}
                  onSubmit={() => submitComment(task)}
                  posting={postingComment}
                />
              )}
            </div>
          );
        })}

        {filteredOtherTasks.length === 0 && !showNew && (
          <p className="py-10 text-center text-base  text-black">
            {selectedPeople.size === 0
              ? "Select a person above to view their tasks."
              : "No tasks for the selected people."}
          </p>
        )}
      </div>

      <ArchivedTasksSection tasks={otherPeopleArchivedTasks} onUnarchive={unarchiveTask} busyId={busyId} />
        </>
      )}
    </>
  );
}

// Collapsible "Archived" panel mirroring the lead-archive pattern. Chrome
// (collapse, header, count, divider) is shared via the generic
// ArchivedSection; this component owns just the per-row layout.
function ArchivedTasksSection({ tasks, onUnarchive, busyId }) {
  return (
    <ArchivedSection
      items={tasks}
      renderRow={(task) => {
        const isBusy = busyId === task.id;
        return (
          <li
            key={task.id}
            className="flex items-center justify-between gap-3 px-3 py-2 text-[14px] text-black"
          >
            <div className="min-w-0 flex-1">
              <span className="tabular-nums text-[13px] text-black">
                {formatDateInIst(task.due_date)}
              </span>
              <span className="ml-2 font-semibold text-black">
                {task.lead_name || task.student_name || "—"}
              </span>
              <span className="ml-2 text-black">— {task.text}</span>
              {task.archived_at && (
                <span className="ml-2 text-[11px] text-black">
                  · archived {formatDateInIst(task.archived_at)}
                </span>
              )}
            </div>
            <button
              onClick={() => onUnarchive(task)}
              disabled={isBusy}
              className="inline-flex shrink-0 items-center gap-1 border border-stone-400 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-black hover:border-stone-600 hover:text-black disabled:opacity-50"
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
      }}
    />
  );
}

// Per-task comment thread. Renders below the task row when expanded.
// Append-only: existing comments are read-only, new ones go through
// the textarea + Post. Author label uses the joined counsellor name
// when present; admin posts say "Admin" since there's no row to join.
function CommentsPanel({ task, comments, loading, draft, onDraftChange, onSubmit, posting }) {
  const list = comments || [];
  const canPost = draft.trim().length > 0 && !posting;
  return (
    <div className="border-t border-stone-200 bg-stone-50 px-4 py-3">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-black">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading comments…
        </div>
      ) : list.length === 0 ? (
        <p className="text-[13px]  text-black">No comments yet.</p>
      ) : (
        <ul className="mb-3 space-y-2">
          {list.map((c) => (
            <li key={c.id} className="border border-stone-200 bg-white px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-black">
                  {c.author_kind === "admin"
                    ? (adminDisplay(c.author_admin_username) || "Admin")
                    : (c.author_name || "Counsellor")}
                </span>
                <span className="text-[11px] tabular-nums text-black">
                  {formatDateInIst(c.created_at)}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[14px] leading-snug text-black">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Add a comment… (Ctrl/Cmd + Enter to post)"
          rows={2}
          className="flex-1 resize-none border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
          onKeyDown={(e) => {
            // Cmd/Ctrl + Enter posts — matches the chat-app convention
            // counsellors expect from message inputs.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canPost) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        <button
          onClick={onSubmit}
          disabled={!canPost}
          className="inline-flex shrink-0 items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {posting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Post
        </button>
      </div>
    </div>
  );
}

// Display-only chip list for a task row's assignees. Reads task.assignees
// (the multi-assignee JSON aggregate from the server) and falls back to
// the legacy single-assignee fields when the array is missing (clients
// that haven't refreshed yet, or rows with no junction record).
// Counsellor chips are click-to-impersonate when the parent passes an
// onImpersonate handler. Admin chips show a small lock icon to mark
// them as the admin inbox (matches the old single-assignee UI).
function AssigneeChips({ task, onImpersonate }) {
  const list = Array.isArray(task.assignees) && task.assignees.length > 0
    ? task.assignees
    : (task.assignee_kind === "admin" && task.assignee_admin_username)
      ? [{ kind: "admin", admin_username: task.assignee_admin_username, name: task.assignee_admin_username }]
      : (task.assignee_id && task.assignee_name)
        ? [{ kind: "counsellor", counsellor_id: task.assignee_id, name: task.assignee_name }]
        : [];
  if (list.length === 0) return <span className="text-black">Unassigned</span>;
  return (
    <>
      {list.map((a, i) => {
        if (a.kind === "admin") {
          return (
            <span
              key={`a:${a.admin_username}:${i}`}
              className="inline-flex items-center gap-1 border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-[12px] text-black"
            >
              <Lock className="h-3 w-3 shrink-0" />
              {adminDisplay(a.admin_username)}
            </span>
          );
        }
        // counsellor
        const label = a.name || a.counsellor_id;
        if (a.counsellor_id && onImpersonate) {
          return (
            <button
              key={`c:${a.counsellor_id}:${i}`}
              onClick={() => onImpersonate(a.counsellor_id)}
              title={`View as ${label}`}
              className="inline-flex items-center gap-1 border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-[12px] text-black hover:border-[#cc785c] hover:text-[#cc785c]"
            >
              {label}
            </button>
          );
        }
        return (
          <span
            key={`c:${a.counsellor_id || "?"}:${i}`}
            className="inline-flex items-center gap-1 border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-[12px] text-black"
          >
            {label}
          </span>
        );
      })}
    </>
  );
}

// Multi-assignee picker. `values` is an array of "kind:value" strings
// (e.g. ["counsellor:abc123", "admin:adminsuhas"]). Renders selected
// assignees as chips with an × button, plus an "Add assignee" dropdown
// that surfaces only the rows not yet picked.
//
// Admin view: counsellors prop = all counsellors; adminAccounts = full
//   list of EXTRA_ADMINS.
// Counsellor view: counsellors prop = [self, ...supervised]; same admin
//   list. UI shows "(you)" next to self for clarity.
function AssigneePicker({ values, onChange, counsellors, adminAccounts, isScoped, scopedCounsellorId }) {
  const selected = Array.isArray(values) ? values : [];
  const labelFor = (val) => {
    const colonIdx = val.indexOf(":");
    const kind = colonIdx >= 0 ? val.slice(0, colonIdx) : "counsellor";
    const target = colonIdx >= 0 ? val.slice(colonIdx + 1) : val;
    if (kind === "admin") return target;
    const c = counsellors.find((cc) => cc.id === target);
    if (!c) return target;
    return c.name + (isScoped && c.id === scopedCounsellorId ? " (you)" : "");
  };

  // Build the dropdown's available rows (everything not already selected).
  const remaining = [
    ...counsellors
      .filter((c) => !selected.includes(`counsellor:${c.id}`))
      .map((c) => ({
        value: `counsellor:${c.id}`,
        label: c.name + (isScoped && c.id === scopedCounsellorId ? " (you)" : ""),
        group: "counsellor",
      })),
    ...adminAccounts
      .filter((a) => !selected.includes(`admin:${a.username}`))
      .map((a) => ({
        value: `admin:${a.username}`,
        label: a.username,
        group: "admin",
      })),
  ];

  const add = (val) => {
    if (!val || selected.includes(val)) return;
    onChange([...selected, val]);
  };
  const remove = (val) => {
    onChange(selected.filter((v) => v !== val));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 border border-stone-300 bg-white px-2 py-1.5">
      {selected.length === 0 && (
        <span className="text-[12px] uppercase tracking-[0.18em] text-stone-500">No assignees yet</span>
      )}
      {selected.map((val) => (
        <span
          key={val}
          className="inline-flex items-center gap-1 border border-stone-300 bg-stone-100 px-2 py-0.5 text-[12px] text-black"
        >
          {labelFor(val)}
          <button
            type="button"
            onClick={() => remove(val)}
            title="Remove assignee"
            className="ml-0.5 text-stone-500 hover:text-red-600"
          >
            ×
          </button>
        </span>
      ))}
      {remaining.length > 0 && (
        <select
          value=""
          onChange={(e) => { add(e.target.value); e.target.value = ""; }}
          className="border-none bg-transparent px-1 py-0.5 text-[13px] text-black outline-none"
        >
          <option value="">+ Add assignee…</option>
          {remaining.filter((r) => r.group === "counsellor").map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
          {remaining.some((r) => r.group === "admin") && (
            <optgroup label="Admin">
              {remaining.filter((r) => r.group === "admin").map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </optgroup>
          )}
        </select>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-[11px] uppercase tracking-[0.15em] border transition-colors ${
        active
          ? "border-[#cc785c] bg-[#cc785c] text-white"
          : "border-stone-300 bg-white text-black hover:border-[#cc785c] hover:text-[#cc785c]"
      }`}
    >
      {label}
    </button>
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
          : "border border-stone-300 bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-black hover:border-stone-500 hover:text-black"
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
