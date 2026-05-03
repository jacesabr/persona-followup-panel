import { useEffect, useState } from "react";
import {
  Loader2,
  Download,
  Copy,
  Check,
  RotateCcw,
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { listResumes, regenerateResume } from "./intakeFiles.js";

// ResumeViewer — final phase. Tabbed view of every generated resume,
// markdown rendered, with download (md, txt) and a "show provenance"
// drawer that lists every bullet and which claim ledger ids it was
// derived from. Regenerate available per resume.
export default function ResumeViewer({ onBack }) {
  const [resumes, setResumes] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [showProvenance, setShowProvenance] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busyRegen, setBusyRegen] = useState(false);

  const refresh = async () => {
    try {
      const list = await listResumes();
      setResumes(list);
      // Default to first succeeded resume if none active.
      setActiveId((cur) => {
        if (cur && list.find((r) => r.id === cur)) return cur;
        const ok = list.find((r) => r.status === "succeeded");
        return ok?.id || list[0]?.id || null;
      });
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => { refresh(); }, []);

  if (resumes == null) {
    return (
      <div className="flex flex-col items-center py-20 text-stone-500">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (resumes.length === 0) {
    return (
      <div className="py-10">
        <p className="text-sm italic text-stone-500">
          No resumes generated yet.{" "}
          <button onClick={onBack} className="underline underline-offset-4 hover:text-stone-900">
            Go back to setup
          </button>{" "}
          to make one.
        </p>
      </div>
    );
  }

  const active = resumes.find((r) => r.id === activeId) || resumes[0];

  const copyMd = async () => {
    if (!active?.contentMd) return;
    try {
      await navigator.clipboard.writeText(active.contentMd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const downloadAs = (mime, ext) => {
    if (!active?.contentMd) return;
    const blob = new Blob([active.contentMd], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(active.label || "resume").replace(/[^a-zA-Z0-9._-]/g, "_")}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const onRegen = async () => {
    if (!active) return;
    if (!confirm(`Regenerate "${active.label}"? The current version will be replaced.`)) return;
    setBusyRegen(true);
    try {
      await regenerateResume(active.id);
      await refresh();
    } catch (e) {
      alert(`Regenerate failed: ${e.message}`);
    } finally {
      setBusyRegen(false);
    }
  };

  return (
    <div className="animate-fadeUp py-8">
      <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
        Step · Your resumes
      </p>
      <h2 className="mt-2 font-serif text-3xl leading-tight md:text-4xl">
        Done — pick one or download all
      </h2>

      {/* Tab strip */}
      <div className="mt-6 flex flex-wrap gap-2 border-b border-stone-300 pb-3">
        {resumes.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveId(r.id)}
            className={`border px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] transition ${
              r.id === active?.id
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white text-stone-600 hover:border-stone-700"
            }`}
          >
            {r.label}
            <span className="ml-2 text-[9px] opacity-70">
              {r.lengthPages}p · {r.style || "—"}
            </span>
            {r.status !== "succeeded" && (
              <span className="ml-2 text-[9px] text-amber-700">{r.status}</span>
            )}
          </button>
        ))}
      </div>

      {active.status === "failed" && (
        <div className="mt-6 border border-red-300 bg-red-50 p-4">
          <p className="inline-flex items-center gap-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4" /> {active.error || "Generation failed."}
          </p>
          <button
            onClick={onRegen}
            disabled={busyRegen}
            className="mt-3 inline-flex items-center gap-2 border border-stone-700 bg-stone-700 px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-stone-800 disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" /> Regenerate
          </button>
        </div>
      )}

      {active.status === "succeeded" && (
        <>
          {/* Action bar */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button
              onClick={() => downloadAs("text/markdown", "md")}
              className="inline-flex items-center gap-1.5 border border-stone-700 bg-stone-700 px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-stone-800"
            >
              <Download className="h-3 w-3" /> Markdown (.md)
            </button>
            <button
              onClick={() => downloadAs("text/plain", "txt")}
              className="inline-flex items-center gap-1.5 border border-stone-300 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-700 transition hover:border-stone-700"
            >
              <Download className="h-3 w-3" /> Plain text (.txt)
            </button>
            <button
              onClick={copyMd}
              className="inline-flex items-center gap-1.5 border border-stone-300 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-700 transition hover:border-stone-700"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-700" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy markdown"}
            </button>
            <button
              onClick={onRegen}
              disabled={busyRegen}
              className="inline-flex items-center gap-1.5 border border-stone-300 bg-white px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-700 transition hover:border-stone-700 disabled:opacity-50"
            >
              {busyRegen ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              Regenerate
            </button>
            <span className="ml-auto text-[10px] text-stone-500">
              ~${((active.costCents || 0) / 100).toFixed(2)} · {active.exampleIds?.length || 0} style examples
            </span>
          </div>

          {/* Resume body — naive markdown render. Headings/paragraphs/
              bullet lists are enough for the copy of generator output;
              no tables / code so a tiny renderer is fine. PDF rendering
              comes later via Typst. */}
          <article className="mt-6 border border-stone-300 bg-white p-8 font-serif text-stone-900">
            <NaiveMarkdown text={active.contentMd || ""} />
          </article>

          {/* Provenance drawer */}
          <div className="mt-4">
            <button
              onClick={() => setShowProvenance((p) => !p)}
              className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em] text-stone-600 hover:text-stone-900"
            >
              {showProvenance ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Provenance — what each bullet was derived from
            </button>
            {showProvenance && (
              <ProvenanceTable snapshot={active.sourceSnapshot} />
            )}
          </div>
        </>
      )}

      <div className="mt-10 flex items-center border-t border-stone-200 pt-6">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 border border-stone-300 bg-transparent px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-stone-600 transition hover:border-stone-700 hover:text-stone-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to resume setup
        </button>
      </div>
    </div>
  );
}

// Tiny markdown renderer. We only emit headings (#, ##), bold-bracket
// header lines (**...** *(meta)*), bullets (- ), and paragraphs.
// Anything fancier, the user can copy the .md and pipe into a real
// renderer.
function NaiveMarkdown({ text }) {
  const lines = (text || "").split("\n");
  const out = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length === 0) return;
    out.push(<ul key={`ul-${out.length}`} className="ml-5 list-disc space-y-1">{buffer}</ul>);
    buffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^# /.test(ln)) {
      flush();
      out.push(<h1 key={i} className="text-2xl font-bold">{ln.slice(2)}</h1>);
    } else if (/^## /.test(ln)) {
      flush();
      out.push(<h2 key={i} className="mt-5 border-b border-stone-300 pb-1 text-sm font-bold uppercase tracking-[0.15em] text-stone-800">{ln.slice(3)}</h2>);
    } else if (/^- /.test(ln)) {
      buffer.push(<li key={i} className="text-[14px]">{renderInline(ln.slice(2))}</li>);
    } else if (ln.trim() === "") {
      flush();
    } else if (ln === "---") {
      flush();
      out.push(<hr key={i} className="my-4 border-stone-200" />);
    } else {
      flush();
      out.push(<p key={i} className="text-[14px]">{renderInline(ln)}</p>);
    }
  }
  flush();
  return <>{out}</>;
}

// Inline: **bold** and *italic*. Not a parser — just two regex passes
// applied serially. Good enough for resume content.
function renderInline(s) {
  const parts = [];
  let rest = s;
  let key = 0;
  while (rest.length > 0) {
    const bold = rest.match(/\*\*(.+?)\*\*/);
    const it = rest.match(/\*(.+?)\*/);
    const m = bold && (!it || bold.index <= it.index) ? bold : it;
    if (!m) {
      parts.push(rest);
      break;
    }
    if (m.index > 0) parts.push(rest.slice(0, m.index));
    parts.push(
      m === bold
        ? <strong key={key++}>{m[1]}</strong>
        : <em key={key++}>{m[1]}</em>
    );
    rest = rest.slice(m.index + m[0].length);
  }
  return parts;
}

function ProvenanceTable({ snapshot }) {
  let parsed = null;
  try { parsed = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot; } catch {}
  const provenance = parsed?.provenance || [];
  if (provenance.length === 0) {
    return <p className="mt-2 text-[12px] italic text-stone-500">No provenance manifest available.</p>;
  }
  return (
    <div className="mt-3 max-h-96 overflow-auto border border-stone-200 bg-stone-50 p-3 text-[12px]">
      {provenance.map((p, i) => (
        <div key={i} className="mb-3 border-b border-stone-200 pb-2 last:border-b-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-stone-500">
            {p.section}
          </p>
          <p className="mt-1 text-stone-900">{p.text}</p>
          <ul className="mt-1 ml-4 list-disc text-[11px] text-stone-600">
            {(p.sources || []).map((s, j) => (
              <li key={j}>
                <span className="font-mono text-stone-400">{s.id}</span> · {s.claim}
                {s.source_id && (
                  <span className="ml-2 font-mono text-[10px] text-stone-400">[{s.source_id}]</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {parsed?.total_rejected > 0 && (
        <p className="mt-2 text-[11px] italic text-amber-700">
          {parsed.total_rejected} bullet{parsed.total_rejected === 1 ? "" : "s"} rejected by validator (cited unknown facts).
        </p>
      )}
      {parsed?.total_drift_warnings > 0 && (
        <p className="mt-1 text-[11px] italic text-stone-600">
          {parsed.total_drift_warnings} soft warning{parsed.total_drift_warnings === 1 ? "" : "s"} (proper-noun drift; review the bullets above).
        </p>
      )}
    </div>
  );
}
