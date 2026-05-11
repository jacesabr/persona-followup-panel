// "Editorial Classic" — Garamond serif resume.
//
// Identity: scholarly, journalistic, quiet authority. Single column,
// centered name block, hairline rules. Best fit for Ivy League /
// Oxbridge applications, research roles, traditional fields.
//
// Renders the same content_json payload the AI pipeline writes (see
// lib/resumeSchema.js / automation/resume_schema_v2.md) so swapping
// templates needs no data reshape.

import "./fonts.js";
import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";
import {
  normalizeResumeJson,
  RESUME_BULLET_SECTIONS,
  RESUME_INLINE_SECTIONS,
} from "../../lib/resumeSchema.js";

const COLOR = {
  ink: "#2C3E50",
  body: "#3C3C3C",
  meta: "#6B6B6B",
  rule: "#CFCFCF",
  chip: "#2C3E50",
};

const styles = StyleSheet.create({
  // Layout tuned to fit a Class XI–XII undergrad applicant (~300-450
  // words across all visible text) onto a single A4 page. Page padding
  // and inter-section spacing were generous in the original template
  // and pushed Pratham's content onto a second page; tightening here
  // brings the rendered page count to 1 for typical payloads while
  // still reading as breathable typography.
  page: {
    backgroundColor: "#FFFFFF",
    paddingTop: 42,
    paddingBottom: 42,
    paddingHorizontal: 50,
    fontFamily: "EB Garamond",
    fontSize: 10.5,
    color: COLOR.body,
    lineHeight: 1.38,
  },
  header: {
    alignItems: "center",
    paddingBottom: 10,
    borderBottomWidth: 0.75,
    borderBottomColor: COLOR.rule,
  },
  name: {
    fontFamily: "EB Garamond",
    fontSize: 22,
    fontWeight: 700,
    color: COLOR.ink,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  headline: {
    marginTop: 4,
    fontSize: 10.5,
    fontStyle: "italic",
    color: COLOR.body,
  },
  contact: {
    marginTop: 3,
    fontSize: 9.5,
    color: COLOR.meta,
  },
  lede: {
    marginTop: 12,
    fontSize: 10.5,
    fontStyle: "italic",
    color: COLOR.body,
    textAlign: "justify",
    lineHeight: 1.5,
  },
  section: {
    marginTop: 12,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  sectionHeading: {
    fontSize: 9.5,
    fontWeight: 700,
    color: COLOR.ink,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  sectionRule: {
    flexGrow: 1,
    marginLeft: 10,
    height: 0.75,
    backgroundColor: COLOR.rule,
  },
  item: {
    marginBottom: 10,
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  itemHeaderLeft: {
    flexDirection: "row",
    alignItems: "baseline",
    flexShrink: 1,
  },
  label: {
    fontSize: 11.5,
    fontWeight: 700,
    color: COLOR.ink,
  },
  body: {
    fontSize: 10.5,
    color: COLOR.body,
  },
  meta: {
    fontSize: 9.5,
    fontStyle: "italic",
    color: COLOR.meta,
    marginLeft: 12,
  },
  gpaChip: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: COLOR.chip,
    fontSize: 8.5,
    fontWeight: 700,
    color: "#FFFFFF",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  inlineStripValues: {
    fontSize: 10.5,
    color: COLOR.body,
  },
  closing: {
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 0.75,
    borderTopColor: COLOR.rule,
    fontSize: 10.5,
    fontStyle: "italic",
    color: COLOR.body,
    textAlign: "justify",
    lineHeight: 1.5,
  },
});

function Section({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.section} wrap={false}>
      <View style={styles.sectionHeadingRow}>
        <Text style={styles.sectionHeading}>{title}</Text>
        <View style={styles.sectionRule} />
      </View>
      {items.map((it, i) => (
        <View key={i} style={styles.item} wrap={false}>
          <View style={styles.itemHeader}>
            <View style={styles.itemHeaderLeft}>
              {it.label ? <Text style={styles.label}>{it.label}.</Text> : null}
              {it.gpa ? <Text style={styles.gpaChip}>{it.gpa}</Text> : null}
            </View>
            {it.meta ? <Text style={styles.meta}>{it.meta}</Text> : null}
          </View>
          {it.body ? <Text style={styles.body}>{it.body}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function InlineStrip({ title, values }) {
  if (!values || values.length === 0) return null;
  return (
    <View style={styles.section} wrap={false}>
      <View style={styles.sectionHeadingRow}>
        <Text style={styles.sectionHeading}>{title}</Text>
        <View style={styles.sectionRule} />
      </View>
      <Text style={styles.inlineStripValues}>{values.join("  ·  ")}</Text>
    </View>
  );
}

export default function EditorialClassic({ payload }) {
  const data = normalizeResumeJson(payload);
  const showContact =
    data.contact?.show && (data.contact.phone || data.contact.email);

  return (
    <Document
      title={`${data.name || "Resume"} — Editorial`}
      author={data.name || "Persona"}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.name}>{data.name || "(unnamed)"}</Text>
          {data.headline ? <Text style={styles.headline}>{data.headline}</Text> : null}
          {showContact ? (
            <Text style={styles.contact}>
              {[data.contact.phone, data.contact.email].filter(Boolean).join("  ·  ")}
            </Text>
          ) : null}
        </View>

        {data.lede ? <Text style={styles.lede}>{data.lede}</Text> : null}

        {RESUME_BULLET_SECTIONS.map((s) => (
          <Section key={s.key} title={s.title} items={data[s.key]} />
        ))}

        {RESUME_INLINE_SECTIONS.map((s) => (
          <InlineStrip key={s.key} title={s.title} values={data[s.key]} />
        ))}

        {data.closing_note ? (
          <Text style={styles.closing}>{data.closing_note}</Text>
        ) : null}
      </Page>
    </Document>
  );
}
