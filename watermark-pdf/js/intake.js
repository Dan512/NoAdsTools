// watermark-pdf/js/intake.js — pure allowlists. No DOM, no I/O.
// The main file must be a PDF (same rule as merge/split: FINAL extension wins,
// MIME rescues an extensionless file). The optional logo must be a raster
// PNG/JPEG — pdf-lib embeds those natively (embedPng/embedJpg); SVG/GIF/WebP are
// NOT supported by pdf-lib, so they are rejected here honestly.
const PDF_MIME = 'application/pdf';
const LOGO_EXTS = new Set(['png', 'jpg', 'jpeg']);
const LOGO_MIMES = new Set(['image/png', 'image/jpeg']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist: real PDFs only. Extension decides when present; MIME rescues extensionless files. */
export function isPdf(name, mime) {
  const e = extOf(name);
  if (e) return e === 'pdf';
  return String(mime || '').toLowerCase() === PDF_MIME;
}

/** Allowlist: PNG/JPEG logos only (what pdf-lib can embed). Extension wins; MIME rescues extensionless files. */
export function isRasterLogo(name, mime) {
  const e = extOf(name);
  if (e) return LOGO_EXTS.has(e);
  return LOGO_MIMES.has(String(mime || '').toLowerCase());
}
