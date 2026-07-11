// watermark-pdf/js/watermark.js — coordinator between the UI and the vendored
// pdf-lib. Loads ONE PDF (classifying encrypted → 'locked', unreadable →
// 'error'), then stamps a text or image watermark onto the chosen pages and
// re-saves. pdf-lib loads lazily through the shared loader, so nothing is
// fetched until the first PDF is added. StandardFonts only — no fontkit; logos
// are embedded with pdf-lib's built-in embedPng/embedJpg. PdfEngineError is the
// cluster-wide engine-failure class (one class, one message).
import { loadPdfLib, loadPdfLibOrThrow, PdfEngineError } from '/shared/pdflib-loader.js';
import { stripSourceMetadata } from '/shared/pdf-meta.js';
import { hexToRgb01, rotatedCenterAnchor, cornerAnchor, tilePositions, clampOpacity, normalizeRotation } from './wm-layout.js';
export { PdfEngineError }; // re-export so main.js has a single import path

// Distinguish "this PDF is encrypted" from any other load failure. The minified
// build doesn't set Error.name reliably, so identity comes from the exported
// class (instanceof), with a message-substring fallback for safety.
function isEncryptedError(err, EncryptedPDFError) {
  if (EncryptedPDFError && err instanceof EncryptedPDFError) return true;
  return /encrypted/i.test(String((err && err.message) || err || ''));
}

/**
 * Read one File into a source descriptor:
 *   { file, name, size, pageCount, status, error, bytes }
 * status: 'ok' | 'locked' (password-protected) | 'error' (corrupt / not a PDF).
 * Throws PdfEngineError only if pdf-lib itself can't load. Caches `bytes` so a
 * later apply never re-reads the File.
 */
export async function loadPdf(file) {
  const src = {
    file, name: file.name, size: file.size,
    pageCount: 0, status: 'ok', error: null, bytes: null,
  };

  try {
    src.bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    src.status = 'error';
    src.error = 'unreadable';
    return src;
  }

  let PDFDocument, EncryptedPDFError;
  try {
    ({ PDFDocument, EncryptedPDFError } = await loadPdfLib());
  } catch (e) {
    throw new PdfEngineError(e);
  }

  try {
    // ignoreEncryption:false → pdf-lib throws EncryptedPDFError for a
    // password-protected file instead of silently loading a broken doc.
    const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: false });
    src.pageCount = doc.getPageCount();
  } catch (err) {
    if (isEncryptedError(err, EncryptedPDFError)) {
      src.status = 'locked';
      src.error = 'password-protected';
    } else {
      src.status = 'error';
      src.error = 'unreadable';
    }
  }
  return src;
}

// Given a page + placement mode + the watermark box dims, call `draw(x, y)` at
// every placement point. `rotatedCenterAnchor`/`cornerAnchor`/`tilePositions`
// are the pure geometry (bottom-left origin, matching pdf-lib). Tiling steps by
// the box plus the gap; a half-gap inset keeps the first tile off the very edge.
// `rotDeg` is the normalized rotation: only the centered stamp compensates for
// the pivot (pdf-lib rotates the drawn box about its anchor, so a rotated
// "center" would otherwise drift off page center); corners are left unrotated
// so they keep their margin anchor (the spec allows corner bleed).
function placeAndDraw(position, pw, ph, wmW, wmH, gap, rotDeg, draw) {
  if (position === 'tile') {
    const stepX = Math.max(1, wmW + gap);
    const stepY = Math.max(1, wmH + gap);
    const pts = tilePositions(pw, ph, stepX, stepY, { marginX: gap / 2, marginY: gap / 2 });
    for (const p of pts) draw(p.x, p.y);
    return;
  }
  const a = position === 'center'
    ? rotatedCenterAnchor(pw, ph, wmW, wmH, rotDeg)
    : cornerAnchor(pw, ph, wmW, wmH, position);
  draw(a.x, a.y);
}

/**
 * Stamp a watermark and return the saved bytes (Uint8Array).
 * @param {Uint8Array} srcBytes cached source bytes
 * @param {{
 *   type:'text'|'image',
 *   text?:string, font?:string, size?:number, colorHex?:string,
 *   logoBytes?:Uint8Array, logoMime?:string, scalePct?:number,
 *   opacity?:number, rotationDeg?:number,
 *   position?:'center'|'tile'|'tl'|'tr'|'bl'|'br', tileGap?:number,
 *   pageSet?:number[]|null
 * }} opts
 * The watermark is drawn AFTER (on top of) each page's own content — the
 * standard watermark look; opacity keeps the page readable through it. Source
 * document properties — both the info dictionary AND the catalog XMP (/Metadata)
 * stream — are cleared (via the shared stripSourceMetadata helper) so nothing
 * from the original is carried forward. Throws PdfEngineError if pdf-lib can't
 * load; other pdf-lib failures (e.g. OOM on a huge job) propagate.
 */
export async function applyWatermark(srcBytes, opts) {
  const pdfLib = await loadPdfLibOrThrow();
  const { PDFDocument, StandardFonts, rgb, degrees } = pdfLib;

  const doc = await PDFDocument.load(srcBytes);
  const pages = doc.getPages();
  const total = pages.length;

  // Which pages get stamped (1-based → 0-based). null/empty → every page.
  const set = (Array.isArray(opts.pageSet) && opts.pageSet.length)
    ? opts.pageSet.filter((p) => p >= 1 && p <= total).map((p) => p - 1)
    : pages.map((_, i) => i);

  const opacity = clampOpacity(opts.opacity);
  const rotDeg = normalizeRotation(opts.rotationDeg);
  const rotate = degrees(rotDeg);
  const position = opts.position || 'center';
  const gap = Number.isFinite(opts.tileGap) ? Math.max(0, opts.tileGap) : 48;

  if (opts.type === 'image') {
    const mime = String(opts.logoMime || '').toLowerCase();
    const img = mime === 'image/png'
      ? await doc.embedPng(opts.logoBytes)
      : await doc.embedJpg(opts.logoBytes);
    const scalePct = Number.isFinite(opts.scalePct) ? opts.scalePct : 30;
    for (const idx of set) {
      const page = pages[idx];
      const { width: pw, height: ph } = page.getSize();
      const wmW = Math.max(1, pw * (scalePct / 100));
      const wmH = wmW * (img.height / img.width);
      placeAndDraw(position, pw, ph, wmW, wmH, gap, rotDeg, (x, y) =>
        page.drawImage(img, { x, y, width: wmW, height: wmH, opacity, rotate }));
    }
  } else {
    const text = String(opts.text ?? '');
    const size = Number.isFinite(opts.size) ? opts.size : 48;
    const fontKey = StandardFonts[opts.font] ? opts.font : 'Helvetica';
    const font = await doc.embedFont(StandardFonts[fontKey]);
    const { r, g, b } = hexToRgb01(opts.colorHex);
    const color = rgb(r, g, b);
    const wmW = font.widthOfTextAtSize(text, size);
    const wmH = size; // approximate cap height — good enough for anchoring
    for (const idx of set) {
      const page = pages[idx];
      const { width: pw, height: ph } = page.getSize();
      placeAndDraw(position, pw, ph, wmW, wmH, gap, rotDeg, (x, y) =>
        page.drawText(text, { x, y, size, font, color, opacity, rotate }));
    }
  }

  // Clear ALL carried metadata — info dictionary AND the catalog XMP (/Metadata)
  // stream — so no source document properties (incl. XMP title/author that PDF
  // readers surface) survive into the watermarked copy. Info-dict setters alone
  // leave the XMP stream untouched, hence the shared helper.
  stripSourceMetadata(doc, pdfLib);
  return doc.save();
}
