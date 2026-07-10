// convert-image/js/convert.js — browser-side coordinator. Owns the session item
// list, a single lazily-spawned module Worker, a serial encode queue, and a
// generation/run token discipline for clear-all + supersede. A simpler sibling
// of compress-images/js/compress.js: the user picks ONE global output format +
// quality; there is no target-size search and no kept-original (convert always
// emits the converted bytes, even if larger — see convert-worker.js).
//
// One worker, serial: images are converted one at a time. The worker holds all
// the WASM; the coordinator only marshals Files in and result blobs out and
// keeps the shared item shape authoritative.
//
// Cancellation has two axes (mirrors find-duplicate-photos/js/scan.js):
//   session.gen    — bumped by clearSession(); makes an in-flight run stale so
//                    its results are dropped and the loop stops.
//   session.runSeq — bumped by every (re)convert call; a newer run supersedes an
//                    older one (slider drag / format change). The older loop
//                    notices runSeq drifted and stops after its current item.
// A run also awaits the previous run's chain before touching the worker, so the
// single worker is never addressed concurrently.

import { CODEC_META } from '/shared/jsquash-loader.js';
import { isAcceptedImage, sourceFormat } from './intake.js';

export function createSession() {
  return {
    items: [],            // shared item shape (see plan header)
    keys: new Set(),      // re-add guard (name+size+lastModified)
    counts: { nonImage: 0, readded: 0 },
    seq: 0,
    worker: null,         // lazily spawned
    gen: 0,               // abort generation — bumped by clearSession
    runSeq: 0,            // supersede token — bumped per (re)convert call
    runChain: Promise.resolve(), // serializes worker access across runs
  };
}

function getWorker(session) {
  if (session.worker) return session.worker;
  session.worker = new Worker(
    new URL('/convert-image/js/convert-worker.js', location.origin),
    { type: 'module' },
  );
  return session.worker;
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
    const src = sourceFormat(file.name, file.type) || file.name;
    const item = {
      id: `v${++session.seq}`, file, name: file.name, size: file.size,
      sourceFormat: src, outFormat: null,
      status: 'pending', outBlob: null, outSize: 0,
      quality: null, firstFrame: false, fallback: false,
      note: null, error: null, phase: null, thumbUrl: null,
    };
    session.items.push(item);
    added.push(item);
  }
  return added;
}

/** Validate the UI's chosen output codec key against CODEC_META. */
function resolveOutFormat(choice) {
  return CODEC_META[choice] ? choice : 'webp';
}

// --- Convert runs ----------------------------------------------------------

/** Convert every item to the chosen format+quality (used on control changes). */
export function convertAll(session, params) {
  return run(session, params, () => true);
}

/** Re-run everything on a format/quality change — a named alias of convertAll. */
export function recompute(session, params) {
  return convertAll(session, params);
}

/** Convert only not-yet-processed items (used right after adding files). */
export function convertPending(session, params) {
  return run(session, params, (it) => it.status === 'pending');
}

async function run(session, params, filter) {
  const gen = session.gen;
  const myRun = ++session.runSeq;
  const outFormat = resolveOutFormat(params.outFormat);
  const quality = clampQuality(params.quality);
  // Serialize worker access: wait for any prior run to release the chain first.
  const prev = session.runChain;
  let release;
  session.runChain = new Promise((r) => { release = r; });
  await prev;
  try {
    for (const item of session.items) {
      if (session.gen !== gen || session.runSeq !== myRun) break; // cleared or superseded
      if (!filter(item)) continue;
      item.outFormat = outFormat;
      item.quality = outFormat === 'png' ? null : quality;
      item.status = 'processing';
      item.phase = 'decoding';
      item.error = null;
      item.note = null;
      item.firstFrame = false;
      item.fallback = false;
      params.onItemStart?.(item);
      await runOne(session, item, outFormat, quality, params, gen);
      if (session.gen !== gen || session.runSeq !== myRun) break;
      params.onItemDone?.(item);
    }
  } finally {
    release();
  }
}

function clampQuality(q) {
  const n = Math.round(Number(q));
  if (!Number.isFinite(n)) return 80;
  return Math.max(1, Math.min(100, n));
}

function runOne(session, item, outFormat, quality, params, gen) {
  return new Promise((resolve) => {
    const worker = getWorker(session);
    const onMessage = (e) => {
      const msg = e && e.data;
      if (!msg || msg.id !== item.id) return;
      if (msg.type === 'progress') {
        if (session.gen === gen) { item.phase = msg.phase; params.onProgress?.(item); }
        return;
      }
      if (msg.type === 'result') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (session.gen === gen) applyResult(item, msg);
        resolve();
      }
    };
    const onError = () => {
      // A worker-level crash (OOM etc.) with a request in flight — the serial
      // queue guarantees it belongs to THIS item. Fail it honestly, keep going.
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (session.gen === gen) {
        item.status = 'failed';
        item.phase = null;
        item.error = 'the browser ran out of memory for this image';
      }
      resolve();
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({
      type: 'convert', id: item.id, file: item.file,
      outFormat, quality, sourceFormat: item.sourceFormat,
      needPreview: !item.thumbUrl,
    });
  });
}

function applyResult(item, msg) {
  item.phase = null;
  if (msg.previewBlob && !item.thumbUrl) {
    item.thumbUrl = URL.createObjectURL(msg.previewBlob);
  }
  if (!msg.ok) {
    item.status = 'failed';
    item.error = msg.error || 'encode_failed';
    item.outBlob = null; item.outSize = 0;
    return;
  }
  item.outBlob = new Blob([msg.outBuffer], { type: msg.outMime });
  item.outSize = item.outBlob.size;
  item.firstFrame = !!msg.firstFrame;
  item.fallback = !!msg.fallback;
  item.note = msg.note || null;
  item.status = 'done';
}

/** Abort + reset: terminate the worker, revoke thumbnails, empty the session. */
export function clearSession(session) {
  session.gen++;               // marks any in-flight run stale
  session.runSeq++;            // supersede any pending loop
  session.runChain = Promise.resolve();
  if (session.worker) { try { session.worker.terminate(); } catch { /* ignore */ } session.worker = null; }
  for (const it of session.items) {
    if (it.thumbUrl) { try { URL.revokeObjectURL(it.thumbUrl); } catch { /* ignore */ } }
  }
  session.items = [];
  session.keys = new Set();
  session.counts = { nonImage: 0, readded: 0 };
}
