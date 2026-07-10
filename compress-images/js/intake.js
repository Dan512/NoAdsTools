// compress-images/js/intake.js — pure intake guards. No DOM, no I/O.
// Compress stays focused on the big-four raster formats @jsquash covers
// (spec §2): GIF/BMP/TIFF/HEIC are out of scope for v1 (find-duplicate-photos
// and heic-to-jpg have wider allowlists for their own purposes).
const EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/** Extension → codec key used by both isAcceptedImage and sourceFormat. */
const EXT_TO_FORMAT = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
};

/** MIME → codec key, for extensionless files (e.g. pasted clipboard images). */
const MIME_TO_FORMAT = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist check: JPEG/PNG/WebP/AVIF only. Extension wins; MIME rescues extensionless files. */
export function isAcceptedImage(name, mime) {
  const e = extOf(name);
  if (e) return EXT.has(e);
  return MIME.has(String(mime || '').toLowerCase());
}

/**
 * Resolve the source codec key ('jpeg'|'png'|'webp'|'avif') for a file, used
 * to drive "keep original format". Extension wins (jpg/jpeg both → 'jpeg');
 * MIME rescues extensionless files. Returns null for anything not accepted.
 */
export function sourceFormat(name, mime) {
  const e = extOf(name);
  if (e) return EXT_TO_FORMAT[e] || null;
  return MIME_TO_FORMAT[String(mime || '').toLowerCase()] || null;
}

/** Alias: "keep original format" reads as `defaultOutFormat` at the call site. */
export const defaultOutFormat = sourceFormat;
