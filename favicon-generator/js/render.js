// favicon-generator/js/render.js — square a decoded bitmap and downscale it to
// a target size. Browser-only (canvas). Two fit modes, never distorting:
//   'pad'  : letterbox the whole source onto a square, filling margins with
//            bgColor (default transparent) — the entire image is kept.
//   'crop' : center-crop the source to a square, then draw it edge to edge.
// bgColor is a CSS color string (e.g. '#ffffff') or null/'' for transparent.
//
// Quality: we first build a square canvas at the source's NATIVE square
// resolution, then step-halve it down to the target. Stepwise halving keeps the
// tiny 16/32 favicons crisp instead of aliased (a single big->tiny drawImage
// aliases badly). If the source is smaller than the target the final draw
// upscales with smoothing (soft — noted honestly upstream).

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toBlob(canvas, mime) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: mime });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), mime);
  });
}

/**
 * Draw `bitmap` squared + resized into a fresh `size×size` canvas and return it.
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap decoded source.
 * @param {number} size target side length in px.
 * @param {{fit?:'pad'|'crop', bgColor?:string|null}} [opts]
 * @returns {OffscreenCanvas|HTMLCanvasElement} the size×size canvas.
 */
export function renderSquareCanvas(bitmap, size, opts = {}) {
  const fit = opts.fit === 'crop' ? 'crop' : 'pad';
  const bgColor = opts.bgColor || null;
  const srcW = Math.max(1, bitmap.width);
  const srcH = Math.max(1, bitmap.height);

  // 1. Square-source canvas at native square resolution.
  let squareSide, sx, sy, sw, sh, dx, dy, dw, dh;
  if (fit === 'crop') {
    squareSide = Math.max(1, Math.min(srcW, srcH));
    sx = Math.floor((srcW - squareSide) / 2);
    sy = Math.floor((srcH - squareSide) / 2);
    sw = squareSide; sh = squareSide;
    dx = 0; dy = 0; dw = squareSide; dh = squareSide;
  } else {
    squareSide = Math.max(1, Math.max(srcW, srcH));
    sx = 0; sy = 0; sw = srcW; sh = srcH;
    dw = srcW; dh = srcH; // native (no upscale at this step)
    dx = Math.floor((squareSide - dw) / 2);
    dy = Math.floor((squareSide - dh) / 2);
  }
  const square = makeCanvas(squareSide, squareSide);
  const sctx = square.getContext('2d');
  if (bgColor) { sctx.fillStyle = bgColor; sctx.fillRect(0, 0, squareSide, squareSide); }
  sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);

  // 2. Step-halve down toward the target, then a final draw to exact size.
  let cur = square, curSize = squareSide;
  while (curSize > size * 2) {
    const next = Math.max(size, Math.floor(curSize / 2));
    const tmp = makeCanvas(next, next);
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(cur, 0, 0, curSize, curSize, 0, 0, next, next);
    cur = tmp; curSize = next;
  }
  const out = makeCanvas(size, size);
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
  octx.drawImage(cur, 0, 0, curSize, curSize, 0, 0, size, size);
  return out;
}

/**
 * Square + resize `bitmap` to `size` and encode a PNG.
 * @returns {Promise<{size:number, pngBytes:Uint8Array, blob:Blob}>}
 */
export async function squareAndResize(bitmap, size, opts = {}) {
  const canvas = renderSquareCanvas(bitmap, size, opts);
  const blob = await toBlob(canvas, 'image/png');
  const pngBytes = new Uint8Array(await blob.arrayBuffer());
  return { size, pngBytes, blob };
}
