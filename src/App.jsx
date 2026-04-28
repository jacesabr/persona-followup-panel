import LeadFollowup from "./LeadFollowup.jsx";

export default function App() {
  return (
    <div
      className="min-h-screen w-full font-serif text-stone-900"
      style={{
        backgroundColor: "#faf9f5",
      }}
    >
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-10 flex items-center justify-between border-b border-stone-200 pb-4">
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-semibold tracking-tight">Persona</span>
            <span className="text-xs uppercase tracking-[0.25em] text-stone-600">
              · Followup Panel
            </span>
          </div>
          <span className="text-[12px] uppercase tracking-[0.25em] text-stone-600">
            {import.meta.env.VITE_ADMIN_TOKEN ? "Token-gated" : "Open access · trial mode"}
          </span>
        </header>

        <LeadFollowup />
      </div>
    </div>
  );
}
