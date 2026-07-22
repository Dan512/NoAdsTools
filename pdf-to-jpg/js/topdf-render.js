// pdf-to-jpg/js/topdf-render.js — coordinator between the UI and the shared
// pdfjs loader + JSZip. pdfjs (legacy build, via /shared/pdfjs-loader.js)
// rasterizes each page to an ON-DOM canvas; the native canvas encoder turns it
// into a PNG/JPG Blob. Nothing is fetched until a PDF is opened; JSZip loads
// only when more than one image is downloaded together. Password / corrupt
// files are classified honestly.
//
// rAF-safe rendering (playbook §4): pdfjs' display `page.render()` only advances
// while requestAnimationFrame fires, and a detached/hidden canvas stalls it — so
// the CALLER must attach every render canvas to the (visible) DOM before calling
// renderPage / exportPages. The staging canvas main.js hands to exportPages lives
// in an on-DOM (clipped) stage for exactly this reason.
import { openPdf, PdfEngineError } from '/shared/pdfjs-loader.js';
import { outName, clampScaleForCanvas } from './render-opts.js';
import { loadJSZip } from './zip.js';
export { PdfEngineError };

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
 * @returns {Promise<{status:'ok'|'locked'|'error'|'engine', doc?:object, numPages?:number,
 *   bytes?:Uint8Array}>} 'locked' = password-protected, 'error' = unreadable,
 *   'engine' = the pdf.js engine could not load (a deploy/network problem, not the file).
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
    // openPdf copies the buffer internally; pass a fresh view so the cached
    // `bytes` is never detached by the worker.
    doc = await openPdf(bytes.slice());
  } catch (err) {
    // Engine load failure (404/offline/blocked) is not the file's fault — flag
    // it so the UI offers a retry rather than blaming the PDF as corrupt.
    if (err instanceof PdfEngineError) return { status: 'engine' };
    return { status: isPasswordError(err) ? 'locked' : 'error' };
  }
  return { status: 'ok', doc, numPages: doc.numPages, bytes };
}

/** A page's PDF-space size in points (cheap — measured at scale 1). */
export async function pageSizePt(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  return { widthPt: vp.width, heightPt: vp.height };
}

/**
 * Rasterize one page into an on-DOM canvas at `scale`, clamping the scale so the
 * longest side stays within the browser's canvas limit (`maxDim`). The canvas
 * MUST already be attached to the visible DOM (rAF-safe — see file header).
 *
 * @param {object} doc pdfjs document proxy
 * @param {number} pageNum 1-based page number
 * @param {{scale:number, canvas:HTMLCanvasElement, maxDim?:number, background?:string|null}} opts
 *   background: a CSS color painted behind the page. pdfjs fills white by
 *   default, so JPG passes white explicitly as belt-and-suspenders;
 *   null/undefined leaves that default white plate in place (PNG stays lossless).
 * @returns {Promise<{width:number, height:number, scale:number, clamped:boolean}>}
 */
export async function renderPage(doc, pageNum, { scale, canvas, maxDim = 4096, background = null }) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const clamp = clampScaleForCanvas(scale, base.width, base.height, maxDim);
  const viewport = page.getViewport({ scale: clamp.scale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  const renderParams = { canvasContext: ctx, viewport, canvas };
  if (background) renderParams.background = background;
  await page.render(renderParams).promise;
  return { width: canvas.width, height: canvas.height, scale: clamp.scale, clamped: clamp.clamped };
}

/** Encode a rendered canvas to a Blob. PNG is lossless (quality ignored). */
export function pageToBlob(canvas, fmt, quality) {
  const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
  const q = fmt === 'png' ? undefined : quality;
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))),
      mime, q,
    );
  });
}

/**
 * Render a set of pages at the export scale and collect encoded image blobs.
 * Renders ONE page at a time into a single reused (caller-supplied) on-DOM
 * canvas, so a long document never allocates N large canvases at once.
 *
 * @param {object} doc pdfjs document proxy
 * @param {number[]} pages 1-based page numbers, in output order
 * @param {{ scale:number, fmt:'jpg'|'png', quality:number, stem:string,
 *   maxDim?:number, onProgress?:(done:number,total:number)=>void,
 *   canvasFactory:()=>HTMLCanvasElement }} opts
 *   canvasFactory returns the VISIBLE on-DOM canvas to render into (rAF-safe).
 * @returns {Promise<{ outputs:Array<{name:string, blob:Blob, width:number,
 *   height:number, pageNum:number, clamped:boolean}>, anyClamped:boolean }>}
 */
export async function exportPages(doc, pages, { scale, fmt, quality, stem, maxDim = 4096, onProgress, canvasFactory }) {
  const outputs = [];
  let anyClamped = false;
  const background = fmt === 'png' ? null : '#ffffff';
  for (let i = 0; i < pages.length; i++) {
    const pageNum = pages[i];
    const canvas = canvasFactory();
    const r = await renderPage(doc, pageNum, { scale, canvas, maxDim, background });
    if (r.clamped) anyClamped = true;
    const blob = await pageToBlob(canvas, fmt, quality);
    outputs.push({ name: outName(stem, pageNum, fmt), blob, width: r.width, height: r.height, pageNum, clamped: r.clamped });
    if (onProgress) onProgress(i + 1, pages.length);
  }
  return { outputs, anyClamped };
}

// Ensure every ZIP entry name is unique — appends `-2`, `-3`, … before the
// extension if a name repeats (defensive; page numbers are already unique).
function uniquify(name, seen) {
  if (!seen.has(name)) { seen.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (seen.has(candidate)) { n += 1; candidate = `${base}-${n}${ext}`; }
  seen.add(candidate);
  return candidate;
}

/**
 * Bundle multiple image outputs into `<stem>-pages.zip`. STORE — PNG/JPG are
 * already compressed, so deflating again only wastes time.
 * @param {Array<{name:string, blob:Blob}>} outputs
 * @param {string} stem output filename stem
 * @returns {Promise<{name:string, blob:Blob}>}
 * Throws if JSZip can't load (zip.js resets its cache so a retry re-fetches).
 */
export async function zipOutputs(outputs, stem) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const seen = new Set();
  for (const out of outputs) {
    zip.file(uniquify(out.name, seen), out.blob, { compression: 'STORE' });
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { name: `${stem}-pages.zip`, blob };
}
