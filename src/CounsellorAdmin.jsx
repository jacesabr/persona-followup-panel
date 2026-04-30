import { useEffect, useState } from "react";
import { Loader2, Plus, X, Check, Eye, EyeOff } from "lucide-react";
import { api } from "./api.js";

// Admin-only tab for managing counsellor accounts: list every counsellor
// with their contact + login credentials, and inline-create a new one
// with name / WhatsApp / email / username / password. Trial-mode plaintext
// passwords (toggleable show/hide for convenience).
export default function CounsellorAdmin() {
  const [counsellors, setCounsellors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealRowId, setRevealRowId] = useState(null);
  const [newC, setNewC] = useState(emptyNewCounsellor());

  const refetch = () => {
    setLoading(true);
    api
      .listCounsellors()
      .then((rows) => {
        setCounsellors(rows);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refetch();
  }, []);

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
      const created = await api.createCounsellor({
        name,
        whatsapp: whatsapp || null,
        email: email || null,
        username,
        password,
      });
      setCounsellors((prev) =>
        [...prev, created].sort((a, b) =>
          (a.name || "").localeCompare(b.name || "")
        )
      );
      setNewC(emptyNewCounsellor());
      setShowNew(false);
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

  const gridCols = "1.5fr 1fr 1.4fr 1fr 1fr";

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
          const revealed = revealRowId === c.id;
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
              <span className="truncate text-[13px] text-stone-700" title={c.email || ""}>
                {c.email || "—"}
              </span>
              <span className="text-[13px] text-stone-700">
                {c.username || (
                  <span className="italic text-stone-400">—</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-stone-700">
                  {revealed
                    ? c.password || "—"
                    : c.password
                      ? "•".repeat(Math.min(8, c.password.length))
                      : "—"}
                </span>
                {c.password && (
                  <button
                    onClick={() =>
                      setRevealRowId(revealed ? null : c.id)
                    }
                    title={revealed ? "Hide password" : "Show password"}
                    className="text-stone-500 hover:text-stone-900"
                  >
                    {revealed ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
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
