// convert-image/js/convert-worker.js — module Web Worker. One request = one
// image, converted to the USER-CHOSEN output format. A simpler sibling of
// compress-images/js/compress-worker.js: decode ONCE natively, then encode ONCE
// to the chosen format at the chosen quality via the shared @jsquash loader.
// NO target-size search, NO kept-original — a format change always emits the
// converted bytes, even if the new file is LARGER. Convert is a format change,
// not a shrink; the UI reports the new size neutrally and never claims "saved".
//
// Pipeline (spec §5):
//   createImageBitmap(file, {imageOrientation:'from-image'})  ← native decode.
//     Applies EXIF orientation and DROPS EXIF/GPS metadata (a privacy plus,
//     on-brand). GIF / animated-WebP decode to their FIRST FRAME only — flagged
//     honestly on the card when the source is a GIF.
//   → OffscreenCanvas → getImageData  ← RGBA pixels, decoded once
//   → encode:
//       jpeg/webp/avif : /shared/jsquash-loader.js encoder(imageData, {quality})
//       png            : canvas.convertToBlob('image/png') → oxipng shrink
//                        (lossless — the quality knob does not apply)
//
// Graceful degradation (identical to compress):
//   - A jpeg/webp encoder wasm that fails to load falls back to the browser's
//     own canvas encoder (bigger files — labeled honestly).
//   - A PNG optimizer failure falls back to the browser's unoptimized PNG.
//   - AVIF has NO reliable canvas fallback (Safari can't encode AVIF), so an
//     avif wasm failure posts error:'avif_unavailable' — the UI disables AVIF
//     output and offers WebP rather than silently producing nothing.
//
// The worker also emits a small (~160px) preview blob from the decoded bitmap
// on request, so the coordinator never decodes a second time for thumbnails.

import {
  loadJpegEncoder, loadWebpEncoder, loadAvifEncoder, loadOxipng, CODEC_META,
} from '/shared/jsquash-loader.js';

const PREVIEW_MAX = 160;

/** AVIF-specific sentinel: no canvas fallback exists, so bubble a distinct code. */
class AvifUnavailable extends Error {}

self.addEventListener('message', (e) => {
  const m = e && e.data;
  if (!m || m.type !== 'convert') return;
  handleConvert(m).catch(() => {
    // Last-resort guard — handleConvert posts its own honest errors; this only
    // catches truly unexpected throws so the coordinator's promise still settles.
    self.postMessage({ type: 'result', id: m.id, ok: false, error: 'encode_failed' });
  });
});

const post = (id, phase) => self.postMessage({ type: 'progress', id, phase });
const clampQuality = (q) => Math.max(1, Math.min(100, Math.round(Number(q) || 0)));

function loadEncoderFor(format) {
  if (format === 'jpeg') return loadJpegEncoder();
  if (format === 'webp') return loadWebpEncoder();
  if (format === 'avif') return loadAvifEncoder();
  return Promise.reject(new Error('unknown_format'));
}

/** Browser-native re-encode fallback for jpeg/webp (quality is 0..1 here). */
async function encodeViaCanvas(canvas, mime, quality) {
  const blob = await canvas.convertToBlob({ type: mime, quality: clampQuality(quality) / 100 });
  if (!blob) throw new Error('canvas_encode_failed');
  return blob.arrayBuffer();
}

async function makePreview(bitmap) {
  const scale = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
  const pw = Math.max(1, Math.round(bitmap.width * scale));
  const ph = Math.max(1, Math.round(bitmap.height * scale));
  const c = new OffscreenCanvas(pw, ph);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, pw, ph);
  return c.convertToBlob({ type: 'image/webp', quality: 0.8 });
}

async function handleConvert(m) {
  const { id, file, outFormat, quality, sourceFormat, needPreview } = m;
  const meta = CODEC_META[outFormat];
  if (!meta) { self.postMessage({ type: 'result', id, ok: false, error: 'unknown_format' }); return; }
  // GIF (and animated WebP) decode to a single frame — flag it honestly.
  const firstFrame = sourceFormat === 'GIF';

  // --- Decode once ---------------------------------------------------------
  post(id, 'decoding');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    self.postMessage({ type: 'result', id, ok: false, error: 'decode_failed' });
    return;
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);

  let previewBlob = null;
  if (needPreview) {
    try { previewBlob = await makePreview(bitmap); } catch { previewBlob = null; }
  }
  bitmap.close?.();

  // --- PNG: lossless, no quality knob -------------------------------------
  if (outFormat === 'png') {
    await handlePng(id, canvas, meta, firstFrame, previewBlob);
    return;
  }

  // --- Lossy: jpeg / webp / avif ------------------------------------------
  let encoder = null;
  let usedFallback = false;
  try {
    post(id, 'loading-codec');
    try {
      encoder = await loadEncoderFor(outFormat);
    } catch {
      // AVIF has no canvas fallback — surface a distinct, honest code.
      if (outFormat === 'avif') throw new AvifUnavailable();
      usedFallback = true;
    }
    post(id, 'encoding');
    const q = clampQuality(quality);
    let outBuffer;
    if (usedFallback) {
      outBuffer = await encodeViaCanvas(canvas, meta.mime, q);
    } else {
      outBuffer = encoder(imageData, { quality: q });
    }
    if (!outBuffer) { self.postMessage({ type: 'result', id, ok: false, error: 'encode_failed', previewBlob }); return; }

    self.postMessage({
      type: 'result', id, ok: true,
      outBuffer, outMime: meta.mime, outSize: outBuffer.byteLength,
      firstFrame, fallback: usedFallback,
      note: usedFallback ? fallbackNote(outFormat) : null,
      previewBlob,
    }, [outBuffer]);
  } catch (err) {
    if (err instanceof AvifUnavailable) {
      self.postMessage({ type: 'result', id, ok: false, error: 'avif_unavailable', previewBlob });
    } else {
      self.postMessage({ type: 'result', id, ok: false, error: 'encode_failed', previewBlob });
    }
  }
}

async function handlePng(id, canvas, meta, firstFrame, previewBlob) {
  let pngBytes;
  try {
    post(id, 'encoding');
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    pngBytes = await pngBlob.arrayBuffer();
  } catch {
    self.postMessage({ type: 'result', id, ok: false, error: 'encode_failed', previewBlob });
    return;
  }

  let outBuffer = pngBytes;
  let fallback = false;
  let note = null;
  try {
    post(id, 'loading-codec');
    const optimise = await loadOxipng();
    post(id, 'encoding');
    outBuffer = optimise(pngBytes);
  } catch {
    // oxipng wasm failed — a plain browser PNG is valid, just larger. Say so.
    outBuffer = pngBytes;
    fallback = true;
    note = 'PNG optimizer could not load — saved a standard PNG (larger than optimized).';
  }

  self.postMessage({
    type: 'result', id, ok: true,
    outBuffer, outMime: meta.mime, outSize: outBuffer.byteLength,
    firstFrame, fallback, note, previewBlob,
  }, [outBuffer]);
}

function fallbackNote(format) {
  const label = CODEC_META[format]?.label || format;
  return `Used the browser's built-in ${label} encoder (the optimized encoder could not load) — the file is a little larger.`;
}
