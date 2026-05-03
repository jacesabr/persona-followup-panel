// Extractor router. Given an intake_files row, picks the right extractor
// by field_id and runs it. The field_id is the canonical routing key —
// we already KNOW marks10sheet is a 10th marksheet, so the extractor
// doesn't need to discover the doc type.

import { extractMarksheet } from "./marksheet.js";

// field_id pattern -> { extractor name (for intake_extractions.extractor),
//                       async fn(file) -> { data, model, elapsedMs, usage } }
const ROUTES = [
  { match: /^marks(10|11|12)sheet$/, name: "marksheet_v1", run: extractMarksheet },
  { match: /^marks12predictedSheet$/, name: "marksheet_v1", run: extractMarksheet },
  // More extractors will land here over time:
  //   transcript, ielts_result, toefl_result, sat_result, ap_result,
  //   passportFront/Back/Last, lor1/2/3, internship1/2/3, sop, photoFile,
  //   activities_list[*].proof, otherDocs_list[*].file
];

export function getExtractor(fieldId) {
  for (const route of ROUTES) {
    if (route.match.test(fieldId)) return route;
  }
  return null;
}

export const supportedFieldIds = () => ROUTES.map((r) => r.match.source);
