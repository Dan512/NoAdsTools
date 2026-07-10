// convert-image/js/intake.js — pure intake guards. No DOM, no I/O.
// Convert accepts a WIDER input set than compress: the six raster formats the
// browser decodes natively via createImageBitmap (spec §2) — JPEG, PNG, WebP,
// AVIF, GIF, BMP. (GIF/animated-WebP yield only their first frame; the worker
// flags that honestly.) Output is a separate user choice, so — unlike compress —
// this module returns a DISPLAY LABEL for the source, used on the card's
// "SRC → TGT" line, not a codec key.
const EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp']);
const MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif',
  'image/gif', 'image/bmp', 'image/x-ms-bmp',
]);

/** Extension → source display label (jpg/jpeg both → 'JPEG'). */
const EXT_TO_LABEL = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
  avif: 'AVIF',
  gif: 'GIF',
  bmp: 'BMP',
};

/** MIME → source display label, for extensionless files (e.g. pasted images). */
const MIME_TO_LABEL = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
  'image/x-ms-bmp': 'BMP',
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist check: the six native-decodable inputs. Extension wins; MIME rescues extensionless files. */
export function isAcceptedImage(name, mime) {
  const e = extOf(name);
  if (e) return EXT.has(e);
  return MIME.has(String(mime || '').toLowerCase());
}

/**
 * Resolve the source display label ('JPEG'|'PNG'|'WebP'|'AVIF'|'GIF'|'BMP') for
 * a file, used on the result card and to flag GIF first-frame conversion.
 * Extension wins (jpg/jpeg both → 'JPEG'); MIME rescues extensionless files.
 * Returns null for anything not accepted.
 */
export function sourceFormat(name, mime) {
  const e = extOf(name);
  if (e) return EXT_TO_LABEL[e] || null;
  return MIME_TO_LABEL[String(mime || '').toLowerCase()] || null;
}
