// compress-images/js/compress.js — browser-side coordinator. Owns the session
// item list, a single lazily-spawned module Worker, a serial encode queue, and
// a generation/run token discipline for clear-all + supersede (mirrors
// find-duplicate-photos/js/scan.js).
//
// One worker, serial: images are encoded one at a time. The worker holds all
// the WASM; the coordinator only marshals Files in and result blobs out and
// keeps the shared item shape (see the plan header) authoritative.
//
// Cancellation has two axes:
//   session.gen   — bumped by clearSession(); makes an in-flight run stale so
//                   its results are dropped and the loop stops.
//   session.runSeq — bumped by every (re)compress call; a newer run supersedes
//                    an older one (slider drag / format change). The older loop
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
    runSeq: 0,            // supersede token — bumped per (re)compress call
    runChain: Promise.resolve(), // serializes worker access across runs
  };
}

function getWorker(session) {
  if (session.worker) return session.worker;
  session.worker = new Worker(
    new URL('/compress-images/js/compress-worker.js', location.origin),
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
    const src = sourceFormat(file.name, file.type) || 'jpeg';
    const item = {
      id: `c${++session.seq}`, file, name: file.name, size: file.size,
      sourceFormat: src, outFormat: src,
      status: 'pending', outBlob: null, outSize: 0,
      quality: null, fallback: false, targetOk: true,
      note: null, error: null, phase: null, thumbUrl: null,
    };
    session.items.push(item);
    added.push(item);
  }
  return added;
}

/** Resolve the output codec key for an item from the UI's format choice. */
function resolveOutFormat(item, choice) {
  if (!choice || choice === 'keep') return item.sourceFormat;
  return CODEC_META[choice] ? choice : item.sourceFormat;
}

// --- Encode runs -----------------------------------------------------------

/** Encode every item (used on control changes — quality/target/format all move output). */
export function compressAll(session, params) {
  return run(session, params, () => true);
}

/** Encode only not-yet-processed items (used right after adding files). */
export function compressPending(session, params) {
  return run(session, params, (it) => it.status === 'pending');
}

/** Re-encode a single item (per-item retry). */
export function recompressOne(session, id, params) {
  return run(session, params, (it) => it.id === id);
}

async function run(session, params, filter) {
  const gen = session.gen;
  const myRun = ++session.runSeq;
  // Serialize worker access: wait for any prior run to release the chain first.
  const prev = session.runChain;
  let release;
  session.runChain = new Promise((r) => { release = r; });
  await prev;
  try {
    for (const item of session.items) {
      if (session.gen !== gen || session.runSeq !== myRun) break; // cleared or superseded
      if (!filter(item)) continue;
      item.outFormat = resolveOutFormat(item, params.outFormatChoice);
      item.status = 'processing';
      item.phase = 'decoding';
      item.error = null;
      params.onItemStart?.(item);
      await runOne(session, item, params, gen);
      if (session.gen !== gen || session.runSeq !== myRun) break;
      params.onItemDone?.(item);
    }
  } finally {
    release();
  }
}

function runOne(session, item, params, gen) {
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
      type: 'compress', id: item.id, file: item.file, outFormat: item.outFormat,
      mode: params.mode, quality: params.quality, targetBytes: params.targetBytes,
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
  if (msg.keptOriginal) {
    item.status = 'kept-original';
    item.outBlob = item.file;
    item.outSize = item.size;
    // The kept bytes ARE the source format — so the card label and the
    // download extension must report the source, not the (larger) forced
    // format the re-encode would have produced. A later run re-resolves
    // outFormat from the UI choice, so this doesn't stick.
    item.outFormat = item.sourceFormat;
    item.quality = msg.quality ?? null;
    item.fallback = false;
    item.targetOk = true;
    item.note = 'already optimized — kept the original file';
    return;
  }
  item.outBlob = new Blob([msg.outBuffer], { type: msg.outMime });
  item.outSize = item.outBlob.size;
  item.quality = msg.quality ?? null;
  item.fallback = !!msg.fallback;
  item.targetOk = msg.targetOk !== false;
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
