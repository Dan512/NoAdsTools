// crop-image/js/crop-render.js — crop a decoded bitmap at a SOURCE-pixel rect
// into a Blob, keeping the source format. Browser-only (canvas); the fiddly
// geometry lives in the Node-tested crop-rect.js, so this file is a thin
// pixels-only marshal. No re-scaling: the crop is drawn 1:1 at source
// resolution, so output is full-res. Re-encoding drops EXIF/GPS (spec §7).

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
// JPEG/WebP re-encode at a fixed high quality; PNG is lossless (quality ignored).
const QUALITY = { jpeg: 0.92, webp: 0.92, png: undefined };

/** Draw a canvas of `w×h`, tolerating browsers without OffscreenCanvas. */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toBlob(canvas, mime, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), mime, quality);
  });
}

/**
 * Crop `bitmap` at the source-pixel rect `{x,y,w,h}` → Blob in the given format.
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap decoded source.
 * @param {{x:number,y:number,w:number,h:number}} rect source-pixel crop region.
 * @param {'jpeg'|'png'|'webp'} format keep the source format.
 * @returns {Promise<Blob>}
 */
export async function cropToBlob(bitmap, rect, format) {
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const sx = Math.round(rect.x);
  const sy = Math.round(rect.y);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  // PNG keeps alpha; JPEG has none. Drawing straight over a fresh (transparent)
  // canvas is correct for all three — JPEG encoding flattens transparency to
  // black, matching a plain crop of an opaque photo.
  ctx.drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
  const mime = MIME[format] || 'image/png';
  const quality = QUALITY[format];
  return toBlob(canvas, mime, quality);
}
