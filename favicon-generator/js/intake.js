// favicon-generator/js/intake.js — pure intake allowlist. No DOM, no I/O.
// A favicon source is decoded with createImageBitmap and re-encoded to PNG, so
// the allowlist is the three raster formats every target browser can decode
// natively: PNG, JPEG, WebP. SVG source is deferred (spec §9 — scalable logos
// are nice but add a decode path); GIF/BMP/AVIF are out of scope.
const EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist check: PNG/JPEG/WebP only. Extension wins; MIME rescues extensionless files. */
export function isAcceptedImage(name, mime) {
  const e = extOf(name);
  if (e) return EXT.has(e);
  return MIME.has(String(mime || '').toLowerCase());
}
