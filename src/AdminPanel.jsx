import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import SimplePanel from "./SimplePanel.jsx";
import LeadFollowup from "./LeadFollowup.jsx";
import { api } from "./api.js";

// Admin's landing page. The new SimplePanel (Followup + Counsellor tasks +
// Counsellors tabs) is the primary surface; the legacy LeadFollowup admin
// lives below it in a collapsed "Old admin view" section so admins can
// still reach transcript upload, full activity log, actionables, the rich
// counsellor form, etc. — features we may pick from / retire over time.
//
// Counsellors roster is owned here (not refetched per child tab) so that:
//   1. The Counsellor tasks tab's assignee dropdown stays current when
//      admin creates a new counsellor in the Counsellors tab.
//   2. We avoid three concurrent listCounsellors() calls every time admin
//      switches tabs.
export default function AdminPanel({ onPickStaff, onImpersonate }) {
  const [oldOpen, setOldOpen] = useState(false);
  const [counsellors, setCounsellors] = useState([]);
  const [counsellorsLoading, setCounsellorsLoading] = useState(true);
  const [counsellorsError, setCounsellorsError] = useState(null);

  // Refetchable so children (CounsellorAdmin's create / reset) can
  // request a refresh after their own mutations.
  const refreshCounsellors = useCallback(async () => {
    setCounsellorsLoading(true);
    try {
      const list = await api.listCounsellors();
      setCounsellors(list);
      setCounsellorsError(null);
    } catch (e) {
      setCounsellorsError(e.message);
    } finally {
      setCounsellorsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCounsellors();
  }, [refreshCounsellors]);

  return (
    <>
      <SimplePanel
        role="admin"
        onImpersonate={onImpersonate}
        counsellors={counsellors}
        counsellorsLoading={counsellorsLoading}
        counsellorsError={counsellorsError}
        onCounsellorsChanged={refreshCounsellors}
      />

      <div className="mt-8 border border-stone-300 bg-stone-50">
        <button
          onClick={() => setOldOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-[12px] font-bold uppercase tracking-[0.18em] text-stone-700 hover:bg-stone-100"
        >
          <span className="inline-flex items-center gap-2">
            {oldOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Old admin view
          </span>
          <span className="text-[11px] font-normal normal-case tracking-normal text-stone-500">
            {oldOpen ? "click to collapse" : "click to expand"}
          </span>
        </button>
        {oldOpen && (
          <div className="border-t border-stone-200 bg-white p-4">
            <LeadFollowup onPickStaff={onPickStaff} />
          </div>
        )}
      </div>
    </>
  );
}
