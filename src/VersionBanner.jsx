import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api.js";

// Polls /api/version and shows a "new version available" banner when the
// build string changes (i.e. Render redeployed under us). Doesn't auto-
// reload — the user might be mid-typing on a non-autosaving form. Click
// the banner to reload.
//
// Polls every 60s + on every window focus. Skipped while the document is
// hidden so background tabs don't burn requests.
const POLL_MS = 60_000;

export default function VersionBanner() {
  const [bootVersion, setBootVersion] = useState(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;
    let timer = null;

    const check = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const { version } = await api.getVersion();
        if (!active || !version) return;
        setBootVersion((prev) => {
          if (prev == null) return version;
          if (prev !== version) setStale(true);
          return prev;
        });
      } catch {
        // Ignore — could be a brief redeploy gap. Next tick retries.
      }
    };

    check();
    timer = setInterval(check, POLL_MS);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!stale) return null;

  return (
    <button
      onClick={() => window.location.reload()}
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b border-[#cc785c] bg-[#cc785c] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#b86a4f]"
      title="Reload to pick up the latest version"
    >
      <RefreshCw className="h-3 w-3" />
      New version available — click to refresh
    </button>
  );
}
