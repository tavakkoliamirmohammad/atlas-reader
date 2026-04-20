// Use Vite's native ?worker import. This gives PDF.js a real Worker
// instance instead of a URL string, which avoids cross-module-loading
// quirks with the prod build under StaticFiles.
import { pdfjs } from "react-pdf";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
