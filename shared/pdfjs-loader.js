// shared/pdfjs-loader.js — lazy pdfjs-dist (Apache-2.0, LEGACY build for iOS<17.4)
// loader. 0 KB until a PDF is opened. Worker + cmaps + standard_fonts all
// same-origin (/vendor/pdfjs/). Shared by sign-pdf / pdf-to-jpg / pdf-to-text.
let cached = null;
export function loadPdfjs() {
  if (cached) return cached;
  cached = (async () => {
    const pdfjs = await import('/vendor/pdfjs/legacy/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
    return pdfjs;
  })();
  cached.catch(() => { cached = null; });
  return cached;
}
/** Open a PDF (Uint8Array) with same-origin cmap/font config. Returns the pdf doc proxy. */
export async function openPdf(data) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data,
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  }).promise;
}
