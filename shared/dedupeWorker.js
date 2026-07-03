// shared/dedupeWorker.js — off-main-thread hash compute for the
// "Find duplicates" batch action.
//
// Spawned by photo-editor/js/dedupe.js (and, for the standalone
// find-duplicate-photos tool, js/scan.js) with
// `new Worker(url, { type: 'module' })`. Receives a batch of items (each as
// { id, sourceBlob, thumbBlob }), computes a SHA-256 of the source bytes and
// a dHash/pHash of the thumbnail, and streams progress back per item. The
// main thread does the clustering (cheap) and orchestrates UI updates.
//
// Why a worker:
//   - Hashing 100+ images on the main thread freezes the UI thread,
//     making the queue grid + progress UI feel broken.
//   - All compute here is pure (no DOM access), so a worker is the right
//     fit. OffscreenCanvas and crypto.subtle.digest both work in workers.
//
// Message protocol:
//   Main → Worker: { type: 'hash', items: [{ id, sourceBlob, thumbBlob }, ...], thumb?: { size } }
//   Worker → Main: { type: 'progress', done, total, id, sha256?, dhash?, phash?, error?,
//                    width?, height?, thumbBlob? }  // width/height/thumbBlob only when `thumb` was requested
//   Worker → Main: { type: 'done', total }
//
// The optional `thumb: { size }` field (opt-in, per batch) requests the
// find-duplicate-photos full-decode path (see hashFullWithThumb below):
// original dimensions + a fit-boxed display thumbnail alongside both hash
// inputs, computed from ONE decode of the ORIGINAL photo. When `thumb` is
// absent the worker behaves exactly as before (the photo editor's path,
// hashing a pre-made thumbnail via hashThumbnail) — byte-identical output.
//
// Errors per item are reported via `error` in the progress message; the
// worker continues with the remaining items. Catastrophic worker errors
// (e.g., out of memory) propagate via the standard onerror channel.

import {
  computeDHashFromLuminance,
  rgbaToLuminance72,
  computePHashFromLuminance,
  rgbaToLuminance1024,
} from './dedupe.js';

self.addEventListener('message', async (event) => {
  const msg = event && event.data;
  if (!msg || msg.type !== 'hash') return;
  const items = Array.isArray(msg.items) ? msg.items : [];
  const thumbSize = (msg.thumb && Number.isFinite(msg.thumb.size) && msg.thumb.size > 0)
    ? Math.floor(msg.thumb.size) : 0;
  const total = items.length;
  let done = 0;
  for (const item of items) {
    let payload = { type: 'progress', done: done + 1, total, id: item && item.id };
    try {
      if (!item || !item.id) throw new Error('missing item id');
      payload.sha256 = await hashSourceBytes(item.sourceBlob);
      if (thumbSize > 0) {
        const r = await hashFullWithThumb(item.thumbBlob, thumbSize);
        payload.dhash = r.dhash;   payload.phash = r.phash;
        payload.width = r.width;   payload.height = r.height;
        payload.thumbBlob = r.thumbBlob;
      } else {
        const { dhash, phash } = await hashThumbnail(item.thumbBlob);
        payload.dhash = dhash;     payload.phash = phash;
      }
    } catch (err) {
      payload.error = (err && err.message) ? err.message : String(err);
    }
    done++;
    payload.done = done;
    self.postMessage(payload);
  }
  self.postMessage({ type: 'done', total });
});

// Full-decode path for the standalone find-duplicate-photos tool: the blob is
// the ORIGINAL photo (not a pre-made thumbnail), so one full decode yields the
// true dimensions, a fit-boxed display thumbnail, and both hash inputs.
async function hashFullWithThumb(blob, thumbSize) {
  if (!blob) throw new Error('blob unavailable');
  const full = await createImageBitmap(blob);
  try {
    const width = full.width, height = full.height;
    const scale = Math.min(1, thumbSize / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const thumbCanvas = new OffscreenCanvas(tw, th);
    const tctx = thumbCanvas.getContext('2d');
    if (!tctx) throw new Error('no 2d context in worker');
    tctx.drawImage(full, 0, 0, tw, th);
    // WebP where the browser can encode it; the canvas falls back to PNG
    // elsewhere — callers must not assume the type.
    const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/webp', quality: 0.8 });

    const big = new OffscreenCanvas(32, 32);
    const ctxBig = big.getContext('2d', { willReadFrequently: true });
    if (!ctxBig) throw new Error('no 2d context in worker (32×32)');
    ctxBig.imageSmoothingEnabled = true;
    ctxBig.imageSmoothingQuality = 'high';
    ctxBig.drawImage(full, 0, 0, 32, 32);
    const phash = computePHashFromLuminance(rgbaToLuminance1024(ctxBig.getImageData(0, 0, 32, 32).data));

    const small = new OffscreenCanvas(9, 8);
    const ctxSmall = small.getContext('2d', { willReadFrequently: true });
    if (!ctxSmall) throw new Error('no 2d context in worker (9×8)');
    ctxSmall.imageSmoothingEnabled = true;
    ctxSmall.imageSmoothingQuality = 'high';
    ctxSmall.drawImage(full, 0, 0, 9, 8);
    const dhash = computeDHashFromLuminance(rgbaToLuminance72(ctxSmall.getImageData(0, 0, 9, 8).data));

    return { dhash, phash, width, height, thumbBlob };
  } finally {
    if (typeof full.close === 'function') full.close();
  }
}

// --- SHA-256 of arbitrary Blob bytes -------------------------------------

async function hashSourceBytes(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new Error('source blob unavailable');
  }
  const buf = await blob.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return bufToHex(hashBuf);
}

function bufToHex(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const h = view[i].toString(16);
    out += h.length === 1 ? ('0' + h) : h;
  }
  return out;
}

// --- dHash + pHash of thumbnail Blob --------------------------------------
//
// We do ONE createImageBitmap at 32×32 (the size pHash needs), then
// derive the 9×8 dHash input by drawing that bitmap onto a smaller
// canvas. Saves one decode pass per image vs. fetching the thumb twice.

async function hashThumbnail(thumbBlob) {
  if (!thumbBlob) throw new Error('thumb blob unavailable');
  const bitmap32 = await createImageBitmap(thumbBlob, {
    resizeWidth: 32,
    resizeHeight: 32,
    resizeQuality: 'high',
  });
  try {
    // 32×32 → pHash (DCT-based).
    const big = new OffscreenCanvas(32, 32);
    const ctxBig = big.getContext('2d', { willReadFrequently: true });
    if (!ctxBig) throw new Error('no 2d context in worker');
    ctxBig.drawImage(bitmap32, 0, 0, 32, 32);
    const dataBig = ctxBig.getImageData(0, 0, 32, 32).data;
    const lum1024 = rgbaToLuminance1024(dataBig);
    const phash = computePHashFromLuminance(lum1024);

    // 32×32 → 9×8 → dHash. Derived from the same source bitmap to avoid
    // a second createImageBitmap call.
    const small = new OffscreenCanvas(9, 8);
    const ctxSmall = small.getContext('2d', { willReadFrequently: true });
    if (!ctxSmall) throw new Error('no 2d context in worker (9×8)');
    ctxSmall.imageSmoothingEnabled = true;
    ctxSmall.imageSmoothingQuality = 'high';
    ctxSmall.drawImage(bitmap32, 0, 0, 9, 8);
    const dataSmall = ctxSmall.getImageData(0, 0, 9, 8).data;
    const lum72 = rgbaToLuminance72(dataSmall);
    const dhash = computeDHashFromLuminance(lum72);

    return { dhash, phash };
  } finally {
    if (bitmap32 && typeof bitmap32.close === 'function') bitmap32.close();
  }
}
