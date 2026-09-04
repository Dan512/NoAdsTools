// compress-video/js/engine.js — the compress operation over mediabunny.
// This module is the seam a future ffmpeg.wasm fallback would slot in
// behind: main.js only ever calls hasWebCodecs()/startCompress() (and
// probe/preview go through loadMediabunny()).
//
// The lazy loader lives in /shared/mediabunny-loader.js (shared with
// split-audio) and is re-exported here so main.js, probe.js, preview.js,
// and calibrate.js keep their existing imports. The path is
// RELATIVE, not /shared/..., because engine.test.js imports this file
// from Node, where an absolute URL specifier cannot resolve.
import { KEY_FRAME_INTERVAL_SEC } from './calibrate.js';
import { loadMediabunny, EngineLoadError, _resetLoaderForTest } from '../../shared/mediabunny-loader.js';
export { loadMediabunny, EngineLoadError };

let testCompress = null;  // injected by _setCompressForTest

/**
 * Named-error pre-flight over mediabunny's discardedTracks. A discarded
 * video track can never produce video output; a discarded audio track we
 * did not ask to remove would ship a silently muted file — both fail NOW
 * with a named error rather than minutes into an encode (or worse, after
 * a "successful" one).
 * @returns {'video_unsupported'|'audio_unsupported'|null}
 */
export function checkDiscards(discardedTracks, plan) {
  const tracks = discardedTracks ?? [];
  if (tracks.some(d => d?.track?.type === 'video')) return 'video_unsupported';
  if (plan?.audio?.mode !== 'remove' && tracks.some(d => d?.track?.type === 'audio')) {
    return 'audio_unsupported';
  }
  return null;
}

// Maps plan.audio (plan-encode.js resolveAudio's result; absent = copy)
// to mediabunny Conversion options. Copy = leave audio unconfigured so
// mediabunny stream-copies when the codec fits MP4 — the exact-bytes case
// the planner charges for. Exported (not just used internally) because it
// is the pin plan-encode.js's resolveAudio JSDoc delegates to this file:
// constant bitrate mode on the audio encoder. Takes `mb` as its first
// param specifically so a spec can inject a fake instead of the real
// vendored module.
export function audioOptions(mb, audio) {
  if (!audio || audio.mode === 'copy') return {};
  if (audio.mode === 'remove') return { audio: { discard: true } };
  return {
    audio: {
      codec: 'aac',
      // Constant bitrate for the same reason as video: the planner's
      // audio byte count is bitrate x duration and must actually hold.
      quality: new mb.Quality({ bitrate: audio.bps, bitrateMode: 'constant' }),
      ...(audio.channels ? { numberOfChannels: audio.channels } : {}),
    },
  };
}

// Candidate AAC bitrates to probe, ascending. A single boolean
// "can this browser encode AAC" is not enough: measured 2026-08-26 against
// the vendored mediabunny + native WebCodecs AudioEncoder, across all three
// engines the project targets —
//   Chromium 148: hard floor at 96 kbps. 64k REJECTED at both mono and
//     stereo; 96k/128k/192k all accepted. bitrateMode is irrelevant to the
//     floor (constant vs variable made no difference; the floor is about
//     the bitrate NUMBER, confirmed via raw AudioEncoder.isConfigSupported
//     probes, not just mediabunny's wrapper).
//   Firefox: AudioEncoder exists, but isConfigSupported returns false for
//     EVERY AAC bitrate tried — no usable floor at all.
//   WebKit: no AudioEncoder global at all.
// So a browser can encode AAC but not at the '64k-mono' rung, which a
// single boolean can't express and a probe at the single most demanding
// rung would misreport as "no AAC encoder" (see the git history on this
// file for that first attempt and why it was wrong). Walking the real
// AUDIO_STEPS-adjacent bitrates and taking the first that is accepted
// finds the actual usable floor instead of guessing at one rung.
const AUDIO_FLOOR_CANDIDATES = Object.freeze([64_000, 96_000, 128_000, 192_000]);

let audioFloorProbe = null; // Promise<number|null>, cached
let testAudioFloor;         // number|null|undefined; undefined = not overridden

/**
 * The lowest AAC bitrate this browser's encoder actually accepts (constant
 * bitrate mode, mono — what a real encode of the lowest rung would ask
 * for), or null if it can't encode AAC at all. See plan-encode.js's
 * resolveAudio, which treats this as the audio floor a rung must clear to
 * be offered rather than collapsed to copy.
 * @returns {Promise<number|null>}
 */
export async function probeAudioFloorBps() {
  if (testAudioFloor !== undefined) return testAudioFloor;
  if (!audioFloorProbe) {
    audioFloorProbe = loadMediabunny()
      .then(async mb => {
        for (const bps of AUDIO_FLOOR_CANDIDATES) {
          const ok = await mb.canEncodeAudio('aac', {
            numberOfChannels: 1,
            quality: new mb.Quality({ bitrate: bps, bitrateMode: 'constant' }),
          });
          if (ok) return bps;
        }
        return null;
      })
      // Same discipline as /shared/mediabunny-loader.js's loadMediabunny: a
      // failed ENGINE LOAD must not poison the answer, or a document that
      // recovers keeps reporting "no AAC encoder" and the planner silently
      // degrades (or drops) audio.
      .catch(() => { audioFloorProbe = null; return null; });
  }
  return audioFloorProbe;
}

export function hasWebCodecs() {
  return typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function';
}

/**
 * Start a compression run. Video is re-encoded at plan.videoBitrate and
 * scaled to plan.out. Audio is handled per plan.audio (see audioOptions
 * above) — absent/'copy' leaves it unconfigured so mediabunny stream-copies
 * whenever the codec fits MP4, the exact-bytes case the planner charges for.
 * @param {File} file
 * @param {{videoBitrate:number, out:{width:number,height:number},
 *   outFps?:number|null, audio?:{mode:'copy'|'encode'|'remove',
 *   bps:number|null, channels:number|null}}} plan outFps resamples the frame
 *   rate (mediabunny options.video.frameRate); null/absent keeps the source
 *   timing untouched. plan.audio is plan-encode.js's resolveAudio result;
 *   absent behaves as 'copy'. Note: plan-encode.js's resolveAudio JSDoc
 *   names THIS file as the place that pins the audio encoder to constant
 *   bitrate mode — audioOptions below is that pin; keep it there.
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
        // 'constant' bitrate mode, not the mediabunny default ('variable'):
        // the encoder treats a variable-mode bitrate as a soft average and
        // overshoots by ~6%, which is more than the planner's safety
        // margin. Constant mode lands within 1% of the requested bitrate.
        quality: new mb.Quality({ bitrate: plan.videoBitrate, bitrateMode: 'constant' }),
        width: plan.out.width,
        height: plan.out.height,
        fit: 'contain',
        // Pinned to the same value the calibration probe uses (calibrate.js)
        // so the probe's short segments have the same keyframe density as
        // this full encode — that match is what makes the probe's
        // predicted size accurate.
        keyFrameInterval: KEY_FRAME_INTERVAL_SEC,
        ...(plan.outFps ? { frameRate: plan.outFps } : {}),
      },
      ...audioOptions(mb, plan.audio),
    });
    if (cancelledEarly) throw new Error('compress_cancelled');
    // Pre-flight both tracks with named errors, not minutes in.
    // (Defensive optional chaining inside checkDiscards: if the field is
    // ever renamed upstream we fall through to execute()'s own error.)
    const discardErr = checkDiscards(conversion.discardedTracks, plan);
    if (discardErr) throw new Error(discardErr);
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

/**
 * Force probeAudioFloorBps's answer for specs: a bitrate, or null for "no
 * AAC encoder at all". Pass undefined to clear (null is itself a real
 * forced answer, so it can't double as the "unset" sentinel).
 */
export function _setAudioFloorForTest(v) { testAudioFloor = v; }

/** Clears the cached module promise, the retry-attempt counter, and the test hooks. */
export function _resetForTest() {
  _resetLoaderForTest(); testCompress = null;
  audioFloorProbe = null; testAudioFloor = undefined;
}
