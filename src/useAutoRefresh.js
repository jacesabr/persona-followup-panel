import { useEffect, useRef } from "react";

// Refetch shared data when the user returns to the tab and on a slow
// polling interval. Used by panels that can go stale when another user
// (admin or another counsellor) mutates the same data in their session.
//
// The callback lives in a ref so a parent passing a new closure each
// render doesn't re-bind listeners. Polling pauses while the document
// is hidden — no point hammering the server for data the user can't
// see, and the focus listener catches them the moment they come back.
export default function useAutoRefresh(refreshFn, { intervalMs = 30000 } = {}) {
  const ref = useRef(refreshFn);
  ref.current = refreshFn;

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const fn = ref.current;
      if (typeof fn === "function") fn();
    };
    const onFocus = () => tick();
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const id = setInterval(tick, intervalMs);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(id);
    };
  }, [intervalMs]);
}
