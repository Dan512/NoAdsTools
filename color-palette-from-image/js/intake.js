// color-palette-from-image/js/intake.js — pure intake guard. No DOM, no I/O.
// Palette extraction only READS pixels (never re-encodes), so the allowlist is
// broad: every raster format the browser can decode natively via
// createImageBitmap — JPEG/PNG/WebP/AVIF/GIF/BMP. SVG (needs rasterizing at a
// size) and non-images are rejected. See spec §2.
const EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp']);
const MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp',
]);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist check: broad raster set only. Extension wins; MIME rescues extensionless files. */
export function isAcceptedImage(name, mime) {
  const e = extOf(name);
  if (e) return EXT.has(e);
  return MIME.has(String(mime || '').toLowerCase());
}
