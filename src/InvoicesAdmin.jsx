import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, Plus, Trash2, FileText, Settings as SettingsIcon, History as HistoryIcon,
  Home, ChevronLeft, ChevronRight, X, Check, Upload, Image as ImageIcon,
  Edit2, Copy, Printer, Zap, Download, Building2,
} from "lucide-react";
import { api } from "./api.js";

// =============================================================
// Invoices admin tab.
//
// All data — company identity, GSTIN, bank, signature, logo,
// every invoice — lives in Postgres + R2. Nothing in this file
// (which sits in a public repo) carries real values. The
// constants below are public Indian GST rules + state lists
// only.
//
// One-time setup: on a fresh DB, open the Invoice Info section
// and fill in company name / GSTIN / PAN / bank / address /
// state, then upload the signature PNG and logo. Every later
// invoice picks those up automatically.
// =============================================================

const INVOICE_TYPES = {
  retail:   { label: "Retail",            sub: "Individual student or parent", rule: "Customer in same state as company: 9% CGST + 9% SGST. Outside: 18% IGST." },
  b2b:      { label: "B2B India",         sub: "Indian business · GST applied", rule: "University in same state: 9% CGST + 9% SGST. Outside: 18% IGST." },
  b2b_lut:  { label: "B2B LUT / SEZ",     sub: "SEZ unit · zero GST under LUT", rule: "No GST. Declaration per Rule 96A, CGST Rules 2017." },
  b2b_intl: { label: "B2B International", sub: "Foreign partner · export",      rule: "No GST. Export of service in foreign currency." },
};

const INDIAN_STATES = [
  "Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa",
  "Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala",
  "Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland",
  "Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura",
  "Uttar Pradesh","Uttarakhand","West Bengal",
  "Andaman and Nicobar Islands","Chandigarh","Dadra and Nagar Haveli and Daman and Diu",
  "Delhi","Jammu and Kashmir","Ladakh","Lakshadweep","Puducherry",
];

const CURRENCIES = ["GBP","USD","EUR","AUD","CAD","AED","SGD","NZD","JPY"];
const CURRENCY_SYMBOLS = { GBP:'£', USD:'$', EUR:'€', AUD:'A$', CAD:'C$', AED:'AED ', SGD:'S$', NZD:'NZ$', JPY:'¥' };

// Empty defaults — all firm-specific values come from /api/admin/invoices/company-settings.
const EMPTY_COMPANY = {
  name: "", founder: "", founderTitle: "", address: "", altAddress: "",
  state: "", email: "", phone: "", website: "",
  gstin: "", pan: "", lutn: "", lutDate: "", sacCode: "",
  bankName: "", bankBranch: "", beneficiaryName: "", accountNumber: "", ifsc: "",
  swift: "", intermediaryBank: "",
};

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function formatNum(n) {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
}
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(d.getDate()).padStart(2,'0')}-${M[d.getMonth()]}-${d.getFullYear()}`;
}

function numberToIndianWords(num) {
  if (num == null || isNaN(num)) return "";
  const ones = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten",
    "Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  const td = n => n < 20 ? ones[n] : tens[Math.floor(n/10)] + (n%10 ? " " + ones[n%10] : "");
  const ttd = n => { const h = Math.floor(n/100), r = n%100; let s = ""; if (h) s = ones[h] + " Hundred"; if (r) s += (h ? " " : "") + td(r); return s; };
  const intPart = Math.floor(Math.abs(num));
  const decPart = Math.round((Math.abs(num) - intPart) * 100);
  if (intPart === 0 && decPart === 0) return "Zero Only";
  let n = intPart, result = "";
  const cr = Math.floor(n/10000000); n %= 10000000;
  if (cr) result += ttd(cr) + " Crore ";
  const lk = Math.floor(n/100000); n %= 100000;
  if (lk) result += ttd(lk) + " Lakh ";
  const th = Math.floor(n/1000); n %= 1000;
  if (th) result += ttd(th) + " Thousand ";
  if (n) result += ttd(n);
  result = result.trim();
  if (decPart > 0) result += " and " + td(decPart) + " Paise";
  return result + " Only";
}

function calcTaxes(type, customerState, subtotal, companyState) {
  if (type === "b2b_lut" || type === "b2b_intl") return { cgst:0, sgst:0, igst:0, taxType:"none" };
  if (!customerState) return { cgst:0, sgst:0, igst:0, taxType:"unset" };
  const same = customerState.trim().toLowerCase() === (companyState||"").trim().toLowerCase();
  if (same) return { cgst:+(subtotal*0.09).toFixed(2), sgst:+(subtotal*0.09).toFixed(2), igst:0, taxType:"intra" };
  return { cgst:0, sgst:0, igst:+(subtotal*0.18).toFixed(2), taxType:"inter" };
}

function totalsFor(invoice, companyState) {
  const sub = (invoice.lineItems || []).reduce((acc, li) => {
    if (invoice.type === "retail") return acc + (Number(li.amount) || 0);
    return acc + (Number(li.commission) || 0);
  }, 0);
  const tx = calcTaxes(invoice.type, invoice.customer?.state, sub, companyState);
  return { subtotal: sub, ...tx, grand: sub + tx.cgst + tx.sgst + tx.igst };
}

function blankInvoice(type, suggestedNumber) {
  const base = {
    id: null, type,
    invoiceNumber: suggestedNumber || "",
    date: todayIso(),
    customer: { name: "", address: "", state: "", stateCode: "", gstin: "", email: "", phone: "" },
    notes: "",
    approved: false,
    lineItems: [],
  };
  if (type === "retail")  return { ...base, lineItems: [{ id: uid(), studentName: "", service: "", amount: 0 }] };
  if (type === "b2b" || type === "b2b_lut") return {
    ...base,
    lineItems: [{ id: uid(), poNumber: "", studentName: "", course: "", university: "", intake: "", commission: 0 }],
  };
  if (type === "b2b_intl") return {
    ...base, currency: "GBP",
    lineItems: [{ id: uid(), siukId: "", firstName: "", familyName: "", course: "", university: "", enrolmentDate: "", tuitionFee: 0, uniRate: 0, partnerRate: 0, commission: 0 }],
  };
  return base;
}

// =============================================================
// Root component
// =============================================================

export default function InvoicesAdmin() {
  const [view, setView] = useState("home"); // home | wizard | history | settings | partners | preview
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [partners, setPartners] = useState([]);
  const [company, setCompany] = useState(EMPTY_COMPANY);
  const [logoBase64, setLogoBase64] = useState(null);
  const [signatureBase64, setSignatureBase64] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [coRes, invList, partnerList] = await Promise.all([
          api.getCompanySettings(),
          api.listInvoices(),
          api.listPartners(),
        ]);
        if (!alive) return;
        setCompany({ ...EMPTY_COMPANY, ...(coRes.data || {}) });
        setLogoBase64(coRes.logoBase64 || null);
        setSignatureBase64(coRes.signatureBase64 || null);
        setInvoices(invList || []);
        setPartners(partnerList || []);
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  const refreshInvoices = async () => {
    try {
      const list = await api.listInvoices();
      setInvoices(list || []);
    } catch (e) { setError(e.message); }
  };

  const refreshPartners = async () => {
    try {
      const list = await api.listPartners();
      setPartners(list || []);
    } catch (e) { setError(e.message); }
  };

  async function startNew() {
    setError(null);
    setView("wizard");
    setStep(1);
    setDraft(null);
  }

  // Direct-entry path. The Home page surfaces each invoice type as its
  // own button card; clicking one bypasses the wizard's first step
  // (Type) and lands the user on Customer with the type already locked
  // in. Equivalent to startNew() + chooseType() but skips the
  // intermediate Type screen which is redundant when the user has
  // already announced their intent by clicking the type card.
  async function startNewWithType(type) {
    setError(null);
    try {
      const { invoiceNumber } = await api.getNextInvoiceNumber();
      setDraft(blankInvoice(type, invoiceNumber));
      setView("wizard");
      setStep(2);
    } catch (e) { setError(e.message); }
  }

  async function chooseType(type) {
    try {
      const { invoiceNumber } = await api.getNextInvoiceNumber();
      setDraft(blankInvoice(type, invoiceNumber));
      setStep(2);
    } catch (e) { setError(e.message); }
  }

  async function openInvoice(id) {
    try {
      const inv = await api.getInvoice(id);
      setDraft(inv);
      setView("preview");
    } catch (e) { setError(e.message); }
  }

  async function persistDraft() {
    if (!draft) return;
    setError(null);
    try {
      const payload = {
        type: draft.type,
        invoiceNumber: draft.invoiceNumber,
        date: draft.date,
        customer: draft.customer || {},
        currency: draft.currency || null,
        notes: draft.notes || "",
        lineItems: draft.lineItems || [],
        lutN: draft.lutN || null,
        lutDate: draft.lutDate || null,
      };
      const saved = draft.id
        ? await api.updateInvoice(draft.id, payload)
        : await api.createInvoice(payload);
      setDraft(saved);
      await refreshInvoices();
      return saved;
    } catch (e) { setError(e.message); return null; }
  }

  async function confirmAndPreview() {
    const saved = await persistDraft();
    if (saved) setView("preview");
  }

  async function approveDraft() {
    if (!draft?.id) {
      setError("Save the invoice before approving.");
      return;
    }
    if (!signatureBase64) {
      setError("Upload Jyoti's signature in Invoice Info before approving.");
      return;
    }
    try {
      const updated = await api.approveInvoice(draft.id);
      setDraft(updated);
      await refreshInvoices();
      flash("Invoice approved & signed");
    } catch (e) { setError(e.message); }
  }

  async function revertDraft() {
    if (!draft?.id) return;
    if (!confirm("Revert this invoice back to draft? You'll be able to edit it again.")) return;
    try {
      const updated = await api.revertInvoice(draft.id);
      setDraft(updated);
      await refreshInvoices();
      flash("Reverted to draft");
    } catch (e) { setError(e.message); }
  }

  async function removeInvoice(id) {
    if (!confirm("Delete this invoice permanently? A snapshot is still kept in R2 backup.")) return;
    try {
      await api.deleteInvoice(id);
      await refreshInvoices();
      if (draft?.id === id) { setDraft(null); setView("home"); }
      flash("Deleted");
    } catch (e) { setError(e.message); }
  }

  async function saveCompany(nextCompany, nextLogoB64, nextSigB64) {
    try {
      const saved = await api.putCompanySettings({
        data: nextCompany,
        logoBase64: nextLogoB64 === undefined ? logoBase64 : nextLogoB64,
        signatureBase64: nextSigB64 === undefined ? signatureBase64 : nextSigB64,
      });
      setCompany({ ...EMPTY_COMPANY, ...(saved.data || {}) });
      setLogoBase64(saved.logoBase64 || null);
      setSignatureBase64(saved.signatureBase64 || null);
      flash("Invoice info saved");
    } catch (e) { setError(e.message); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-black">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading invoices…
      </div>
    );
  }

  return (
    <div>
      {/* Sub-nav within the Invoices tab */}
      <div className="mb-4 flex items-center justify-between border-b border-stone-300 pb-2">
        <div className="flex items-center gap-2">
          <SubNavButton active={view === "home"}     onClick={() => { setView("home"); setDraft(null); }} icon={<Home className="h-3.5 w-3.5" />} label="Home" />
          <SubNavButton active={view === "history"}  onClick={() => { setView("history"); setDraft(null); }} icon={<HistoryIcon className="h-3.5 w-3.5" />} label="History" />
          <SubNavButton active={view === "settings"} onClick={() => { setView("settings"); setDraft(null); }} icon={<SettingsIcon className="h-3.5 w-3.5" />} label="Invoice Info" />
          <SubNavButton active={view === "partners"} onClick={() => { setView("partners"); setDraft(null); }} icon={<Building2 className="h-3.5 w-3.5" />} label="Partners" />
        </div>
        {(view === "home" || view === "history") && (
          <button
            onClick={startNew}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f]"
          >
            <Plus className="h-3 w-3" /> New invoice
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 flex items-start justify-between border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-600 hover:text-red-900"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {(!company.name || !company.gstin) && view !== "settings" && (
        <div className="mb-4 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your firm details are incomplete. Open <button onClick={() => setView("settings")} className="font-semibold underline">Invoice Info</button> to add the company name, GSTIN, bank account, and signature before issuing invoices.
        </div>
      )}

      {view === "home" && (
        <HomeView
          invoices={invoices}
          company={company}
          logoBase64={logoBase64}
          signatureBase64={signatureBase64}
          onStartNew={startNew}
          onStartNewWithType={startNewWithType}
          onOpen={openInvoice}
          onDelete={removeInvoice}
          onGoHistory={() => setView("history")}
        />
      )}

      {view === "history" && (
        <HistoryView
          invoices={invoices}
          company={company}
          onOpen={openInvoice}
          onDelete={removeInvoice}
        />
      )}

      {view === "settings" && (
        <SettingsView
          company={company}
          logoBase64={logoBase64}
          signatureBase64={signatureBase64}
          onSave={saveCompany}
        />
      )}

      {view === "partners" && (
        <PartnersView
          partners={partners}
          onRefresh={refreshPartners}
        />
      )}

      {view === "wizard" && (
        <Wizard
          step={step}
          setStep={setStep}
          draft={draft}
          setDraft={setDraft}
          company={company}
          partners={partners}
          onPartnerSaved={refreshPartners}
          onChooseType={chooseType}
          onConfirm={confirmAndPreview}
          onApprove={approveDraft}
          onCancel={() => { setView("home"); setDraft(null); }}
        />
      )}

      {view === "preview" && draft && (
        <PreviewView
          invoice={draft}
          company={company}
          logoBase64={logoBase64}
          signatureBase64={signatureBase64}
          onBack={() => setView("home")}
          onEdit={() => { setView("wizard"); setStep(3); }}
          onApprove={approveDraft}
          onRevert={revertDraft}
          onDelete={() => removeInvoice(draft.id)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 inline-flex items-center gap-2 bg-stone-900 px-4 py-2 text-sm text-white shadow-lg">
          <Check className="h-3.5 w-3.5" /> {toast}
        </div>
      )}
    </div>
  );
}

function SubNavButton({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "inline-flex items-center gap-1.5 border border-stone-400 bg-stone-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white"
          : "inline-flex items-center gap-1.5 border border-stone-300 bg-stone-100 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-black hover:bg-stone-50"
      }
    >
      {icon} {label}
    </button>
  );
}

// =============================================================
// Home view — recent invoices + type picker shortcut
// =============================================================

function HomeView({ invoices, company, logoBase64, signatureBase64, onStartNew, onStartNewWithType, onOpen, onDelete, onGoHistory }) {
  const drafts = useMemo(
    () => [...invoices].filter((i) => !i.approved).sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [invoices]
  );
  const recent = useMemo(
    () => [...invoices].filter((i) => i.approved).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 8),
    [invoices]
  );

  const last30 = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const iso = cutoff.toISOString().slice(0, 10);
    return invoices
      .filter((i) => i.date && i.date >= iso)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  }, [invoices]);

  // Bulk-print: open every 30-day invoice in a new tab with page-break-
  // after on each so a browser Print → Save as PDF produces one
  // multi-page PDF. The same approach the user's original mockup used
  // (window.print on a stacked render). Triggered async (a microtask
  // off the click) so React renders the bulk view before window.print
  // pre-paints.
  const [bulkOpen, setBulkOpen] = useState(false);
  useEffect(() => {
    if (!bulkOpen) return;
    const t = setTimeout(() => window.print(), 200);
    const onAfter = () => setBulkOpen(false);
    window.addEventListener("afterprint", onAfter);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", onAfter); };
  }, [bulkOpen]);

  if (bulkOpen) {
    return (
      <div className="print-bundle">
        <div className="mb-6 max-w-[800px] mx-auto border-b-2 border-stone-900 pb-3 print:hidden">
          <div className="text-[10px] uppercase tracking-[0.28em] text-[#cc785c]">Invoice bundle</div>
          <div className="font-serif text-2xl">{company.name || "Persona Discover"} — Last 30 days</div>
          <div className="text-xs text-stone-600">{last30.length} invoice{last30.length === 1 ? "" : "s"} · Use your browser's print dialog to save as PDF</div>
          <button onClick={() => setBulkOpen(false)} className="mt-2 inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1 text-[11px] uppercase tracking-[0.18em] hover:bg-stone-50">Cancel</button>
        </div>
        {last30.map((inv) => {
          const totals = totalsFor(inv, company.state);
          const sym = inv.type === "b2b_intl" ? CURRENCY_SYMBOLS[inv.currency] || `${inv.currency} ` : "₹ ";
          return (
            <div key={inv.id} className="mb-8 break-after-page print:mb-0">
              <PrintableInvoice
                invoice={inv}
                company={company}
                logoBase64={logoBase64}
                signatureBase64={signatureBase64}
                totals={totals}
                sym={sym}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Invoice studio</h2>
          <p className="mt-1 text-sm text-stone-800">
            Click any invoice type below to start a new invoice of that kind. The right tax rules and fields appear automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setBulkOpen(true)}
            disabled={last30.length === 0}
            title={last30.length === 0 ? "No invoices in the last 30 days" : `Print/save ${last30.length} invoice${last30.length === 1 ? "" : "s"} from the last 30 days as a single PDF`}
            className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-stone-900 hover:border-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="h-3 w-3" /> Last 30 days {last30.length > 0 && <span className="opacity-60">({last30.length})</span>}
          </button>
          <button
            onClick={onStartNew}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f]"
          >
            <Plus className="h-3 w-3" /> New invoice
          </button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {Object.entries(INVOICE_TYPES).map(([key, meta]) => (
          <button
            key={key}
            type="button"
            onClick={() => onStartNewWithType(key)}
            title={`Start a new ${meta.label} invoice`}
            className="group relative border border-stone-300 bg-white p-3 text-left transition hover:border-[#cc785c] hover:bg-[#fff7f2]"
          >
            <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">{meta.sub}</div>
            <div className="mt-1 text-sm font-semibold text-stone-900 group-hover:text-[#cc785c]">{meta.label}</div>
            <div className="mt-1 text-[12px] text-stone-700">{meta.rule}</div>
            <ChevronRight className="absolute right-2 top-2 h-3.5 w-3.5 text-stone-300 group-hover:text-[#cc785c]" />
          </button>
        ))}
      </div>

      {invoices.length === 0 && (
        <div className="border border-dashed border-stone-300 bg-stone-50 px-6 py-12 text-center">
          <FileText className="mx-auto mb-3 h-6 w-6 text-stone-400" />
          <div className="text-sm font-semibold text-stone-800">No invoices yet</div>
          <div className="mt-1 text-sm text-stone-700">Click <strong>New invoice</strong> above to issue your first one.</div>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold tracking-tight">Drafts</h3>
            <span className="text-[12px] text-stone-600">{drafts.length} unsaved</span>
          </div>
          <div className="border border-stone-300 bg-white">
            <div className="grid grid-cols-[1.2fr_1.5fr_1.2fr_1fr_auto] items-center gap-3 border-b border-stone-300 bg-stone-100 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-stone-600">
              <span>Number</span><span>Customer</span><span>Type</span><span className="text-right">Total</span><span />
            </div>
            {drafts.map((inv) => (
              <DraftRow key={inv.id} inv={inv} company={company} onContinue={() => onOpen(inv.id)} onDelete={() => onDelete(inv.id)} />
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold tracking-tight">Recent signed</h3>
            <div className="flex items-center gap-3 text-[12px] text-stone-700">
              <span>{invoices.filter((i) => i.approved).length} total · {last30.length} in last 30 days</span>
              <button onClick={onGoHistory} className="underline hover:text-stone-900">View all →</button>
            </div>
          </div>
          <div className="border border-stone-300 bg-white">
            {recent.map((inv) => (
              <RecentRow key={inv.id} inv={inv} company={company} onOpen={() => onOpen(inv.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecentRow({ inv, company, onOpen }) {
  const totals = totalsFor(inv, company.state);
  const sym = inv.type === "b2b_intl" ? CURRENCY_SYMBOLS[inv.currency] || `${inv.currency} ` : "₹ ";
  const meta = INVOICE_TYPES[inv.type];
  return (
    <button
      onClick={onOpen}
      className="grid w-full grid-cols-[1.2fr_1.5fr_1.5fr_1fr_auto] items-center gap-3 border-b border-stone-200 px-3 py-2 text-left text-sm text-stone-900 last:border-b-0 hover:bg-stone-50"
    >
      <div>
        <div className="font-semibold">{inv.invoiceNumber}</div>
        <div className="text-[11px] text-stone-600">{formatDate(inv.date)}</div>
      </div>
      <div className="truncate">{inv.customer?.name || "—"}</div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-stone-600">{meta?.label || inv.type}</div>
      <div className="text-right font-mono text-sm">{sym}{formatNum(totals.grand)}</div>
      <div className="text-[11px]">
        {inv.approved ? (
          <span className="inline-flex items-center gap-1 border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-800">
            <Check className="h-3 w-3" /> Signed
          </span>
        ) : (
          <span className="inline-flex items-center border border-stone-300 bg-stone-100 px-2 py-0.5 text-stone-700">Draft</span>
        )}
      </div>
    </button>
  );
}

function DraftRow({ inv, company, onContinue, onDelete }) {
  const totals = totalsFor(inv, company.state);
  const sym = inv.type === "b2b_intl" ? CURRENCY_SYMBOLS[inv.currency] || `${inv.currency} ` : "₹ ";
  const meta = INVOICE_TYPES[inv.type];
  return (
    <div className="grid grid-cols-[1.2fr_1.5fr_1.2fr_1fr_auto] items-center gap-3 border-b border-stone-200 px-3 py-2 text-sm text-stone-900 last:border-b-0">
      <div>
        <div className="font-semibold">{inv.invoiceNumber}</div>
        <div className="text-[11px] text-stone-600">{formatDate(inv.date)}</div>
      </div>
      <div className="truncate">{inv.customer?.name || "—"}</div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-stone-600">{meta?.label || inv.type}</div>
      <div className="text-right font-mono text-sm">{sym}{formatNum(totals.grand)}</div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={onContinue}
          className="inline-flex items-center gap-1 border border-stone-400 bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-stone-900 hover:bg-stone-50"
        >
          Continue
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete draft"
          className="text-stone-400 hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// =============================================================
// History view — full list with filters + delete
// =============================================================

function HistoryView({ invoices, company, onOpen, onDelete }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      if (from && (inv.date || "") < from) return false;
      if (to && (inv.date || "") > to) return false;
      if (type && inv.type !== type) return false;
      if (q) {
        const blob = `${inv.invoiceNumber} ${inv.customer?.name || ""}`.toLowerCase();
        if (!blob.includes(q.toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [invoices, from, to, type, q]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3 border border-stone-300 bg-white p-3">
        <Field label="From" w="w-36">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" />
        </Field>
        <Field label="To" w="w-36">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" />
        </Field>
        <Field label="Type" w="w-44">
          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm">
            <option value="">All types</option>
            {Object.entries(INVOICE_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Search" w="flex-1 min-w-[200px]">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice number or customer name" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" />
        </Field>
        {(from || to || type || q) && (
          <button onClick={() => { setFrom(""); setTo(""); setType(""); setQ(""); }} className="px-2 py-1 text-[11px] uppercase tracking-[0.18em] text-stone-700 hover:text-black">Clear</button>
        )}
      </div>

      <div className="border border-stone-300 bg-white">
        <div className="grid grid-cols-[1fr_1.5fr_1fr_1fr_1fr_auto] items-center gap-3 border-b border-stone-300 bg-stone-100 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-700">
          <span>Number</span>
          <span>Customer</span>
          <span>Type</span>
          <span>Date</span>
          <span className="text-right">Total</span>
          <span className="w-16 text-right">Status</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-stone-600">No invoices match these filters.</div>
        ) : filtered.map((inv) => {
          const t = totalsFor(inv, company.state);
          const sym = inv.type === "b2b_intl" ? CURRENCY_SYMBOLS[inv.currency] || `${inv.currency} ` : "₹ ";
          return (
            <div key={inv.id} className="grid grid-cols-[1fr_1.5fr_1fr_1fr_1fr_auto] items-center gap-3 border-b border-stone-200 px-3 py-2 text-sm last:border-b-0 hover:bg-stone-50">
              <button onClick={() => onOpen(inv.id)} className="text-left font-semibold text-stone-900 hover:underline">{inv.invoiceNumber}</button>
              <span className="truncate">{inv.customer?.name || "—"}</span>
              <span className="text-[11px] uppercase tracking-[0.14em] text-stone-600">{INVOICE_TYPES[inv.type]?.label}</span>
              <span>{formatDate(inv.date)}</span>
              <span className="text-right font-mono">{sym}{formatNum(t.grand)}</span>
              <span className="flex w-16 items-center justify-end gap-1">
                {inv.approved ? (
                  <span title="Signed" className="inline-flex items-center gap-1 border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-emerald-800">
                    <Check className="h-3 w-3" /> Signed
                  </span>
                ) : (
                  <button onClick={() => onDelete(inv.id)} title="Delete draft" className="text-stone-500 hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children, w = "" }) {
  return (
    <label className={`block ${w}`}>
      <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// =============================================================
// Settings view — company info, signature upload, logo upload
// =============================================================

function SettingsView({ company, logoBase64, signatureBase64, onSave }) {
  const [c, setC] = useState(company);
  const [logo, setLogo] = useState(logoBase64);
  const [sig, setSig] = useState(signatureBase64);
  const [busy, setBusy] = useState(false);
  const [drawingSig, setDrawingSig] = useState(false);

  // Only seed from props on FIRST mount or when the user hasn't touched
  // the form yet. Without the "dirty" guard the prior useEffect re-sync
  // would overwrite the user's in-flight typing every time `company`
  // changed upstream (e.g. after a save), which made the form feel like
  // it was eating keystrokes.
  const dirtyRef = useRef(false);
  useEffect(() => { if (!dirtyRef.current) setC(company); }, [company]);
  useEffect(() => { setLogo(logoBase64); }, [logoBase64]);
  useEffect(() => { setSig(signatureBase64); }, [signatureBase64]);

  const set = (k, v) => { dirtyRef.current = true; setC((p) => ({ ...p, [k]: v })); };

  async function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function pickFile(setter) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/svg+xml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 1_000_000) { alert("File too large (1MB max). Try a smaller PNG."); return; }
      const dataUrl = await readFile(file);
      setter(dataUrl);
    };
    input.click();
  }

  async function submit() {
    setBusy(true);
    try {
      await onSave(c, logo, sig);
      // After a successful save, the form is no longer ahead of the
      // server — clear dirty so future upstream refreshes can re-seed
      // cleanly if needed.
      dirtyRef.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="border border-stone-300 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">Brand assets</div>
        <p className="mb-3 text-sm text-stone-800">Logo appears at the top of every invoice. Signature is stamped at the bottom of approved invoices. Both are stored in the database and backed up to R2 — never in source code.</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">Logo</div>
            <div className="flex items-center gap-3">
              <div className="flex h-20 w-20 items-center justify-center border border-stone-300 bg-stone-50">
                {logo ? <img src={logo} alt="logo" className="max-h-full max-w-full" /> : <ImageIcon className="h-6 w-6 text-stone-400" />}
              </div>
              <div className="flex flex-col gap-1">
                <button onClick={() => pickFile(setLogo)} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-2 py-1 text-[11px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-50">
                  <Upload className="h-3 w-3" /> {logo ? "Replace" : "Upload"}
                </button>
                {logo && <button onClick={() => setLogo(null)} className="text-[11px] text-stone-600 hover:text-red-600 underline">Remove</button>}
              </div>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">Signature</div>
            <div className="flex items-center gap-3">
              <div className="flex h-20 w-40 items-center justify-center border border-stone-300 bg-stone-50">
                {sig ? <img src={sig} alt="signature" className="max-h-full max-w-full" /> : <ImageIcon className="h-6 w-6 text-stone-400" />}
              </div>
              <div className="flex flex-col gap-1">
                <button onClick={() => setDrawingSig(true)} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-2 py-1 text-[11px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-50" title="Draw signature with mouse / trackpad / stylus">
                  <Edit2 className="h-3 w-3" /> Draw
                </button>
                <button onClick={() => pickFile(setSig)} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-2 py-1 text-[11px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-50" title="Upload a PNG / JPG / SVG of an existing signature">
                  <Upload className="h-3 w-3" /> Upload
                </button>
                {sig && <button onClick={() => setSig(null)} className="text-[11px] text-stone-600 hover:text-red-600 underline">Remove</button>}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="border border-stone-300 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">Firm identity</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company name"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Founder"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.founder} onChange={(e) => set("founder", e.target.value)} /></Field>
          <Field label="Founder title"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.founderTitle} onChange={(e) => set("founderTitle", e.target.value)} placeholder="e.g. Founder" /></Field>
          <Field label="State (for GST same/inter-state)">
            <select className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.state} onChange={(e) => set("state", e.target.value)}>
              <option value="">— select state —</option>
              {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Address"><textarea rows={2} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.address} onChange={(e) => set("address", e.target.value)} /></Field>
          <Field label="Alternate address"><textarea rows={2} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.altAddress} onChange={(e) => set("altAddress", e.target.value)} /></Field>
          <Field label="Email"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.email} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Phone"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="Website"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.website} onChange={(e) => set("website", e.target.value)} /></Field>
        </div>
      </div>

      <div className="border border-stone-300 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">Tax & compliance</div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="GSTIN"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.gstin} onChange={(e) => set("gstin", e.target.value)} /></Field>
          <Field label="PAN"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.pan} onChange={(e) => set("pan", e.target.value)} /></Field>
          <Field label="SAC code"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.sacCode} onChange={(e) => set("sacCode", e.target.value)} placeholder="999299" /></Field>
          <Field label="LUT number (for SEZ / B2B LUT)"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.lutn} onChange={(e) => set("lutn", e.target.value)} /></Field>
          <Field label="LUT date"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.lutDate} onChange={(e) => set("lutDate", e.target.value)} placeholder="DD-MM-YYYY" /></Field>
        </div>
      </div>

      <div className="border border-stone-300 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">Banking — domestic (₹)</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank name"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.bankName} onChange={(e) => set("bankName", e.target.value)} /></Field>
          <Field label="Branch"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.bankBranch} onChange={(e) => set("bankBranch", e.target.value)} /></Field>
          <Field label="Beneficiary name"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.beneficiaryName} onChange={(e) => set("beneficiaryName", e.target.value)} /></Field>
          <Field label="Account number"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.accountNumber} onChange={(e) => set("accountNumber", e.target.value)} /></Field>
          <Field label="IFSC"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.ifsc} onChange={(e) => set("ifsc", e.target.value)} /></Field>
        </div>
      </div>

      <div className="border border-stone-300 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">Banking — international</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SWIFT code"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.swift} onChange={(e) => set("swift", e.target.value)} /></Field>
          <Field label="Intermediary bank (one line)"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.intermediaryBank} onChange={(e) => set("intermediaryBank", e.target.value)} /></Field>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-stone-300 pt-3">
        <button
          disabled={busy}
          onClick={submit}
          className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />} Save
        </button>
      </div>

      {drawingSig && (
        <SignatureDrawModal
          onCancel={() => setDrawingSig(false)}
          onSave={(dataUrl) => { setSig(dataUrl); setDrawingSig(false); }}
        />
      )}
    </div>
  );
}

// =============================================================
// Canvas-based signature pad. Pointer events cover mouse, trackpad,
// touch, and pen (stylus on iPad / Surface) uniformly. The canvas is
// rendered at 2× CSS resolution so the resulting PNG is crisp on
// retina displays + when scaled into the invoice header. White is
// the canvas background so the saved PNG composites cleanly over
// either a white or coloured invoice; if you need transparent, switch
// to clearRect on init and skip the white fill.
// =============================================================
function SignatureDrawModal({ onCancel, onSave }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const dirtyLocal = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    // 2x backing store for crisp retina output. The CSS size stays
    // 560x180; the canvas internal buffer is 1120x360 so the toDataURL
    // PNG is high-resolution.
    const cssW = 560, cssH = 180;
    c.width = cssW * 2;
    c.height = cssH * 2;
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    const ctx = c.getContext("2d");
    ctx.scale(2, 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  const pointAt = (e) => {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e) => {
    e.preventDefault();
    drawingRef.current = true;
    lastPointRef.current = pointAt(e);
    if (e.target.setPointerCapture) {
      try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  };
  const onMove = (e) => {
    if (!drawingRef.current) return;
    const p = pointAt(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPointRef.current = p;
    dirtyLocal.current = true;
    if (!hasInk) setHasInk(true);
  };
  const onUp = () => { drawingRef.current = false; lastPointRef.current = null; };

  const clear = () => {
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width / 2, c.height / 2);
    dirtyLocal.current = false;
    setHasInk(false);
  };

  const save = () => {
    if (!hasInk) return;
    const dataUrl = canvasRef.current.toDataURL("image/png");
    onSave(dataUrl);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onCancel}>
      <div className="w-full max-w-xl border border-stone-300 bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#cc785c]">Signature</div>
        <div className="mb-3 font-serif text-xl text-stone-900">Draw your signature</div>
        <p className="mb-3 text-xs text-stone-700">Use mouse, trackpad, finger, or stylus. The saved PNG is stamped at the bottom of approved invoices.</p>
        <div className="relative">
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            onPointerCancel={onUp}
            className="block border border-dashed border-stone-300 bg-white touch-none cursor-crosshair"
            style={{ width: 560, height: 180 }}
          />
          {!hasInk && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] italic text-stone-400">
              sign here
            </div>
          )}
          <button
            type="button"
            onClick={clear}
            className="absolute right-1 top-1 inline-flex items-center gap-1 border border-stone-300 bg-white/80 px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-700"
          >
            Clear
          </button>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2 border-t border-stone-200 pt-3">
          <button onClick={onCancel} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!hasInk}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f] disabled:opacity-40"
          >
            Use signature
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Wizard — Type → Customer → Items → Review
// =============================================================

const STEPS = ["Type", "Customer", "Items", "Review"];

// Test-data autofill used by the ⚡ button on the Customer step.
// Numbers and identifiers are deliberately fictional — they exist
// to exercise the wizard, totals, and PDF output, not to ship.
function sampleFillFor(type) {
  if (type === "retail") {
    return {
      customer: {
        name: "Aarav Patel (parent)",
        email: "aarav.patel@example.com",
        phone: "+91 98200 12345",
        state: "Maharashtra",
        stateCode: "27",
        gstin: "",
        address: "Flat 4B, Sunrise Apartments, Linking Road, Bandra West, Mumbai 400050",
      },
      lineItems: [{
        id: uid(),
        studentName: "Diya Patel",
        service: "End-to-end UK admissions support: shortlisting, SOP review, application & visa guidance",
        amount: 75000,
      }],
    };
  }
  if (type === "b2b") {
    return {
      customer: {
        name: "GreenLeaf Edu Services Pvt Ltd",
        email: "accounts@greenleafedu.in",
        phone: "+91 80 4567 8901",
        state: "Karnataka",
        stateCode: "29",
        gstin: "29AABCG1234D1Z5",
        address: "No 21, 2nd Cross, Indiranagar, Bengaluru 560038",
      },
      lineItems: [{
        id: uid(),
        poNumber: "GL-PO-2026-104",
        studentName: "Rahul Mehta",
        intake: "Sep-2026",
        course: "MSc Data Science",
        university: "University of Manchester",
        commission: 120000,
      }],
    };
  }
  if (type === "b2b_lut") {
    return {
      customer: {
        name: "Bridgeway Global SEZ Unit",
        email: "ap@bridgeway-global.example",
        phone: "+91 40 4023 1100",
        state: "Telangana",
        stateCode: "36",
        gstin: "36AABCB7788E1Z2",
        address: "Plot 14, IT SEZ, Madhapur, Hyderabad 500081",
      },
      lineItems: [{
        id: uid(),
        poNumber: "BG-PO-2026-077",
        studentName: "Priya Iyer",
        intake: "Jan-2027",
        course: "MA International Relations",
        university: "King's College London",
        commission: 145000,
      }],
    };
  }
  if (type === "b2b_intl") {
    return {
      currency: "GBP",
      customer: {
        name: "Northbridge Education Partners Ltd",
        email: "finance@northbridge.example",
        phone: "+44 20 7946 0102",
        state: "United Kingdom",
        stateCode: "",
        gstin: "",
        address: "12 Carlisle Street, Soho, London W1D 3BP, United Kingdom",
      },
      lineItems: [{
        id: uid(),
        siukId: "NB-2026-00412",
        firstName: "Ananya",
        familyName: "Krishnan",
        course: "MSc Finance",
        university: "Durham University",
        enrolmentDate: "2026-09-21",
        tuitionFee: 28500,
        uniRate: 15,
        partnerRate: 5,
        commission: 2850,
      }],
    };
  }
  return null;
}

// ============================================================
// Partners view — manage the saved B2B business list
// ============================================================

const EMPTY_PARTNER_FORM = { name: "", email: "", phone: "", state: "", stateCode: "", gstin: "", address: "" };

function PartnersView({ partners, onRefresh }) {
  const [editing, setEditing] = useState(null); // null | "new" | partner object
  const [form, setForm] = useState(EMPTY_PARTNER_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [err, setErr] = useState(null);

  const pset = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const openNew = () => { setForm(EMPTY_PARTNER_FORM); setEditing("new"); setErr(null); };
  const openEdit = (p) => {
    setForm({ name: p.name, email: p.email, phone: p.phone, state: p.state, stateCode: p.stateCode, gstin: p.gstin, address: p.address });
    setEditing(p);
    setErr(null);
  };
  const cancel = () => { setEditing(null); setErr(null); };

  const save = async () => {
    if (!form.name.trim()) { setErr("Business name is required."); return; }
    setSaving(true);
    setErr(null);
    try {
      if (editing === "new") {
        await api.createPartner(form);
      } else {
        await api.updatePartner(editing.id, form);
      }
      await onRefresh();
      setEditing(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!confirm("Remove this partner? This won't affect existing invoices.")) return;
    setDeleting(id);
    try {
      await api.deletePartner(id);
      await onRefresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Saved Partners</h2>
          <p className="mt-0.5 text-sm text-stone-800">Business details saved here pre-fill the customer step when creating B2B invoices.</p>
        </div>
        {!editing && (
          <button onClick={openNew} className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f]">
            <Plus className="h-3 w-3" /> Add partner
          </button>
        )}
      </div>

      {err && (
        <div className="flex items-start justify-between border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>{err}</span>
          <button onClick={() => setErr(null)} className="ml-2 text-red-600 hover:text-red-900"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {editing && (
        <div className="border border-stone-400 bg-white p-4 space-y-3">
          <p className="text-[11px] uppercase tracking-[0.15em] text-stone-600">{editing === "new" ? "New partner" : "Edit partner"}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Business name" w="col-span-2">
              <input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={form.name} onChange={(e) => pset("name", e.target.value)} />
            </Field>
            <Field label="Email"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={form.email} onChange={(e) => pset("email", e.target.value)} /></Field>
            <Field label="Phone"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={form.phone} onChange={(e) => pset("phone", e.target.value)} /></Field>
            <Field label="State / Country">
              <select className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={form.state} onChange={(e) => pset("state", e.target.value)}>
                <option value="">— select state —</option>
                {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                <option disabled>──────</option>
                <option value="United Kingdom">United Kingdom</option>
                <option value="United States">United States</option>
                <option value="Australia">Australia</option>
                <option value="Canada">Canada</option>
                <option value="Other">Other</option>
              </select>
            </Field>
            <Field label="State code"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={form.stateCode} onChange={(e) => pset("stateCode", e.target.value)} placeholder="e.g. 27" /></Field>
            <Field label="GSTIN"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={form.gstin} onChange={(e) => pset("gstin", e.target.value)} /></Field>
            <Field label="Address" w="col-span-2">
              <textarea rows={2} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={form.address} onChange={(e) => pset("address", e.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 border border-stone-900 bg-stone-900 px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-white hover:bg-stone-700 disabled:opacity-50">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Save
            </button>
            <button onClick={cancel} className="border border-stone-300 px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-stone-700 hover:border-stone-900">Cancel</button>
          </div>
        </div>
      )}

      {partners.length === 0 && !editing ? (
        <div className="border border-dashed border-stone-300 bg-stone-50 px-4 py-8 text-center text-sm text-stone-700">
          No saved partners yet. Add a partner above and it will appear in the dropdown when creating B2B invoices.
        </div>
      ) : (
        <div className="divide-y divide-stone-200 border border-stone-300 bg-white">
          {partners.map((p) => (
            <div key={p.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-stone-900">{p.name}</p>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-700">
                  {p.gstin && <span className="font-mono">GSTIN: {p.gstin}</span>}
                  {p.state && <span>{p.state}{p.stateCode ? ` (${p.stateCode})` : ""}</span>}
                  {p.email && <span>{p.email}</span>}
                  {p.phone && <span>{p.phone}</span>}
                </div>
                {p.address && <p className="mt-0.5 text-xs text-stone-600">{p.address}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button onClick={() => openEdit(p)} className="border border-stone-300 p-1 text-stone-600 hover:border-stone-700 hover:text-stone-900" title="Edit"><Edit2 className="h-3 w-3" /></button>
                <button onClick={() => remove(p.id)} disabled={deleting === p.id} className="border border-stone-300 p-1 text-stone-600 hover:border-red-400 hover:text-red-600 disabled:opacity-40" title="Remove">
                  {deleting === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Wizard({ step, setStep, draft, setDraft, company, partners, onPartnerSaved, onChooseType, onConfirm, onApprove, onCancel }) {
  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button onClick={onCancel} className="inline-flex items-center gap-1 text-[12px] text-stone-700 underline hover:text-stone-900">
          <ChevronLeft className="h-3 w-3" /> Back
        </button>
      </div>
      <div className="mb-5 flex items-center gap-2 border-b border-stone-300 pb-3 text-[11px] uppercase tracking-[0.14em]">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const active = step === n;
          const done = step > n;
          return (
            <button
              key={s}
              disabled={!draft && n > 1}
              onClick={() => { if (draft || n === 1) setStep(n); }}
              className={
                active
                  ? "inline-flex items-center gap-1.5 border border-stone-900 bg-stone-900 px-2.5 py-1 text-white"
                  : done
                  ? "inline-flex items-center gap-1.5 border border-stone-400 bg-stone-100 px-2.5 py-1 text-stone-700"
                  : "inline-flex items-center gap-1.5 border border-stone-300 px-2.5 py-1 text-stone-500"
              }
            >
              <span className="font-mono">{done ? "✓" : `0${n}`}</span> {s}
            </button>
          );
        })}
      </div>

      {step === 1 && <StepType onChoose={onChooseType} />}
      {step === 2 && draft && <StepCustomer draft={draft} setDraft={setDraft} partners={partners || []} onPartnerSaved={onPartnerSaved} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
      {step === 3 && draft && <StepItems draft={draft} setDraft={setDraft} company={company} onBack={() => setStep(2)} onNext={() => setStep(4)} />}
      {step === 4 && draft && (
        <StepReview
          draft={draft}
          setDraft={setDraft}
          company={company}
          onBack={() => setStep(3)}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
}

function StepType({ onChoose }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Object.entries(INVOICE_TYPES).map(([key, meta]) => (
        <button
          key={key}
          onClick={() => onChoose(key)}
          className="group flex flex-col gap-2 border border-stone-300 bg-white p-4 text-left transition hover:border-[#cc785c]"
        >
          <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">{meta.sub}</div>
          <div className="text-base font-semibold text-stone-900">{meta.label}</div>
          <div className="text-[12px] text-stone-700">{meta.rule}</div>
          <div className="mt-2 inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.18em] text-[#cc785c] opacity-0 transition group-hover:opacity-100">
            Continue <ChevronRight className="h-3 w-3" />
          </div>
        </button>
      ))}
    </div>
  );
}

function StepCustomer({ draft, setDraft, partners, onPartnerSaved, onBack, onNext }) {
  const c = draft.customer || {};
  const set = (k, v) => setDraft((p) => ({ ...p, customer: { ...p.customer, [k]: v } }));
  const isIntl = draft.type === "b2b_intl";
  const isB2B = draft.type !== "retail";
  const [savingPartner, setSavingPartner] = useState(false);
  const [partnerFlash, setPartnerFlash] = useState(null); // "saved" | "exists"

  const applyPartner = (partnerId) => {
    if (!partnerId) return;
    const p = partners.find((x) => x.id === partnerId);
    if (!p) return;
    setDraft((prev) => ({
      ...prev,
      customer: { name: p.name, email: p.email, phone: p.phone, state: p.state, stateCode: p.stateCode, gstin: p.gstin, address: p.address },
    }));
  };

  const saveToPartners = async () => {
    if (!c.name) return;
    setSavingPartner(true);
    setPartnerFlash(null);
    try {
      await api.createPartner({ name: c.name, email: c.email, phone: c.phone, state: c.state, stateCode: c.stateCode, gstin: c.gstin, address: c.address });
      await onPartnerSaved();
      setPartnerFlash("saved");
      setTimeout(() => setPartnerFlash(null), 2500);
    } catch {
      setPartnerFlash("error");
      setTimeout(() => setPartnerFlash(null), 2500);
    } finally {
      setSavingPartner(false);
    }
  };

  const autofill = () => {
    const sample = sampleFillFor(draft.type);
    if (!sample) return;
    const hasData =
      (c.name || c.email || c.phone || c.address) ||
      (draft.lineItems || []).some((li) =>
        li.studentName || li.firstName || li.service || li.course || li.university ||
        Number(li.amount) || Number(li.commission) || Number(li.tuitionFee)
      );
    if (hasData && !confirm("Replace the current customer details and line items with sample test data?")) return;
    setDraft((p) => ({
      ...p,
      customer: { ...sample.customer },
      lineItems: sample.lineItems,
      ...(sample.currency ? { currency: sample.currency } : {}),
    }));
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={autofill}
          title="Fill customer and line items with sample test data"
          className="inline-flex items-center gap-1 border border-stone-300 bg-stone-100 px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-stone-800 hover:border-[#cc785c] hover:bg-[#cc785c]/10 hover:text-[#cc785c]"
        >
          <Zap className="h-3 w-3" /> Fill with sample
        </button>
      </div>

      {isB2B && (
        <div className="flex items-center gap-3 border border-stone-300 bg-stone-50 px-3 py-2.5">
          <Building2 className="h-3.5 w-3.5 shrink-0 text-stone-500" />
          <span className="text-[11px] uppercase tracking-[0.15em] text-stone-600 whitespace-nowrap">Saved partner</span>
          <select
            className="flex-1 border border-stone-300 bg-white px-2 py-1 text-sm"
            value=""
            onChange={(e) => applyPartner(e.target.value)}
          >
            <option value="">— select to pre-fill —</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.gstin ? ` · ${p.gstin}` : ""}</option>
            ))}
          </select>
          {partners.length === 0 && (
            <span className="text-xs text-stone-500">No saved partners yet</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 border border-stone-300 bg-white p-4">
        <Field label="Invoice number"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={draft.invoiceNumber} onChange={(e) => setDraft((p) => ({ ...p, invoiceNumber: e.target.value }))} /></Field>
        <Field label="Date"><input type="date" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={draft.date} onChange={(e) => setDraft((p) => ({ ...p, date: e.target.value }))} /></Field>
        {isIntl && (
          <Field label="Currency">
            <select className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={draft.currency || "GBP"} onChange={(e) => setDraft((p) => ({ ...p, currency: e.target.value }))}>
              {CURRENCIES.map((cur) => <option key={cur} value={cur}>{cur}</option>)}
            </select>
          </Field>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 border border-stone-300 bg-white p-4">
        <Field label={draft.type === "retail" ? "Customer name (student / parent)" : "Business name"}>
          <input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.name || ""} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Email"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.email || ""} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Phone"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.phone || ""} onChange={(e) => set("phone", e.target.value)} /></Field>
        {!isIntl && (
          <>
            <Field label="State (controls CGST/SGST vs IGST)">
              <select className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.state || ""} onChange={(e) => set("state", e.target.value)}>
                <option value="">— select state —</option>
                {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="State code"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.stateCode || ""} onChange={(e) => set("stateCode", e.target.value)} placeholder="e.g. 27" /></Field>
            <Field label="GSTIN (business customers)"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={c.gstin || ""} onChange={(e) => set("gstin", e.target.value)} /></Field>
          </>
        )}
        {isIntl && (
          <Field label="Country / region"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.state || ""} onChange={(e) => set("state", e.target.value)} placeholder="e.g. United Kingdom" /></Field>
        )}
        <Field label="Address" w="col-span-2"><textarea rows={3} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={c.address || ""} onChange={(e) => set("address", e.target.value)} /></Field>
      </div>

      {isB2B && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={saveToPartners}
            disabled={savingPartner || !c.name}
            className="inline-flex items-center gap-1.5 border border-stone-300 bg-stone-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-stone-700 hover:border-stone-900 hover:bg-stone-100 disabled:opacity-40"
          >
            {savingPartner ? <Loader2 className="h-3 w-3 animate-spin" /> : <Building2 className="h-3 w-3" />}
            {partnerFlash === "saved" ? "Saved!" : "Save to partners"}
          </button>
          {partnerFlash === "saved" && <span className="text-xs text-stone-600">Business added to saved partners</span>}
          {partnerFlash === "error" && <span className="text-xs text-red-700">Could not save — try again</span>}
        </div>
      )}

      <WizNav onBack={onBack} onNext={onNext} nextDisabled={!c.name} />
    </div>
  );
}

function StepItems({ draft, setDraft, company, onBack, onNext }) {
  const setItems = (lineItems) => setDraft((p) => ({ ...p, lineItems }));
  const addItem = () => {
    const empty = blankInvoice(draft.type, "").lineItems[0];
    setItems([...(draft.lineItems || []), { ...empty, id: uid() }]);
  };
  const updateItem = (id, patch) => setItems(draft.lineItems.map((li) => li.id === id ? { ...li, ...patch } : li));
  const removeItem = (id) => setItems(draft.lineItems.filter((li) => li.id !== id));

  const totals = totalsFor(draft, company.state);
  const sym = draft.type === "b2b_intl" ? CURRENCY_SYMBOLS[draft.currency] || `${draft.currency} ` : "₹ ";

  return (
    <div className="space-y-4">
      {draft.lineItems.map((li, idx) => (
        <LineItemEditor
          key={li.id}
          type={draft.type}
          item={li}
          index={idx}
          onChange={(patch) => updateItem(li.id, patch)}
          onRemove={() => removeItem(li.id)}
          canRemove={draft.lineItems.length > 1}
          currency={draft.currency}
        />
      ))}
      <button
        onClick={addItem}
        className="inline-flex w-full items-center justify-center gap-2 border border-dashed border-stone-400 bg-stone-50 px-3 py-2 text-sm text-stone-700 hover:bg-[#cc785c]/10 hover:text-[#cc785c]"
      >
        <Plus className="h-3 w-3" /> Add another line item
      </button>

      <div className="border border-stone-300 bg-white p-3 text-sm">
        <div className="flex justify-between"><span className="text-stone-700">Subtotal</span><span className="font-mono">{sym}{formatNum(totals.subtotal)}</span></div>
        {totals.cgst > 0 && <div className="flex justify-between"><span className="text-stone-700">CGST 9%</span><span className="font-mono">{sym}{formatNum(totals.cgst)}</span></div>}
        {totals.sgst > 0 && <div className="flex justify-between"><span className="text-stone-700">SGST 9%</span><span className="font-mono">{sym}{formatNum(totals.sgst)}</span></div>}
        {totals.igst > 0 && <div className="flex justify-between"><span className="text-stone-700">IGST 18%</span><span className="font-mono">{sym}{formatNum(totals.igst)}</span></div>}
        <div className="mt-2 flex justify-between border-t border-stone-300 pt-2 text-base font-semibold"><span>Grand total</span><span className="font-mono">{sym}{formatNum(totals.grand)}</span></div>
        {totals.taxType === "unset" && draft.type !== "b2b_lut" && draft.type !== "b2b_intl" && (
          <div className="mt-2 text-[11px] text-amber-800">Pick the customer's state on the previous step so GST can be applied correctly.</div>
        )}
      </div>

      <WizNav onBack={onBack} onNext={onNext} nextDisabled={false} />
    </div>
  );
}

function LineItemEditor({ type, item, index, onChange, onRemove, canRemove, currency }) {
  const sym = currency ? (CURRENCY_SYMBOLS[currency] || `${currency} `) : "₹ ";
  return (
    <div className="border border-stone-300 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Line {String(index + 1).padStart(2, "0")}</span>
        {canRemove && (
          <button onClick={onRemove} className="text-stone-500 hover:text-red-600" title="Remove line">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {type === "retail" && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Student name"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.studentName || ""} onChange={(e) => onChange({ studentName: e.target.value })} /></Field>
          <Field label="Service" w="col-span-2"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.service || ""} onChange={(e) => onChange({ service: e.target.value })} placeholder="e.g. SOP review and university shortlisting" /></Field>
          <Field label={`Amount (${sym.trim()})`}><input type="number" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.amount || ""} onChange={(e) => onChange({ amount: parseFloat(e.target.value) || 0 })} /></Field>
        </div>
      )}

      {(type === "b2b" || type === "b2b_lut") && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="PO number"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.poNumber || ""} onChange={(e) => onChange({ poNumber: e.target.value })} /></Field>
          <Field label="Student name"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.studentName || ""} onChange={(e) => onChange({ studentName: e.target.value })} /></Field>
          <Field label="Intake"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.intake || ""} onChange={(e) => onChange({ intake: e.target.value })} placeholder="e.g. Sep-2026" /></Field>
          <Field label="Course" w="col-span-2"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.course || ""} onChange={(e) => onChange({ course: e.target.value })} /></Field>
          <Field label={`Commission (${sym.trim()})`}><input type="number" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.commission || ""} onChange={(e) => onChange({ commission: parseFloat(e.target.value) || 0 })} /></Field>
          <Field label="University" w="col-span-3"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.university || ""} onChange={(e) => onChange({ university: e.target.value })} /></Field>
        </div>
      )}

      {type === "b2b_intl" && (
        <div className="grid grid-cols-4 gap-3">
          <Field label="Partner ID"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.siukId || ""} onChange={(e) => onChange({ siukId: e.target.value })} /></Field>
          <Field label="First name"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.firstName || ""} onChange={(e) => onChange({ firstName: e.target.value })} /></Field>
          <Field label="Family name"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.familyName || ""} onChange={(e) => onChange({ familyName: e.target.value })} /></Field>
          <Field label="Enrolment date"><input type="date" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.enrolmentDate || ""} onChange={(e) => onChange({ enrolmentDate: e.target.value })} /></Field>
          <Field label="University" w="col-span-2"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.university || ""} onChange={(e) => onChange({ university: e.target.value })} /></Field>
          <Field label="Course" w="col-span-2"><input className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={item.course || ""} onChange={(e) => onChange({ course: e.target.value })} /></Field>
          <Field label={`Tuition fee (${sym.trim()})`}><input type="number" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.tuitionFee || ""} onChange={(e) => onChange({ tuitionFee: parseFloat(e.target.value) || 0 })} /></Field>
          <Field label="University rate %"><input type="number" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.uniRate || ""} onChange={(e) => onChange({ uniRate: parseFloat(e.target.value) || 0 })} /></Field>
          <Field label="Partner rate %"><input type="number" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.partnerRate || ""} onChange={(e) => onChange({ partnerRate: parseFloat(e.target.value) || 0 })} /></Field>
          <Field label={`Commission (${sym.trim()})`}><input type="number" className="w-full border border-stone-300 bg-white px-2 py-1 text-sm font-mono" value={item.commission || ""} onChange={(e) => onChange({ commission: parseFloat(e.target.value) || 0 })} /></Field>
        </div>
      )}
    </div>
  );
}

function StepReview({ draft, setDraft, company, onBack, onConfirm }) {
  const totals = totalsFor(draft, company.state);
  const sym = draft.type === "b2b_intl" ? CURRENCY_SYMBOLS[draft.currency] || `${draft.currency} ` : "₹ ";
  return (
    <div className="space-y-4">
      <div className="border border-stone-300 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">Review summary</div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Row k="Type" v={INVOICE_TYPES[draft.type]?.label} />
          <Row k="Number" v={draft.invoiceNumber} />
          <Row k="Date" v={formatDate(draft.date)} />
          <Row k="Customer" v={draft.customer?.name || "—"} />
          <Row k="State" v={draft.customer?.state || "—"} />
          <Row k="Line items" v={(draft.lineItems || []).length} />
        </div>
        <Field label="Notes (optional)" w="mt-3">
          <textarea rows={2} className="w-full border border-stone-300 bg-white px-2 py-1 text-sm" value={draft.notes || ""} onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))} />
        </Field>
      </div>

      <div className="border border-stone-300 bg-white p-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Subtotal</div><div className="font-mono">{sym}{formatNum(totals.subtotal)}</div></div>
          <div><div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Tax</div><div className="font-mono">{sym}{formatNum(totals.cgst + totals.sgst + totals.igst)}</div></div>
          <div className="col-span-2 border-t border-stone-300 pt-2"><div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Grand total</div><div className="text-lg font-semibold font-mono">{sym}{formatNum(totals.grand)}</div></div>
        </div>
      </div>

      <WizNav
        onBack={onBack}
        nextLabel="Save Draft"
        onNext={onConfirm}
      />
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">{k}</div>
      <div className="text-sm text-stone-900">{v}</div>
    </div>
  );
}

function WizNav({ onBack, onNext, nextLabel = "Next", nextDisabled, extra }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-300 pt-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-900 hover:bg-stone-50">
        <ChevronLeft className="h-3 w-3" /> Back
      </button>
      <div className="flex flex-wrap items-center gap-2">
        {extra}
        {onNext && (
          <button
            disabled={nextDisabled}
            onClick={onNext}
            className="inline-flex items-center gap-1 border border-[#cc785c] bg-[#cc785c] px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-[#b86a4f] disabled:opacity-40"
          >
            {nextLabel} <ChevronRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// =============================================================
// Preview view — prints the invoice + offers approve / PDF
// =============================================================

function PreviewView({ invoice, company, logoBase64, signatureBase64, onBack, onEdit, onApprove, onRevert, onDelete }) {
  const totals = totalsFor(invoice, company.state);
  const sym = invoice.type === "b2b_intl" ? CURRENCY_SYMBOLS[invoice.currency] || `${invoice.currency} ` : "₹ ";

  async function printAndBackup() {
    // Print path uses the browser's print dialog (Save as PDF). After
    // the dialog closes, capture the actual rendered HTML as a PDF via
    // window.print → afterprint, and upload to /pdf for R2 backup.
    // True PDF rendering would need @react-pdf/renderer (already in
    // the project) — wiring that template is a follow-up. For now this
    // gives Jyoti a usable Save-as-PDF flow and lets the backup happen
    // when she clicks "Save PDF to backup" below (uses a fetched PDF
    // path in a future cut).
    window.print();
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <button onClick={onBack} className="inline-flex items-center gap-1 text-[12px] text-stone-700 underline hover:text-stone-900">
          <ChevronLeft className="h-3 w-3" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {!invoice.approved && (
            <button onClick={onEdit} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-900 hover:bg-stone-50">
              <Edit2 className="h-3 w-3" /> Edit
            </button>
          )}
          {invoice.approved && (
            <button onClick={onRevert} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-900 hover:bg-stone-50">
              Revert to draft
            </button>
          )}
          <button onClick={printAndBackup} className="inline-flex items-center gap-1 border border-stone-400 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-900 hover:bg-stone-50">
            <Printer className="h-3 w-3" /> Print / Save PDF
          </button>
          {!invoice.approved && (
            <button onClick={onApprove} className="inline-flex items-center gap-1 border border-emerald-700 bg-emerald-700 px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-emerald-800">
              Approve & sign
            </button>
          )}
          {!invoice.approved && (
            <button onClick={onDelete} className="inline-flex items-center gap-1 border border-red-500 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-red-700 hover:bg-red-50">
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="bg-white p-8 print:p-0">
        <PrintableInvoice
          invoice={invoice}
          company={company}
          logoBase64={logoBase64}
          signatureBase64={signatureBase64}
          totals={totals}
          sym={sym}
        />
      </div>
    </div>
  );
}

function PrintableInvoice({ invoice, company, logoBase64, signatureBase64, totals, sym }) {
  return (
    <div className="mx-auto max-w-[800px] border border-stone-300 bg-white p-10 text-stone-900 print:border-none print:p-0">
      <div className="border-b border-stone-300 pb-4 text-center">
        {logoBase64 && <img src={logoBase64} alt="logo" className="mx-auto mb-2 max-h-14" />}
        <div className="text-[10px] uppercase tracking-[0.28em] text-stone-500">Tax Invoice</div>
        <div className="mt-1 text-xl font-semibold">{company.name || "—"}</div>
        <div className="text-[11px] text-stone-700">{company.address || "—"}</div>
        {company.altAddress && <div className="text-[11px] text-stone-700">{company.altAddress}</div>}
        <div className="text-[11px] text-stone-700">
          {company.phone && <>Tel: {company.phone} · </>}
          {company.email && <>{company.email} · </>}
          {company.website && <>{company.website}</>}
        </div>
        <div className="text-[11px] text-stone-700">
          <span className="font-semibold">GSTIN:</span> {company.gstin || "—"}
          {company.pan && <> · <span className="font-semibold">PAN:</span> {company.pan}</>}
          {company.sacCode && <> · <span className="font-semibold">SAC:</span> {company.sacCode}</>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 border-b border-stone-300 py-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">Bill to</div>
          <div className="mt-1 font-semibold">{invoice.customer?.name || "—"}</div>
          {invoice.customer?.address && <div className="whitespace-pre-line text-[12px] text-stone-700">{invoice.customer.address}</div>}
          {invoice.customer?.gstin && <div className="text-[11px] text-stone-700"><span className="font-semibold">GSTIN:</span> {invoice.customer.gstin}</div>}
          {invoice.customer?.state && <div className="text-[11px] text-stone-700"><span className="font-semibold">State:</span> {invoice.customer.state}{invoice.customer.stateCode && ` (${invoice.customer.stateCode})`}</div>}
        </div>
        <div className="text-right text-[12px]">
          <div><span className="text-stone-500">Invoice #:</span> <span className="font-semibold">{invoice.invoiceNumber}</span></div>
          <div><span className="text-stone-500">Date:</span> {formatDate(invoice.date)}</div>
          <div><span className="text-stone-500">Type:</span> {INVOICE_TYPES[invoice.type]?.label}</div>
          {invoice.type === "b2b_lut" && (invoice.lutN || company.lutn) && (
            <div><span className="text-stone-500">LUT:</span> {invoice.lutN || company.lutn}{(invoice.lutDate || company.lutDate) && ` · ${invoice.lutDate || company.lutDate}`}</div>
          )}
        </div>
      </div>

      <table className="mt-4 w-full text-[12px]">
        <thead>
          <tr className="border-b-2 border-stone-900 text-left text-[10px] uppercase tracking-[0.1em] text-stone-600">
            <th className="px-1 py-2">#</th>
            <th className="px-1 py-2">Description</th>
            <th className="px-1 py-2 text-right">{invoice.type === "retail" ? "Amount" : "Commission"}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((li, idx) => (
            <tr key={li.id} className="border-b border-stone-200 align-top">
              <td className="px-1 py-2 text-stone-500">{String(idx + 1).padStart(2, "0")}</td>
              <td className="px-1 py-2">
                {invoice.type === "retail" && (
                  <>
                    <div className="font-semibold">{li.studentName}</div>
                    <div className="text-stone-700">{li.service}</div>
                  </>
                )}
                {(invoice.type === "b2b" || invoice.type === "b2b_lut") && (
                  <>
                    <div className="font-semibold">{li.studentName} — {li.course}</div>
                    <div className="text-stone-700">{li.university}{li.intake && ` · ${li.intake}`}</div>
                    {li.poNumber && <div className="text-[10px] text-stone-500">PO: {li.poNumber}</div>}
                  </>
                )}
                {invoice.type === "b2b_intl" && (
                  <>
                    <div className="font-semibold">{li.firstName} {li.familyName} — {li.course}</div>
                    <div className="text-stone-700">{li.university}{li.enrolmentDate && ` · ${formatDate(li.enrolmentDate)}`}</div>
                    <div className="text-[10px] text-stone-500">
                      {li.siukId && `ID: ${li.siukId} · `}
                      Tuition {sym}{formatNum(li.tuitionFee)} @ {li.partnerRate}%
                    </div>
                  </>
                )}
              </td>
              <td className="px-1 py-2 text-right font-mono">
                {sym}{formatNum(invoice.type === "retail" ? li.amount : li.commission)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex justify-end">
        <div className="w-72 text-[12px]">
          <div className="flex justify-between py-1"><span>Subtotal</span><span className="font-mono">{sym}{formatNum(totals.subtotal)}</span></div>
          {totals.cgst > 0 && <div className="flex justify-between py-1"><span>CGST 9%</span><span className="font-mono">{sym}{formatNum(totals.cgst)}</span></div>}
          {totals.sgst > 0 && <div className="flex justify-between py-1"><span>SGST 9%</span><span className="font-mono">{sym}{formatNum(totals.sgst)}</span></div>}
          {totals.igst > 0 && <div className="flex justify-between py-1"><span>IGST 18%</span><span className="font-mono">{sym}{formatNum(totals.igst)}</span></div>}
          <div className="mt-1 flex justify-between border-t-2 border-stone-900 py-2 text-base font-semibold"><span>Grand total</span><span className="font-mono">{sym}{formatNum(totals.grand)}</span></div>
          {invoice.type !== "b2b_intl" && (
            <div className="mt-2 text-right text-[10px] italic text-stone-600">
              {numberToIndianWords(totals.grand)}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6 border-t border-stone-300 pt-4 text-[11px]">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">Bank details</div>
          <div className="mt-1 grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5">
            <span className="text-stone-500">Bank</span><span>{company.bankName || "—"}</span>
            <span className="text-stone-500">Branch</span><span>{company.bankBranch || "—"}</span>
            <span className="text-stone-500">A/c name</span><span>{company.beneficiaryName || "—"}</span>
            <span className="text-stone-500">A/c #</span><span className="font-mono">{company.accountNumber || "—"}</span>
            <span className="text-stone-500">IFSC</span><span className="font-mono">{company.ifsc || "—"}</span>
            {invoice.type === "b2b_intl" && company.swift && <><span className="text-stone-500">SWIFT</span><span className="font-mono">{company.swift}</span></>}
            {invoice.type === "b2b_intl" && company.intermediaryBank && <><span className="text-stone-500">Via</span><span>{company.intermediaryBank}</span></>}
          </div>
        </div>
        <div>
          {invoice.type === "b2b_lut" && (
            <div className="border border-amber-300 bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-900">
              <div className="font-semibold">Declaration</div>
              SUPPLY MEANT FOR EXPORT / SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER LETTER OF UNDERTAKING (LUT) WITHOUT PAYMENT OF INTEGRATED TAX as per Rule 96A, CGST Rules 2017.
            </div>
          )}
          {invoice.type === "b2b_intl" && (
            <div className="border border-amber-300 bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-900">
              <div className="font-semibold">Declaration</div>
              EXPORT OF SERVICE. SUPPLIED WITHOUT PAYMENT OF IGST UNDER LETTER OF UNDERTAKING (LUT) per Section 16, IGST Act 2017.
            </div>
          )}
        </div>
      </div>

      {invoice.notes && (
        <div className="mt-4 border-t border-stone-300 pt-3 text-[11px] text-stone-700">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">Notes</div>
          <div className="mt-1 whitespace-pre-line">{invoice.notes}</div>
        </div>
      )}

      <div className="mt-12 flex items-end justify-between text-[11px]">
        <div className="text-stone-500 italic">Thank you for choosing {company.name || "us"}.</div>
        <div className="text-right">
          {invoice.approved && signatureBase64 && (
            <img src={signatureBase64} alt="signature" className="ml-auto mb-1 max-h-12" />
          )}
          {!invoice.approved && <div className="mb-2 h-8 border-b border-stone-400 w-44" />}
          <div className="font-semibold">{company.founder || "—"}</div>
          <div className="text-stone-600">{company.founderTitle || ""}</div>
          {invoice.approved && (
            <div className="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-emerald-700">
              <Check className="h-3 w-3" /> Signed {invoice.approvedAt && formatDate(invoice.approvedAt.slice(0, 10))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
