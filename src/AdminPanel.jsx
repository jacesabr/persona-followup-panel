import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import SimplePanel from "./SimplePanel.jsx";
import LeadFollowup from "./LeadFollowup.jsx";

// Admin's landing page. The new SimplePanel (Followup + Counsellor tasks
// tabs) is the primary surface; the legacy LeadFollowup admin lives below
// it in a collapsed "Old admin view" section so admins can still reach
// transcript upload, full activity log, actionables, the rich counsellor
// form, etc. — features we may pick from / retire over time.
//
// The `onPickStaff` callback is forwarded to LeadFollowup so the
// "view-as" impersonation flow (still part of the legacy panel) keeps
// working — App.jsx uses it to render the StaffDashboard with the
// "Back to admin" banner.
export default function AdminPanel({ onPickStaff }) {
  const [oldOpen, setOldOpen] = useState(false);

  return (
    <>
      <SimplePanel role="admin" />

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
