import { useCallback, useEffect, useState } from "react";
import SimplePanel from "./SimplePanel.jsx";
import { api } from "./api.js";

// Admin's landing page. The SimplePanel (Followup + Counsellor tasks +
// Counsellors tabs) is the entire admin surface.
//
// Counsellors roster is owned here (not refetched per child tab) so:
//   1. The Counsellor-tasks tab's assignee dropdown stays current when
//      admin creates a new counsellor in the Counsellors tab.
//   2. We avoid three concurrent listCounsellors() calls every time
//      admin switches tabs.
export default function AdminPanel({ onImpersonate }) {
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
    <SimplePanel
      role="admin"
      onImpersonate={onImpersonate}
      counsellors={counsellors}
      counsellorsLoading={counsellorsLoading}
      counsellorsError={counsellorsError}
      onCounsellorsChanged={refreshCounsellors}
    />
  );
}
