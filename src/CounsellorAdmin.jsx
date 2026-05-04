import { useEffect, useState } from "react";
import { Loader2, Plus, X, Check, KeyRound } from "lucide-react";
import { api } from "./api.js";

// Admin-only tab for managing counsellor accounts. Lists every counsellor
// with their contact + username + plaintext password (the operator
// explicitly opted in to plain-text visibility on the panel — see the
// password_plain column comment in migrate.js for the tradeoff).
// Inline actions:
//   + New counsellor — name / WhatsApp / email / username / password
//   Reset password   — opens an inline input on a row; PATCH writes the
//                      new value but the response still omits it.
//
// Counsellors prop is passed from AdminPanel (single source of truth for
// the counsellor roster). onCounsellorsChanged refetches at the parent
// level so newly created counsellors immediately appear in other tabs'
// dropdowns (the Counsellor tasks assignee picker in particular).
export default function CounsellorAdmin({
  counsellors = [],
  loading = false,
  error: externalError = null,
  onCounsellorsChanged,
}) {
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [resetRowId, setResetRowId] = useState(null);
  const [resetValue, setResetValue] = useState("");
  const [newC, setNewC] = useState(emptyNewCounsellor());

  // Surface either the parent-level fetch error or a local action error.
  const displayError = error || externalError;

  const submitNew = async () => {
    const name = newC.name.trim();
    const whatsapp = newC.whatsapp.trim();
    const email = newC.email.trim();
    const username = newC.username.trim();
    const password = newC.password;

    if (!name) return setError("Name is required.");
    if (!whatsapp && !email)
      return setError("At least one of WhatsApp or email is required.");
    if (whatsapp && !/^\d{8,15}$/.test(whatsapp))
      return setError("WhatsApp must be 8–15 digits only.");
    if (!username) return setError("Username is required.");
    if (!password) return setError("Password is required.");

    setBusy(true);
    setError(null);
    try {
      await api.createCounsellor({
        name,
        whatsapp: whatsapp || null,
        email: email || null,
        username,
        password,
      });
      // Refetch the parent-level list so the assignee dropdown in the
      // Counsellor tasks tab picks up the new counsellor without a reload.
      onCounsellorsChanged && (await onCounsellorsChanged());
      setNewC(emptyNewCounsellor());
      setShowNew(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelReset = () => {
    setResetRowId(null);
    setResetValue("");
    setError(null);
  };

  const submitReset = async (counsellorId) => {
    if (!resetValue) {
      setError("New password can't be blank.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateCounsellor(counsellorId, { password: resetValue });
      onCounsellorsChanged && (await onCounsellorsChanged());
      cancelReset();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-stone-600">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const gridCols = "1.5fr 1fr 1.4fr 1fr 1.2fr";

  return (
    <>
      <div className="mb-4 flex items-center justify-between border-b border-stone-300 pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Counsellors</h2>
          <span className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            {counsellors.length}{" "}
            {counsellors.length === 1 ? "counsellor" : "counsellors"}
          </span>
        </div>
        {!showNew && (
          <button
            onClick={() => {
              setNewC(emptyNewCounsellor());
              setShowNew(true);
              setError(null);
            }}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f]"
          >
            <Plus className="h-3 w-3" /> New counsellor
          </button>
        )}
      </div>

      {displayError && (
        <div className="mb-3 border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800">
          {displayError}
        </div>
      )}

      <div className="border border-stone-300 bg-white">
        <div
          className="grid items-center gap-3 border-b border-stone-300 bg-stone-100 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-700"
          style={{ gridTemplateColumns: gridCols }}
        >
          <span className="whitespace-nowrap">Name</span>
          <span className="whitespace-nowrap">WhatsApp</span>
          <span className="whitespace-nowrap">Email</span>
          <span className="whitespace-nowrap">Username</span>
          <span className="whitespace-nowrap">Password</span>
        </div>

        {showNew && (
          <div
            className="grid items-start gap-3 border-b-2 border-[#cc785c] bg-[#cc785c]/5 px-4 py-3 text-[14px] text-stone-800"
            style={{ gridTemplateColumns: gridCols }}
          >
            <input
              type="text"
              placeholder="Full name *"
              value={newC.name}
              onChange={(e) => setNewC((p) => ({ ...p, name: e.target.value }))}
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
              autoFocus
            />
            <input
              type="tel"
              placeholder="WhatsApp digits"
              value={newC.whatsapp}
              onChange={(e) =>
                setNewC((p) => ({
                  ...p,
                  whatsapp: e.target.value.replace(/\D/g, ""),
                }))
              }
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] tabular-nums outline-none focus:border-[#cc785c]"
            />
            <input
              type="email"
              placeholder="Email"
              value={newC.email}
              onChange={(e) => setNewC((p) => ({ ...p, email: e.target.value }))}
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
            />
            <input
              type="text"
              placeholder="Username *"
              value={newC.username}
              onChange={(e) =>
                setNewC((p) => ({ ...p, username: e.target.value }))
              }
              autoComplete="off"
              className="border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
            />
            <span className="flex items-center gap-1.5">
              <input
                type="text"
                placeholder="Password *"
                value={newC.password}
                onChange={(e) =>
                  setNewC((p) => ({ ...p, password: e.target.value }))
                }
                autoComplete="new-password"
                className="min-w-0 flex-1 border border-stone-300 bg-white px-2 py-1.5 text-[14px] outline-none focus:border-[#cc785c]"
              />
              <button
                onClick={submitNew}
                disabled={busy}
                title="Save"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={() => {
                  setShowNew(false);
                  setNewC(emptyNewCounsellor());
                  setError(null);
                }}
                disabled={busy}
                title="Cancel"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-stone-300 bg-white text-stone-600 hover:border-stone-500 hover:text-stone-900 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}

        {counsellors.length === 0 && !showNew && (
          <p className="py-10 text-center text-sm italic text-stone-600">
            No counsellors yet. Click "+ New counsellor" to add one.
          </p>
        )}

        {counsellors.map((c) => {
          const isResetting = resetRowId === c.id;
          return (
            <div
              key={c.id}
              className="grid items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5 last:border-b-0 hover:bg-stone-50"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span className="font-semibold text-stone-900">{c.name}</span>
              <span className="text-[13px] tabular-nums text-stone-700">
                {c.whatsapp || "—"}
              </span>
              <span
                className="truncate text-[13px] text-stone-700"
                title={c.email || ""}
              >
                {c.email || "—"}
              </span>
              <span className="text-[13px] text-stone-700">
                {c.username || (
                  <span className="italic text-stone-400">—</span>
                )}
              </span>
              <span className="flex items-center gap-1.5">
                {isResetting ? (
                  <>
                    <input
                      type="text"
                      placeholder="New password"
                      value={resetValue}
                      onChange={(e) => setResetValue(e.target.value)}
                      autoComplete="off"
                      autoFocus
                      className="min-w-0 flex-1 border border-stone-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-[#cc785c]"
                    />
                    <button
                      onClick={() => submitReset(c.id)}
                      disabled={busy}
                      title="Save new password"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-[#cc785c] bg-[#cc785c] text-white hover:bg-[#b86a4f] disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      onClick={cancelReset}
                      disabled={busy}
                      title="Cancel"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-stone-300 bg-white text-stone-600 hover:border-stone-500 hover:text-stone-900 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <>
                    {/* Plain-text password from password_plain column.
                        Legacy rows that pre-date the column show "—"
                        until they log in once or admin resets. */}
                    <span
                      className="select-all truncate font-mono text-[13px] text-stone-800"
                      title={c.password_plain || ""}
                    >
                      {c.password_plain || (
                        <span className="italic text-stone-400">—</span>
                      )}
                    </span>
                    <button
                      onClick={() => {
                        setResetRowId(c.id);
                        setResetValue("");
                        setError(null);
                      }}
                      title="Reset password"
                      className="inline-flex shrink-0 items-center gap-1 border border-stone-300 bg-white px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:border-[#cc785c] hover:text-[#cc785c]"
                    >
                      <KeyRound className="h-3 w-3" /> Reset
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function emptyNewCounsellor() {
  return {
    name: "",
    whatsapp: "",
    email: "",
    username: "",
    password: "",
  };
}
