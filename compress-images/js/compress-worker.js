// compress-images/js/compress-worker.js — module Web Worker. One request =
// one image: decode natively, encode via the vendored @jsquash codecs, and
// post the smallest honest result back.
//
// Pipeline (spec §6):
//   createImageBitmap(file, {imageOrientation:'from-image'})  ← native decode,
//     applies EXIF orientation and DROPS EXIF/GPS (a privacy plus, on-brand)
//   → OffscreenCanvas → getImageData  ← decode ONCE per request, RGBA pixels
//   → encode:
//       jpeg/webp/avif : /shared/jsquash-loader.js encoder(imageData, {quality})
//       png            : canvas.convertToBlob('image/png') → oxipng shrink
//                        (lossless — the quality knob does not apply)
//   Quality mode : a single encode at the chosen quality.
//   Target  mode : searchQualityForTarget() from plan-quality.js binary-searches
//                  the highest quality whose bytes fit under the target
//                  (PNG has no quality knob → one lossless pass, flagged if it
//                  overshoots the target).
//
// Graceful degradation:
//   - A jpeg/webp encoder wasm that fails to load falls back to the browser's
//     own canvas encoder (bigger files, fewer knobs — labeled honestly).
//   - AVIF has NO reliable canvas fallback (Safari can't encode AVIF), so an
//     avif wasm failure posts error:'avif_unavailable' — the UI disables AVIF
//     output and offers WebP rather than silently producing nothing.
//   - A PNG optimizer failure falls back to the browser's unoptimized PNG.
//
// Kept-original: if the smallest result is >= the original bytes (re-encoding
// an already-tiny file often grows it), we post keptOriginal:true and the
// coordinator keeps the ORIGINAL file untouched.
//
// The worker also emits a small (~160px) preview blob from the decoded bitmap
// on request, so the coordinator never has to decode a second time for thumbs.

import {
  loadJpegEncoder, loadWebpEncoder, loadAvifEncoder, loadOxipng, CODEC_META,
} from '/shared/jsquash-loader.js';
import { searchQualityForTarget } from '/compress-images/js/plan-quality.js';

const PREVIEW_MAX = 160;

/** AVIF-specific sentinel: no canvas fallback exists, so bubble a distinct code. */
class AvifUnavailable extends Error {}

self.addEventListener('message', (e) => {
  const m = e && e.data;
  if (!m || m.type !== 'compress') return;
  handleCompress(m).catch(() => {
    // Last-resort guard — handleCompress posts its own honest errors; this only
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

async function handleCompress(m) {
  const { id, file, outFormat, mode, quality, targetBytes, needPreview } = m;
  const meta = CODEC_META[outFormat];
  if (!meta) { self.postMessage({ type: 'result', id, ok: false, error: 'unknown_format' }); return; }

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

  const originalSize = file.size;

  // --- PNG: lossless, no quality knob -------------------------------------
  if (outFormat === 'png') {
    await handlePng(id, canvas, meta, originalSize, mode, targetBytes, previewBlob);
    return;
  }

  // --- Lossy: jpeg / webp / avif ------------------------------------------
  const memo = new Map();       // quality → ArrayBuffer (search re-uses measured passes)
  let encoder = null;
  let usedFallback = false;

  const encodeAt = async (q) => {
    if (!usedFallback && !encoder) {
      post(id, 'loading-codec');
      try {
        encoder = await loadEncoderFor(outFormat);
      } catch {
        // AVIF has no canvas fallback — surface a distinct, honest code.
        if (outFormat === 'avif') throw new AvifUnavailable();
        usedFallback = true;
      }
    }
    post(id, 'encoding');
    let buffer;
    if (usedFallback) {
      buffer = await encodeViaCanvas(canvas, meta.mime, q);
    } else {
      buffer = encoder(imageData, { quality: q });
    }
    memo.set(q, buffer);
    return buffer.byteLength;
  };

  try {
    let usedQuality;
    let targetOk = true;
    if (mode === 'target') {
      const bytes = Number(targetBytes) > 0 ? Number(targetBytes) : originalSize;
      const r = await searchQualityForTarget({ encodeAt, targetBytes: bytes });
      usedQuality = r.quality;
      targetOk = r.ok;
    } else {
      usedQuality = clampQuality(quality);
      await encodeAt(usedQuality);
    }

    const outBuffer = memo.get(usedQuality);
    if (!outBuffer) { self.postMessage({ type: 'result', id, ok: false, error: 'encode_failed', previewBlob }); return; }

    // Re-encoding an already-small file can grow it — keep the original then.
    if (outBuffer.byteLength >= originalSize) {
      self.postMessage({
        type: 'result', id, ok: true, keptOriginal: true,
        quality: usedQuality, previewBlob,
      });
      return;
    }

    self.postMessage({
      type: 'result', id, ok: true,
      outBuffer, outMime: meta.mime, outSize: outBuffer.byteLength,
      quality: usedQuality, fallback: usedFallback,
      note: usedFallback ? fallbackNote(outFormat) : null,
      targetOk, previewBlob,
    }, [outBuffer]);
  } catch (err) {
    if (err instanceof AvifUnavailable) {
      self.postMessage({ type: 'result', id, ok: false, error: 'avif_unavailable', previewBlob });
    } else {
      self.postMessage({ type: 'result', id, ok: false, error: 'encode_failed', previewBlob });
    }
  }
}

async function handlePng(id, canvas, meta, originalSize, mode, targetBytes, previewBlob) {
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

  if (outBuffer.byteLength >= originalSize) {
    self.postMessage({ type: 'result', id, ok: true, keptOriginal: true, quality: null, previewBlob });
    return;
  }

  const targetOk = mode !== 'target'
    || (Number(targetBytes) > 0 ? outBuffer.byteLength <= Number(targetBytes) : true);

  self.postMessage({
    type: 'result', id, ok: true,
    outBuffer, outMime: meta.mime, outSize: outBuffer.byteLength,
    quality: null, fallback,
    note: note || (mode === 'target' && !targetOk
      ? 'PNG is lossless, so it has a size floor — convert to WebP or JPEG to hit a smaller target.'
      : null),
    targetOk, previewBlob,
  }, [outBuffer]);
}

function fallbackNote(format) {
  const label = CODEC_META[format]?.label || format;
  return `Used the browser's built-in ${label} encoder (the optimized encoder could not load) — the file is a little larger.`;
}
