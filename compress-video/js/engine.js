// compress-video/js/engine.js — lazy mediabunny loader + the compress
// operation. This module is the seam a future ffmpeg.wasm fallback would
// slot in behind: main.js only ever calls hasWebCodecs()/startCompress()
// (and probe/preview go through loadMediabunny()).
//
// mediabunny (MPL-2.0, ~660 KB min ESM) is vendored at
// /vendor/mediabunny/mediabunny.min.mjs and dynamic-imported on first use —
// 0 bytes at page boot. A failed load must not poison the cache: the
// promise resets on rejection so the next attempt retries, and the retry
// cache-busts the specifier so the browser's per-specifier module map
// (which caches a failed import() for the life of the document) can't
// replay the old rejection without a real re-fetch.

let cached = null;        // Promise<module>
let attempt = 0;          // bumped on every attempt; arms the next call as a retry
let testCompress = null;  // injected by _setCompressForTest

// One class so main.js can split "our asset failed to load" (retryable,
// never the file's fault) from "this file can't be processed".
export class EngineLoadError extends Error {
  constructor() { super('engine_load_failed'); this.name = 'EngineLoadError'; }
}

export function hasWebCodecs() {
  return typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function';
}

export async function loadMediabunny() {
  if (cached) return cached;
  // The browser module map caches a FAILED import per-specifier for the
  // life of the document, so a bare retry would replay the cached
  // rejection without touching the network. A fresh query string forces a
  // real re-fetch; the first attempt keeps the bare, HTTP-cacheable URL.
  const url = '/vendor/mediabunny/mediabunny.min.mjs' + (attempt ? `?retry=${attempt}` : '');
  attempt += 1;
  cached = import(url)
    .catch(() => { throw new EngineLoadError(); });
  cached.catch(() => { cached = null; });
  return cached;
}

/**
 * Start a compression run. Video is re-encoded at plan.videoBitrate and
 * scaled to plan.out; audio is deliberately unconfigured so mediabunny
 * COPIES it whenever the codec fits MP4 — the stream-copy the size math
 * assumes.
 * @param {File} file
 * @param {{videoBitrate:number, out:{width:number,height:number},
 *   outFps?:number|null}} plan outFps resamples the frame rate (mediabunny
 *   options.video.frameRate); null/absent keeps the source timing untouched.
 * @param {{onProgress?:(p:number)=>void}} [cb]
 * @returns {{done:Promise<Blob>, cancel:() => Promise<void>}}
 */
export function startCompress(file, plan, cb = {}) {
  if (testCompress) return testCompress(file, plan, cb);
  let conversion = null;
  let cancelledEarly = false;
  const done = (async () => {
    const mb = await loadMediabunny();
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat(),
      target: new mb.BufferTarget(),
    });
    conversion = await mb.Conversion.init({
      input, output,
      video: {
        quality: new mb.Quality({ bitrate: plan.videoBitrate }),
        width: plan.out.width,
        height: plan.out.height,
        fit: 'contain',
        ...(plan.outFps ? { frameRate: plan.outFps } : {}),
      },
    });
    if (cancelledEarly) throw new Error('compress_cancelled');
    // Pre-flight: a video track mediabunny had to discard means this file
    // cannot produce video output — fail now with a named error, not
    // minutes in. (Defensive optional chaining: if the field is ever
    // renamed upstream, we fall through to execute()'s own error.)
    const discardedVideo = (conversion.discardedTracks ?? [])
      .some(d => d?.track?.type === 'video');
    if (discardedVideo) throw new Error('video_unsupported');
    if (cb.onProgress) conversion.onProgress = cb.onProgress;
    await conversion.execute();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  })();
  // Swallow here only to avoid unhandled-rejection noise when the caller
  // cancels before awaiting; main.js still awaits `done` and handles it.
  done.catch(() => {});
  return {
    done,
    cancel: async () => {
      cancelledEarly = true;
      if (conversion) await conversion.cancel();
    },
  };
}

// ---------- Test escape hatches ---------------------------------------------

/** Replace startCompress for specs. Pass null to clear. */
export function _setCompressForTest(fn) { testCompress = fn; }

/** Clears the cached module promise, the retry-attempt counter, and the test hook. */
export function _resetForTest() { cached = null; attempt = 0; testCompress = null; }
