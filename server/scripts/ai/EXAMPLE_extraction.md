# Worked example — `ai_description` for a CBSE Class X marksheet

This is the reference output the agent should mirror when extracting an
uploaded file. The example is fictitious for illustration; structure
matters more than the specific values.

The full block below is what gets written to `intake_files.ai_description`
verbatim. The matching `ai_extracted` JSON is at the bottom.

---

## ai_description (markdown)

CBSE All India Senior School Certificate Examination — Class X
marksheet for Pratham Aggarwal, Roll No 7894561, Session 2023-24.
Issued by the Central Board of Secondary Education, Delhi. Single-page
A4 document, English language, with embedded school stamp and the
Controller of Examinations' signature. Reads cleanly across the full
page; no illegible regions.

### Verbatim

**CENTRAL BOARD OF SECONDARY EDUCATION**
SECONDARY SCHOOL EXAMINATION — 2024
STATEMENT OF SUBJECT-WISE PERFORMANCE

Roll No: 7894561
Name: PRATHAM AGGARWAL
Mother's Name: POOJA AGGARWAL
Father's Name: VIKAS AGGARWAL
Date of Birth: 01-06-2008
School: SAT PAUL MITTAL SCHOOL, LUDHIANA (10412)

| Code | Subject              | Marks | Grade | Grade Point |
|------|----------------------|-------|-------|-------------|
| 184  | English Language     | 95    | A1    | 10          |
| 085  | Hindi Course-A       | 88    | A2    | 9           |
| 041  | Mathematics — Std.   | 96    | A1    | 10          |
| 086  | Science              | 94    | A1    | 10          |
| 087  | Social Science       | 89    | A2    | 9           |

Result: PASS
Total Marks (best of five): 462 / 500
*[stamp: "Controller of Examinations, Delhi"]*
*[signature]*
Issued: 12 May 2024

### Fields

| Field             | Value                                | Source                       |
|-------------------|--------------------------------------|------------------------------|
| Document type     | CBSE Class X marksheet               | Header                       |
| Board             | Central Board of Secondary Education | Header                       |
| Exam session      | 2024                                 | Sub-header                   |
| Roll number       | 7894561                              | Top-left identification block|
| Student name      | PRATHAM AGGARWAL                     | Identification block         |
| Father's name     | VIKAS AGGARWAL                       | Identification block         |
| Mother's name     | POOJA AGGARWAL                       | Identification block         |
| Date of birth     | 01-06-2008                           | Identification block         |
| School name       | Sat Paul Mittal School, Ludhiana     | Identification block         |
| School code       | 10412                                | Identification block         |
| English mark      | 95 / 100                             | Marks table row 1            |
| Hindi mark        | 88 / 100                             | Marks table row 2            |
| Mathematics mark  | 96 / 100                             | Marks table row 3            |
| Science mark      | 94 / 100                             | Marks table row 4            |
| Social Science    | 89 / 100                             | Marks table row 5            |
| Total (best of 5) | 462 / 500                            | Footer                       |
| Result            | PASS                                 | Footer                       |
| Issue date        | 12 May 2024                          | Bottom-right                 |

### Summary

- **Total**: 462 / 500 = **92.4%** (best-of-five aggregate, the standard
  CBSE Class X reporting basis).
- **Subject averages**: STEM (Math + Science) = 95.0; Humanities
  (English + Hindi + Social) = 90.7. Stronger in STEM by 4.3 points.
- **Best subject**: Mathematics, 96 / 100.
- **Weakest subject**: Hindi Course-A, 88 / 100. Still A2 grade.
- **Time signal**: marksheet issued 12 May 2024, ~12 months old as of
  today — current and authoritative.

### Conclusions

- 92.4% is in roughly the top decile of CBSE 2024 Class X candidates
  (board-wide pass-percentage average was ~93.6% with mean aggregate
  near 87% in the 2024 cycle); a strong academic baseline for
  international undergraduate review.
- STEM 95.0 vs Humanities 90.7 supports a Computer-Science-leaning
  application narrative without having to overstate the gap.
- Identification fields (name, DOB, parents' names, school) match
  `answers.name`, `answers.dob`, `answers.school10Name`,
  `answers.fatherName`, `answers.motherName` — no reconciliation
  required. **Autofill candidate**: `marks10pct = 92.4`,
  `school10Name = "Sat Paul Mittal School"` (only if currently empty).

---

## ai_extracted (JSON)

```json
{
  "marks10pct": 92.4,
  "school10Name": "Sat Paul Mittal School",
  "name": "Pratham Aggarwal",
  "dob": "2008-06-01",
  "fatherName": "Vikas Aggarwal",
  "motherName": "Pooja Aggarwal"
}
```

Only keys that match the **Field-mapping registry** in
[manual_opus_generate.md](../../../manual_opus_generate.md) are
included. The verbatim transcription holds everything else; the
autofill pipeline reads only `ai_extracted`.

---

## Calibration notes

The example above runs ~520 words of `ai_description`. A passport
photo would run ~40-60 words (Section 1 only). A multi-page transcript
would run 1500+ words because each page gets its own verbatim block.
Length scales with the document; do not pad short docs and do not
truncate long ones.

If a document has nothing to say beyond identification (a passport
photo, a blank consent form), Sections 4 and 5 are omitted. Sections
1, 2, 3 are required for any document with text or data on it.
