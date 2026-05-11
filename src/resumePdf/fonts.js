// Font registration for the @react-pdf/renderer resume templates.
//
// Bundled via @fontsource/* packages instead of fetched from a CDN
// at runtime — react-pdf's #1 reported bug is fonts hanging the
// usePDF instance when an external CDN is slow / blocked. Bundling
// makes the URLs same-origin and synchronous-ish (Vite serves the
// font binaries from /assets/ at build time).
//
// Format: .woff, NOT .woff2. fontkit (the parser react-pdf uses
// internally) decompresses .woff2 via Brotli and that path is the
// source of the "Offset is outside the bounds of the DataView"
// crash that broke the PDF preview on the new deployment. .woff
// uses gzip / zlib decompression which fontkit handles reliably,
// at the cost of ~25-30% larger asset size — acceptable since these
// files are still small (single-digit KB each, latin subset only).
//
// Each weight registers as its own variant; react-pdf falls back to
// the closest weight if a requested fontWeight isn't registered, so
// register every weight a template actually uses.
//
// All three templates import this module for side effects only —
// `import "./fonts.js"` once per template entry to ensure the
// Font.register calls have run before the first <Document> mount.

import { Font } from "@react-pdf/renderer";

import garamondRegular from "@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff?url";
import garamondItalic  from "@fontsource/eb-garamond/files/eb-garamond-latin-400-italic.woff?url";
import garamondBold    from "@fontsource/eb-garamond/files/eb-garamond-latin-700-normal.woff?url";

import interRegular from "@fontsource/inter/files/inter-latin-400-normal.woff?url";
import interBold    from "@fontsource/inter/files/inter-latin-700-normal.woff?url";

import robotoLight   from "@fontsource/roboto/files/roboto-latin-300-normal.woff?url";
import robotoRegular from "@fontsource/roboto/files/roboto-latin-400-normal.woff?url";
import robotoBold    from "@fontsource/roboto/files/roboto-latin-700-normal.woff?url";

import latoRegular from "@fontsource/lato/files/lato-latin-400-normal.woff?url";
import latoItalic  from "@fontsource/lato/files/lato-latin-400-italic.woff?url";
import latoBold    from "@fontsource/lato/files/lato-latin-700-normal.woff?url";

Font.register({
  family: "EB Garamond",
  fonts: [
    { src: garamondRegular, fontWeight: 400, fontStyle: "normal" },
    { src: garamondItalic,  fontWeight: 400, fontStyle: "italic" },
    { src: garamondBold,    fontWeight: 700, fontStyle: "normal" },
  ],
});

Font.register({
  family: "Inter",
  fonts: [
    { src: interRegular, fontWeight: 400 },
    { src: interBold,    fontWeight: 700 },
  ],
});

Font.register({
  family: "Roboto",
  fonts: [
    { src: robotoLight,   fontWeight: 300 },
    { src: robotoRegular, fontWeight: 400 },
    { src: robotoBold,    fontWeight: 700 },
  ],
});

Font.register({
  family: "Lato",
  fonts: [
    { src: latoRegular, fontWeight: 400, fontStyle: "normal" },
    { src: latoItalic,  fontWeight: 400, fontStyle: "italic" },
    { src: latoBold,    fontWeight: 700, fontStyle: "normal" },
  ],
});

// Disables react-pdf's automatic hyphenation. Resumes look unprofessional
// when long words like "responsibilities" or company names get hyphenated
// across line breaks. We'd rather let a long word push to the next line.
Font.registerHyphenationCallback((word) => [word]);
