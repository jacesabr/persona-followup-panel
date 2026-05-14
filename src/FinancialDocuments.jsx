// Financial dossier — post-intake panel tab. Captures ITRs, income
// proofs, business docs, KYC, sponsor affidavits, banking + travel
// history. Uploads land in intake_files under a `fin_*` field_id
// namespace; structured metadata (people lists, toggles, travel rows,
// bank manager contact, free-text notes) lives in the
// intake_financial_dossier jsonb. Same optimistic-concurrency model
// as the intake form's /me/record path.
//
// Field-id convention (kept under the 40-char server regex):
//   fin_itr_<pid>_fy1 / fy2 / fy3
//   fin_income_<pid>_slips           (multi-row via row_index)
//   fin_income_<pid>_empLetter / form16
//   fin_business_<pid>_registration / gst / bs1 / bs2 / bs3
//   fin_business_<pid>_other         (multi-row, up to 4)
//   fin_kyc_fatherPan / fatherAadhar / motherPan / motherAadhar
//   fin_kyc_addPan / addAadhar       (when kycAdditional)
//   fin_loan_sanction / disbursal
//   fin_networth_<pid>
//   fin_affidavit_<pid>
//   fin_banking_savings1 / savings2 / fdCopies / fdCert /
//                balanceCert / bizStatement / bizBalanceCert
//
// Person IDs are generated client-side as `p` + 6 random chars; this
// keeps the field ID under the regex cap on the worst-case slot
// (`fin_business_pXXXXXX_registration` is 33 chars).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Upload, X, Check, AlertCircle } from "lucide-react";
import {
  loadFinancial,
  loadStaffFinancial,
  saveFinancial,
  uploadFile,
  validateFile,
  humanSize,
} from "./intakeFiles.js";

const RELATIONSHIPS = [
  "Father",
  "Mother",
  "Grandfather",
  "Grandmother",
  "Maternal Uncle",
  "Paternal Uncle",
  "Maternal Aunt",
  "Paternal Aunt",
  "Brother",
  "Sister",
  "Other",
];

// Default state shape. Mirrors the HTML reference but the persisted
// dossier may be partial — anything missing falls back here.
const DEFAULT_DOSSIER = {
  studentLoanTaken: false,
  kycAdditional: false,
  bankManager: { card: "", email: "", phone: "" },
  itrPeople: [],
  incomePeople: [],
  businessPeople: [],
  networthPeople: [],
  affidavitPeople: [],
  travelTrips: [],
};

const PEOPLE_KEYS = [
  "itrPeople",
  "incomePeople",
  "businessPeople",
  "networthPeople",
  "affidavitPeople",
];

function normaliseDossier(d) {
  const out = { ...DEFAULT_DOSSIER, ...(d || {}) };
  out.bankManager = { ...DEFAULT_DOSSIER.bankManager, ...(out.bankManager || {}) };
  PEOPLE_KEYS.forEach((k) => {
    if (!Array.isArray(out[k])) out[k] = [];
  });
  if (!Array.isArray(out.travelTrips)) out.travelTrips = [];
  return out;
}

function uid(prefix = "p") {
  // 6 chars from [0-9a-z] keeps the server field_id under the 40-char
  // cap even on the longest slot (`fin_business_p123456_registration`).
  return prefix + Math.random().toString(36).slice(2, 8);
}

function currentFY() {
  const now = new Date();
  const yr = now.getFullYear();
  const m = now.getMonth();
  // Indian financial year flips on April 1. If we're past April, the
  // "last filed" FY ended in March of this year; otherwise it ended in
  // March of the previous year.
  const latest = m >= 3 ? yr : yr - 1;
  const fy = (y) => `FY ${y - 1}–${String(y).slice(-2)}`;
  return { y1: fy(latest), y2: fy(latest - 1), y3: fy(latest - 2) };
}

// Lookup helpers over the flat files-by-fieldId map. Multi-row slots
// (salary slips, business other) live under "<fieldId>:<rowIndex>" so
// the same lookup handles both.
function fileKey(fieldId, rowIndex) {
  return rowIndex != null ? `${fieldId}:${rowIndex}` : fieldId;
}
function getFile(filesMap, fieldId, rowIndex) {
  return filesMap[fileKey(fieldId, rowIndex)] || null;
}
function getMultiFiles(filesMap, fieldId) {
  return Object.entries(filesMap)
    .filter(([k]) => k.startsWith(fieldId + ":"))
    .map(([k, v]) => ({ ...v, rowIndex: Number(k.split(":").pop()) }))
    .sort((a, b) => a.rowIndex - b.rowIndex);
}
function nextMultiIndex(filesMap, fieldId) {
  const used = getMultiFiles(filesMap, fieldId).map((f) => f.rowIndex);
  for (let i = 0; i < 50; i++) if (!used.includes(i)) return i;
  return used.length;
}

// ---------- progress calc ----------
function progressFor(dossier, filesMap, sectionId) {
  const has = (fid, ri) => !!getFile(filesMap, fid, ri);
  const hasAny = (fid) => getMultiFiles(filesMap, fid).length > 0;
  switch (sectionId) {
    case "itr": {
      let total = 0, filled = 0;
      dossier.itrPeople.forEach((p) => {
        ["fy1", "fy2", "fy3"].forEach((yr) => {
          total++;
          if (has(`fin_itr_${p.id}_${yr}`)) filled++;
        });
      });
      return { filled, total };
    }
    case "income": {
      let total = 0, filled = 0;
      dossier.incomePeople.forEach((p) => {
        total += 3;
        if (hasAny(`fin_income_${p.id}_slips`)) filled++;
        if (has(`fin_income_${p.id}_empLetter`)) filled++;
        if (has(`fin_income_${p.id}_form16`)) filled++;
      });
      return { filled, total };
    }
    case "business": {
      let total = 0, filled = 0;
      dossier.businessPeople.forEach((p) => {
        total += 5;
        ["registration", "gst", "bs1", "bs2", "bs3"].forEach((k) => {
          if (has(`fin_business_${p.id}_${k}`)) filled++;
        });
      });
      return { filled, total };
    }
    case "kyc": {
      const total = 4 + (dossier.kycAdditional ? 2 : 0);
      let filled = 0;
      ["fatherPan", "fatherAadhar", "motherPan", "motherAadhar"].forEach((k) => {
        if (has(`fin_kyc_${k}`)) filled++;
      });
      if (dossier.kycAdditional) {
        if (has(`fin_kyc_addPan`)) filled++;
        if (has(`fin_kyc_addAadhar`)) filled++;
      }
      return { filled, total };
    }
    case "loan": {
      if (!dossier.studentLoanTaken) return { filled: 0, total: 0, na: true };
      let filled = 0;
      if (has(`fin_loan_sanction`)) filled++;
      if (has(`fin_loan_disbursal`)) filled++;
      return { filled, total: 2 };
    }
    case "networth": {
      const total = dossier.networthPeople.length;
      let filled = 0;
      dossier.networthPeople.forEach((p) => {
        if (has(`fin_networth_${p.id}`)) filled++;
      });
      return { filled, total };
    }
    case "affidavit": {
      const total = dossier.affidavitPeople.length;
      let filled = 0;
      dossier.affidavitPeople.forEach((p) => {
        if (has(`fin_affidavit_${p.id}`)) filled++;
      });
      return { filled, total };
    }
    case "banking": {
      let total = 10, filled = 0;
      [
        "savings1",
        "savings2",
        "fdCopies",
        "fdCert",
        "balanceCert",
        "bizStatement",
        "bizBalanceCert",
      ].forEach((k) => {
        if (has(`fin_banking_${k}`)) filled++;
      });
      if (dossier.bankManager.card) filled++;
      if (dossier.bankManager.email) filled++;
      if (dossier.bankManager.phone) filled++;
      return { filled, total };
    }
    case "travel": {
      const trips = dossier.travelTrips.length;
      return { filled: trips, total: Math.max(trips, 1), trips };
    }
    default:
      return { filled: 0, total: 0 };
  }
}

function overallProgress(dossier, filesMap) {
  const ids = [
    "itr",
    "income",
    "business",
    "kyc",
    "loan",
    "networth",
    "affidavit",
    "banking",
    "travel",
  ];
  let f = 0, t = 0;
  ids.forEach((id) => {
    const p = progressFor(dossier, filesMap, id);
    if (p.na) return;
    f += p.filled;
    t += p.total;
  });
  return { filled: f, total: t, pct: t === 0 ? 0 : Math.round((f / t) * 100) };
}

// ---------- main component ----------
// When `studentId` is provided, the panel renders in staff read-only
// mode: hits the staff GET endpoint scoped by student_id, skips all
// persistence, and hides every upload / add / remove / toggle / input
// control so reviewers see exactly what the student uploaded without
// any way to mutate it.
export default function FinancialDocuments({ studentId = null } = {}) {
  const readOnly = !!studentId;
  const [dossier, setDossier] = useState(DEFAULT_DOSSIER);
  const [filesMap, setFilesMap] = useState({});
  const [hydration, setHydration] = useState("loading");
  const [saveState, setSaveState] = useState("idle");
  const [error, setError] = useState(null);
  const dossierRef = useRef(dossier);
  const expectedUpdatedAtRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    dossierRef.current = dossier;
  }, [dossier]);

  // Hydrate once on mount. The endpoint returns both the dossier and the
  // active financial-file list so we can paint the green-tick UI without
  // a second round-trip.
  useEffect(() => {
    let cancelled = false;
    const loader = studentId ? loadStaffFinancial(studentId) : loadFinancial();
    loader
      .then((body) => {
        if (cancelled) return;
        const d = normaliseDossier(body?.dossier);
        const map = {};
        (body?.files || []).forEach((f) => {
          map[fileKey(f.fieldId, f.rowIndex)] = f;
        });
        setDossier(d);
        setFilesMap(map);
        expectedUpdatedAtRef.current = body?.updatedAt || null;
        setHydration("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message);
        setHydration("error");
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  // Persist dossier (jsonb), debounced. Server is the source of truth
  // for updated_at; we keep its echo for the next save's precondition.
  const persist = useCallback(async () => {
    setSaveState("saving");
    try {
      const res = await saveFinancial({
        data: dossierRef.current,
        expectedUpdatedAt: expectedUpdatedAtRef.current,
      });
      expectedUpdatedAtRef.current = res?.updatedAt || expectedUpdatedAtRef.current;
      setSaveState("saved");
    } catch (e) {
      if (e?.code === "STALE_WRITE" && e?.latest) {
        // Merge: server's latest wins for keys we didn't touch; our
        // in-memory edits win for everything else. Cheap heuristic
        // (last-write-wins per field) — same model the intake form uses.
        const merged = { ...e.latest.data, ...dossierRef.current };
        dossierRef.current = merged;
        setDossier(merged);
        expectedUpdatedAtRef.current = e.latest.updatedAt;
        try {
          const res = await saveFinancial({
            data: dossierRef.current,
            expectedUpdatedAt: expectedUpdatedAtRef.current,
          });
          expectedUpdatedAtRef.current = res?.updatedAt || expectedUpdatedAtRef.current;
          setSaveState("saved");
        } catch (e2) {
          console.warn("[financial] retry after 409 failed:", e2.message);
          setSaveState("error");
        }
      } else {
        console.warn("[financial] save failed:", e.message);
        setSaveState("error");
      }
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (readOnly) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => persist(), 1200);
  }, [persist, readOnly]);

  const updateDossier = useCallback(
    (mutator) => {
      if (readOnly) return;
      setDossier((prev) => {
        const next = typeof mutator === "function" ? mutator(prev) : { ...prev, ...mutator };
        dossierRef.current = next;
        return next;
      });
      scheduleSave();
    },
    [scheduleSave, readOnly]
  );

  // Upload helper — runs validation, hits /me/upload, then registers the
  // returned file row in the local map so the slot flips to "uploaded"
  // without a refetch.
  const handleUpload = useCallback(
    async (file, fieldId, rowIndex = null) => {
      if (readOnly) return;
      const v = await validateFile(file, {
        accept: "image/jpeg,image/png,application/pdf",
        maxSizeMB: 10,
      });
      if (!v.ok) {
        alert(v.error);
        return;
      }
      try {
        const { fileId, url, uploadedAt } = await uploadFile(file, {
          fieldId,
          rowIndex,
          accept: "image/jpeg,image/png,application/pdf",
        });
        setFilesMap((m) => ({
          ...m,
          [fileKey(fieldId, rowIndex)]: {
            id: fileId,
            fieldId,
            rowIndex,
            name: file.name,
            size: file.size,
            mime: file.type,
            url: url || `/api/students/me/files/${fileId}`,
            uploadedAt,
          },
        }));
      } catch (e) {
        alert(e.message || "Upload failed.");
      }
    },
    [readOnly]
  );

  // No DELETE endpoint exists for financial slots yet. Removing a row
  // here clears the local-map entry so the UI shows the empty state and
  // a re-upload supersedes the server row via the existing per-slot
  // unique-index path. The old blob lingers on R2 (durable by policy)
  // but is no longer the active row.
  const handleClearLocal = useCallback((fieldId, rowIndex = null) => {
    if (readOnly) return;
    setFilesMap((m) => {
      const next = { ...m };
      delete next[fileKey(fieldId, rowIndex)];
      return next;
    });
  }, [readOnly]);

  if (hydration === "loading") {
    return (
      <div className="flex items-center justify-center py-16 text-stone-800">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (hydration === "error") {
    return (
      <div className="border border-rose-400/40 bg-rose-50 p-6 text-sm text-rose-900">
        <AlertCircle className="mb-2 h-5 w-5" />
        Couldn't load your financial dossier: {error}
      </div>
    );
  }

  const overall = overallProgress(dossier, filesMap);
  return (
    <div className="space-y-12 font-serif text-black">
      <Header overall={overall} saveState={saveState} readOnly={readOnly} />
      <TOC dossier={dossier} filesMap={filesMap} />
      <ITRSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <IncomeSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <BusinessSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <KYCSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <LoanSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <NetworthSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <AffidavitSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <BankingSection
        dossier={dossier}
        filesMap={filesMap}
        updateDossier={updateDossier}
        handleUpload={handleUpload}
        handleClearLocal={handleClearLocal}
        readOnly={readOnly}
      />
      <TravelSection dossier={dossier} updateDossier={updateDossier} readOnly={readOnly} />
    </div>
  );
}

// ---------- header ----------
function Header({ overall, saveState, readOnly }) {
  const saveLabel =
    saveState === "saving"
      ? "saving…"
      : saveState === "saved"
      ? "saved"
      : saveState === "error"
      ? "save error"
      : "";
  return (
    <header className="border-b border-stone-900/15 pb-6">
      <p className="text-[10px] uppercase tracking-[0.3em] text-black">
        ▸ Financial documents
      </p>
      <h1 className="mt-2 font-serif text-3xl leading-tight md:text-4xl">
        {readOnly ? "Student's financial dossier" : "Your financial dossier"}
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-stone-800">
        {readOnly
          ? "Read-only review of what the student has uploaded so far. Click any document to open it."
          : "Upload every document we'll need for the visa and university financial review. The more complete this is, the smoother the rest of the application — incomplete dossiers are the single biggest reason a file stalls before submission."}
      </p>
      <div className="mt-5 flex items-baseline gap-3">
        <span className="font-serif text-2xl text-[#cc785c]">{overall.pct}%</span>
        <span className="text-[10px] uppercase tracking-[0.25em] text-stone-800">complete</span>
        {!readOnly && saveLabel && (
          <span className="ml-3 text-[10px] uppercase tracking-[0.2em] text-stone-800">
            · {saveLabel}
          </span>
        )}
      </div>
    </header>
  );
}

// ---------- TOC ----------
function TOC({ dossier, filesMap }) {
  const sections = [
    { id: "itr", num: "01", name: "ITRs", aside: "Income Tax Returns" },
    { id: "income", num: "02", name: "Income proof", aside: "salaried" },
    { id: "business", num: "03", name: "Proof of business", aside: "self-employed" },
    { id: "kyc", num: "04", name: "Parents KYC", aside: "" },
    { id: "loan", num: "05", name: "Student loan", aside: "if applicable" },
    { id: "networth", num: "06", name: "Net worth", aside: "" },
    { id: "affidavit", num: "07", name: "Sponsor affidavits", aside: "" },
    { id: "banking", num: "08", name: "Banking", aside: "" },
    { id: "travel", num: "09", name: "Travel history", aside: "student, 10 yrs" },
  ];
  return (
    <nav className="border border-stone-900/15 bg-white/40 p-6">
      <p className="mb-4 text-[10px] uppercase tracking-[0.3em] text-black">Contents</p>
      <ul className="grid gap-2 md:grid-cols-2 md:gap-x-12">
        {sections.map((s) => {
          const p = progressFor(dossier, filesMap, s.id);
          let status, cls = "text-stone-800";
          if (p.na) status = "n/a";
          else if (s.id === "travel") {
            status = `${p.trips} trip${p.trips === 1 ? "" : "s"}`;
            cls = p.trips > 0 ? "text-[#cc785c]" : "text-stone-800";
          } else if (p.total === 0) status = "—";
          else if (p.filled === p.total) {
            status = "Complete";
            cls = "text-emerald-700";
          } else if (p.filled > 0) {
            status = `${p.filled} / ${p.total}`;
            cls = "text-[#cc785c]";
          } else status = `0 / ${p.total}`;
          return (
            <li key={s.id}>
              <a
                href={`#fin-${s.id}`}
                className="flex items-baseline gap-3 py-1 text-sm hover:text-[#cc785c]"
              >
                <span className="w-6 text-stone-800">{s.num}</span>
                <span className="font-medium">{s.name}</span>
                <span className="flex-1 border-b border-dotted border-stone-300" />
                <span className={`text-xs tabular-nums ${cls}`}>{status}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------- shared chrome ----------
function SectionShell({ id, num, title, aside, note, status, children }) {
  return (
    <section id={`fin-${id}`} className="border-t border-stone-900/10 pt-10">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <span className="text-xs uppercase tracking-[0.25em] text-stone-800 tabular-nums">
          {num}
        </span>
        <h2 className="flex-1 font-serif text-2xl md:text-3xl">
          {title}
          {aside && (
            <span className="ml-2 text-base font-normal italic text-stone-800">
              — {aside}
            </span>
          )}
        </h2>
        {status && <StatusPill p={status} />}
      </div>
      {note && <p className="mb-6 max-w-2xl text-sm text-stone-800">{note}</p>}
      {children}
    </section>
  );
}

function StatusPill({ p }) {
  let cls = "border-stone-300 bg-stone-50 text-stone-800";
  let label = "—";
  if (p.na) {
    label = "n/a";
  } else if (p.trips != null) {
    if (p.trips > 0) {
      label = `${p.trips} trip${p.trips === 1 ? "" : "s"}`;
      cls = "border-[#cc785c]/40 bg-[#cc785c]/10 text-[#cc785c]";
    }
  } else if (p.total === 0) {
    label = "—";
  } else if (p.filled === p.total) {
    label = "Complete";
    cls = "border-emerald-600/30 bg-emerald-50 text-emerald-800";
  } else if (p.filled > 0) {
    label = `${p.filled} / ${p.total}`;
    cls = "border-[#cc785c]/40 bg-[#cc785c]/10 text-[#cc785c]";
  } else {
    label = `0 / ${p.total}`;
  }
  return (
    <span className={`inline-flex shrink-0 items-center border px-3 py-1 text-[11px] uppercase tracking-[0.15em] ${cls}`}>
      {label}
    </span>
  );
}

function UploadBox({ tag, title, hint, file, onUpload, onClear, optional, readOnly }) {
  const inputRef = useRef(null);
  return (
    <div
      className={`flex min-h-[110px] flex-col border p-4 ${
        file
          ? "border-emerald-500/40 bg-emerald-50/60"
          : optional
          ? "border-dashed border-stone-300 bg-white/50"
          : "border-stone-300 bg-white/50"
      }`}
    >
      <div
        className={`text-[10px] font-semibold uppercase tracking-[0.15em] ${
          file ? "text-emerald-700" : optional ? "text-stone-500" : "text-stone-700"
        }`}
      >
        {file ? "✓ Uploaded" : tag}
      </div>
      <div className="mt-1 text-sm font-medium text-black">{title}</div>
      {hint && <div className="mt-1 text-xs leading-snug text-stone-800">{hint}</div>}
      <div className="mt-auto pt-3">
        {file ? (
          <div className="flex items-center gap-2 border border-emerald-600/30 bg-white px-3 py-2 text-xs">
            <Check className="h-4 w-4 shrink-0 text-emerald-700" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-black">{file.name}</div>
              <div className="text-[11px] text-stone-800">{humanSize(file.size)}</div>
            </div>
            <a
              href={file.url}
              target="_blank"
              rel="noreferrer"
              className="text-stone-800 hover:text-[#cc785c]"
              title="Open"
            >
              ↗
            </a>
            {!readOnly && (
              <button
                type="button"
                onClick={onClear}
                className="text-stone-800 hover:text-[#cc785c]"
                title="Replace"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ) : readOnly ? (
          <div className="border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-800">
            Not uploaded
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full items-center gap-2 border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-stone-800 hover:border-[#cc785c] hover:text-[#cc785c]"
          >
            <Plus className="h-3.5 w-3.5" /> Upload document
          </button>
        )}
        {!readOnly && (
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (f) onUpload(f);
              e.target.value = "";
            }}
          />
        )}
      </div>
    </div>
  );
}

function MultiUploadBox({ tag, title, hint, files, onUpload, onClear, readOnly }) {
  const inputRef = useRef(null);
  return (
    <div
      className={`flex min-h-[110px] flex-col border p-4 ${
        files.length > 0 ? "border-emerald-500/40 bg-emerald-50/60" : "border-stone-300 bg-white/50"
      }`}
    >
      <div
        className={`text-[10px] font-semibold uppercase tracking-[0.15em] ${
          files.length > 0 ? "text-emerald-700" : "text-stone-700"
        }`}
      >
        {files.length > 0 ? `✓ ${files.length} added` : tag}
      </div>
      <div className="mt-1 text-sm font-medium text-black">{title}</div>
      {hint && <div className="mt-1 text-xs leading-snug text-stone-800">{hint}</div>}
      <div className="mt-auto pt-3 space-y-1.5">
        {files.map((f) => (
          <div
            key={f.id}
            className="flex items-center gap-2 border border-emerald-600/30 bg-white px-3 py-1.5 text-xs"
          >
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-black">{f.name}</div>
              <div className="text-[11px] text-stone-800">{humanSize(f.size)}</div>
            </div>
            <a
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className="text-stone-800 hover:text-[#cc785c]"
            >
              ↗
            </a>
            {!readOnly && (
              <button
                type="button"
                onClick={() => onClear(f.rowIndex)}
                className="text-stone-800 hover:text-[#cc785c]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
        {readOnly ? (
          files.length === 0 && (
            <div className="border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-800">
              Not uploaded
            </div>
          )
        ) : (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-1 border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:border-[#cc785c] hover:text-[#cc785c]"
            >
              <Plus className="h-3.5 w-3.5" />
              {files.length > 0 ? "Add another" : "Upload"}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (f) onUpload(f);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function PersonBlock({ peopleKey, person, onChange, onRemove, readOnly, children }) {
  return (
    <div className="mb-5 border border-stone-200 bg-white/60 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-stone-200 pb-3">
        {readOnly ? (
          <>
            <span className="font-serif text-base font-medium text-black">
              {person.name || "(name not entered)"}
            </span>
            <span className="text-sm text-stone-800">
              {person.relationship || "Father"}
            </span>
          </>
        ) : (
          <>
            <input
              type="text"
              value={person.name}
              placeholder="Name"
              onChange={(e) =>
                onChange({ ...person, name: e.target.value })
              }
              className="border-b border-dashed border-stone-300 bg-transparent px-1 py-0.5 font-serif text-base font-medium text-black outline-none focus:border-[#cc785c]"
            />
            <select
              value={person.relationship || "Father"}
              onChange={(e) => onChange({ ...person, relationship: e.target.value })}
              className="border-b border-transparent bg-transparent text-sm text-stone-800 outline-none hover:border-stone-300"
            >
              {RELATIONSHIPS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={onRemove}
              className="ml-auto text-stone-500 hover:text-[#cc785c]"
              title="Remove person"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
      {children}
    </div>
  );
}

function AddPersonRow({ peopleKey, label, count, onAdd, readOnly }) {
  if (readOnly) return null;
  if (count >= 8) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 border border-stone-200 bg-white/60 px-4 py-3 text-sm">
      <span className="flex-1 text-stone-800">
        Add {count === 0 ? "a" : "another"} <em className="not-italic font-medium text-black">{label}</em>
        {count > 0 && (
          <span className="ml-2 text-stone-600">— {count} added</span>
        )}
      </span>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1 border border-stone-900 bg-stone-900 px-3 py-1.5 text-xs uppercase tracking-[0.2em] text-white hover:bg-stone-800"
      >
        <Plus className="h-3.5 w-3.5" /> Add
      </button>
    </div>
  );
}

function EmptyPersonBlock({ label }) {
  return (
    <div className="mb-3 border border-dashed border-stone-300 bg-stone-50/50 px-5 py-6 text-center text-sm text-stone-800">
      <strong className="block font-serif text-base font-medium text-black">
        No {label}s added yet
      </strong>
      Use the toggle below to add one.
    </div>
  );
}

function TogglePill({ value, options, onChange, readOnly }) {
  if (readOnly) {
    const active = options.find((opt) => opt.value === value);
    return (
      <span className="inline-flex items-center border border-stone-300 bg-stone-100 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-900">
        {active?.label || "—"}
      </span>
    );
  }
  return (
    <div className="inline-flex items-center border border-stone-300 bg-stone-100 p-0.5">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.15em] ${
              active ? "bg-stone-900 text-white" : "text-stone-700 hover:text-stone-900"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- people-list helpers, used by every per-person section ----------
function makePersonOps(peopleKey, dossier, updateDossier) {
  const list = dossier[peopleKey] || [];
  const update = (id, next) => {
    updateDossier((d) => ({
      ...d,
      [peopleKey]: d[peopleKey].map((p) => (p.id === id ? next : p)),
    }));
  };
  const remove = (id) => {
    updateDossier((d) => ({
      ...d,
      [peopleKey]: d[peopleKey].filter((p) => p.id !== id),
    }));
  };
  const add = (defaults = {}) => {
    updateDossier((d) => ({
      ...d,
      [peopleKey]: [
        ...d[peopleKey],
        { id: uid(), name: "", relationship: "Father", ...defaults },
      ],
    }));
  };
  return { list, update, remove, add };
}

// ---------- 01 ITRs ----------
function ITRSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const ops = makePersonOps("itrPeople", dossier, updateDossier);
  const fy = currentFY();
  const p = progressFor(dossier, filesMap, "itr");
  return (
    <SectionShell
      id="itr"
      num="01"
      title="ITRs"
      aside="Income Tax Returns"
      status={p}
      note="Three years of returns for each person providing them. Add as many filers as needed — this list is independent of the other sections."
    >
      {ops.list.length === 0 ? (
        <EmptyPersonBlock label="filer" />
      ) : (
        ops.list.map((person) => (
          <PersonBlock
            key={person.id}
            peopleKey="itrPeople"
            person={person}
            onChange={(next) => ops.update(person.id, next)}
            onRemove={() => ops.remove(person.id)}
            readOnly={readOnly}
          >
            <div className="grid gap-3 md:grid-cols-3">
              {[
                { slot: "fy1", tag: fy.y1, title: "Last year", hint: "Latest filed return" },
                { slot: "fy2", tag: fy.y2, title: "Year before", hint: "One year prior" },
                { slot: "fy3", tag: fy.y3, title: "Three years ago", hint: "Two years prior" },
              ].map((s) => {
                const fid = `fin_itr_${person.id}_${s.slot}`;
                return (
                  <UploadBox
                    key={s.slot}
                    tag={s.tag}
                    title={s.title}
                    hint={s.hint}
                    file={getFile(filesMap, fid)}
                    onUpload={(f) => handleUpload(f, fid)}
                    onClear={() => handleClearLocal(fid)}
                    readOnly={readOnly}
                  />
                );
              })}
            </div>
          </PersonBlock>
        ))
      )}
      <AddPersonRow peopleKey="itrPeople" label="filer" count={ops.list.length} onAdd={() => ops.add()} readOnly={readOnly} />
    </SectionShell>
  );
}

// ---------- 02 Income ----------
function IncomeSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const ops = makePersonOps("incomePeople", dossier, updateDossier);
  const p = progressFor(dossier, filesMap, "income");
  return (
    <SectionShell
      id="income"
      num="02"
      title="Income proof"
      aside="for those with a job"
      status={p}
      note="Salary slips (last 3 months), employment letter, Form 16 — per salaried person."
    >
      {ops.list.length === 0 ? (
        <EmptyPersonBlock label="salaried person" />
      ) : (
        ops.list.map((person) => {
          const slipsFid = `fin_income_${person.id}_slips`;
          const empFid = `fin_income_${person.id}_empLetter`;
          const form16Fid = `fin_income_${person.id}_form16`;
          const slipFiles = getMultiFiles(filesMap, slipsFid);
          return (
            <PersonBlock
              key={person.id}
              peopleKey="incomePeople"
              person={person}
              onChange={(next) => ops.update(person.id, next)}
              onRemove={() => ops.remove(person.id)}
              readOnly={readOnly}
            >
              <div className="grid gap-3 md:grid-cols-3">
                <MultiUploadBox
                  tag="3 months min"
                  title="Salary slips"
                  hint="Latest three months at minimum"
                  files={slipFiles}
                  onUpload={(f) =>
                    handleUpload(f, slipsFid, nextMultiIndex(filesMap, slipsFid))
                  }
                  onClear={(idx) => handleClearLocal(slipsFid, idx)}
                  readOnly={readOnly}
                />
                <UploadBox
                  tag="Required"
                  title="Employment letter"
                  hint="On company letterhead"
                  file={getFile(filesMap, empFid)}
                  onUpload={(f) => handleUpload(f, empFid)}
                  onClear={() => handleClearLocal(empFid)}
                  readOnly={readOnly}
                />
                <UploadBox
                  tag="Latest AY"
                  title="Form 16"
                  hint="Most recent assessment year"
                  file={getFile(filesMap, form16Fid)}
                  onUpload={(f) => handleUpload(f, form16Fid)}
                  onClear={() => handleClearLocal(form16Fid)}
                  readOnly={readOnly}
                />
              </div>
            </PersonBlock>
          );
        })
      )}
      <AddPersonRow
        peopleKey="incomePeople"
        label="salaried person"
        count={ops.list.length}
        onAdd={() => ops.add()}
        readOnly={readOnly}
      />
    </SectionShell>
  );
}

// ---------- 03 Business ----------
function BusinessSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const ops = makePersonOps("businessPeople", dossier, updateDossier);
  const p = progressFor(dossier, filesMap, "business");
  return (
    <SectionShell
      id="business"
      num="03"
      title="Proof of business"
      aside="for those self-employed"
      status={p}
      note="Registration, GST, three years of balance sheets, plus optional supporting docs — per self-employed person."
    >
      {ops.list.length === 0 ? (
        <EmptyPersonBlock label="self-employed person" />
      ) : (
        ops.list.map((person) => {
          const otherFid = `fin_business_${person.id}_other`;
          const otherFiles = getMultiFiles(filesMap, otherFid);
          return (
            <PersonBlock
              key={person.id}
              peopleKey="businessPeople"
              person={person}
              onChange={(next) => ops.update(person.id, next)}
              onRemove={() => ops.remove(person.id)}
              readOnly={readOnly}
            >
              <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">
                Registration & GST
              </p>
              <div className="mb-5 grid gap-3 md:grid-cols-2">
                {[
                  { slot: "registration", title: "Business registration", hint: "MoA, Udyam, or partnership deed" },
                  { slot: "gst", title: "GST certificate", hint: "GSTIN registration" },
                ].map((s) => {
                  const fid = `fin_business_${person.id}_${s.slot}`;
                  return (
                    <UploadBox
                      key={s.slot}
                      tag="Required"
                      title={s.title}
                      hint={s.hint}
                      file={getFile(filesMap, fid)}
                      onUpload={(f) => handleUpload(f, fid)}
                      onClear={() => handleClearLocal(fid)}
                      readOnly={readOnly}
                    />
                  );
                })}
              </div>
              <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">
                Balance sheets — last 3 years
              </p>
              <div className="mb-5 grid gap-3 md:grid-cols-3">
                {[
                  { slot: "bs1", tag: "Year 1", title: "Most recent", hint: "Audited, CA-signed" },
                  { slot: "bs2", tag: "Year 2", title: "Year before" },
                  { slot: "bs3", tag: "Year 3", title: "Two years before" },
                ].map((s) => {
                  const fid = `fin_business_${person.id}_${s.slot}`;
                  return (
                    <UploadBox
                      key={s.slot}
                      tag={s.tag}
                      title={s.title}
                      hint={s.hint}
                      file={getFile(filesMap, fid)}
                      onUpload={(f) => handleUpload(f, fid)}
                      onClear={() => handleClearLocal(fid)}
                      readOnly={readOnly}
                    />
                  );
                })}
              </div>
              <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">
                Supporting docs — optional, up to 4
              </p>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {[0, 1, 2, 3].map((slotIdx) => {
                  const file = otherFiles.find((f) => f.rowIndex === slotIdx);
                  return (
                    <UploadBox
                      key={slotIdx}
                      tag="Optional"
                      optional
                      title={`Doc ${slotIdx + 1}`}
                      hint="P&L, IT cert, etc."
                      file={file ? { ...file } : null}
                      onUpload={(f) => handleUpload(f, otherFid, slotIdx)}
                      onClear={() => handleClearLocal(otherFid, slotIdx)}
                      readOnly={readOnly}
                    />
                  );
                })}
              </div>
            </PersonBlock>
          );
        })
      )}
      <AddPersonRow
        peopleKey="businessPeople"
        label="self-employed person"
        count={ops.list.length}
        onAdd={() => ops.add()}
        readOnly={readOnly}
      />
    </SectionShell>
  );
}

// ---------- 04 KYC ----------
function KYCSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const p = progressFor(dossier, filesMap, "kyc");
  const kycBox = (slot, title, optional = false) => {
    const fid = `fin_kyc_${slot}`;
    return (
      <UploadBox
        tag={optional ? "Optional" : "Required"}
        optional={optional}
        title={title}
        file={getFile(filesMap, fid)}
        onUpload={(f) => handleUpload(f, fid)}
        onClear={() => handleClearLocal(fid)}
        readOnly={readOnly}
      />
    );
  };
  return (
    <SectionShell
      id="kyc"
      num="04"
      title="Parents KYC"
      aside=""
      status={p}
      note="PAN and Aadhaar for both parents. Add a spouse / step-parent pair if relevant."
    >
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">Father</p>
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {kycBox("fatherPan", "PAN Card")}
        {kycBox("fatherAadhar", "Aadhaar Card")}
      </div>
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">Mother</p>
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {kycBox("motherPan", "PAN Card")}
        {kycBox("motherAadhar", "Aadhaar Card")}
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3 border border-stone-200 bg-white/60 px-4 py-3">
        <span className="flex-1 text-sm text-stone-800">
          Add an <em className="not-italic font-medium text-black">additional spouse / step-parent</em> KYC pair?
        </span>
        <TogglePill
          value={!!dossier.kycAdditional}
          options={[
            { value: false, label: "No" },
            { value: true, label: "Yes" },
          ]}
          onChange={(v) => updateDossier({ kycAdditional: !!v })}
          readOnly={readOnly}
        />
      </div>
      {dossier.kycAdditional && (
        <>
          <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">Additional</p>
          <div className="grid gap-3 md:grid-cols-2">
            {kycBox("addPan", "PAN Card", true)}
            {kycBox("addAadhar", "Aadhaar Card", true)}
          </div>
        </>
      )}
    </SectionShell>
  );
}

// ---------- 05 Loan ----------
function LoanSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const p = progressFor(dossier, filesMap, "loan");
  return (
    <SectionShell
      id="loan"
      num="05"
      title="Student loan"
      aside="if applicable"
      status={p}
    >
      <div className="mb-5 flex flex-wrap items-center gap-3 border border-stone-200 bg-white/60 px-4 py-3">
        <span className="flex-1 text-sm text-stone-800">Are you taking a student loan?</span>
        <TogglePill
          value={!!dossier.studentLoanTaken}
          options={[
            { value: false, label: "No" },
            { value: true, label: "Yes" },
          ]}
          onChange={(v) => updateDossier({ studentLoanTaken: !!v })}
          readOnly={readOnly}
        />
      </div>
      {dossier.studentLoanTaken ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[
            { slot: "sanction", title: "Loan sanction letter", hint: "Bank letter confirming approval" },
            { slot: "disbursal", title: "Loan disbursal letter", hint: "Confirms funds released or schedule" },
          ].map((s) => {
            const fid = `fin_loan_${s.slot}`;
            return (
              <UploadBox
                key={s.slot}
                tag="Required"
                title={s.title}
                hint={s.hint}
                file={getFile(filesMap, fid)}
                onUpload={(f) => handleUpload(f, fid)}
                onClear={() => handleClearLocal(fid)}
                readOnly={readOnly}
              />
            );
          })}
        </div>
      ) : (
        <div className="border border-dashed border-stone-300 bg-stone-50/50 px-5 py-8 text-center text-sm text-stone-800">
          <strong className="block font-serif text-base font-medium text-black">
            Marked as self-funded
          </strong>
          {readOnly
            ? "The student has marked this section as self-funded."
            : <>Toggle above to <em className="not-italic font-medium">Yes</em> if you've taken or are taking a student loan.</>}
        </div>
      )}
    </SectionShell>
  );
}

// ---------- 06 Net worth ----------
function NetworthSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const ops = makePersonOps("networthPeople", dossier, updateDossier);
  const p = progressFor(dossier, filesMap, "networth");
  return (
    <SectionShell
      id="networth"
      num="06"
      title="Net worth"
      aside=""
      status={p}
      note="CA-certified net worth statement for each person providing one. On CA letterhead, with stamp, signature, and membership number."
    >
      {ops.list.length === 0 ? (
        <EmptyPersonBlock label="person" />
      ) : (
        ops.list.map((person) => {
          const fid = `fin_networth_${person.id}`;
          return (
            <PersonBlock
              key={person.id}
              peopleKey="networthPeople"
              person={person}
              onChange={(next) => ops.update(person.id, next)}
              onRemove={() => ops.remove(person.id)}
              readOnly={readOnly}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <UploadBox
                  tag="Required"
                  title="CA net worth statement"
                  hint="CA letterhead, stamp, signature, membership #"
                  file={getFile(filesMap, fid)}
                  onUpload={(f) => handleUpload(f, fid)}
                  onClear={() => handleClearLocal(fid)}
                  readOnly={readOnly}
                />
              </div>
            </PersonBlock>
          );
        })
      )}
      <AddPersonRow
        peopleKey="networthPeople"
        label="person"
        count={ops.list.length}
        onAdd={() => ops.add()}
        readOnly={readOnly}
      />
    </SectionShell>
  );
}

// ---------- 07 Affidavits ----------
function AffidavitSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const ops = makePersonOps("affidavitPeople", dossier, updateDossier);
  const p = progressFor(dossier, filesMap, "affidavit");
  return (
    <SectionShell
      id="affidavit"
      num="07"
      title="Sponsor affidavits"
      aside=""
      status={p}
      note="A notarised affidavit from each sponsor declaring financial support. Stamp paper, notary seal, sponsor signature & ID."
    >
      {ops.list.length === 0 ? (
        <EmptyPersonBlock label="sponsor" />
      ) : (
        ops.list.map((person) => {
          const fid = `fin_affidavit_${person.id}`;
          return (
            <PersonBlock
              key={person.id}
              peopleKey="affidavitPeople"
              person={person}
              onChange={(next) => ops.update(person.id, next)}
              onRemove={() => ops.remove(person.id)}
              readOnly={readOnly}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <UploadBox
                  tag="Required"
                  title="Sponsor affidavit"
                  hint="Stamp paper, notary seal, sponsor signature & ID"
                  file={getFile(filesMap, fid)}
                  onUpload={(f) => handleUpload(f, fid)}
                  onClear={() => handleClearLocal(fid)}
                  readOnly={readOnly}
                />
              </div>
            </PersonBlock>
          );
        })
      )}
      <AddPersonRow
        peopleKey="affidavitPeople"
        label="sponsor"
        count={ops.list.length}
        onAdd={() => ops.add()}
        readOnly={readOnly}
      />
    </SectionShell>
  );
}

// ---------- 08 Banking ----------
function BankingSection({ dossier, filesMap, updateDossier, handleUpload, handleClearLocal, readOnly }) {
  const p = progressFor(dossier, filesMap, "banking");
  const box = (slot, opts) => {
    const fid = `fin_banking_${slot}`;
    return (
      <UploadBox
        tag={opts.tag}
        optional={opts.optional}
        title={opts.title}
        hint={opts.hint}
        file={getFile(filesMap, fid)}
        onUpload={(f) => handleUpload(f, fid)}
        onClear={() => handleClearLocal(fid)}
        readOnly={readOnly}
      />
    );
  };
  const bankInput = (key, placeholder) => {
    if (readOnly) {
      const v = dossier.bankManager?.[key] || "";
      return (
        <p className="py-1 font-serif text-sm text-black">
          {v || <span className="text-stone-500">— not provided</span>}
        </p>
      );
    }
    return (
      <input
        type="text"
        value={dossier.bankManager?.[key] || ""}
        onChange={(e) =>
          updateDossier((d) => ({
            ...d,
            bankManager: { ...(d.bankManager || {}), [key]: e.target.value },
          }))
        }
        placeholder={placeholder}
        className="w-full border-b border-stone-300 bg-transparent py-1 font-serif text-sm text-black outline-none focus:border-[#cc785c]"
      />
    );
  };
  return (
    <SectionShell id="banking" num="08" title="Banking" aside="" status={p}>
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">
        Savings account statements — last 6 months
      </p>
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {box("savings1", { tag: "Bank 1", title: "Savings A/C — Bank 1", hint: "Primary savings statement" })}
        {box("savings2", { tag: "Bank 2", optional: true, title: "Savings A/C — Bank 2", hint: "If you maintain a second bank" })}
      </div>
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">Fixed deposits</p>
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {box("fdCopies", { tag: "Bank-verified", title: "Fixed deposit copies", hint: "Stamped and signed by bank" })}
        {box("fdCert", { tag: "Required", title: "Bank certificate of FDs", hint: "Fresh letter listing every FD" })}
      </div>
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">Balance confirmation</p>
      <div className="mb-5 grid gap-3">
        {box("balanceCert", {
          tag: "Required",
          title: "Bank certificate of balance confirmation",
          hint: "Recent letter from branch manager on letterhead",
        })}
      </div>
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">
        Business banking — if anyone is self-employed
      </p>
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {box("bizStatement", { tag: "If applicable", optional: true, title: "Business bank statement", hint: "Current account, last 6 months" })}
        {box("bizBalanceCert", { tag: "If applicable", optional: true, title: "Bank certificate of business balance", hint: "Fresh letter for business account" })}
      </div>
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-stone-700">Bank manager contact</p>
      <p className="mb-3 text-xs text-stone-700">
        The embassy may call to verify — keep a direct contact at the branch.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="border border-stone-300 bg-white/60 p-4">
          <p className="font-serif text-sm font-medium">Name / card</p>
          <p className="mt-1 mb-2 text-[10px] uppercase tracking-[0.15em] text-stone-700">From their business card</p>
          {bankInput("card", "Name & designation")}
        </div>
        <div className="border border-stone-300 bg-white/60 p-4">
          <p className="font-serif text-sm font-medium">Email</p>
          <p className="mt-1 mb-2 text-[10px] uppercase tracking-[0.15em] text-stone-700">Direct email</p>
          {bankInput("email", "manager@bank.in")}
        </div>
        <div className="border border-stone-300 bg-white/60 p-4">
          <p className="font-serif text-sm font-medium">Phone</p>
          <p className="mt-1 mb-2 text-[10px] uppercase tracking-[0.15em] text-stone-700">Direct number</p>
          {bankInput("phone", "+91 …")}
        </div>
      </div>
    </SectionShell>
  );
}

// ---------- 09 Travel ----------
function TravelSection({ dossier, updateDossier, readOnly }) {
  const [draft, setDraft] = useState({ country: "", purpose: "", from: "", to: "" });
  const trips = dossier.travelTrips || [];
  const addTrip = () => {
    if (!draft.country.trim()) {
      alert("Country is required for a trip.");
      return;
    }
    updateDossier((d) => ({
      ...d,
      travelTrips: [
        ...d.travelTrips,
        {
          id: uid("t"),
          country: draft.country.trim(),
          purpose: draft.purpose.trim(),
          from: draft.from,
          to: draft.to,
        },
      ],
    }));
    setDraft({ country: "", purpose: "", from: "", to: "" });
  };
  const removeTrip = (id) =>
    updateDossier((d) => ({
      ...d,
      travelTrips: d.travelTrips.filter((t) => t.id !== id),
    }));
  const inputCls =
    "w-full border border-stone-300 bg-white px-2 py-1.5 text-sm text-black outline-none focus:border-[#cc785c]";
  return (
    <SectionShell
      id="travel"
      num="09"
      title="Travel history"
      aside="student only, last 10 years"
      status={{ trips: trips.length, filled: trips.length, total: Math.max(trips.length, 1) }}
      note="International travel only — domestic doesn't count. Add a row for each trip the student has taken."
    >
      {!readOnly && (
        <div className="mb-3 grid gap-2 border border-stone-200 bg-white/60 p-4 md:grid-cols-[1.4fr_1.4fr_1fr_1fr_auto]">
          <div>
            <label className="block text-[10px] uppercase tracking-[0.15em] text-stone-700">
              Country
            </label>
            <input
              className={inputCls}
              value={draft.country}
              onChange={(e) => setDraft({ ...draft, country: e.target.value })}
              placeholder="e.g. Singapore"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-[0.15em] text-stone-700">
              Purpose
            </label>
            <input
              className={inputCls}
              value={draft.purpose}
              onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
              placeholder="Tourism, education…"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-[0.15em] text-stone-700">From</label>
            <input
              type="date"
              className={inputCls}
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-[0.15em] text-stone-700">To</label>
            <input
              type="date"
              className={inputCls}
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={addTrip}
              className="inline-flex h-[34px] items-center gap-1 border border-stone-900 bg-stone-900 px-4 text-xs uppercase tracking-[0.15em] text-white hover:bg-stone-800"
            >
              <Plus className="h-3.5 w-3.5" /> Add trip
            </button>
          </div>
        </div>
      )}
      {trips.length === 0 ? (
        <div className="border border-dashed border-stone-300 bg-stone-50/50 px-5 py-8 text-center text-sm text-stone-800">
          {readOnly ? "No trips logged." : "No trips logged yet — add the first one above."}
        </div>
      ) : (
        <ul className="space-y-1">
          {trips.map((t) => (
            <li
              key={t.id}
              className="grid grid-cols-[1.4fr_1.4fr_1fr_1fr_auto] items-center gap-3 border border-stone-200 bg-white/60 px-4 py-2 text-sm"
            >
              <span className="font-medium text-black">{t.country}</span>
              <span className="text-stone-800">{t.purpose || "—"}</span>
              <span className="text-stone-700 tabular-nums">{t.from || "—"}</span>
              <span className="text-stone-700 tabular-nums">{t.to || "—"}</span>
              {readOnly ? (
                <span />
              ) : (
                <button
                  type="button"
                  onClick={() => removeTrip(t.id)}
                  className="text-stone-500 hover:text-[#cc785c]"
                  title="Remove"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}
