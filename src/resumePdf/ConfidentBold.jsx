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
  page: {
    backgroundColor: "#FFFFFF",
    paddingTop: 44,
    paddingBottom: 44,
    paddingHorizontal: 48,
    fontFamily: "Lato",
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.4,
  },
  header: {
    marginBottom: 4,
  },
  name: {
    fontFamily: "Roboto",
    fontSize: 26,
    fontWeight: 700,
    color: COLOR.ink,
    letterSpacing: -0.5,
  },
  headline: {
    marginTop: 4,
    fontFamily: "Lato",
    fontSize: 11,
    color: COLOR.terracotta,
    fontWeight: 700,
  },
  contact: {
    marginTop: 6,
    fontSize: 9,
    color: COLOR.meta,
    fontWeight: 300,
    letterSpacing: 0.3,
  },
  ledeBlock: {
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: COLOR.cream,
  },
  lede: {
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.5,
    fontStyle: "italic",
  },
  section: {
    marginTop: 18,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionHeadingBar: {
    width: 4,
    height: 12,
    backgroundColor: COLOR.terracotta,
    marginRight: 8,
  },
  sectionHeading: {
    fontFamily: "Roboto",
    fontSize: 11,
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
    marginBottom: 8,
    paddingLeft: 12,
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 1,
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
    lineHeight: 1.4,
  },
  meta: {
    marginTop: 1,
    fontSize: 9,
    color: COLOR.meta,
    fontWeight: 300,
  },
  gpaChip: {
    marginLeft: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: COLOR.terracotta,
    fontSize: 7.5,
    fontWeight: 700,
    color: COLOR.terracotta,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  inlineStripValues: {
    paddingLeft: 12,
    fontSize: 10,
    color: COLOR.body,
  },
  closing: {
    marginTop: 22,
    paddingTop: 14,
    borderTopWidth: 2,
    borderTopColor: COLOR.terracotta,
    fontSize: 10,
    color: COLOR.body,
    lineHeight: 1.5,
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
            {it.label ? <Text style={styles.label}>{it.label}</Text> : null}
            {it.gpa ? <Text style={styles.gpaChip}>{it.gpa}</Text> : null}
          </View>
          {it.body ? <Text style={styles.body}>{it.body}</Text> : null}
          {it.meta ? <Text style={styles.meta}>{it.meta}</Text> : null}
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
