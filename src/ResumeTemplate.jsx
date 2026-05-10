// Renders a structured resume payload (lib/resumeSchema.js) as a
// designed single-column document. Used in two surfaces:
//
//   - Staff student-detail panel (StudentsAdmin.jsx)
//   - Student dashboard (StudentDashboard.jsx)
//
// Both consumers pass the parsed JSON straight in via the `payload`
// prop. When the row only has legacy content_md, the consumer falls
// back to <ResumeMarkdown> instead — this component owns the JSON
// path only.
//
// Visual language:
//   - Serif body, sans-serif section headings (uppercase + tracking)
//   - Section headings carry a thin accent rule below them
//   - Bullet lists use a leading bolded label + period before the body
//     (no em-dashes, banned by Stealth Mode)
//   - Single column, generous whitespace — single page when printed
//
// Print: the .resume-print scope below kicks in via @media print so
// "save as PDF" yields the same look as the screen render. The wrapping
// div carries the class so the host page's chrome can be hidden.

import {
  CURRENT_RESUME_SCHEMA_VERSION,
  normalizeResumeJson,
  RESUME_BULLET_SECTIONS,
  RESUME_INLINE_SECTIONS,
} from "../lib/resumeSchema.js";

export default function ResumeTemplate({ payload }) {
  const data = normalizeResumeJson(payload);

  if (data.schema_version > CURRENT_RESUME_SCHEMA_VERSION) {
    return (
      <div className="border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        This resume was generated with a newer schema (v{data.schema_version}).
        Refresh the page to load the latest renderer; if this persists,
        regenerate the resume.
      </div>
    );
  }

  return (
    <article className="resume-print mx-auto max-w-3xl bg-white px-10 py-12 font-serif text-black">
      <Header name={data.name} headline={data.headline} contact={data.contact} />

      {data.lede && (
        <p className="mt-6 text-base leading-relaxed text-black">{data.lede}</p>
      )}

      {RESUME_BULLET_SECTIONS.map((s) => (
        <Section key={s.key} title={s.title} items={data[s.key]} />
      ))}

      {RESUME_INLINE_SECTIONS.map((s) => (
        <InlineStrip key={s.key} title={s.title} values={data[s.key]} />
      ))}

      {data.closing_note && (
        <p className="mt-8 border-t border-stone-200 pt-6 text-base leading-relaxed text-black">
          {data.closing_note}
        </p>
      )}
    </article>
  );
}

function Header({ name, headline, contact }) {
  return (
    <header className="border-b border-stone-300 pb-5">
      <h1 className="font-sans text-3xl font-semibold uppercase tracking-[0.18em] text-black">
        {name || "(unnamed)"}
      </h1>
      {headline && (
        <p className="mt-2 text-base text-black">{headline}</p>
      )}
      {contact?.show && (contact.phone || contact.email) && (
        <p className="mt-1 text-sm text-stone-700">
          {[contact.phone, contact.email].filter(Boolean).join(" · ")}
        </p>
      )}
    </header>
  );
}

function Section({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <section className="mt-8">
      <SectionHeading>{title}</SectionHeading>
      <ul className="mt-3 space-y-3">
        {items.map((it, idx) => (
          <li key={idx} className="text-base leading-relaxed text-black">
            {it.label && (
              <span className="font-semibold text-black">{it.label}.</span>
            )}
            {it.gpa && (
              <span className="ml-2 inline-flex items-center border border-stone-700 px-1.5 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-900">
                {it.gpa}
              </span>
            )}
            {it.label && it.body && " "}
            {it.body}
            {it.meta && (
              <span className="mt-0.5 block text-sm text-stone-700">{it.meta}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function InlineStrip({ title, values }) {
  if (!values || values.length === 0) return null;
  return (
    <section className="mt-6">
      <SectionHeading>{title}</SectionHeading>
      <p className="mt-2 text-base text-black">{values.join(" · ")}</p>
    </section>
  );
}

function SectionHeading({ children }) {
  return (
    <h2 className="font-sans text-xs font-semibold uppercase tracking-[0.22em] text-black">
      <span className="border-b-2 border-stone-700 pb-1 pr-1">{children}</span>
    </h2>
  );
}
