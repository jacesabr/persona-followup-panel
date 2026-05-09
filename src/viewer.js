// One-time setup for the document viewers. Imported from main.jsx so
// the pdf.js worker URL and the global lightbox/text-layer styles
// register before any preview component renders.
//
// react-pdf needs the worker wired up explicitly under Vite — without
// the URL/import.meta.url ceremony, the production bundle ships no
// worker and pdf.js silently renders a blank canvas. The same line
// works in dev (Vite resolves it through node_modules) and in build
// (rolled up as a separate asset).
import { pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "react-photo-view/dist/react-photo-view.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();
