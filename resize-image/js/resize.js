// resize-image/js/resize.js — browser-side coordinator. Owns the session item
// list and the per-image pipeline: native decode (createImageBitmap) → pica
// high-quality resize (its own internal worker pool) → native re-encode
// (canvas.toBlob) at the SOURCE format. The pure plan-dims.js decides the
// target W×H; this file only marshals pixels.
//
// Cancellation mirrors compress.js:
//   session.gen    — bumped by clearSession(); makes an in-flight run stale so
//                    its results are dropped and the loop stops.
//   session.runSeq — bumped by every (re)run; a newer run (control change)
//                    supersedes an older one, which stops after its item.
// A run also awaits the previous run's chain, so only one image is decoded +
// resized at a time — memory stays bounded (important on phones).

import { isAcceptedImage, sourceFormat } from './intake.js';
import { planDimensions } from './plan-dims.js';
import { loadPica } from './pica-loader.js';

const THUMB_SIZE = 160;
const MAX_DIM = 20000; // browsers cap canvas area; refuse absurd targets honestly.

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const QUALITY = { jpeg: 0.92, webp: 0.92, png: undefined }; // png is lossless

let picaInst = null; // module singleton — pica manages its own worker pool.

export function createSession() {
  return {
    items: [],            // shared item shape (see plan header)
    keys: new Set(),      // re-add guard (name+size+lastModified)
    counts: { nonImage: 0, readded: 0 },
    seq: 0,
    gen: 0,               // abort generation — bumped by clearSession
    runSeq: 0,            // supersede token — bumped per (re)run
    runChain: Promise.resolve(), // serializes decode/resize across runs
  };
}

// --- Intake ----------------------------------------------------------------

/** Add Files (input[multiple] / drop / paste). Returns the newly-added items. */
export function addFiles(session, files) {
  const added = [];
  for (const file of files) {
    if (!isAcceptedImage(file.name, file.type)) { session.counts.nonImage++; continue; }
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (session.keys.has(key)) { session.counts.readded++; continue; }
    session.keys.add(key);
    const src = sourceFormat(file.name, file.type) || 'jpeg';
    const item = {
      id: `r${++session.seq}`, file, name: file.name, size: file.size,
      sourceFormat: src,
      nativeW: 0, nativeH: 0,
      outBlob: null, outSize: 0, outW: 0, outH: 0,
      status: 'pending', action: null, note: null, error: null,
      thumbUrl: null,
    };
    session.items.push(item);
    added.push(item);
  }
  return added;
}

// --- Runs ------------------------------------------------------------------

/** Resize every item (used on control changes — new controls move all output). */
export function resizeAll(session, params) {
  return run(session, params, () => true);
}

/** Resize only not-yet-processed items (used right after adding files). */
export function resizePending(session, params) {
  return run(session, params, (it) => it.status === 'pending');
}

async function run(session, params, filter) {
  const gen = session.gen;
  const myRun = ++session.runSeq;
  // Serialize: wait for any prior run to release the chain first.
  const prev = session.runChain;
  let release;
  session.runChain = new Promise((r) => { release = r; });
  await prev;
  try {
    for (const item of session.items) {
      if (session.gen !== gen || session.runSeq !== myRun) break; // cleared or superseded
      if (!filter(item)) continue;
      item.status = 'processing';
      item.error = null;
      params.onItemStart?.(item);
      await resizeOne(session, item, params, gen, myRun);
      if (session.gen !== gen || session.runSeq !== myRun) break;
      params.onItemDone?.(item);
    }
  } finally {
    release();
  }
}

async function getPica() {
  const factory = await loadPica();
  if (!picaInst) picaInst = factory();
  return picaInst;
}

async function resizeOne(session, item, params, gen, myRun) {
  const stale = () => session.gen !== gen || session.runSeq !== myRun;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(item.file, { imageOrientation: 'from-image' });
    if (stale()) return;
    item.nativeW = bitmap.width;
    item.nativeH = bitmap.height;

    // Thumbnail once (reuse the decoded bitmap). Represents the source image.
    if (!item.thumbUrl) {
      try {
        const tb = await makeThumb(bitmap);
        if (stale()) { bitmap.close?.(); return; }
        if (tb) item.thumbUrl = URL.createObjectURL(tb);
      } catch { /* a missing thumbnail is not fatal */ }
    }

    const plan = planDimensions({
      mode: params.mode,
      targetW: params.targetW, targetH: params.targetH, percent: params.percent,
      allowUpscale: params.allowUpscale, aspectLock: params.aspectLock,
      nativeW: item.nativeW, nativeH: item.nativeH,
    });
    item.action = plan.action;
    item.outW = plan.width;
    item.outH = plan.height;

    if (plan.width > MAX_DIM || plan.height > MAX_DIM) {
      item.status = 'failed';
      item.error = `the target size (${plan.width}×${plan.height}) is larger than this browser can render`;
      return;
    }

    // kept-native: nothing to resize — keep the original bytes untouched
    // (no needless lossy re-encode).
    if (plan.action === 'kept-native' && plan.width === item.nativeW && plan.height === item.nativeH) {
      item.outBlob = item.file;
      item.outSize = item.size;
      item.note = 'kept native size (already smaller than the target)';
      item.status = 'done';
      return;
    }

    const mime = MIME[item.sourceFormat] || 'image/jpeg';
    const quality = QUALITY[item.sourceFormat];

    // Source canvas at native size (pica reads from it).
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = item.nativeW;
    srcCanvas.height = item.nativeH;
    srcCanvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.(); bitmap = null;

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = plan.width;
    dstCanvas.height = plan.height;

    let usedFallback = false;
    try {
      const pica = await getPica();
      if (stale()) return;
      await pica.resize(srcCanvas, dstCanvas);
    } catch {
      // pica failed to load or run — fall back to a plain high-quality draw.
      usedFallback = true;
      const ctx = dstCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, plan.width, plan.height);
      ctx.drawImage(srcCanvas, 0, 0, plan.width, plan.height);
    }
    if (stale()) return;

    const blob = await toBlob(dstCanvas, mime, quality);
    if (stale()) return;
    if (!blob) {
      item.status = 'failed';
      item.error = 'the browser could not re-encode this image at that size';
      return;
    }
    item.outBlob = blob;
    item.outSize = blob.size;
    item.note = usedFallback
      ? 'resized with a lower-quality fallback (the high-quality resizer could not load)'
      : null;
    item.fallback = usedFallback;
    item.status = 'done';
  } catch (err) {
    if (stale()) return;
    item.status = 'failed';
    item.error = 'this image could not be decoded — it may be damaged or use an unsupported variant';
  } finally {
    if (bitmap) bitmap.close?.();
  }
}

function makeThumb(bitmap) {
  const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return toBlob(c, 'image/webp', 0.8);
}

function toBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), mime, quality);
  });
}

/** Abort + reset: revoke thumbnails, empty the session. pica keeps its pool. */
export function clearSession(session) {
  session.gen++;               // marks any in-flight run stale
  session.runSeq++;            // supersede any pending loop
  session.runChain = Promise.resolve();
  for (const it of session.items) {
    if (it.thumbUrl) { try { URL.revokeObjectURL(it.thumbUrl); } catch { /* ignore */ } }
  }
  session.items = [];
  session.keys = new Set();
  session.counts = { nonImage: 0, readded: 0 };
}
