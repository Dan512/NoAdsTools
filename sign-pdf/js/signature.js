// sign-pdf/js/signature.js — turn a drawn or typed signature into a trimmed,
// transparent PNG for pdf-lib to embed. Browser-only canvas helpers (no Node
// coverage; exercised by the browser smoke). Two producers:
//   • drawSignatureToPng(canvas) — scan the draw canvas' alpha, crop to the ink
//     bounding box, return a transparent PNG (Uint8Array) + its natural w/h.
//   • typeSignatureToPng(name, {font, color}) — render the name to a canvas
//     sized to the measured glyphs, transparent background, same return shape.
// Both return null when there is nothing to stamp (blank canvas / empty name),
// so the caller can keep Apply disabled honestly.

// A tiny padding (device px) kept around the ink so the crop never clips a
// stroke's anti-aliased edge.
const TRIM_PAD = 6;
// Alpha at or below this counts as "no ink" — ignores stray anti-alias dust.
const ALPHA_FLOOR = 10;
// Supersample the typed render so a modestly-sized font still stamps crisply
// (the PNG is just an image; only its aspect ratio matters downstream).
const TYPE_SS = 2;
const TYPE_PAD = 8; // padding (CSS px, pre-supersample) around the typed text

/** Encode a canvas to PNG bytes (transparent background preserved). */
async function canvasToPngBytes(canvas) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Trim a draw canvas to its ink and return a transparent PNG.
 * @param {HTMLCanvasElement} canvas the on-screen draw surface (any resolution).
 * @returns {Promise<{bytes:Uint8Array,width:number,height:number}|null>} null when blank.
 */
export async function drawSignatureToPng(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return null;
  const ctx = canvas.getContext('2d');
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // tainted / zero-size — treat as blank rather than throw
  }

  // Scan the alpha channel for the ink bounding box.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > ALPHA_FLOOR) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null; // no ink at all

  minX = Math.max(0, minX - TRIM_PAD);
  minY = Math.max(0, minY - TRIM_PAD);
  maxX = Math.min(w - 1, maxX + TRIM_PAD);
  maxY = Math.min(h - 1, maxY + TRIM_PAD);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;

  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const octx = out.getContext('2d');
  octx.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  const bytes = await canvasToPngBytes(out);
  return { bytes, width: cw, height: ch };
}

/**
 * Render a typed name as a transparent-background PNG in a signature-ish style.
 * @param {string} name the text to render.
 * @param {{font?:string,color?:string}} opts canvas font shorthand + ink color.
 * @returns {Promise<{bytes:Uint8Array,width:number,height:number}|null>} null when empty.
 */
export async function typeSignatureToPng(name, { font = 'italic 600 72px "Times New Roman", "Georgia", serif', color = '#12305c' } = {}) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return null;

  // Measure at 1x with the target font.
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  const m = meas.measureText(text);
  const ascent = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : 56;
  const descent = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : 18;
  const textW = Math.max(1, Math.ceil(m.width));
  const cssW = textW + TYPE_PAD * 2;
  const cssH = Math.ceil(ascent + descent) + TYPE_PAD * 2;

  const out = document.createElement('canvas');
  out.width = Math.max(1, cssW * TYPE_SS);
  out.height = Math.max(1, cssH * TYPE_SS);
  const ctx = out.getContext('2d');
  ctx.scale(TYPE_SS, TYPE_SS);       // draw in CSS px; supersample the raster
  ctx.font = font;                   // font size is baked into `font`
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(text, TYPE_PAD, TYPE_PAD + ascent);

  const bytes = await canvasToPngBytes(out);
  return { bytes, width: out.width, height: out.height };
}
