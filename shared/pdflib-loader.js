// shared/pdflib-loader.js — lazy pdf-lib (MIT) loader. 0 KB until a PDF op runs.
// The ESM dist is self-contained (no bare imports), so a memoized dynamic
// import() is all that's needed — every byte same-origin from /vendor/pdf-lib/.
// Shared across the V1.2 PDF cluster (merge/split/sign/watermark).
let cached = null;
export function loadPdfLib() {
  if (cached) return cached;
  cached = import('/vendor/pdf-lib/pdf-lib.esm.min.js'); // { PDFDocument, StandardFonts, rgb, degrees, ... }
  cached.catch(() => { cached = null; }); // a failed load must not poison the cache
  return cached;
}

// Thrown when pdf-lib itself can't be fetched/parsed — an engine failure, NOT
// the file's fault. Cluster tools surface this as a global "couldn't load the
// PDF engine" message instead of blaming the dropped file (playbook: never
// blame the file for a load limit). One class shared by every PDF tool.
export class PdfEngineError extends Error {
  constructor(cause) {
    super('failed to load the PDF engine');
    this.name = 'PdfEngineError';
    this.cause = cause;
  }
}

// Convenience: load pdf-lib, or throw PdfEngineError on a load failure. Tools
// wrap their engine access with this so the error classification is uniform.
export async function loadPdfLibOrThrow() {
  try {
    return await loadPdfLib();
  } catch (e) {
    throw new PdfEngineError(e);
  }
}
