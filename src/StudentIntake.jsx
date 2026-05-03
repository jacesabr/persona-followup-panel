import { useState, useEffect, useRef, useCallback, forwardRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  AlertCircle,
  ChevronDown,
  Check,
  Zap,
  Loader2,
  RotateCcw,
  Upload,
  Plus,
  X,
} from "lucide-react";
import {
  fileMeta,
  humanSize,
  isFileSlot,
  isFileInflight,
  isFileErrored,
  isFileUploaded,
  uploadFile,
  validateFile,
  syncRecord,
  loadRecord,
  fetchExtraction,
  retryExtraction,
  isExtractionTerminal,
} from "./intakeFiles.js";
import ExtractionReview from "./ExtractionReview.jsx";
import ResumeConfig from "./ResumeConfig.jsx";
import ResumeGenerating from "./ResumeGenerating.jsx";
import ResumeViewer from "./ResumeViewer.jsx";
import { generateResumes } from "./intakeFiles.js";

// ============================================================
// Schema — chapters → pages → fields.
// Every field on the legacy Dashboard is covered here so the
// flow map is the single source of "things we ever ask".
// ============================================================
const CHAPTERS = [
  {
    id: "personal",
    title: "Personal details",
    pages: [
      {
        id: "p_basics",
        title: "Tell us about yourself",
        helper: "The basics — we'll use these everywhere else.",
        fields: [
          { id: "name", label: "Full name", type: "text", placeholder: "First Last" },
          { id: "email", label: "Email", type: "email", placeholder: "name@example.com" },
          { id: "phone", label: "Phone", type: "tel", placeholder: "+91 98XXX XXXXX" },
          { id: "dob", label: "Date of birth", type: "date" },
          { id: "bloodGroup", label: "Blood group", type: "text", placeholder: "O+", optional: true },
        ],
      },
      {
        id: "p_address",
        title: "Where you live",
        fields: [
          { id: "houseAddress", label: "House address", type: "textarea", placeholder: "Street, area, city, state, PIN" },
        ],
      },
      {
        id: "p_ids",
        title: "Identification",
        helper: "We need these for university and visa applications.",
        fields: [
          { id: "aadhar", label: "Aadhar card #", type: "text", placeholder: "XXXX XXXX XXXX" },
          { id: "pan", label: "PAN card #", type: "text", optional: true },
          { id: "passport", label: "Passport #", type: "text", placeholder: "A1234567" },
          { id: "passportExpiry", label: "Passport expiry date", type: "date" },
        ],
      },
      {
        id: "p_photo",
        title: "Upload your photo",
        helper: "White background, formals, 3.5×4.5 cm. JPG or PDF.",
        fields: [
          { id: "photoFile", label: "Photo", type: "file", accept: "image/jpeg,image/png,application/pdf", maxSizeMB: 5 },
        ],
      },
    ],
  },
  {
    id: "schooling",
    title: "Schooling",
    pages: [
      {
        id: "p_school",
        title: "Your school (undergraduate)",
        fields: [
          { id: "schoolName", label: "School name", type: "text" },
          { id: "schoolEmail", label: "School email", type: "email" },
          { id: "schoolAddress", label: "School address", type: "textarea" },
        ],
      },
      {
        id: "p_uni",
        title: "Your university (post-graduate)",
        helper: "Skip if you're applying for an undergraduate program.",
        optional: true,
        fields: [
          { id: "uniName", label: "University / college", type: "text", optional: true },
          { id: "uniEmail", label: "University email", type: "email", optional: true },
          { id: "uniAddress", label: "Address", type: "textarea", optional: true },
        ],
      },
    ],
  },
  {
    id: "academics",
    title: "Academic record",
    pages: [
      {
        id: "p_marks10",
        title: "10th-grade marks",
        fields: [
          { id: "marks10pct", label: "Percentage", type: "number", placeholder: "85" },
          { id: "marks10sheet", label: "Marksheet (PDF)", type: "file" },
        ],
      },
      {
        id: "p_marks11",
        title: "11th-grade marks",
        helper: "Per-subject scores if you have them.",
        fields: [
          { id: "marks11pct", label: "Percentage", type: "number" },
          { id: "marks11sheet", label: "Marksheet (PDF)", type: "file" },
        ],
      },
      {
        id: "p_marks12",
        title: "12th-grade marks",
        helper: "If boards aren't out yet, fill the predicted-scores fields and skip the marksheet.",
        fields: [
          { id: "marks12pct", label: "Percentage", type: "number", optional: true, helper: "Skip if boards aren't out." },
          { id: "marks12sheet", label: "Marksheet (PDF)", type: "file", optional: true },
          { id: "marks12predicted", label: "Predicted score", type: "text", optional: true, placeholder: "e.g. 92% predicted" },
          { id: "marks12predictedSheet", label: "Predicted-scores sheet (PDF)", type: "file", optional: true },
        ],
      },
      {
        id: "p_cgpa",
        title: "Graduate CGPA",
        helper: "Only fill if applying for a post-graduate program.",
        optional: true,
        fields: [
          { id: "cgpa", label: "CGPA", type: "text", optional: true },
          { id: "transcript", label: "Transcript (PDF)", type: "file", optional: true },
          { id: "finalDegree", label: "Final degree (PDF)", type: "file", optional: true },
          { id: "semesterTranscripts", label: "All-semester transcripts (PDF)", type: "file", optional: true },
        ],
      },
    ],
  },
  {
    id: "passport",
    title: "Passport scans",
    pages: [
      {
        id: "p_passport_scans",
        title: "Upload passport pages",
        helper: "Three PDFs — front & back combined, front page alone, last page alone.",
        fields: [
          { id: "passportFrontBack", label: "Front & back (combined)", type: "file" },
          { id: "passportFront", label: "Front page", type: "file" },
          { id: "passportLast", label: "Last page", type: "file" },
        ],
      },
    ],
  },
  {
    id: "tests",
    title: "Standardized tests",
    pages: [
      {
        id: "p_tests",
        title: "Test scores",
        helper: "Per test: score (if taken), whether it's booked, booking #, and result PDF. Skip what doesn't apply.",
        optional: true,
        fields: [
          // IELTS
          { id: "ielts_score", label: "IELTS · score", type: "text", optional: true },
          { id: "ielts_booked", label: "IELTS · booked?", type: "checkbox", optional: true },
          { id: "ielts_bookingNum", label: "IELTS · booking #", type: "text", optional: true },
          { id: "ielts_result", label: "IELTS · result (PDF)", type: "file", optional: true },
          // TOEFL
          { id: "toefl_score", label: "TOEFL · score", type: "text", optional: true },
          { id: "toefl_booked", label: "TOEFL · booked?", type: "checkbox", optional: true },
          { id: "toefl_bookingNum", label: "TOEFL · booking #", type: "text", optional: true },
          { id: "toefl_result", label: "TOEFL · result (PDF)", type: "file", optional: true },
          // SAT / ACT
          { id: "sat_score", label: "SAT / ACT · score", type: "text", optional: true },
          { id: "sat_booked", label: "SAT / ACT · booked?", type: "checkbox", optional: true },
          { id: "sat_bookingNum", label: "SAT / ACT · booking #", type: "text", optional: true },
          { id: "sat_result", label: "SAT / ACT · result (PDF)", type: "file", optional: true },
          // AP
          { id: "ap_score", label: "AP · scores", type: "text", optional: true },
          { id: "ap_booked", label: "AP · booked?", type: "checkbox", optional: true },
          { id: "ap_bookingNum", label: "AP · booking #", type: "text", optional: true },
          { id: "ap_result", label: "AP · result (PDF)", type: "file", optional: true },
          // Other (TUMA / TSA / etc.)
          { id: "other_score", label: "Other (TUMA / TSA) · score", type: "text", optional: true },
          { id: "other_booked", label: "Other · booked?", type: "checkbox", optional: true },
          { id: "other_bookingNum", label: "Other · booking #", type: "text", optional: true },
          { id: "other_result", label: "Other · result (PDF)", type: "file", optional: true },
        ],
      },
    ],
  },
  {
    id: "family",
    title: "Family",
    pages: [
      {
        id: "p_father",
        title: "Father's details",
        fields: [
          { id: "father_name", label: "Name", type: "text" },
          { id: "father_dob", label: "Date of birth", type: "date" },
          { id: "father_education", label: "Education", type: "text" },
          { id: "father_institution", label: "Educational institution", type: "text" },
          { id: "father_aadhar", label: "Aadhar card", type: "text" },
          { id: "father_occupation", label: "Occupation", type: "text" },
          { id: "father_position", label: "Position at workplace", type: "text" },
          { id: "father_phone", label: "Phone", type: "tel" },
          { id: "father_email", label: "Email", type: "email" },
          { id: "father_org", label: "Name of organisation", type: "text" },
        ],
      },
      {
        id: "p_mother",
        title: "Mother's details",
        fields: [
          { id: "mother_name", label: "Name", type: "text" },
          { id: "mother_dob", label: "Date of birth", type: "date" },
          { id: "mother_education", label: "Education", type: "text" },
          { id: "mother_institution", label: "Educational institution", type: "text" },
          { id: "mother_aadhar", label: "Aadhar card", type: "text" },
          { id: "mother_occupation", label: "Occupation", type: "text" },
          { id: "mother_position", label: "Position at workplace", type: "text" },
          { id: "mother_phone", label: "Phone", type: "tel" },
          { id: "mother_email", label: "Email", type: "email" },
          { id: "mother_org", label: "Name of organisation", type: "text" },
        ],
      },
    ],
  },
  {
    id: "extracurriculars",
    title: "Activities & achievements",
    pages: [
      {
        id: "p_activities",
        title: "Activities, clubs, awards",
        helper: "Community service, art & culture, leadership, sports — anything that says something about you. Add up to 25.",
        fields: [
          {
            id: "activities_list",
            label: "Your activities",
            type: "repeater",
            minRows: 1,
            max: 25,
            itemFields: [
              { id: "name", label: "Name of activity", type: "text", placeholder: "School CS Club" },
              { id: "description", label: "Description", type: "text", placeholder: "Founder & president, 30+ members" },
              { id: "proof", label: "Proof (PDF)", type: "file" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "profile_docs",
    title: "Profile documents",
    pages: [
      {
        id: "p_lors",
        title: "Letters of recommendation",
        fields: [
          { id: "lor1", label: "LOR 1", type: "file" },
          { id: "lor2", label: "LOR 2", type: "file" },
          { id: "lor3", label: "LOR 3", type: "file", optional: true },
        ],
      },
      {
        id: "p_internships",
        title: "Internships",
        helper: "Offer letters or completion certificates.",
        optional: true,
        fields: [
          { id: "internship1", label: "Internship 1", type: "file", optional: true },
          { id: "internship2", label: "Internship 2", type: "file", optional: true },
          { id: "internship3", label: "Internship 3", type: "file", optional: true },
        ],
      },
      {
        id: "p_sop",
        title: "Statement of purpose",
        helper: "Upload a draft — we'll review and give feedback.",
        fields: [
          { id: "sop", label: "SOP (PDF)", type: "file" },
        ],
      },
      {
        id: "p_resume",
        title: "Resume",
        helper: "We can also generate one from your profile. Upload one if you already have it.",
        optional: true,
        fields: [
          { id: "resumeFile", label: "Resume (PDF)", type: "file", optional: true },
        ],
      },
      {
        id: "p_other_docs",
        title: "Any other documents?",
        helper: "Anything else worth attaching — awards, certificates, character references, etc. Add as many as you need.",
        optional: true,
        fields: [
          {
            id: "otherDocs_list",
            label: "Other documents",
            type: "repeater",
            minRows: 2,
            max: 15,
            itemFields: [
              { id: "description", label: "Description", type: "text", placeholder: "What is this document?" },
              { id: "file", label: "File (PDF)", type: "file" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "story",
    title: "Your story",
    pages: [
      {
        id: "p_summary",
        title: "Tell us a bit about yourself",
        helper: "What do you love? What are you curious about? A few sentences is fine.",
        fields: [
          { id: "summary", label: "About you", type: "textarea" },
        ],
      },
    ],
  },
  {
    id: "destination",
    title: "Where you want to go",
    pages: [
      {
        id: "p_country",
        title: "Your target country",
        fields: [
          {
            id: "targetCountry",
            label: "Primary target country",
            type: "select",
            options: ["Canada", "USA", "UK", "Switzerland", "Singapore", "Australia", "Germany", "Other"],
          },
        ],
      },
      {
        id: "p_paths",
        title: "Programs & universities",
        helper: "Each row is one program at one university in one country. Add as many as you like.",
        fields: [
          {
            id: "paths_list",
            label: "Your application list",
            type: "repeater",
            minRows: 1,
            max: 10,
            itemFields: [
              { id: "country", label: "Country", type: "text", placeholder: "USA" },
              { id: "university", label: "University", type: "text", placeholder: "MIT" },
              { id: "program", label: "Program", type: "text", placeholder: "BSc Computer Science" },
            ],
          },
        ],
      },
    ],
  },
];

const ALL_PAGES = CHAPTERS.flatMap((c) =>
  c.pages.map((p) => ({ ...p, chapterId: c.id, chapterTitle: c.title }))
);
const PAGES_BY_ID = Object.fromEntries(ALL_PAGES.map((p) => [p.id, p]));
const DEFAULT_ORDER = ALL_PAGES.map((p) => p.id);

// Build an "already-uploaded" file slot for the autofill mock so the
// fill-state UI shows green and pages count as complete.
const mockFile = (name, size = 245678) => ({
  name,
  size,
  type: name.toLowerCase().endsWith(".pdf")
    ? "application/pdf"
    : name.toLowerCase().match(/\.(jpe?g)$/)
    ? "image/jpeg"
    : name.toLowerCase().endsWith(".png")
    ? "image/png"
    : "application/pdf",
  lastModified: Date.now(),
  status: "uploaded",
  error: null,
  uploadedUrl: `stub://mock/${encodeURIComponent(name)}`,
  uploadedAt: new Date().toISOString(),
});

const MOCK = {
  name: "Riya Sharma",
  email: "riya.sharma@example.com",
  phone: "+91 98765 43210",
  dob: "2007-06-15",
  bloodGroup: "B+",
  houseAddress: "12, Model Town, Ludhiana, Punjab 141002",
  aadhar: "1234 5678 9012",
  pan: "ABCDE1234F",
  passport: "A1234567",
  passportExpiry: "2030-04-12",
  photoFile: mockFile("riya_photo.jpg", 184321),
  schoolName: "Sacred Heart Convent School, Ludhiana",
  schoolEmail: "office@sacredheart.edu.in",
  schoolAddress: "Sarabha Nagar, Ludhiana, Punjab 141001",
  marks10pct: "94",
  marks10sheet: mockFile("marks_10.pdf", 312001),
  marks11pct: "92",
  marks11sheet: mockFile("marks_11.pdf", 298440),
  marks12pct: "91",
  marks12sheet: mockFile("marks_12.pdf", 305712),
  marks12predicted: "92% predicted",
  marks12predictedSheet: mockFile("marks_12_predicted.pdf", 102301),
  passportFrontBack: mockFile("passport_front_back.pdf", 411022),
  passportFront: mockFile("passport_front.pdf", 198332),
  passportLast: mockFile("passport_last.pdf", 187901),
  ielts_score: "8.5",
  ielts_booked: true,
  ielts_bookingNum: "IELTS-IND-2025-44821",
  ielts_result: mockFile("ielts_result.pdf", 224531),
  toefl_score: "110",
  toefl_booked: true,
  toefl_bookingNum: "TOEFL-IN-998761",
  toefl_result: mockFile("toefl_result.pdf", 218803),
  sat_score: "1520",
  sat_booked: true,
  sat_bookingNum: "SAT-IN-2025-13902",
  sat_result: mockFile("sat_result.pdf", 201145),
  ap_score: "AP CS A: 5, AP Calc BC: 5",
  ap_booked: false,
  ap_result: mockFile("ap_results.pdf", 199002),
  other_score: "",
  other_booked: false,
  lor1: mockFile("lor_principal.pdf", 256711),
  lor2: mockFile("lor_cs_teacher.pdf", 244982),
  lor3: mockFile("lor_debate_coach.pdf", 230011),
  internship1: mockFile("internship_offer_a.pdf", 312890),
  internship2: mockFile("internship_offer_b.pdf", 287115),
  sop: mockFile("statement_of_purpose.pdf", 412009),
  resumeFile: mockFile("riya_resume.pdf", 198550),
  father_name: "Vikram Sharma",
  father_dob: "1972-03-08",
  father_education: "MBA",
  father_institution: "Punjab University",
  father_aadhar: "9876 5432 1098",
  father_occupation: "Executive Director",
  father_position: "Head of Operations",
  father_phone: "+91 98765 12345",
  father_email: "vikram.sharma@example.com",
  father_org: "Sharma Industries Pvt Ltd",
  mother_name: "Priya Sharma",
  mother_dob: "1975-07-22",
  mother_education: "MA English Literature",
  mother_institution: "Delhi University",
  mother_aadhar: "5432 1098 7654",
  mother_occupation: "School Principal",
  mother_position: "Principal",
  mother_phone: "+91 98765 67890",
  mother_email: "priya.sharma@example.com",
  mother_org: "Sacred Heart Convent School",
  activities_list: [
    {
      name: "Founder & President — School CS Club",
      description: "Started 2024–25 with 30+ members, weekly hack nights.",
      proof: mockFile("cs_club_certificate.pdf", 184422),
    },
    {
      name: "National Debate Team",
      description: "Member of the Indian national high-school debate team, 2025.",
      proof: mockFile("debate_certificate.pdf", 199881),
    },
    {
      name: "ICPC qualifier 2025",
      description: "Qualified for ACM ICPC Asia regional rounds.",
      proof: mockFile("icpc_certificate.pdf", 211009),
    },
    {
      name: "Habitat for Humanity volunteer",
      description: "Punjab chapter — house-building weekends through 2024–25.",
      proof: mockFile("habitat_certificate.pdf", 178322),
    },
  ],
  paths_list: [
    { country: "USA", university: "MIT", program: "BSc Computer Science" },
    { country: "USA", university: "Stanford University", program: "BSc Computer Science" },
    { country: "Canada", university: "University of Toronto", program: "BSc Computer Science" },
  ],
  otherDocs_list: [
    { description: "INSPIRE Scholarship 2025 award letter", file: mockFile("inspire_award.pdf", 211442) },
    { description: "Character reference from school principal", file: mockFile("principal_reference.pdf", 198772) },
  ],
  summary:
    "I'm fascinated by how computers can model the world. I've been programming since I was 13 — started with web, now mostly into ML and systems. I also love a good policy debate.",
  targetCountry: "USA",
};

// ============================================================
// Canonical "rich profile" derived from the flat answers map. Used by
// downstream consumers (RAG pipeline, counsellor view) that want a
// structured shape instead of the form-specific keys. The backend
// stores only the flat answers + page order; this function is pure.
// ============================================================
// Project a file slot into the canonical record. Always returns either
// "" (no file) or an object with a stable shape for downstream consumers.
const fileOut = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v; // legacy fallback
  if (isFileSlot(v)) {
    return {
      name: v.name,
      size: v.size,
      type: v.type,
      status: v.status,
      uploadedUrl: v.uploadedUrl || null,
      uploadedAt: v.uploadedAt || null,
      error: v.error || null,
    };
  }
  return "";
};

export function buildStudentRecord(answers, opts = {}) {
  return {
    intakeComplete: !!opts.intakeComplete,
    personal: {
      name: answers.name || "",
      email: answers.email || "",
      phone: answers.phone || "",
      dob: answers.dob || "",
      bloodGroup: answers.bloodGroup || "",
      address: { house: answers.houseAddress || "" },
      ids: {
        aadhar: answers.aadhar || "",
        pan: answers.pan || "",
        passport: answers.passport || "",
        passportExpiry: answers.passportExpiry || "",
      },
      photoFile: fileOut(answers.photoFile),
    },
    schooling: {
      school: {
        name: answers.schoolName || "",
        email: answers.schoolEmail || "",
        address: answers.schoolAddress || "",
      },
      university: {
        name: answers.uniName || "",
        email: answers.uniEmail || "",
        address: answers.uniAddress || "",
      },
    },
    academics: {
      marks10: { percentage: answers.marks10pct || "", marksheet: fileOut(answers.marks10sheet) },
      marks11: { percentage: answers.marks11pct || "", marksheet: fileOut(answers.marks11sheet) },
      marks12: {
        percentage: answers.marks12pct || "",
        marksheet: fileOut(answers.marks12sheet),
        predicted: answers.marks12predicted || "",
        predictedSheet: fileOut(answers.marks12predictedSheet),
      },
      cgpa: answers.cgpa || "",
      transcript: fileOut(answers.transcript),
      finalDegree: fileOut(answers.finalDegree),
      semesterTranscripts: fileOut(answers.semesterTranscripts),
      tests: {
        ielts: {
          score: answers.ielts_score || "",
          booked: !!answers.ielts_booked,
          bookingNum: answers.ielts_bookingNum || "",
          result: fileOut(answers.ielts_result),
        },
        toefl: {
          score: answers.toefl_score || "",
          booked: !!answers.toefl_booked,
          bookingNum: answers.toefl_bookingNum || "",
          result: fileOut(answers.toefl_result),
        },
        sat: {
          score: answers.sat_score || "",
          booked: !!answers.sat_booked,
          bookingNum: answers.sat_bookingNum || "",
          result: fileOut(answers.sat_result),
        },
        ap: {
          score: answers.ap_score || "",
          booked: !!answers.ap_booked,
          bookingNum: answers.ap_bookingNum || "",
          result: fileOut(answers.ap_result),
        },
        other: {
          score: answers.other_score || "",
          booked: !!answers.other_booked,
          bookingNum: answers.other_bookingNum || "",
          result: fileOut(answers.other_result),
        },
      },
    },
    passport: {
      frontBack: fileOut(answers.passportFrontBack),
      front: fileOut(answers.passportFront),
      last: fileOut(answers.passportLast),
    },
    family: {
      father: {
        name: answers.father_name || "",
        dob: answers.father_dob || "",
        education: answers.father_education || "",
        institution: answers.father_institution || "",
        aadhar: answers.father_aadhar || "",
        occupation: answers.father_occupation || "",
        position: answers.father_position || "",
        phone: answers.father_phone || "",
        email: answers.father_email || "",
        organization: answers.father_org || "",
      },
      mother: {
        name: answers.mother_name || "",
        dob: answers.mother_dob || "",
        education: answers.mother_education || "",
        institution: answers.mother_institution || "",
        aadhar: answers.mother_aadhar || "",
        occupation: answers.mother_occupation || "",
        position: answers.mother_position || "",
        phone: answers.mother_phone || "",
        email: answers.mother_email || "",
        organization: answers.mother_org || "",
      },
    },
    extracurriculars: (Array.isArray(answers.activities_list) ? answers.activities_list : [])
      .filter((a) => a && (a.name || a.description || a.proof))
      .map((a) => ({
        name: a.name || "",
        description: a.description || "",
        proof: fileOut(a.proof),
      })),
    profileDocs: {
      lors: [fileOut(answers.lor1), fileOut(answers.lor2), fileOut(answers.lor3)],
      internships: [
        fileOut(answers.internship1),
        fileOut(answers.internship2),
        fileOut(answers.internship3),
      ],
      sop: fileOut(answers.sop),
      resume: fileOut(answers.resumeFile),
      otherDocs: (Array.isArray(answers.otherDocs_list) ? answers.otherDocs_list : [])
        .filter((d) => d && (d.description || d.file))
        .map((d) => ({ description: d.description || "", file: fileOut(d.file) })),
    },
    story: {
      summary: answers.summary || "",
    },
    destination: {
      targetCountry: answers.targetCountry || "",
      paths: (Array.isArray(answers.paths_list) ? answers.paths_list : [])
        .filter((p) => p && (p.country || p.university || p.program))
        .map((p) => ({
          country: p.country || "",
          university: p.university || "",
          program: p.program || "",
        })),
    },
  };
}

// If the tab was closed mid-upload, the in-memory File is gone but the
// slot object that round-tripped through the backend still says
// "uploading". Mark those as errored so the UI prompts a re-upload.
const repairTransientStates = (answers) => {
  const fix = (v) => {
    if (
      isFileSlot(v) &&
      (v.status === "uploading" || v.status === "validating" || v.status === "pending")
    ) {
      return { ...v, status: "error", error: "Upload interrupted — please re-upload." };
    }
    return v;
  };
  const out = {};
  for (const [k, v] of Object.entries(answers || {})) {
    if (Array.isArray(v)) {
      out[k] = v.map((row) => {
        if (!row || typeof row !== "object") return row;
        const r = {};
        for (const [rk, rv] of Object.entries(row)) r[rk] = fix(rv);
        return r;
      });
    } else {
      out[k] = fix(v);
    }
  }
  return out;
};

// Filter the saved page order against the current schema, append any
// pages we've added since.
const reconcileOrder = (saved) => {
  if (!Array.isArray(saved)) return DEFAULT_ORDER;
  const known = saved.filter((id) => PAGES_BY_ID[id]);
  const missing = DEFAULT_ORDER.filter((id) => !known.includes(id));
  return [...known, ...missing];
};

const isFieldFilled = (val) => {
  if (val === "" || val === null || val === undefined) return false;
  if (typeof val === "boolean") return val;
  // File slots count as "filled" only once the upload has succeeded.
  if (isFileSlot(val)) return val.status === "uploaded";
  if (Array.isArray(val)) {
    return val.some(
      (row) =>
        row &&
        typeof row === "object" &&
        Object.values(row).some((v) => {
          if (isFileSlot(v)) return v.status === "uploaded";
          return v !== "" && v != null && v !== false;
        })
    );
  }
  return true;
};

// True if any file slot in this value (or any nested cell) is currently
// validating or uploading. Blocks page advancement.
const fieldHasInflight = (val) => {
  if (isFileInflight(val)) return true;
  if (Array.isArray(val)) {
    return val.some(
      (row) =>
        row && typeof row === "object" && Object.values(row).some((v) => isFileInflight(v))
    );
  }
  return false;
};

const fieldHasError = (val) => {
  if (isFileErrored(val)) return true;
  if (Array.isArray(val)) {
    return val.some(
      (row) =>
        row && typeof row === "object" && Object.values(row).some((v) => isFileErrored(v))
    );
  }
  return false;
};
const pageFillState = (page, answers) => {
  const required = page.fields.filter((f) => !f.optional && !page.optional);
  const filledReq = required.filter((f) => isFieldFilled(answers[f.id])).length;
  const filledAny = page.fields.filter((f) => isFieldFilled(answers[f.id])).length;
  if (required.length === 0) {
    return filledAny > 0 ? "complete" : "empty";
  }
  if (filledReq === required.length) return "complete";
  if (filledReq > 0 || filledAny > 0) return "partial";
  return "empty";
};

// ============================================================
// Main flow
// ============================================================
export default function StudentIntake({ studentName = "student", onComplete, onExit }) {
  const [answers, setAnswers] = useState({});
  const [order, setOrder] = useState(DEFAULT_ORDER);
  // step: -1 = welcome, 0..N-1 = page, N = closing
  const [step, setStep] = useState(-1);
  // hydration: 'loading' until the backend has answered, then 'ready' or 'error'
  const [hydration, setHydration] = useState("loading");
  // saveState: idle / saving / saved / error
  const [saveState, setSaveState] = useState("idle");
  const debounceTimer = useRef(null);
  // Latest answers without re-binding callbacks every keystroke.
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; }, [answers]);
  const orderRef = useRef(order);
  useEffect(() => { orderRef.current = order; }, [order]);
  // Latest server-known updated_at for the student record. We pass this
  // as `expectedUpdatedAt` on every PUT so the server can reject stale
  // writes (concurrent-tab race) with 409 instead of silently overwriting.
  const expectedUpdatedAtRef = useRef(null);

  // Hydrate from backend on mount. The server sets the intake_sid cookie
  // if missing, then returns either the saved record or an empty one.
  useEffect(() => {
    let cancelled = false;
    loadRecord()
      .then((body) => {
        if (cancelled) return;
        const data = body?.data || {};
        const savedAnswers = data.answers || {};
        const savedOrder = data.order;
        setAnswers(repairTransientStates(savedAnswers));
        setOrder(reconcileOrder(savedOrder));
        expectedUpdatedAtRef.current = body?.updatedAt || null;
        setHydration("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[hydrate]", err);
        setHydration("error");
      });
    return () => { cancelled = true; };
  }, []);

  const orderedPages = order.map((id) => PAGES_BY_ID[id]).filter(Boolean);
  const total = orderedPages.length;
  const isWelcome = step === -1;
  const isClosing = step >= total;
  const currentPage = !isWelcome && !isClosing ? orderedPages[step] : null;
  const prevPage = step > 0 ? orderedPages[step - 1] : null;
  const isChapterStart = currentPage && (!prevPage || prevPage.chapterId !== currentPage.chapterId);

  // Single sync path. data shape on the wire is { answers, order } so the
  // backend stores the form's own state verbatim — no schema dependency.
  // On a 409 (another tab wrote first), refetch latest, merge our local
  // edits on top of the server's, retry once. If the second attempt also
  // races (rare — three tabs?), surface the error and let the next save
  // try again. We DON'T overwrite the user's typed answers on the merge —
  // their local edits always win at the field level.
  const persist = useCallback(async (opts = {}) => {
    setSaveState("saving");
    const tryOnce = async () => {
      const payload = {
        data: { answers: answersRef.current, order: orderRef.current },
        intakeComplete: !!opts.intakeComplete,
        expectedUpdatedAt: expectedUpdatedAtRef.current,
      };
      const res = await syncRecord(payload);
      expectedUpdatedAtRef.current = res?.updatedAt || expectedUpdatedAtRef.current;
      return res;
    };
    try {
      await tryOnce();
      setSaveState("saved");
    } catch (err) {
      if (err?.code === "STALE_WRITE" && err?.latest) {
        // Pull in the server's latest state, but keep the student's
        // currently-typed answers on top — last-edit-wins per field.
        const serverAnswers = err.latest?.data?.answers || {};
        const merged = { ...serverAnswers, ...answersRef.current };
        answersRef.current = merged;
        setAnswers(merged);
        expectedUpdatedAtRef.current = err.latest.updatedAt;
        try {
          await tryOnce();
          setSaveState("saved");
        } catch (err2) {
          console.warn("[sync] retry after 409 failed:", err2.message);
          setSaveState("error");
        }
      } else {
        console.warn("[sync] failed:", err.message);
        setSaveState("error");
      }
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      persist();
    }, 1500);
  }, [persist]);

  const flushSave = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    persist();
  }, [persist]);

  const setAnswer = (fid, value) => {
    setAnswers((prev) => {
      const next = { ...prev, [fid]: value };
      answersRef.current = next;
      scheduleSave();
      return next;
    });
  };

  const advance = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    persist();
    setStep((s) => s + 1);
  };
  const goBack = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    persist();
    setStep((s) => Math.max(-1, s - 1));
  };

  const fillMock = () => {
    setAnswers(MOCK);
    answersRef.current = MOCK;
    persist();
  };

  const movePage = (id, direction) => {
    const idx = order.indexOf(id);
    const newIdx = idx + direction;
    if (idx < 0 || newIdx < 0 || newIdx >= order.length) return;
    const next = [...order];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setOrder(next);
    orderRef.current = next;
    persist();
    if (step === idx) setStep(newIdx);
    else if (step === newIdx) setStep(idx);
  };

  const jumpTo = (idx) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    persist();
    setStep(idx);
  };

  const resetOrder = () => {
    setOrder(DEFAULT_ORDER);
    orderRef.current = DEFAULT_ORDER;
    persist();
  };

  const reorderTo = (srcId, dstId) => {
    if (!srcId || srcId === dstId) return;
    const currentId = currentPage?.id;
    const next = [...order];
    const srcIdx = next.indexOf(srcId);
    const dstIdx = next.indexOf(dstId);
    if (srcIdx < 0 || dstIdx < 0) return;
    const [moved] = next.splice(srcIdx, 1);
    next.splice(dstIdx, 0, moved);
    setOrder(next);
    orderRef.current = next;
    persist();
    if (currentId) {
      const newIdx = next.indexOf(currentId);
      if (newIdx >= 0) setStep(newIdx);
    }
  };

  // Mark intake as complete on the canonical record. After this, the
  // student moves on to the post-intake phases (review extractions,
  // configure resumes, generate). The parent's onComplete fires too,
  // for any external bookkeeping.
  const finishIntake = useCallback(async () => {
    await persist({ intakeComplete: true });
    setPhase("review");
    onComplete?.(answersRef.current);
  }, [persist, onComplete]);

  // Post-intake phase machine. Lives inside StudentIntake so the
  // student stays in one cohesive component until they're done; the
  // server is the source of truth for intake_complete so a refresh
  // picks the right phase to land on.
  //   "intake"     → filling the form
  //   "review"     → confirming extracted data per document
  //   "config"     → picking resume count + length
  //   "generating" → (next push) generation in progress
  //   "done"       → (next push) resumes ready, view + download
  const [phase, setPhase] = useState("intake");
  // Once hydration finishes and we know intake_complete, jump straight
  // into review so a returning student doesn't see the intake form
  // they already finished. Preserved across reloads via the server flag.
  useEffect(() => {
    if (hydration !== "ready") return;
    // The hydrate effect already loaded body.intakeComplete; re-pull
    // from the answers ref via the parent record. We mirror it onto
    // a local flag set during loadRecord. Simplest: re-fetch once.
    loadRecord().then((body) => {
      if (body?.intakeComplete) setPhase("review");
    }).catch(() => {});
  }, [hydration]);

  // Enter advances on welcome / closing only — multi-field pages need free Enter.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      const tag = e.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      e.preventDefault();
      if (isWelcome) setStep(0);
      else if (isClosing) finishIntake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isWelcome, isClosing, finishIntake]);

  if (hydration !== "ready") {
    return <HydrationGate state={hydration} />;
  }

  // Post-intake phases: render full-width without the intake's flow map.
  if (phase === "review") {
    return (
      <PostIntakeFrame onExit={onExit} title="Review">
        <ExtractionReview
          onBack={() => setPhase("intake")}
          onContinue={() => setPhase("config")}
        />
      </PostIntakeFrame>
    );
  }
  if (phase === "config") {
    return (
      <PostIntakeFrame onExit={onExit} title="Resume setup">
        <ResumeConfig
          onBack={() => setPhase("review")}
          onGenerate={async (specs) => {
            // Kick off the batch on the backend; it returns immediately
            // with the created row ids and runs each generation in the
            // background. The Generating screen polls for status.
            try {
              await generateResumes(specs);
              setPhase("generating");
            } catch (e) {
              alert(`Couldn't start generation: ${e.message}`);
            }
          }}
        />
      </PostIntakeFrame>
    );
  }
  if (phase === "generating") {
    return (
      <PostIntakeFrame onExit={onExit} title="Generating">
        <ResumeGenerating
          onBack={() => setPhase("config")}
          onAllDone={() => setPhase("done")}
        />
      </PostIntakeFrame>
    );
  }
  if (phase === "done") {
    return (
      <PostIntakeFrame onExit={onExit} title="Your resumes">
        <ResumeViewer onBack={() => setPhase("config")} />
      </PostIntakeFrame>
    );
  }

  return (
    <div
      className="min-h-screen w-full font-serif text-stone-900"
      style={{ backgroundColor: "#f4f0e6" }}
    >
      <TopBar onExit={onExit} onAutofill={fillMock} saveState={saveState} />

      <section className="mx-auto max-w-3xl px-6 pt-28 pb-12">
        <p className="mb-2 text-[10px] uppercase tracking-[0.3em] text-stone-500">
          Live view
        </p>
        <div className="min-h-[420px] border border-stone-900/15 bg-white/40 px-8 py-2">
          {isWelcome && <Welcome name={studentName} onStart={() => setStep(0)} />}
          {currentPage && (
            <PageCard
              key={currentPage.id}
              page={currentPage}
              answers={answers}
              onChange={setAnswer}
              onBlur={flushSave}
              onAdvance={advance}
              onBack={goBack}
              isChapterStart={isChapterStart}
              stepLabel={`Page ${step + 1}`}
            />
          )}
          {isClosing && (
            <Closing onDone={finishIntake} onBack={() => setStep(total - 1)} />
          )}
        </div>
      </section>

      <FlowMap
        orderedPages={orderedPages}
        currentIdx={isWelcome ? -1 : isClosing ? total : step}
        answers={answers}
        onMove={movePage}
        onJump={jumpTo}
        onReset={resetOrder}
        onReorder={reorderTo}
      />
    </div>
  );
}

// Shared frame for the post-intake screens (Review, Config, Generating,
// Done). Same brand chrome as the intake's TopBar minus the autofill
// button, plus a wider content area since these screens have tables.
function PostIntakeFrame({ children, onExit, title }) {
  return (
    <div
      className="min-h-screen w-full font-serif text-stone-900"
      style={{ backgroundColor: "#f4f0e6" }}
    >
      <header className="fixed left-0 right-0 top-0 z-10 flex items-center justify-between border-b border-stone-900/10 bg-[#f4f0e6]/80 px-6 py-4 backdrop-blur">
        <button
          onClick={onExit}
          className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-stone-500 hover:text-stone-900"
        >
          <ArrowLeft className="h-3 w-3" /> sign out
        </button>
        <div className="flex items-baseline gap-2">
          <span className="text-sm italic text-stone-500">the</span>
          <span className="text-lg font-semibold tracking-tight">Persona</span>
          <span className="text-[10px] uppercase tracking-[0.25em] text-stone-500">
            · {title}
          </span>
        </div>
        <div className="w-20" /> {/* spacer to balance the sign-out */}
      </header>
      <section className="mx-auto max-w-4xl px-6 pt-24 pb-16">
        {children}
      </section>
    </div>
  );
}

function HydrationGate({ state }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center font-serif text-stone-900"
      style={{ backgroundColor: "#f4f0e6" }}
    >
      {state === "loading" && (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-stone-500" />
          <p className="mt-4 text-[10px] uppercase tracking-[0.3em] text-stone-500">
            Loading your profile…
          </p>
        </>
      )}
      {state === "error" && (
        <>
          <AlertCircle className="h-5 w-5 text-red-700" />
          <p className="mt-4 max-w-md text-center text-sm text-stone-600">
            Couldn't reach the server. Check your connection and reload.
          </p>
        </>
      )}
    </div>
  );
}

// ============================================================
// Top bar — autofill + save indicator
// ============================================================
function TopBar({ onExit, onAutofill, saveState }) {
  return (
    <header className="fixed left-0 right-0 top-0 z-10 flex items-center justify-between border-b border-stone-900/10 bg-[#f4f0e6]/80 px-6 py-4 backdrop-blur">
      <button
        onClick={onExit}
        className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="h-3 w-3" /> exit
      </button>
      <div className="flex items-baseline gap-2">
        <span className="text-sm italic text-stone-500">the</span>
        <span className="text-lg font-semibold tracking-tight">Persona</span>
        <span className="text-[10px] uppercase tracking-[0.25em] text-stone-500">· intake</span>
      </div>
      <div className="flex items-center gap-4">
        <SaveIndicator state={saveState} />
        <button
          onClick={onAutofill}
          title="Fill with mock data"
          aria-label="Fill with mock data"
          className="inline-flex items-center gap-1.5 border border-stone-900/30 bg-white/60 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.2em] text-stone-700 transition hover:border-stone-900 hover:bg-white"
        >
          <Zap className="h-3 w-3" /> Autofill
        </button>
      </div>
    </header>
  );
}

function SaveIndicator({ state }) {
  if (state === "idle") {
    return (
      <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400">Ready</span>
    );
  }
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-stone-500">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "error") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-red-700"
        title="Couldn't reach the server. Your changes will retry on the next edit."
      >
        <AlertCircle className="h-3 w-3" /> Sync failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-emerald-700">
      <Check className="h-3 w-3" /> Saved
    </span>
  );
}

// ============================================================
// Welcome / Closing
// ============================================================
function Welcome({ name, onStart }) {
  return (
    <div className="animate-fadeUp py-20">
      <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">Step 01</p>
      <h1 className="mt-2 font-serif text-5xl leading-[1.05] md:text-6xl">
        Welcome to Persona,
        <br />
        {name}.
      </h1>
      <p className="mt-6 max-w-xl text-base leading-relaxed text-stone-600">
        We'll walk through your profile a page at a time. We save as you go, so come
        back any time. Skip what doesn't apply — your counsellor will fill the gaps.
      </p>
      <div className="mt-10 flex items-center gap-4">
        <button
          onClick={onStart}
          className="inline-flex items-center gap-2 border border-stone-900 bg-stone-900 px-6 py-3 text-sm uppercase tracking-[0.2em] text-stone-50 transition hover:bg-stone-800"
        >
          Let's start <ArrowRight className="h-4 w-4" />
        </button>
        <span className="text-xs italic text-stone-500">press Enter ↵</span>
      </div>
    </div>
  );
}

function Closing({ onDone, onBack }) {
  return (
    <div className="animate-fadeUp py-20">
      <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">All done</p>
      <h2 className="mt-2 font-serif text-5xl leading-[1.05]">
        All saved.
        <br />
        We'll take it from here.
      </h2>
      <p className="mt-6 max-w-xl text-base leading-relaxed text-stone-600">
        Your counsellor will reach out within 24 hours. You can review and edit
        anything from your dashboard.
      </p>
      <div className="mt-10 flex items-center gap-4">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 border border-stone-900/30 bg-transparent px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-stone-600 transition hover:border-stone-900 hover:text-stone-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onDone}
          className="inline-flex items-center gap-2 border border-stone-900 bg-stone-900 px-6 py-3 text-sm uppercase tracking-[0.2em] text-stone-50 transition hover:bg-stone-800"
        >
          Go to dashboard <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Page card — renders all fields on a page with autosave
// ============================================================
function PageCard({ page, answers, onChange, onBlur, onAdvance, onBack, isChapterStart, stepLabel }) {
  const firstFieldRef = useRef(null);
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [page.id]);

  const requiredFields = page.fields.filter((f) => !f.optional && !page.optional);
  const allRequiredFilled = requiredFields.every((f) => isFieldFilled(answers[f.id]));
  const inflight = page.fields.some((f) => fieldHasInflight(answers[f.id]));
  const errored = page.fields.some((f) => fieldHasError(answers[f.id]));
  const canAdvance = !inflight && !errored && (page.optional || allRequiredFilled);

  const advanceLabel = inflight
    ? "uploading…"
    : errored
    ? "fix file errors"
    : canAdvance
    ? "OK"
    : `${requiredFields.length - requiredFields.filter((f) => isFieldFilled(answers[f.id])).length} required left`;

  return (
    <div key={page.id} className="animate-fadeUp py-10">
      {isChapterStart && (
        <p className="mb-4 text-[10px] uppercase tracking-[0.3em] text-stone-500">
          ▸ {page.chapterTitle}
        </p>
      )}
      <div className="flex items-baseline gap-3">
        <span className="text-xs uppercase tracking-[0.25em] text-stone-400">{stepLabel}</span>
        {page.optional && (
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400">
            optional · skippable
          </span>
        )}
      </div>
      <h2 className="mt-2 font-serif text-3xl leading-tight md:text-4xl">{page.title}</h2>
      {page.helper && <p className="mt-3 text-sm italic text-stone-500">{page.helper}</p>}

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {page.fields.map((field, i) => {
          let v = answers[field.id];
          if (v === undefined) {
            v = field.type === "repeater" ? [] : field.type === "checkbox" ? false : "";
          }
          return (
            <FieldRow
              key={field.id}
              field={field}
              value={v}
              onChange={(val) => onChange(field.id, val)}
              onBlur={onBlur}
              inputRef={i === 0 ? firstFieldRef : undefined}
              wide={field.type === "textarea" || field.type === "file" || field.type === "repeater"}
            />
          );
        })}
      </div>

      <div className="mt-10 flex items-center gap-4">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 border border-stone-900/30 bg-transparent px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-stone-600 transition hover:border-stone-900 hover:text-stone-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onAdvance}
          disabled={!canAdvance}
          className="inline-flex items-center gap-2 border border-stone-900 bg-stone-900 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-stone-50 transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {advanceLabel}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function FieldRow({ field, value, onChange, onBlur, inputRef, wide }) {
  // Repeater contains many inputs; wrapping in a single <label> is invalid.
  const Wrapper = field.type === "repeater" ? "div" : "label";
  return (
    <Wrapper className={`block ${wide ? "md:col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
        {field.label}
        {field.optional && (
          <span className="ml-2 italic text-stone-400 normal-case tracking-normal">(optional)</span>
        )}
      </span>
      <FieldInput field={field} value={value} onChange={onChange} onBlur={onBlur} ref={inputRef} />
      {field.helper && (
        <span className="mt-1 block text-[10px] italic text-stone-500">{field.helper}</span>
      )}
    </Wrapper>
  );
}

const FieldInput = forwardRef(function FieldInput({ field, value, onChange, onBlur }, ref) {
  const lineCls =
    "mt-1.5 w-full border-b border-stone-900/30 bg-transparent py-1.5 font-serif text-base text-stone-900 outline-none transition focus:border-stone-900 placeholder:text-stone-300";

  if (field.type === "textarea") {
    return (
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        rows={4}
        className="mt-1.5 w-full resize-none border border-stone-900/30 bg-white/40 p-3 font-serif text-sm text-stone-900 outline-none transition focus:border-stone-900 placeholder:text-stone-400"
      />
    );
  }
  if (field.type === "select") {
    return (
      <select
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={lineCls}
      >
        <option value="">— pick one —</option>
        {field.options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  if (field.type === "file") {
    return (
      <FileSlot
        ref={ref}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        accept={field.accept || "application/pdf"}
        maxSizeMB={field.maxSizeMB ?? 10}
        fieldId={field.id}
      />
    );
  }
  if (field.type === "checkbox") {
    return (
      <div className="mt-1.5 flex items-center gap-2 py-1.5">
        <input
          ref={ref}
          type="checkbox"
          checked={!!value}
          onChange={(e) => {
            onChange(e.target.checked);
            onBlur?.();
          }}
          className="h-4 w-4 border border-stone-900/40"
        />
        <span className="text-sm text-stone-700">Yes</span>
      </div>
    );
  }
  if (field.type === "repeater") {
    const rows = Array.isArray(value) ? value : [];
    const minRows = field.minRows ?? 1;
    const max = field.max;
    const displayRows =
      rows.length >= minRows
        ? rows
        : [...rows, ...Array(minRows - rows.length).fill({})];

    const updateRow = (idx, key, val) => {
      const next = displayRows.map((r, i) => (i === idx ? { ...(r || {}), [key]: val } : r || {}));
      onChange(next);
    };
    const addRow = () => {
      if (max != null && displayRows.length >= max) return;
      onChange([...displayRows, {}]);
    };
    const removeRow = (idx) => {
      const next = displayRows.filter((_, i) => i !== idx);
      onChange(next.length === 0 ? [{}] : next);
    };

    const cols = field.itemFields.length;
    const gridStyle = { gridTemplateColumns: `2rem repeat(${cols}, minmax(0, 1fr)) 2rem` };

    return (
      <div className="mt-2">
        <div className="overflow-hidden border border-stone-900/20">
          <div
            className="grid items-center gap-px bg-stone-900/15 text-[9px] uppercase tracking-[0.15em] text-stone-600"
            style={gridStyle}
          >
            <div className="bg-[#f4f0e6] px-2 py-1.5">#</div>
            {field.itemFields.map((sf) => (
              <div key={sf.id} className="bg-[#f4f0e6] px-2 py-1.5 truncate">
                {sf.label}
              </div>
            ))}
            <div className="bg-[#f4f0e6] px-2 py-1.5" />
          </div>
          {displayRows.map((row, i) => (
            <div
              key={i}
              className="grid items-stretch gap-px border-t border-stone-900/15 bg-stone-900/15"
              style={gridStyle}
            >
              <div className="flex items-center bg-[#f4f0e6] px-2 py-2 font-serif text-xs italic text-stone-500">
                {String(i + 1).padStart(2, "0")}
              </div>
              {field.itemFields.map((sf, j) => (
                <RepeaterCell
                  key={sf.id}
                  subfield={sf}
                  value={(row && row[sf.id]) ?? (sf.type === "checkbox" ? false : "")}
                  onChange={(v) => updateRow(i, sf.id, v)}
                  onBlur={onBlur}
                  rootRef={i === 0 && j === 0 ? ref : undefined}
                />
              ))}
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={displayRows.length <= minRows}
                className="flex items-center justify-center bg-[#f4f0e6] px-2 text-stone-400 transition hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-25"
                aria-label="Remove row"
                title="Remove this row"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addRow}
          disabled={max != null && displayRows.length >= max}
          className="mt-3 inline-flex items-center gap-1.5 border border-stone-900/30 bg-white px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-stone-700 transition hover:border-stone-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Plus className="h-3 w-3" /> Add another
          {max != null && (
            <span className="ml-1 italic text-stone-400 normal-case tracking-normal">
              ({displayRows.length}/{max})
            </span>
          )}
        </button>
      </div>
    );
  }
  return (
    <input
      ref={ref}
      type={field.type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={field.placeholder}
      className={lineCls}
    />
  );
});

// ============================================================
// FileSlot — real <input type="file"> with validation and upload.
// State machine: empty → validating → uploading → uploaded | error
// On error or completion the user can replace or remove the file.
// ============================================================
const FileSlot = forwardRef(function FileSlot(
  { value, onChange, onBlur, accept = "application/pdf", maxSizeMB = 10, fieldId, compact = false },
  ref
) {
  const inputRef = useRef(null);
  const slot = isFileSlot(value) ? value : null;
  const status = slot?.status || "empty";

  // Latest slot in a ref so the polling effect's closure can spread the
  // current shape into onChange even if React state has moved on.
  const slotRef = useRef(slot);
  useEffect(() => { slotRef.current = slot; }, [slot]);

  // Poll extraction status while non-terminal. Triggered any time the
  // extractionId changes (new upload or retry). Aborts on unmount /
  // before re-runs.
  const extractionId = slot?.extractionId || null;
  useEffect(() => {
    if (!extractionId) return;
    const initial = slotRef.current?.extractionStatus;
    if (initial && isExtractionTerminal(initial)) return;

    let cancelled = false;
    let timer = null;
    const ctrl = new AbortController();

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetchExtraction(extractionId, { signal: ctrl.signal });
        if (cancelled) return;
        const cur = slotRef.current;
        // If the user replaced the file mid-poll, the slot's extractionId
        // changed underneath us — bail and let the new effect take over.
        if (!cur || cur.extractionId !== extractionId) return;
        if (res.status !== cur.extractionStatus) {
          onChange({
            ...cur,
            extractionStatus: res.status,
            extractionError: res.error || null,
          });
          onBlur?.();
        }
        if (!isExtractionTerminal(res.status)) {
          timer = setTimeout(tick, 3000);
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          console.warn("[extract poll]", e);
          // Back off + retry on transient errors.
          if (!cancelled) timer = setTimeout(tick, 8000);
        }
      }
    };
    tick();

    return () => {
      cancelled = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [extractionId]);

  const handleFile = async (file) => {
    const base = fileMeta(file);

    onChange({ ...base, status: "validating" });
    const v = await validateFile(file, { accept, maxSizeMB });
    if (!v.ok) {
      onChange({ ...base, status: "error", error: v.error });
      onBlur?.();
      return;
    }

    onChange({ ...base, status: "uploading" });
    try {
      const { url, uploadedAt, fileId: uploadedFileId, extraction } = await uploadFile(
        file,
        { fieldId }
      );
      onChange({
        ...base,
        status: "uploaded",
        uploadedUrl: url,
        uploadedAt,
        fileId: uploadedFileId,
        // Auto-extraction kicked off server-side iff this field has a
        // registered extractor; if not, these stay null.
        extractionId: extraction?.id || null,
        extractionStatus: extraction?.status || null,
        extractionError: null,
      });
      onBlur?.();
    } catch (err) {
      onChange({ ...base, status: "error", error: err?.message || "Upload failed." });
      onBlur?.();
    }
  };

  const handleRetryExtraction = async () => {
    if (!slot?.fileId) return;
    try {
      const r = await retryExtraction(slot.fileId);
      onChange({
        ...slot,
        extractionId: r.id,
        extractionStatus: r.status,
        extractionError: null,
      });
      onBlur?.();
    } catch (e) {
      console.warn("[extract retry]", e);
    }
  };

  const handlePick = () => inputRef.current?.click();
  const handleRemove = () => {
    onChange("");
    onBlur?.();
  };

  const acceptHuman = accept
    .split(",")
    .map((a) => (a.trim() === "application/pdf" ? "PDF" : a.trim() === "image/jpeg" ? "JPG" : a.trim() === "image/png" ? "PNG" : a.trim()))
    .join(" / ");

  const borderCls =
    status === "uploaded"
      ? "border-emerald-700/40"
      : status === "error"
      ? "border-red-700/50"
      : "border-stone-900/30";

  const padCls = compact ? "px-2 py-1.5" : "px-3 py-2";
  const textCls = compact ? "text-xs" : "text-sm";

  return (
    <div className={`${compact ? "" : "mt-1.5"} flex items-center justify-between gap-2 border border-dashed bg-white/40 ${padCls} transition ${borderCls}`}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />

      <div className="min-w-0 flex-1">
        {status === "empty" && (
          <span className={`block truncate italic text-stone-400 ${textCls}`}>
            {compact ? `${acceptHuman} · max ${maxSizeMB} MB` : `no file selected · ${acceptHuman} · max ${maxSizeMB} MB`}
          </span>
        )}
        {status === "validating" && (
          <span className={`inline-flex items-center gap-1.5 text-stone-600 ${textCls}`}>
            <Loader2 className="h-3 w-3 animate-spin" /> checking…
          </span>
        )}
        {status === "uploading" && (
          <span className={`inline-flex items-center gap-1.5 truncate text-stone-600 ${textCls}`}>
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="truncate">uploading {slot?.name}</span>
          </span>
        )}
        {status === "uploaded" && (
          <span className="block min-w-0">
            <span className={`inline-flex w-full items-center gap-1.5 truncate text-stone-900 ${textCls}`}>
              <Check className="h-3 w-3 shrink-0 text-emerald-700" />
              <span className="min-w-0 flex-1 truncate">{slot?.name}</span>
              <span className="shrink-0 text-[9px] uppercase tracking-[0.15em] text-stone-400">
                {humanSize(slot?.size)}
              </span>
            </span>
            <ExtractionStatus
              extractionStatus={slot?.extractionStatus}
              extractionError={slot?.extractionError}
              onRetry={handleRetryExtraction}
              compact={compact}
            />
          </span>
        )}
        {status === "error" && (
          <span className="block min-w-0">
            <span className={`inline-flex items-center gap-1.5 truncate text-red-700 ${textCls}`}>
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{slot?.error}</span>
            </span>
            {slot?.name && (
              <span className="block truncate text-[10px] italic text-stone-500">{slot.name}</span>
            )}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {(status === "uploaded" || status === "error") && (
          <button
            type="button"
            onClick={handleRemove}
            aria-label="Remove file"
            title="Remove file"
            className="border border-stone-900/20 bg-white p-1 text-stone-500 transition hover:border-stone-900 hover:text-stone-900"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {status !== "uploading" && status !== "validating" && (
          <button
            type="button"
            ref={ref}
            onClick={handlePick}
            className="inline-flex items-center gap-1 border border-stone-900/30 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-900"
          >
            <Upload className="h-3 w-3" />
            {status === "uploaded" ? "replace" : status === "error" ? "retry" : "upload"}
          </button>
        )}
      </div>
    </div>
  );
});

// Inline extraction state shown under an uploaded file's name. Hidden
// for fields with no registered extractor (extractionStatus is null).
function ExtractionStatus({ extractionStatus, extractionError, onRetry, compact }) {
  if (!extractionStatus) return null;

  const tx = compact ? "text-[9px]" : "text-[10px]";
  const cls = `mt-0.5 inline-flex items-center gap-1 ${tx} uppercase tracking-[0.15em]`;

  if (extractionStatus === "pending" || extractionStatus === "running") {
    return (
      <span className={`${cls} text-stone-500`}>
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        reading document…
      </span>
    );
  }
  if (extractionStatus === "succeeded") {
    return (
      <span className={`${cls} text-emerald-700`}>
        <Check className="h-2.5 w-2.5" /> read
      </span>
    );
  }
  if (extractionStatus === "failed") {
    return (
      <span className={`${cls} text-red-700`}>
        <AlertCircle className="h-2.5 w-2.5" />
        couldn't read
        <span className="ml-1 normal-case tracking-normal italic text-stone-500">
          ({extractionError || "unknown error"})
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 border border-stone-900/20 bg-white px-1 py-0.5 text-[9px] uppercase tracking-[0.15em] text-stone-700 transition hover:border-stone-900"
        >
          retry
        </button>
      </span>
    );
  }
  return null;
}

function RepeaterCell({ subfield, value, onChange, onBlur, rootRef }) {
  if (subfield.type === "file") {
    return (
      <div className="bg-[#f4f0e6] px-1.5 py-1">
        <FileSlot
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          accept={subfield.accept || "application/pdf"}
          maxSizeMB={subfield.maxSizeMB ?? 10}
          fieldId={subfield.id}
          compact
        />
      </div>
    );
  }
  if (subfield.type === "checkbox") {
    return (
      <div className="flex items-center justify-center bg-[#f4f0e6] px-2 py-2">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => {
            onChange(e.target.checked);
            onBlur?.();
          }}
          className="h-3.5 w-3.5"
        />
      </div>
    );
  }
  return (
    <input
      ref={rootRef}
      type={subfield.type === "textarea" ? "text" : subfield.type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={subfield.placeholder}
      className="bg-[#f4f0e6] px-2 py-2 text-sm outline-none placeholder:italic placeholder:text-stone-400"
    />
  );
}

// ============================================================
// Flow map — mini-card thumbnails of every page, with reorder
// ============================================================
function FlowMap({ orderedPages, currentIdx, answers, onMove, onJump, onReset, onReorder }) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  return (
    <section className="border-t border-stone-900/15 bg-stone-50/40 px-6 pt-10 pb-20">
      <div className="mx-auto max-w-md">
        <div className="flex items-baseline justify-between border-b border-stone-900/15 pb-3">
          <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
            Flow map · {orderedPages.length} pages
          </p>
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-stone-500 hover:text-stone-900"
            title="Restore the original order"
          >
            <RotateCcw className="h-3 w-3" /> reset
          </button>
        </div>
        <p className="mt-3 text-xs italic text-stone-500">
          Drag a card to reorder, or use the arrows. Click any card to jump there in
          the live view above.
        </p>

        <div className="mt-8 flex flex-col items-stretch">
          {orderedPages.map((page, idx) => {
            const prev = idx > 0 ? orderedPages[idx - 1] : null;
            const isChapterStart = !prev || prev.chapterId !== page.chapterId;
            return (
              <FlowThumb
                key={page.id}
                page={page}
                idx={idx}
                active={idx === currentIdx}
                fill={pageFillState(page, answers)}
                isChapterStart={isChapterStart}
                isFirst={idx === 0}
                isLast={idx === orderedPages.length - 1}
                isDragging={dragId === page.id}
                isOver={overId === page.id && dragId && dragId !== page.id}
                onMoveUp={() => onMove(page.id, -1)}
                onMoveDown={() => onMove(page.id, 1)}
                onJump={() => onJump(idx)}
                onDragStart={(e) => {
                  setDragId(page.id);
                  e.dataTransfer.setData("text/plain", page.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragId && dragId !== page.id && overId !== page.id) setOverId(page.id);
                }}
                onDragLeave={() => {
                  if (overId === page.id) setOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== page.id) onReorder(dragId, page.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FlowThumb({
  page,
  idx,
  active,
  fill,
  isChapterStart,
  isFirst,
  isLast,
  isDragging,
  isOver,
  onMoveUp,
  onMoveDown,
  onJump,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}) {
  const fillColor =
    fill === "complete" ? "text-emerald-700" : fill === "partial" ? "text-amber-700" : "text-stone-300";
  const fillGlyph = fill === "complete" ? "✓" : fill === "partial" ? "◐" : "○";

  return (
    <div className="flex w-full flex-col">
      {isChapterStart && (
        <p className="mb-2 mt-3 text-[10px] uppercase tracking-[0.3em] text-stone-500">
          ▸ {page.chapterTitle}
        </p>
      )}
      {isOver && <div className="mb-1 h-0.5 w-full bg-amber-600" />}
      <div className="flex items-stretch gap-2">
        <button
          draggable
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          onClick={onJump}
          className={`group flex-1 cursor-grab border bg-white px-3 py-2.5 text-left transition active:cursor-grabbing ${
            active
              ? "border-stone-900 shadow-[2px_2px_0_rgba(0,0,0,0.08)]"
              : "border-stone-900/20 hover:border-stone-900/60"
          } ${isDragging ? "opacity-40" : ""}`}
        >
          {/* Mini "wireframe" of the page */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] uppercase tracking-[0.2em] text-stone-400">
              Page {idx + 1}
              {page.optional && " · optional"}
            </span>
            <span className={`text-[10px] ${fillColor}`}>{fillGlyph}</span>
          </div>
          <p className="mt-1 truncate font-serif text-sm font-medium text-stone-900">
            {page.title}
          </p>
          <div className="mt-2 border-t border-stone-900/10 pt-2">
            <MiniFieldList fields={page.fields} />
          </div>
        </button>
        <div className="flex flex-col gap-1">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className="border border-stone-900/20 bg-white p-1 text-stone-600 transition hover:border-stone-900 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-25"
            aria-label="Move up"
            title="Move up"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className="border border-stone-900/20 bg-white p-1 text-stone-600 transition hover:border-stone-900 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-25"
            aria-label="Move down"
            title="Move down"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
        </div>
      </div>
      {!isLast && (
        <div className="my-1 flex flex-col items-center text-stone-300">
          <div className="h-2 w-px bg-stone-300" />
          <ChevronDown className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}

function MiniFieldList({ fields }) {
  const visible = fields.slice(0, 4);
  const more = fields.length - visible.length;
  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((f) => (
        <div key={f.id} className="flex items-center gap-2">
          <span className="w-20 shrink-0 truncate text-[8px] uppercase tracking-[0.15em] text-stone-400">
            {f.label}
          </span>
          <FieldGlyph field={f} />
        </div>
      ))}
      {more > 0 && (
        <span className="text-[9px] italic text-stone-400">+ {more} more field{more > 1 ? "s" : ""}</span>
      )}
    </div>
  );
}

function FieldGlyph({ field }) {
  if (field.type === "textarea") {
    return (
      <div className="flex flex-1 flex-col gap-0.5">
        <div className="h-px w-full bg-stone-300" />
        <div className="h-px w-full bg-stone-300" />
        <div className="h-px w-2/3 bg-stone-300" />
      </div>
    );
  }
  if (field.type === "file") {
    return (
      <div className="flex h-3 flex-1 items-center justify-center border border-dashed border-stone-300">
        <span className="text-[7px] uppercase tracking-[0.15em] text-stone-400">↑ upload</span>
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <div className="flex flex-1 items-center justify-between border-b border-stone-300 pb-px">
        <span className="text-[8px] text-stone-300">▾</span>
      </div>
    );
  }
  if (field.type === "checkbox") {
    return (
      <div className="flex flex-1 items-center">
        <span className="inline-block h-2 w-2 border border-stone-300" />
      </div>
    );
  }
  if (field.type === "repeater") {
    const cols = field.itemFields?.length || 3;
    return (
      <div className="flex flex-1 flex-col gap-0.5">
        <div className="flex gap-0.5">
          {Array.from({ length: cols }).map((_, i) => (
            <div key={i} className="h-px flex-1 bg-stone-400" />
          ))}
        </div>
        <div className="flex gap-0.5">
          {Array.from({ length: cols }).map((_, i) => (
            <div key={i} className="h-px flex-1 bg-stone-300" />
          ))}
        </div>
        <div className="flex gap-0.5">
          {Array.from({ length: cols }).map((_, i) => (
            <div key={i} className="h-px flex-1 bg-stone-300" />
          ))}
        </div>
        <span className="text-[7px] italic text-stone-400">
          ↻ up to {field.max ?? "many"} rows
        </span>
      </div>
    );
  }
  return <div className="h-px w-full flex-1 bg-stone-300" />;
}
