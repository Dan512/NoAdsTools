// resize-image/js/intake.js — pure intake guards. No DOM, no I/O.
// Resize keeps the source format, so the allowlist is only the three raster
// formats every target browser can BOTH decode natively (createImageBitmap)
// AND re-encode natively (canvas.toBlob): JPEG/PNG/WebP. AVIF is excluded in
// v1 (Safari's canvas can't encode it — keep-format would silently fail);
// GIF/BMP are excluded (animation loss / niche). See spec §2.
const EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Extension → format key used by both isAcceptedImage and sourceFormat. */
const EXT_TO_FORMAT = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
};

/** MIME → format key, for extensionless files (e.g. pasted clipboard images). */
const MIME_TO_FORMAT = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist check: JPEG/PNG/WebP only. Extension wins; MIME rescues extensionless files. */
export function isAcceptedImage(name, mime) {
  const e = extOf(name);
  if (e) return EXT.has(e);
  return MIME.has(String(mime || '').toLowerCase());
}

/**
 * Resolve the source format key ('jpeg'|'png'|'webp') for a file, used to drive
 * "keep original format". Extension wins (jpg/jpeg both → 'jpeg'); MIME rescues
 * extensionless files. Returns null for anything not accepted.
 */
export function sourceFormat(name, mime) {
  const e = extOf(name);
  if (e) return EXT_TO_FORMAT[e] || null;
  return MIME_TO_FORMAT[String(mime || '').toLowerCase()] || null;
}
