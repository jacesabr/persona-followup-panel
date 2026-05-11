// "Confident Bold" — Roboto display + Lato body, terracotta accent
// (matches the Persona brand color #cc785c). Single column with a
// chunky left-edge bar on section headings for visual rhythm.
// Best fit for design / creative roles, startups, and standout
// candidates who want a distinctive look without being loud.
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
  terracotta: "#CC785C",
  body: "#3C3C3C",
  meta: "#7A6E68",
  rule: "#E8DED8",
  cream: "#F9F5F1",
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
    paddingHorizontal: 46,
    fontFamily: "Lato",
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.38,
  },
  header: {
    marginBottom: 2,
  },
  name: {
    fontFamily: "Roboto",
    fontSize: 24,
    fontWeight: 700,
    color: COLOR.ink,
    letterSpacing: -0.5,
    // Explicit lineHeight so the line box fully contains descenders
    // ("g", "y" in names like "Aggarwal"). Without this, react-pdf
    // sometimes ignores the page-level lineHeight for single-line
    // Text and the descender punches into the headline below.
    lineHeight: 1.25,
  },
  headline: {
    marginTop: 6,
    fontFamily: "Lato",
    fontSize: 10.5,
    color: COLOR.terracotta,
    fontWeight: 700,
  },
  contact: {
    marginTop: 4,
    fontSize: 9,
    color: COLOR.meta,
    fontWeight: 300,
    letterSpacing: 0.3,
  },
  ledeBlock: {
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: COLOR.cream,
  },
  lede: {
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.45,
    fontStyle: "italic",
  },
  section: {
    marginTop: 12,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  sectionHeadingBar: {
    width: 4,
    height: 11,
    backgroundColor: COLOR.terracotta,
    marginRight: 8,
  },
  sectionHeading: {
    fontFamily: "Roboto",
    fontSize: 10.5,
    fontWeight: 700,
    color: COLOR.ink,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  sectionHeadingRule: {
    flexGrow: 1,
    marginLeft: 10,
    height: 1,
    backgroundColor: COLOR.rule,
  },
  item: {
    marginBottom: 6,
    paddingLeft: 12,
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
    fontFamily: "Lato",
    fontSize: 10.5,
    fontWeight: 700,
    color: COLOR.ink,
  },
  body: {
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.38,
  },
  meta: {
    fontSize: 9,
    color: COLOR.meta,
    fontWeight: 300,
    marginLeft: 12,
  },
  gpaChip: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: COLOR.terracotta,
    fontSize: 8,
    fontWeight: 700,
    color: "#FFFFFF",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  inlineStripValues: {
    paddingLeft: 12,
    fontSize: 10,
    color: COLOR.body,
  },
  closing: {
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 2,
    borderTopColor: COLOR.terracotta,
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.45,
    fontStyle: "italic",
  },
});

function Section({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.section} wrap={false}>
      <View style={styles.sectionHeadingRow}>
        <View style={styles.sectionHeadingBar} />
        <Text style={styles.sectionHeading}>{title}</Text>
        <View style={styles.sectionHeadingRule} />
      </View>
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
      <View style={styles.sectionHeadingRow}>
        <View style={styles.sectionHeadingBar} />
        <Text style={styles.sectionHeading}>{title}</Text>
        <View style={styles.sectionHeadingRule} />
      </View>
      <Text style={styles.inlineStripValues}>{values.join("  ·  ")}</Text>
    </View>
  );
}

export default function ConfidentBold({ payload }) {
  const data = normalizeResumeJson(payload);
  const showContact =
    data.contact?.show && (data.contact.phone || data.contact.email);

  return (
    <Document
      title={`${data.name || "Resume"} — Bold`}
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

        {data.lede ? (
          <View style={styles.ledeBlock}>
            <Text style={styles.lede}>{data.lede}</Text>
          </View>
        ) : null}

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
