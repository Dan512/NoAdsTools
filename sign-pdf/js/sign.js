// sign-pdf/js/sign.js — coordinator between the UI and the two engines. pdfjs
// (via the shared loader) renders each page to an on-DOM canvas for placement;
// pdf-lib (via the shared loader) embeds the signature PNG and stamps it at the
// mapped page coordinates. Nothing is fetched until a PDF is opened. Password /
// corrupt files are classified honestly; PdfEngineError is the cluster-wide
// engine-failure class (one class, one message) re-exported for main.js.
import { openPdf } from '/shared/pdfjs-loader.js';
import { loadPdfLibOrThrow, PdfEngineError } from '/shared/pdflib-loader.js';
import { stripSourceMetadata } from '/shared/pdf-meta.js';
import { toPdfRect } from './place-rect.js';
export { PdfEngineError };

// pdfjs throws a PasswordException (name set, code 1/2) for an encrypted PDF.
// The minified build still sets `.name`, but keep a message fallback for safety.
function isPasswordError(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || err || '');
  return name === 'PasswordException' || /password/i.test(msg);
}

/**
 * Open a PDF and build a canvas per page for the placement preview.
 *
 * Rendering is LAZY: only the first `eager` pages are rasterized before this
 * resolves; the rest are painted on demand via the returned `renderPage(index)`
 * so a 100+ page document doesn't allocate 100+ large canvases at once (a phone
 * would OOM). Each page's PDF-space dimensions (pageWidthPt/pageHeightPt) are
 * measured cheaply for EVERY page up front, so placement + coordinate mapping
 * work on any page — the pixel raster is the only thing deferred.
 *
 * The canvas is created here but handed to the caller via `onPage` BEFORE any
 * render is awaited, so the caller can attach it to the (visible) DOM first —
 * pdfjs' display render only advances while requestAnimationFrame fires, and a
 * detached/hidden canvas would stall the render promise (playbook §4).
 *
 * @param {File} file the dropped PDF.
 * @param {{ onPage?:(meta)=>void|Promise<void>, fitWidth?:number, eager?:number }} opts
 *   onPage receives { pageIndex, canvas, viewport, pageWidthPt, pageHeightPt,
 *   renderScale, rendered } for each page (in order). fitWidth is the target
 *   canvas width in px (the page is scaled to it, preserving aspect). eager is
 *   how many leading pages to rasterize before resolving (default 10).
 * @returns {Promise<{status:'ok'|'locked'|'error', bytes?:Uint8Array,
 *   numPages?:number, pages?:object[], renderPage?:(index:number)=>Promise<boolean>,
 *   eager?:number}>}
 *   renderPage(index) rasterizes one page's canvas on demand (idempotent;
 *   resolves true once that page is rendered). Its render targets the SAME
 *   canvas element handed to onPage, so no DOM swap is needed on completion.
 */
export async function loadAndRender(file, { onPage, fitWidth = 900, eager = 10 } = {}) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { status: 'error' };
  }

  let pdf;
  try {
    // openPdf copies the buffer internally; pass a fresh view so the cached
    // `bytes` (reused by applySignature) is never detached by the worker.
    pdf = await openPdf(bytes.slice());
  } catch (err) {
    // An engine-load failure is not the file's fault — let it propagate so
    // main.js shows the honest, retryable "couldn't load the PDF engine"
    // message (it already catches PdfEngineError), the same as a pdf-lib load
    // failure. Only a genuine open failure is classified locked/corrupt here.
    if (err instanceof PdfEngineError) throw err;
    return { status: isPasswordError(err) ? 'locked' : 'error' };
  }

  const numPages = pdf.numPages;
  const pages = [];
  const renderTasks = []; // index → idempotent async render fn (or null for a dead page)

  for (let i = 1; i <= numPages; i++) {
    let page;
    try {
      page = await pdf.getPage(i);
    } catch {
      // A single unreadable page shouldn't sink the whole document.
      const meta = { pageIndex: i - 1, canvas: null, viewport: null, pageWidthPt: 0, pageHeightPt: 0, renderScale: 1, rendered: false };
      if (onPage) await onPage(meta);
      pages.push(meta);
      renderTasks.push(null);
      continue;
    }
    const base = page.getViewport({ scale: 1 });
    const pageWidthPt = base.width, pageHeightPt = base.height;
    const renderScale = fitWidth / (pageWidthPt || fitWidth);
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const meta = { pageIndex: i - 1, canvas, viewport, pageWidthPt, pageHeightPt, renderScale, rendered: false };
    // Let the caller attach the canvas (visible) BEFORE any render is awaited.
    if (onPage) await onPage(meta);
    pages.push(meta);

    // One idempotent render task per page. Concurrent calls (an IntersectionObserver
    // and an explicit "make the active page ready" call can race) share the same
    // in-flight promise; a failed render clears it so a later scroll can retry.
    let inFlight = null;
    const task = () => {
      if (meta.rendered) return Promise.resolve(true);
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          meta.rendered = true;
          return true;
        } catch {
          meta.rendered = false; // page failed to render — caller shows a placeholder
          inFlight = null;
          return false;
        }
      })();
      return inFlight;
    };
    renderTasks.push(task);
  }

  // Eagerly rasterize the first `eager` pages (visible-first). The rest wait for
  // renderPage() — driven by the caller's IntersectionObserver / page selection.
  const eagerCount = Math.min(Math.max(0, eager), renderTasks.length);
  for (let i = 0; i < eagerCount; i++) {
    if (renderTasks[i]) await renderTasks[i]();
  }

  const renderPage = (index) => {
    const task = renderTasks[index];
    return task ? task() : Promise.resolve(false);
  };

  return { status: 'ok', bytes, numPages, pages, renderPage, eager: eagerCount };
}

/**
 * Stamp the signature PNG onto one page and return the saved PDF bytes.
 * @param {Uint8Array} srcBytes cached source bytes (from loadAndRender).
 * @param {{
 *   pngBytes:Uint8Array, pageIndex:number,
 *   box:{x:number,y:number,w:number,h:number},   // display px, top-left origin
 *   renderScale:number, pageWidthPt:number, pageHeightPt:number
 * }} opts
 * @returns {Promise<Uint8Array>} the signed PDF. Throws PdfEngineError if
 *   pdf-lib can't load; other pdf-lib failures propagate.
 */
export async function applySignature(srcBytes, { pngBytes, pageIndex, box, renderScale, pageWidthPt, pageHeightPt }) {
  const pdfLib = await loadPdfLibOrThrow();
  const { PDFDocument } = pdfLib;

  const doc = await PDFDocument.load(srcBytes);
  const sig = await doc.embedPng(pngBytes);
  const page = doc.getPage(pageIndex);
  const rect = toPdfRect(box, { renderScale, pageWidthPt, pageHeightPt });
  page.drawImage(sig, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });

  // Clear carried source metadata (info dict + catalog XMP) — nothing from the
  // original document properties is carried into the signed copy.
  stripSourceMetadata(doc, pdfLib);
  return doc.save();
}
