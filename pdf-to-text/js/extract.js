// pdf-to-text/js/extract.js — coordinator between the UI and the shared pdfjs
// loader + the lazy Tesseract OCR loader. For each page it pulls the real text
// layer (pdfjs `getTextContent`, fast + exact for digital PDFs); when a page has
// little or no text layer (Auto mode) or the user forced OCR ("OCR all pages"),
// it rasterizes the page to a canvas and runs Tesseract on it. Nothing is
// fetched until a PDF is opened; the ~22 MB Tesseract engine is fetched ONLY the
// first time a page actually needs OCR. Password / corrupt files are classified
// honestly (never blamed on the user).
//
// rAF-safe rendering (playbook §4): pdfjs' display `page.render()` only advances
// while requestAnimationFrame fires, and a detached/hidden canvas stalls it — so
// the CALLER must supply an OCR render canvas that is already attached to the
// (visible) DOM. main.js keeps that canvas in an on-DOM (clipped) render stage.
import { openPdf } from '/shared/pdfjs-loader.js';
import { loadOcr } from '/shared/tesseract-loader.js';
import { needsOcr } from './extract-opts.js';

const OCR_SCALE = 2;   // ~150–200 DPI at typical page sizes — enough for OCR
const MAX_DIM = 4096;  // canvas-side clamp (iOS ~4096²)

// pdfjs throws a PasswordException (name set, code 1/2) for an encrypted PDF.
// The minified build still sets `.name`, but keep a message fallback for safety.
function isPasswordError(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || err || '');
  return name === 'PasswordException' || /password/i.test(msg);
}

/**
 * Open ONE PDF and return the pdfjs document proxy + page count.
 * @param {File} file the dropped PDF.
 * @returns {Promise<{status:'ok'|'locked'|'error', doc?:object, numPages?:number}>}
 *   'locked' = password-protected, 'error' = unreadable/corrupt.
 */
export async function loadPdf(file) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { status: 'error' };
  }
  let doc;
  try {
    // openPdf copies the buffer internally; pass a fresh view so nothing the
    // caller keeps is detached by the worker.
    doc = await openPdf(bytes.slice());
  } catch (err) {
    return { status: isPasswordError(err) ? 'locked' : 'error' };
  }
  return { status: 'ok', doc, numPages: doc.numPages };
}

// Pull the text layer of one page into a plain string. pdfjs returns positioned
// text runs; join them, break the line on `hasEOL`, then normalise runs of
// spaces so a digital PDF reads back cleanly. Whitespace-only / empty layers
// come back as '' (which is what `needsOcr` keys off in Auto mode).
async function textLayerOf(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items || []) {
    out += typeof item.str === 'string' ? item.str : '';
    out += item.hasEOL ? '\n' : ' ';
  }
  return out
    .replace(/[ \t]+/g, ' ')     // collapse space runs
    .replace(/ ?\n ?/g, '\n')    // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')  // cap blank-line runs
    .trim();
}

// Compute the largest scale whose longest rendered side stays within maxDim.
function clampScale(scale, wPt, hPt, maxDim) {
  const longest = Math.max(wPt, hPt) * scale;
  return longest <= maxDim ? scale : scale * (maxDim / longest);
}

// Rasterize a page into the caller-supplied ON-DOM canvas (rAF-safe, see header)
// on a white plate, ready for OCR.
async function renderForOcr(doc, pageNum, canvas) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = clampScale(OCR_SCALE, base.width, base.height, MAX_DIM);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport, canvas, background: '#ffffff' }).promise;
}

/**
 * Extract text from a set of pages.
 * @param {object} doc pdfjs document proxy
 * @param {number[]} pageSet 1-based page numbers, in order
 * @param {{
 *   mode?: 'auto'|'text'|'ocr-all',
 *   onProgress?: (info:{page:number, index:number, total:number, phase:'text'|'ocr'}) => void,
 *   ocrCanvas?: HTMLCanvasElement   // ON-DOM canvas used for OCR rasterisation
 * }} [opts]
 * @returns {Promise<{ pages:Array<{page:number, text:string, ocr:boolean}>, ocrError:Error|null }>}
 *   `ocr:true` marks a page whose text came from OCR. `ocrError` is set (once)
 *   if the Tesseract engine failed to load or recognise — the text-layer results
 *   are still returned so nothing is lost.
 */
export async function extractPages(doc, pageSet, opts = {}) {
  const { mode = 'auto', onProgress, ocrCanvas } = opts;
  const total = pageSet.length;
  const pages = [];
  let ocrError = null;

  for (let i = 0; i < pageSet.length; i++) {
    const pageNum = pageSet[i];
    if (onProgress) onProgress({ page: pageNum, index: i, total, phase: 'text' });

    let text = await textLayerOf(doc, pageNum);
    let ocr = false;

    // 'text' never OCRs; 'ocr-all' forces it; 'auto' OCRs only a thin page.
    const wantOcr = mode === 'ocr-all' || (mode === 'auto' && needsOcr(text));
    if (wantOcr) {
      if (onProgress) onProgress({ page: pageNum, index: i, total, phase: 'ocr' });
      try {
        if (ocrCanvas) await renderForOcr(doc, pageNum, ocrCanvas);
        const worker = await loadOcr();               // lazy — fetches ~22 MB on first real use
        const result = await worker.recognize(ocrCanvas);
        const ocrText = ((result && result.text) || '').trim();
        // Mode-aware: 'ocr-all' forces OCR to win (its whole purpose is to
        // override a garbled/wrong text layer) unless OCR came back blank; in
        // 'auto' OCR only replaces a thin/empty text layer, never a real one.
        const useOcr = mode === 'ocr-all'
          ? ocrText.length > 0
          : ocrText.length >= text.length;
        // The badge (ocr:true) must appear ONLY when the shown text is the OCR
        // text — so it can never claim OCR for text that wasn't used.
        if (useOcr) { text = ocrText; ocr = true; }
      } catch (err) {
        // Honest failure: remember it for the UI note, keep the text-layer text.
        if (!ocrError) ocrError = err instanceof Error ? err : new Error(String(err));
      }
    }

    pages.push({ page: pageNum, text, ocr });
  }

  return { pages, ocrError };
}
