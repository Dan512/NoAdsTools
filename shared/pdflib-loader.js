// shared/pdflib-loader.js — lazy pdf-lib (MIT) loader. 0 KB until a PDF op runs.
// The ESM dist is self-contained (no bare imports), so a memoized dynamic
// import() is all that's needed — every byte same-origin from /vendor/pdf-lib/.
// Shared across the V1.2 PDF cluster (merge/split/sign/watermark).
import { PdfEngineError } from './pdf-engine-error.js';
// Re-exported so existing importers keep `import { PdfEngineError } from
// '/shared/pdflib-loader.js'` working; the class itself now lives in its own
// module so pdfjs-loader can throw the SAME class (one instanceof for both engines).
export { PdfEngineError };
let cached = null;
export function loadPdfLib() {
  if (cached) return cached;
  cached = import('/vendor/pdf-lib/pdf-lib.esm.min.js'); // { PDFDocument, StandardFonts, rgb, degrees, ... }
  cached.catch(() => { cached = null; }); // a failed load must not poison the cache
  return cached;
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
