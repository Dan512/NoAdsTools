// find-duplicate-photos/js/intake.js — pure intake guards. No DOM, no I/O.
const EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'heic', 'heif']);
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/heic', 'image/heif']);
const HEIC_EXT = new Set(['heic', 'heif']);
const HEIC_MIME = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist check: accepted photo formats only. Extension wins; MIME rescues extensionless files. */
export function isAcceptedImage(name, mime) {
  const e = extOf(name);
  if (e) return EXT.has(e);
  return MIME.has(String(mime || '').toLowerCase());
}

/** HEIC/HEIF detection — these route to the main-thread libheif queue. */
export function isHeic(name, mime) {
  if (HEIC_EXT.has(extOf(name))) return true;
  return HEIC_MIME.has(String(mime || '').toLowerCase());
}

/** Session re-add guard key: dropping the same folder twice must not create self-duplicates. */
export function itemKey(relPath, size, lastModified) {
  return `${relPath} ${size} ${lastModified}`;
}
