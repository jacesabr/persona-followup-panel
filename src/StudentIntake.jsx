import { useState, useEffect, useRef, useCallback, useMemo, forwardRef } from "react";
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
  transitionPhase,
} from "./intakeFiles.js";
import StudentDashboard from "./StudentDashboard.jsx";
import { CHAPTERS, validateIntakeRequired, isFieldVisible } from "../lib/intakeSchema.js";

// ============================================================
// Schema lives in ../lib/intakeSchema.js so the server can validate
// the intake → done phase transition against the same shape.
// Re-exported here for back-compat with existing importers.
// ============================================================
export { CHAPTERS };

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
  aadharFile: mockFile("riya_aadhar.jpg", 198440),
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
  ielts_status: "Already taken",
  ielts_score: "8.5",
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
function ageFromDob(dob) {
  if (!dob) return "";
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 ? `${age}` : "";
}

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
        aadharFile: fileOut(answers.aadharFile),
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
          // Tri-state status drives the panel; booked stays for back-
          // compat with downstream resume generators that read it.
          status: answers.ielts_status || "",
          plannedDate: answers.ielts_planned_date || "",
          score: answers.ielts_score || "",
          booked:
            answers.ielts_status === "Planning to take" ||
            answers.ielts_status === "Already taken",
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
  // Hidden conditional fields must not count as required (otherwise a
  // page like p_ielts shows "1 required left" forever when the student
  // picks "Won't take" — the score field is hidden but technically
  // non-optional in the schema).
  const visible = page.fields.filter((f) => isFieldVisible(f, answers));
  const required = visible.filter((f) => !f.optional && !page.optional);
  const filledReq = required.filter((f) => isFieldFilled(answers[f.id])).length;
  const filledAny = visible.filter((f) => isFieldFilled(answers[f.id])).length;
  // requireAtLeastOne pages (e.g. p_marks12 — marksheet OR predicted-
  // scores) need at least one filled cell on top of the per-field
  // required check, otherwise an all-empty page reads as "complete".
  const atLeastOneOk = !page.requireAtLeastOne || page.optional || filledAny > 0;
  if (required.length === 0) {
    if (page.requireAtLeastOne && !page.optional) {
      return filledAny > 0 ? "complete" : "empty";
    }
    return filledAny > 0 ? "complete" : "empty";
  }
  if (filledReq === required.length && atLeastOneOk) return "complete";
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

  // Hydrate from backend on mount. ONE round-trip — body now includes
  // both the saved data AND a server-resolved `phase` so reload during
  // any post-intake screen lands on the right thing (was a hole the
  // wiring audit found: phase was component-local; reload bounced the
  // student back to review and re-POSTing duplicated generations).
  // Also restores the last page they were on (data.lastStep) so the
  // 80-question intake doesn't restart at welcome.
  useEffect(() => {
    let cancelled = false;
    loadRecord()
      .then((body) => {
        if (cancelled) return;
        const data = body?.data || {};
        const savedAnswers = data.answers || {};
        const savedOrder = data.order;
        const reconciledOrder = reconcileOrder(savedOrder);
        setAnswers(repairTransientStates(savedAnswers));
        setOrder(reconciledOrder);
        expectedUpdatedAtRef.current = body?.updatedAt || null;

        // Last-page restore. data.lastStep is the index into the
        // ordered pages array we were on. Clamp into [-1, total-1] in
        // case the schema changed since the save.
        if (Number.isInteger(data.lastStep)) {
          const clamped = Math.max(-1, Math.min(reconciledOrder.length - 1, data.lastStep));
          setStep(clamped);
        }

        // Phase restore — server is the source of truth.
        const serverPhase = body?.phase;
        if (serverPhase && serverPhase !== "intake") {
          setPhase(serverPhase);
        }
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
  // Track the latest step in a ref so persist() can include it in the
  // payload without re-binding on every step change.
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  const persist = useCallback(async (opts = {}) => {
    setSaveState("saving");
    const tryOnce = async () => {
      const payload = {
        data: {
          answers: answersRef.current,
          order: orderRef.current,
          // Persist the page index so a returning student lands on the
          // exact page they left, not the welcome screen. Cheap — adds
          // ~10 bytes to every PUT.
          lastStep: stepRef.current,
        },
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

  // Mark general intake as done and transition the server-side phase
  // straight to 'done'. Transcription used to live in a separate
  // doc_review screen but now happens inline on each upload page, so
  // the only post-intake state is the auto-fired resume's status.
  //
  // Two server calls (save-then-transition) on purpose: the phase
  // endpoint doesn't take data, so the debounced save has to land
  // first or the resume generator would see a stale snapshot.
  // transitionPhase will 409 if the server already moved past 'intake'
  // (another tab finished first) — we surface that as a generic
  // "couldn't continue"; refreshing rehydrates the correct phase.
  const finishIntake = useCallback(async () => {
    // Defence-in-depth: the page-by-page advance gate already prevents
    // skipping required fields, but a stale draft (saved before a flag
    // changed in the schema, or restored from another tab mid-edit)
    // can land here with a hole. Re-validate against the same shape
    // the server is about to check on `phase=done` — if anything is
    // missing, jump the student back to the offending page instead of
    // opening a 422 round-trip.
    const { ok, missing } = validateIntakeRequired(answersRef.current);
    if (!ok) {
      const firstPageId = missing[0]?.pageId;
      const idx = orderRef.current.indexOf(firstPageId);
      if (idx >= 0) setStep(idx);
      const labels = missing
        .slice(0, 5)
        .map((m) => m.label)
        .join(", ");
      const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : "";
      alert(
        `Some required fields are still empty — fill them before continuing:\n\n${labels}${more}`
      );
      return;
    }
    await persist({ intakeComplete: false });
    try {
      await transitionPhase("done");
      // Resume is auto-fired by the server in the same transaction; show
      // the generating-state dashboard until polling flips it to done.
      setPhase("generating");
      onComplete?.(answersRef.current);
    } catch (e) {
      // Silent failure on PHASE_CONFLICT: refresh once the user
      // notices nothing happened and the server's hydration will
      // jump them to the right place.
      console.error("[finishIntake] phase transition failed:", e);
      alert(e?.message || "Couldn't continue — refresh and try again.");
    }
  }, [persist, onComplete]);

  // Server-driven phase machine. Single source of truth for which
  // screen the student sees:
  //   "intake"      → filling the general form (uploads + transcription
  //                   happen inline on the same page)
  //   "generating"  → resume auto-fired by the intake→done transition;
  //                   dashboard polls until the markdown is ready
  //   "done"        → resume ready; dashboard renders it
  // Only one resume is generated for v1 (no picker, no extraction).
  const [phase, setPhase] = useState("intake");
  // Phase is now set inside the hydrate useEffect from the server's
  // resolved phase field — see the loadRecord block above. The previous
  // implementation re-fetched /me/record solely to read intake_complete,
  // which (a) doubled the round-trips on every mount and (b) only
  // handled the intake→review transition; reload during generating /
  // done bounced the student back to review. The wiring audit flagged
  // both.

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

  // Post-intake phase: StudentDashboard renders the auto-generated
  // resume and polls while it's still in flight.
  if (phase === "generating" || phase === "done") {
    // Both phases render the same dashboard — it polls until the
    // auto-fired resume's status becomes terminal, then shows the
    // markdown. The server's GET /me/record may bump phase from
    // "done" to "generating" if the resume hasn't completed yet.
    return (
      <StudentDashboard studentName={studentName} onExit={onExit} />
    );
  }

  return (
    <div
      className="min-h-screen w-full font-serif text-stone-900"
      style={{ backgroundColor: "#f4f0e6" }}
    >
      <TopBar onExit={onExit} onAutofill={fillMock} saveState={saveState} />

      <section className="mx-auto max-w-3xl px-6 pt-28 pb-12">
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
            <Closing
              onDone={finishIntake}
              onBack={() => setStep(total - 1)}
              answers={answers}
              onEditPage={(pageId) => {
                const idx = orderedPages.findIndex((p) => p.id === pageId);
                if (idx >= 0) jumpTo(idx);
              }}
            />
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
        back any time. Skip what doesn't apply.
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

// Walk every field in the schema (including repeater sub-fields) and
// pull out the file slots that the student successfully uploaded. The
// closing review needs this twice: once to render previews under each
// page, and once to render the flat "all documents" gallery that
// downstream AI/transcription tooling will pick from.
function collectUploadedFiles(answers) {
  const out = [];
  for (const chapter of CHAPTERS) {
    for (const page of chapter.pages) {
      for (const field of page.fields) {
        const v = answers[field.id];
        if (field.type === "file") {
          if (isFileUploaded(v)) {
            out.push({
              key: field.id,
              label: field.label,
              chapterTitle: chapter.title,
              pageId: page.id,
              file: v,
            });
          }
        } else if (field.type === "repeater" && Array.isArray(v)) {
          v.forEach((row, rowIdx) => {
            if (!row || typeof row !== "object") return;
            for (const sub of field.itemFields || []) {
              if (sub.type !== "file") continue;
              const cell = row[sub.id];
              if (isFileUploaded(cell)) {
                out.push({
                  key: `${field.id}-${rowIdx}-${sub.id}`,
                  label: `${field.label} #${rowIdx + 1} — ${sub.label}`,
                  chapterTitle: chapter.title,
                  pageId: page.id,
                  file: cell,
                });
              }
            }
          });
        }
      }
    }
  }
  return out;
}

// Project a single field into 0..N text rows for the per-page summary.
// Files are intentionally omitted here — they're rendered as previews
// in their own block under the page summary, plus once more in the
// flat docs gallery at the bottom. Empty values produce no rows so a
// fully-skipped optional page collapses cleanly.
function fieldSummaryRows(field, value) {
  if (field.type === "file") return [];
  if (field.type === "repeater") {
    if (!Array.isArray(value)) return [];
    const rows = [];
    value.forEach((row, idx) => {
      if (!row || typeof row !== "object") return;
      const cells = (field.itemFields || [])
        .map((sub) => {
          if (sub.type === "file") return null;
          const cv = row[sub.id];
          if (typeof cv === "boolean") return cv ? sub.label : null;
          if (cv === "" || cv == null) return null;
          return `${sub.label}: ${cv}`;
        })
        .filter(Boolean);
      if (cells.length === 0) return;
      rows.push({
        label: `${field.label} #${idx + 1}`,
        value: cells.join(" · "),
      });
    });
    return rows;
  }
  if (field.type === "checkbox") {
    if (!value) return [];
    return [{ label: field.label, value: "Yes" }];
  }
  if (value === "" || value == null) return [];
  return [{ label: field.label, value: String(value) }];
}

// One page's worth of the summary: text rows for the typed-in fields,
// then any uploaded files for that page rendered with their inline
// preview so the student can verify the doc is the right one without
// scrolling down to the gallery.
function PageSummary({ page, answers, files, onEditPage }) {
  const rows = page.fields.flatMap((f) => fieldSummaryRows(f, answers[f.id]));
  if (rows.length === 0 && files.length === 0) return null;
  return (
    <div className="border-t border-stone-900/10 pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-serif text-xl text-stone-900">{page.title}</h4>
        <button
          onClick={() => onEditPage?.(page.id)}
          className="text-[10px] uppercase tracking-[0.2em] text-stone-500 hover:text-stone-900"
        >
          edit
        </button>
      </div>
      {rows.length > 0 && (
        <div className="mt-3 space-y-2">
          {rows.map((row, i) => (
            <div
              key={i}
              className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[180px_1fr] sm:gap-4"
            >
              <span className="text-[11px] uppercase tracking-wider text-stone-500">
                {row.label}
              </span>
              <span className="whitespace-pre-wrap break-words text-sm text-stone-800">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mt-4 space-y-3">
          {files.map((entry) => (
            <div key={entry.key} className="border border-stone-900/10 bg-white/60 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] uppercase tracking-wider text-stone-500">
                  {entry.label}
                </p>
                <p className="text-[10px] text-stone-500">
                  {humanSize(entry.file.size)}
                </p>
              </div>
              <p className="mt-1 truncate text-sm text-stone-800">{entry.file.name}</p>
              <FilePreview slot={entry.file} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Closing({ onDone, onBack, answers, onEditPage }) {
  const allFiles = useMemo(() => collectUploadedFiles(answers || {}), [answers]);
  const filesByPage = useMemo(() => {
    const m = {};
    for (const f of allFiles) {
      if (!m[f.pageId]) m[f.pageId] = [];
      m[f.pageId].push(f);
    }
    return m;
  }, [allFiles]);

  return (
    <div className="animate-fadeUp py-12">
      <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">Almost there</p>
      <h2 className="mt-2 font-serif text-5xl leading-[1.05]">Review your profile.</h2>
      <p className="mt-6 max-w-xl text-base leading-relaxed text-stone-600">
        A final check before we generate your resume. Tap{" "}
        <span className="italic">edit</span> on any section to fix something —
        we'll bring you right back here.
      </p>

      <div className="mt-12 space-y-12">
        {CHAPTERS.map((chapter) => {
          const visiblePages = chapter.pages.filter((page) => {
            const rowCount = page.fields.flatMap((f) =>
              fieldSummaryRows(f, (answers || {})[f.id])
            ).length;
            const fileCount = (filesByPage[page.id] || []).length;
            return rowCount > 0 || fileCount > 0;
          });
          if (visiblePages.length === 0) return null;
          return (
            <div key={chapter.id}>
              <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
                ▸ {chapter.title}
              </p>
              <div className="mt-3 space-y-6">
                {visiblePages.map((page) => (
                  <PageSummary
                    key={page.id}
                    page={page}
                    answers={answers || {}}
                    files={filesByPage[page.id] || []}
                    onEditPage={onEditPage}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-16 border-t border-stone-900/15 pt-10">
        <p className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
          Documents · {allFiles.length}
        </p>
        <h3 className="mt-2 font-serif text-3xl text-stone-900">
          Every file you uploaded
        </h3>
        <p className="mt-3 max-w-xl text-sm italic text-stone-500">
          One place to scan everything you sent us. Open any preview to verify
          the contents are right.
        </p>
        {allFiles.length === 0 ? (
          <p className="mt-6 text-sm italic text-stone-500">
            No documents uploaded.
          </p>
        ) : (
          <ul className="mt-6 space-y-4">
            {allFiles.map((entry) => (
              <li
                key={entry.key}
                className="border border-stone-900/15 bg-white/40 p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-stone-500">
                    {entry.chapterTitle} · {entry.label}
                  </p>
                  <p className="text-[10px] text-stone-500">
                    {humanSize(entry.file.size)}
                  </p>
                </div>
                <p className="mt-1 truncate text-sm text-stone-800">
                  {entry.file.name}
                </p>
                <FilePreview slot={entry.file} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-12 border-t border-stone-900/15 pt-10">
        <p className="max-w-xl text-base leading-relaxed text-stone-600">
          We'll generate a 300-word summary of your profile from everything
          above. Takes about a minute. You'll land on your dashboard once it's
          ready — your counsellor sees everything from there too.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
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
            Submit & generate resume <ArrowRight className="h-4 w-4" />
          </button>
        </div>
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

  // Visibility filter for showIf-driven fields — must run before any
  // gate logic so hidden fields don't show up as "missing".
  const visibleFields = page.fields.filter((f) => isFieldVisible(f, answers));
  const requiredFields = visibleFields.filter((f) => !f.optional && !page.optional);
  const allRequiredFilled = requiredFields.every((f) => isFieldFilled(answers[f.id]));
  // requireAtLeastOne (e.g. p_marks12) — page advances only when at
  // least one of its fields is filled, regardless of per-field flags.
  const anyFieldFilled = visibleFields.some((f) => isFieldFilled(answers[f.id]));
  const atLeastOneOk = !page.requireAtLeastOne || page.optional || anyFieldFilled;
  const inflight = visibleFields.some((f) => fieldHasInflight(answers[f.id]));
  const errored = visibleFields.some((f) => fieldHasError(answers[f.id]));
  const canAdvance =
    !inflight && !errored && (page.optional || (allRequiredFilled && atLeastOneOk));

  const remainingRequired =
    requiredFields.length - requiredFields.filter((f) => isFieldFilled(answers[f.id])).length;
  const advanceLabel = inflight
    ? "uploading…"
    : errored
    ? "fix file errors"
    : canAdvance
    ? "OK"
    : remainingRequired > 0
    ? `${remainingRequired} required left`
    : "upload at least one";

  // Split layout: when a page has both file uploads and non-file fields,
  // put the uploads (with their inline previews) on the left and the
  // typed-in fields on the right so the student can transcribe values
  // (passport #, marks %, scores) while looking at the doc they just
  // uploaded. Pages with only files OR only text fields fall back to
  // the original 2-col grid.
  const fileFields = visibleFields.filter((f) => f.type === "file");
  const textFields = visibleFields.filter((f) => f.type !== "file" && f.type !== "repeater");
  const repeaterFields = visibleFields.filter((f) => f.type === "repeater");
  const isSplit =
    page.layout === "split" || (fileFields.length > 0 && textFields.length > 0);

  const renderField = (field, ref) => {
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
        inputRef={ref}
        wide={field.type === "textarea" || field.type === "file" || field.type === "repeater"}
      />
    );
  };

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

      {page.id === "p_passport_scans" && (
        <div className="mt-5 inline-flex items-baseline gap-3 border-l-2 border-stone-300 pl-3 text-xs text-stone-600">
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400">Age</span>
          <span className="font-medium text-stone-800">
            {answers.dob ? `${ageFromDob(answers.dob)} years` : "fill date of birth →"}
          </span>
        </div>
      )}

      {isSplit ? (
        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <div className="space-y-6">
            {fileFields.map((field, i) =>
              renderField(field, page.fields[0]?.id === field.id ? firstFieldRef : undefined)
            )}
          </div>
          <div className="space-y-6">
            {textFields.map((field, i) =>
              renderField(field, page.fields[0]?.id === field.id ? firstFieldRef : undefined)
            )}
            {repeaterFields.map((field) => renderField(field))}
          </div>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {visibleFields.map((field, i) =>
            renderField(field, i === 0 ? firstFieldRef : undefined)
          )}
        </div>
      )}

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
        // Default accept now allows phone-camera photos (JPG/PNG) AND
        // PDFs everywhere. Indian students overwhelmingly snap
        // marksheets/LORs on Android; PDF-only was rejecting the
        // most common upload path. Server validator already accepts
        // image/jpeg + image/png, so this is a pure client-side
        // unblock. Per-field schema can still override (e.g. force
        // PDF-only for a field where photos make no sense).
        accept={field.accept || "image/jpeg,image/png,application/pdf"}
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

    // Repeaters with a file subfield (activities, other-docs) get an
    // extra "Preview" column so the student can pop the upload open in
    // a new tab and verify it. We don't inline a full FilePreview here
    // because the row is already a tight grid — a tappable thumbnail
    // (image) or PDF badge keeps the row's height bounded.
    const fileSubfield = field.itemFields.find((sf) => sf.type === "file");
    const hasFileSubfield = !!fileSubfield;
    const cols = field.itemFields.length;
    // Per-cell minimum so cells stay readable on phones. Without this,
    // a 320px viewport with 5 columns squeezes each cell to ~50px and
    // text inputs become unusable. With min 9rem per data column the
    // table widens past the viewport and the wrapper scrolls
    // horizontally — standard pattern for data-dense tables on mobile.
    const dataColTrack = "minmax(9rem, 1fr)";
    const gridStyle = {
      gridTemplateColumns: hasFileSubfield
        ? `2rem repeat(${cols}, ${dataColTrack}) 4rem 2rem`
        : `2rem repeat(${cols}, ${dataColTrack}) 2rem`,
    };

    return (
      <div className="mt-2">
        {/* overflow-x-auto turns the table into a horizontally
            scrollable strip on narrow viewports. -webkit-overflow-
            scrolling: touch makes the scroll feel native on iOS. The
            inner grid keeps its full width via the min-width tracks
            above. */}
        <div className="overflow-x-auto overflow-y-hidden border border-stone-900/20">
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
            {hasFileSubfield && (
              <div className="bg-[#f4f0e6] px-2 py-1.5 truncate">Preview</div>
            )}
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
              {hasFileSubfield && (
                <RepeaterThumb slot={row?.[fileSubfield.id]} />
              )}
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
  // Normalise on blur so the persisted value is canonical (digits-only
  // Aadhar formatted as "XXXX XXXX XXXX", upper-cased passport, etc.)
  // even if the student typed freely. Doing it on blur instead of
  // on-change avoids the cursor-jumping jank that mid-typing reformat
  // produces. The mutation goes through onChange so the autosave debounce
  // still fires.
  const norm = field.normalize ? NORMALIZERS[field.normalize] : null;
  return (
    <input
      ref={ref}
      type={field.type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => {
        if (norm) {
          const next = norm(value);
          if (next !== value) onChange(next);
        }
        onBlur?.(e);
      }}
      placeholder={field.placeholder}
      inputMode={field.inputMode}
      autoComplete={field.autoComplete}
      className={lineCls}
    />
  );
});

// Field-level value canonicalisers, keyed by the schema's `normalize`
// flag. Each is a pure (string -> string); blur handlers apply them
// after the user stops editing.
const NORMALIZERS = {
  // Aadhar is a 12-digit number, conventionally written in groups of
  // four. We tolerate any input — students paste in dashes, hyphens,
  // dots, sometimes with the country code — and reduce to digits. Once
  // it's exactly 12 digits we space-format it; otherwise we leave the
  // raw digits so a partially-typed value stays editable instead of
  // getting padded into nonsense.
  aadhar: (s) => {
    const digits = String(s || "").replace(/\D+/g, "");
    if (digits.length === 12) {
      return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
    }
    return digits;
  },
  // Indian passports are alphanumeric (commonly one capital letter +
  // 7 digits, e.g. "A1234567"). Strip whitespace and uppercase the
  // letters; keep everything else as-is so we don't mangle unfamiliar
  // formats from non-Indian passports.
  passport: (s) => String(s || "").replace(/\s+/g, "").toUpperCase(),
};

// ============================================================
// FileSlot — real <input type="file"> with validation and upload.
// State machine: empty → validating → uploading → uploaded | error
// On error or completion the user can replace or remove the file.
// ============================================================
const FileSlot = forwardRef(function FileSlot(
  { value, onChange, onBlur, accept = "image/jpeg,image/png,application/pdf", maxSizeMB = 10, fieldId, compact = false, capture = null },
  ref
) {
  const inputRef = useRef(null);
  const slot = isFileSlot(value) ? value : null;
  const status = slot?.status || "empty";
  // Drag-over visual: tracked locally so the dashed border lights up
  // when the student drags a file into the slot. dragDepth handles
  // child-element drag events that would otherwise flicker the state.
  const [dragDepth, setDragDepth] = useState(0);
  const isDragging = dragDepth > 0;

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
      const { url, uploadedAt, fileId: uploadedFileId } = await uploadFile(
        file,
        { fieldId }
      );
      onChange({
        ...base,
        status: "uploaded",
        uploadedUrl: url,
        uploadedAt,
        fileId: uploadedFileId,
      });
      onBlur?.();
    } catch (err) {
      onChange({ ...base, status: "error", error: err?.message || "Upload failed." });
      onBlur?.();
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

  // Drag-and-drop wiring. The hidden <input> still owns the canonical
  // file-picker UX (click → OS dialog) and on-mobile the camera-capture
  // hint; drag events only matter on desktop. dragenter/leave events
  // bubble through child nodes which would otherwise flip the state on
  // every internal transition — counter via depth so we only un-style
  // when the cursor truly leaves the slot.
  const onDragEnter = (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      setDragDepth((d) => d + 1);
    }
  };
  const onDragOver = (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDragLeave = () => setDragDepth((d) => Math.max(0, d - 1));
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    setDragDepth(0);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  return (
    <div className={compact ? "" : "mt-1.5"}>
    <div
      className={`flex items-center justify-between gap-2 border border-dashed bg-white/40 ${padCls} transition ${
        isDragging ? "border-stone-900 bg-stone-50" : borderCls
      }`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={capture || undefined}
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
            {isDragging
              ? "drop file here…"
              : compact
              ? `${acceptHuman} · max ${maxSizeMB} MB`
              : `no file selected · ${acceptHuman} · max ${maxSizeMB} MB`}
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
          <span className={`inline-flex w-full items-center gap-1.5 truncate text-stone-900 ${textCls}`}>
            <Check className="h-3 w-3 shrink-0 text-emerald-700" />
            <span className="min-w-0 flex-1 truncate">{slot?.name}</span>
            <span className="shrink-0 text-[9px] uppercase tracking-[0.15em] text-stone-400">
              {humanSize(slot?.size)}
            </span>
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
    {!compact && status === "uploaded" && <FilePreview slot={slot} />}
    </div>
  );
});

// Inline preview shown right below an uploaded file slot. Image files
// render with an <img>; PDFs render as a tappable card that opens the
// file in a new tab.
//
// We intentionally don't <iframe> PDFs: iOS Safari (and most mobile
// browsers) refuse to render PDFs inline and show a blank box instead,
// so a meaningful slice of users would see a broken preview right at
// the point they're trying to transcribe values from it. The
// "open in new tab" affordance hands the file off to the OS / browser
// PDF viewer, which works everywhere.
//
// Image attrs:
//   loading="lazy"      — defer offscreen renders until scrolled into view
//   decoding="async"    — don't block the main thread while decoding the
//                         full-resolution photo (phone JPEGs are big)
//   referrerpolicy="no-referrer" — don't leak the file's URL via Referer
//                         if a student ever right-clicks → "open image in
//                         new tab" on a page that gets shared.
//
// EXIF orientation: server-side sharp() bakes the rotation into the
// pixels at upload time, so by the time we render the <img> the image
// is already physically right-side-up. Modern browsers also honour the
// EXIF tag for <img> by default; this is belt-and-suspenders.
function FilePreview({ slot }) {
  const url = slot?.uploadedUrl;
  if (!url) return null;
  // Autofill mock writes stub:// URLs that no browser can render. Skip
  // the preview block in that case so the demo state shows the
  // "uploaded" pill without a broken image underneath.
  if (url.startsWith("stub://")) return null;
  const type = slot?.type || "";
  const name = slot?.name || "uploaded file";
  if (type.startsWith("image/")) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block border border-stone-900/15 bg-white"
        title="Open full size"
      >
        <img
          src={url}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="block max-h-96 w-full object-contain"
          style={{ imageOrientation: "from-image" }}
        />
      </a>
    );
  }
  // PDF (or any non-image — the upload validator only accepts PDF / JPEG
  // / PNG, so this branch is effectively "PDF").
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-2 flex items-center justify-between gap-3 border border-stone-900/15 bg-white px-3 py-3 transition hover:border-stone-900 hover:bg-stone-50"
      title="Open in a new tab"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-stone-900/30 bg-stone-50 text-[9px] font-semibold uppercase tracking-wider text-stone-700">
          PDF
        </span>
        <span className="min-w-0 truncate text-sm text-stone-700">{name}</span>
      </div>
      <span className="shrink-0 text-[10px] uppercase tracking-[0.15em] text-stone-500">
        Open ↗
      </span>
    </a>
  );
}

function RepeaterCell({ subfield, value, onChange, onBlur, rootRef }) {
  if (subfield.type === "file") {
    return (
      <div className="bg-[#f4f0e6] px-1.5 py-1">
        <FileSlot
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          accept={subfield.accept || "image/jpeg,image/png,application/pdf"}
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

// Tiny tappable preview shown in the "Preview" column of repeaters
// that have a file subfield. Clicking pops the upload open in a new
// tab so the student can verify it without leaving the page. Empty /
// in-flight rows render as a blank cell of the same height to keep the
// row's grid track aligned.
function RepeaterThumb({ slot }) {
  const url = slot?.uploadedUrl;
  const isReady =
    isFileUploaded(slot) && url && !url.startsWith("stub://");
  if (!isReady) {
    return <div className="bg-[#f4f0e6]" aria-hidden="true" />;
  }
  const type = slot?.type || "";
  const name = slot?.name || "uploaded file";
  const isImage = type.startsWith("image/");
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open ${name} in a new tab`}
      className="flex items-center justify-center overflow-hidden bg-[#f4f0e6] p-1 transition hover:bg-stone-200"
    >
      {isImage ? (
        <img
          src={url}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="block h-10 w-full object-cover"
          style={{ imageOrientation: "from-image" }}
        />
      ) : (
        <span className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-[0.1em] text-stone-600">
          PDF ↗
        </span>
      )}
    </a>
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
          the preview above.
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
