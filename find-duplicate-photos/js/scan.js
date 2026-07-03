// find-duplicate-photos/js/scan.js — browser coordinator. Owns the session
// item list, folder traversal, the worker pool (non-HEIC), and the serial
// main-thread HEIC queue (libheif is script-inject/window-bound, so HEIC
// can't decode in a worker).
import { isAcceptedImage, isHeic, itemKey } from './intake.js';
import {
  computeDHashFromLuminance, rgbaToLuminance72,
  computePHashFromLuminance, rgbaToLuminance1024,
} from '/shared/dedupe.js';

const THUMB_SIZE = 160;
const MAX_POOL = 4;

export function createSession() {
  return {
    items: [],                 // shared item shape (see plan header)
    keys: new Set(),           // re-add guard
    counts: { nonImage: 0, readded: 0 },
    seq: 0,
    pool: null,                // [Worker, …]
    scanning: false,
    gen: 0,                    // abort generation — bumped by clearSession
    abortResolvers: [],        // outstanding per-worker resolves (see hashInPool)
  };
}

// --- Intake ----------------------------------------------------------------

/** Add plain Files (input[multiple] or webkitdirectory). Returns the added items. */
export function addFiles(session, files) {
  const added = [];
  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    if (!isAcceptedImage(file.name, file.type)) { session.counts.nonImage++; continue; }
    const key = itemKey(relPath, file.size, file.lastModified);
    if (session.keys.has(key)) { session.counts.readded++; continue; }
    session.keys.add(key);
    const item = {
      id: `f${++session.seq}`, file, name: file.name, relPath,
      size: file.size, isHeic: isHeic(file.name, file.type),
      order: session.items.length, status: 'pending',
      width: 0, height: 0, sha256: null, dhash: null, phash: null,
      thumbUrl: null, error: null,
    };
    session.items.push(item);
    added.push(item);
  }
  return added;
}

/** Recursively collect Files from a drop's DataTransfer (folder-aware). */
export async function filesFromDataTransfer(dataTransfer) {
  const entries = [...(dataTransfer.items || [])]
    .map(i => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (!entries.some(Boolean)) return [...(dataTransfer.files || [])]; // no entry API — plain files
  const files = [];
  const walk = async (entry, prefix) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (!file) return;
      // entry.file() loses the path — carry it ourselves for report/ZIP.
      if (prefix && !file.webkitRelativePath) {
        Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name });
      }
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns ≤100 per call — loop until drained.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix + entry.name + '/');
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return files;
}

// --- Hashing ---------------------------------------------------------------

/**
 * Hash every 'pending' item. onProgress({done, total}) fires per item across
 * both queues. Resolves when all pending items are settled. Safe to call
 * again after adding more files (only pending items are processed).
 */
export async function scanPending(session, onProgress) {
  const pending = session.items.filter(it => it.status === 'pending');
  if (!pending.length) return;
  session.scanning = true;
  const gen = session.gen; // capture — a clearSession bump makes this scan stale
  const total = pending.length;
  let done = 0;
  const tick = () => { done++; try { onProgress({ done, total }); } catch { /* ignore */ } };

  const heic = pending.filter(it => it.isHeic);
  const rest = pending.filter(it => !it.isHeic);
  await Promise.all([
    hashInPool(session, rest, tick, gen),
    hashHeicSerially(session, heic, tick, gen),
  ]);
  session.scanning = false;
}

function getPool(session) {
  if (session.pool) return session.pool;
  const hc = Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 2;
  const size = Math.max(1, Math.min(MAX_POOL, hc));
  session.pool = Array.from({ length: size }, () =>
    new Worker(new URL('/shared/dedupeWorker.js', location.origin), { type: 'module' }));
  return session.pool;
}

function hashInPool(session, items, tick, gen) {
  if (!items.length) return Promise.resolve();
  const pool = getPool(session);
  // A terminated worker never fires 'done' — clearSession invokes these
  // outstanding resolvers so scanPending's promise settles immediately.
  session.abortResolvers = [];
  const buckets = Array.from({ length: pool.length }, () => []);
  items.forEach((it, i) => buckets[i % pool.length].push(it));
  return Promise.all(pool.map((worker, wi) => new Promise((resolve) => {
    session.abortResolvers.push(resolve);
    const batch = buckets[wi];
    if (!batch.length) { resolve(); return; }
    const byId = new Map(batch.map(it => [it.id, it]));
    const onMessage = (event) => {
      const m = event && event.data;
      if (!m) return;
      if (m.type === 'progress') {
        if (session.gen !== gen) return; // stale — session was cleared mid-scan
        const it = byId.get(m.id);
        if (it) applyWorkerResult(it, m);
        tick();
      } else if (m.type === 'done') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        resolve();
      }
    };
    const onError = () => {
      // Worker died (OOM etc.) — fail its remaining items honestly, keep the rest of the scan alive.
      if (session.gen === gen) {
        for (const it of batch) if (it.status === 'pending') { it.status = 'failed'; it.error = 'browser could not process this file'; tick(); }
      }
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve();
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({
      type: 'hash',
      items: batch.map(it => ({ id: it.id, sourceBlob: it.file, thumbBlob: it.file })),
      thumb: { size: THUMB_SIZE },
    });
  })));
}

function applyWorkerResult(it, m) {
  if (m.error) {
    // Decode failed but sha256 may still be present (bytes were readable).
    if (m.sha256) { it.sha256 = m.sha256; it.status = 'exact-only'; it.error = 'compared byte-for-byte only (could not decode the image)'; }
    else { it.status = 'failed'; it.error = 'file could not be read'; }
    return;
  }
  it.sha256 = m.sha256; it.dhash = m.dhash; it.phash = m.phash;
  it.width = m.width || 0; it.height = m.height || 0;
  if (m.thumbBlob) it.thumbUrl = URL.createObjectURL(m.thumbBlob);
  it.status = 'hashed';
}

async function hashHeicSerially(session, items, tick, gen) {
  if (!items.length) return;
  let decoder = null;
  try {
    const { loadHeicDecoder } = await import('/shared/heic-loader.js');
    decoder = await loadHeicDecoder();
  } catch { decoder = null; } // every HEIC falls back to exact-only below
  for (const it of items) {
    if (session.gen !== gen) break; // aborted by clearSession mid-scan
    try {
      const buf = await it.file.arrayBuffer();
      it.sha256 = bufToHex(await crypto.subtle.digest('SHA-256', buf));
      if (!decoder) { it.status = 'exact-only'; it.error = 'compared byte-for-byte only (HEIC decoder failed to load)'; tick(); continue; }
      const decoded = await decoder.decode(buf); // { data, width, height }
      it.width = decoded.width; it.height = decoded.height;
      const imageData = new ImageData(decoded.data, decoded.width, decoded.height);
      const scale = Math.min(1, THUMB_SIZE / Math.max(decoded.width, decoded.height));
      const tw = Math.max(1, Math.round(decoded.width * scale));
      const th = Math.max(1, Math.round(decoded.height * scale));
      const bitmap = await createImageBitmap(imageData, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      try {
        const thumbBlob = await canvasBlob(bitmap, tw, th);
        if (session.gen !== gen) break; // cleared mid-decode — don't leak a URL onto a detached item
        it.thumbUrl = URL.createObjectURL(thumbBlob);
        it.phash = computePHashFromLuminance(rgbaToLuminance1024(drawTo(bitmap, 32, 32)));
        it.dhash = computeDHashFromLuminance(rgbaToLuminance72(drawTo(bitmap, 9, 8)));
      } finally { bitmap.close?.(); }
      it.status = 'hashed';
    } catch (err) {
      // Clear any partially-assigned perceptual hash — exact-only items must
      // never carry one (report.js also gates on status; belt and braces).
      it.dhash = null; it.phash = null;
      if (it.sha256) { it.status = 'exact-only'; it.error = 'compared byte-for-byte only (could not decode this HEIC)'; }
      else { it.status = 'failed'; it.error = 'file could not be read'; }
    }
    tick();
    // Yield so the progress label paints between big serial decodes.
    await new Promise(r => setTimeout(r, 0));
  }
}

function drawTo(bitmap, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function canvasBlob(bitmap, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/webp', 0.8));
}

function bufToHex(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

/** Abort + reset: terminate the pool, revoke thumbnails, empty the session. */
export function clearSession(session) {
  session.gen++; // marks any in-flight scan stale
  if (session.pool) { for (const w of session.pool) { try { w.terminate(); } catch { /* ignore */ } } session.pool = null; }
  // Terminated workers never post 'done' — settle the hung pool promises now.
  const resolvers = session.abortResolvers || [];
  session.abortResolvers = [];
  for (const r of resolvers) { try { r(); } catch { /* ignore */ } }
  for (const it of session.items) if (it.thumbUrl) { try { URL.revokeObjectURL(it.thumbUrl); } catch { /* ignore */ } }
  session.items = []; session.keys = new Set();
  session.counts = { nonImage: 0, readded: 0 };
  session.scanning = false;
}
