// shared/pdfjs-loader.js — lazy pdfjs-dist (Apache-2.0, LEGACY build for iOS<17.4)
// loader. 0 KB until a PDF is opened. Worker + cmaps + standard_fonts all
// same-origin (/vendor/pdfjs/). Shared by sign-pdf / pdf-to-jpg / pdf-to-text.
import { PdfEngineError } from './pdf-engine-error.js';
// Re-exported so the pdfjs tools can import the ONE cluster engine-error class
// straight from the loader they already use. Same class pdflib-loader throws —
// so a tool's `err instanceof PdfEngineError` catches either engine failing.
export { PdfEngineError };

let cached = null;
export function loadPdfjs() {
  if (cached) return cached;
  cached = (async () => {
    let pdfjs;
    try {
      pdfjs = await import('/vendor/pdfjs/legacy/build/pdf.min.mjs');
    } catch (err) {
      // The engine MODULE itself failed to load (a 404 — as when the vendored
      // build/ dir was gitignored out of the deploy — an offline network, or a
      // non-JavaScript MIME type on the .mjs that makes the browser block the
      // import). That is an engine failure, NOT the file's fault: throw the
      // shared PdfEngineError so tools show an honest, retryable message rather
      // than blaming the dropped PDF as "corrupt".
      console.error('[noadstools] pdf.js engine failed to load from /vendor/pdfjs/:', err);
      throw new PdfEngineError(err);
    }
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
    return pdfjs;
  })();
  cached.catch(() => { cached = null; }); // a failed load must not poison the cache
  return cached;
}

// pdf.js loads its WORKER lazily at the first getDocument (NOT at module import),
// so a worker-specific fault — the worker .mjs 404s (it lives in the same
// build/ dir the engine bug hit), is MIME-blocked, or its ~1.3 MB fetch is
// truncated on a flaky link — surfaces here as a worker-setup rejection, which
// is NOT the module-import error loadPdfjs() catches. Distinguish it from a
// genuine bad/encrypted PDF so callers can reclassify it as an engine failure.
function isWorkerLoadError(err) {
  const name = String((err && err.name) || '');
  // Never reclassify a real content/password problem as an engine failure.
  if (name === 'PasswordException' || name === 'InvalidPDFException'
    || name === 'MissingPDFException' || name === 'FormatError') return false;
  const msg = String((err && err.message) || err || '');
  return /worker/i.test(msg)
    || /setting up fake worker failed/i.test(msg)
    || /cannot load script/i.test(msg)
    || /importScripts/i.test(msg)
    || /dynamically imported module/i.test(msg)   // the worker .mjs failed to import
    || /failed to fetch/i.test(msg);              // at open time the only fetch is the worker
}

/** Open a PDF (Uint8Array) with same-origin cmap/font config. Returns the pdf doc proxy. */
export async function openPdf(data) {
  const pdfjs = await loadPdfjs(); // throws PdfEngineError if the engine module can't load
  try {
    return await pdfjs.getDocument({
      data,
      cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    }).promise;
  } catch (err) {
    // A worker/engine bring-up failure is our infra's fault, not the file's —
    // surface it as PdfEngineError so the tool shows the honest, retryable
    // "couldn't load the PDF engine" message instead of "corrupt PDF".
    if (isWorkerLoadError(err)) {
      console.error('[noadstools] pdf.js worker failed to load from /vendor/pdfjs/:', err);
      throw new PdfEngineError(err);
    }
    throw err;
  }
}
