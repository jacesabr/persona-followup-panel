// "Modern Confident" — Inter sans, navy + sage. Single column,
// left-aligned, contemporary humanist sans. Best fit for tech /
// consulting / finance internships and US undergrad applications.
//
// Renders the same content_json payload the AI pipeline writes (see
// lib/resumeSchema.js / automation/resume_schema_v2.md).

import "./fonts.js";
import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";
import {
  normalizeResumeJson,
  RESUME_BULLET_SECTIONS,
  RESUME_INLINE_SECTIONS,
} from "../../lib/resumeSchema.js";

const COLOR = {
  ink: "#1F1F1F",
  navy: "#2C5F7F",
  sage: "#4A635D",
  body: "#3C3C3C",
  meta: "#787878",
  rule: "#D8DEE0",
};

const styles = StyleSheet.create({
  // Tuned for single-page A4 fit at ~300-450 visible words. If a
  // payload still overflows, content is too long — trim at source
  // (lede or longest body strings) rather than retuning the
  // geometry; the runbook's pre-dispatch self-audit owns that bar.
  page: {
    backgroundColor: "#FFFFFF",
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 48,
    fontFamily: "Inter",
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.38,
  },
  header: {
    paddingBottom: 10,
    borderBottomWidth: 1.5,
    borderBottomColor: COLOR.navy,
  },
  name: {
    fontFamily: "Inter",
    fontSize: 22,
    fontWeight: 700,
    color: COLOR.ink,
    letterSpacing: -0.4,
  },
  headline: {
    marginTop: 3,
    fontSize: 10.5,
    color: COLOR.navy,
    fontWeight: 400,
  },
  contact: {
    marginTop: 4,
    fontSize: 9,
    color: COLOR.meta,
    letterSpacing: 0.2,
  },
  lede: {
    marginTop: 12,
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.45,
  },
  section: {
    marginTop: 12,
  },
  sectionHeading: {
    fontSize: 10,
    fontWeight: 700,
    color: COLOR.navy,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    paddingBottom: 3,
    borderBottomWidth: 0.75,
    borderBottomColor: COLOR.sage,
    marginBottom: 6,
  },
  item: {
    marginBottom: 6,
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 1,
  },
  itemHeaderLeft: {
    flexDirection: "row",
    alignItems: "baseline",
    flexShrink: 1,
  },
  label: {
    fontSize: 10.5,
    fontWeight: 700,
    color: COLOR.ink,
  },
  body: {
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.4,
  },
  meta: {
    fontSize: 9,
    color: COLOR.meta,
    marginLeft: 12,
  },
  gpaChip: {
    marginLeft: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: COLOR.sage,
    fontSize: 7.5,
    fontWeight: 700,
    color: "#FFFFFF",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  inlineStripValues: {
    fontSize: 10,
    color: COLOR.body,
  },
  closing: {
    marginTop: 18,
    paddingTop: 12,
    borderTopWidth: 0.75,
    borderTopColor: COLOR.rule,
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.5,
  },
});

function Section({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.section} wrap={false}>
      <Text style={styles.sectionHeading}>{title}</Text>
      {items.map((it, i) => (
        <View key={i} style={styles.item} wrap={false}>
          <View style={styles.itemHeader}>
            <View style={styles.itemHeaderLeft}>
              {it.label ? <Text style={styles.label}>{it.label}</Text> : null}
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
      <Text style={styles.sectionHeading}>{title}</Text>
      <Text style={styles.inlineStripValues}>{values.join("  ·  ")}</Text>
    </View>
  );
}

export default function ModernConfident({ payload }) {
  const data = normalizeResumeJson(payload);
  const showContact =
    data.contact?.show && (data.contact.phone || data.contact.email);

  return (
    <Document
      title={`${data.name || "Resume"} — Modern`}
      author={data.name || "Persona"}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.name}>{data.name || "(unnamed)"}</Text>
          {data.headline ? <Text style={styles.headline}>{data.headline}</Text> : null}
          {showContact ? (
            <Text style={styles.contact}>
              {[data.contact.phone, data.contact.email].filter(Boolean).join("   ·   ")}
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
