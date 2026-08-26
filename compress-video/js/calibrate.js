// compress-video/js/calibrate.js — measure what the planned bitrate ACTUALLY
// costs by encoding a couple of short segments of the real clip before
// committing to the full encode. Encoders have a content-dependent floor
// they won't go below (see plan-encode.js's FLOOR_BPP): the planner's guess
// can undershoot that floor, and the only way to know is to ask the encoder.
//
// Two empirical facts pin this module's shape (established in-browser,
// 2026-08-25 — do not re-derive):
//   - bitrateMode: 'constant' is required, or the encoder overshoots ~6%.
//   - The probe MUST use the same keyFrameInterval as the full encode. A
//     mismatch inflates the measurement badly (per-segment keyframe density
//     was skewing error 20-87%; pinning it to the full-encode value dropped
//     that to 0-13%).
import { loadMediabunny } from './engine.js';

// Keyframe interval (seconds) for both the probe and the full encode.
// Exported from here because it must be the SAME value in both places;
// engine.js and preview.js import this constant rather than each picking
// their own.
export const KEY_FRAME_INTERVAL_SEC = 2;

// Each probe segment is one full keyframe interval long — shorter than that
// and the segment's keyframe density no longer matches the full encode's,
// which is exactly the mismatch that inflated measurement error above.
export const PROBE_SEGMENT_SEC = 2;

// Two segments, spread through the clip, so the measurement isn't just one
// lucky (or unlucky) patch of content — a title card, a static frame, a
// burst of motion.
export const PROBE_SEGMENTS = 2;

// Below this source duration, a full encode is already cheap enough that
// probing first would cost more than it saves — skip probing entirely.
export const PROBE_MIN_DURATION_SEC = 15;

let testProbe = null; // injected by _setProbeEncodeForTest

/** True when a clip is long enough that probing before the full encode pays for itself. */
export function shouldProbe(durationSec) {
  return durationSec >= PROBE_MIN_DURATION_SEC;
}

// Segment start times targeting evenly-spread slot centers over `count`
// slots — for count = PROBE_SEGMENTS (2) that's the 1/4 and 3/4 marks.
// Clamped to fit inside the clip; returns fewer/shorter segments rather
// than overlapping ones when the clip is too short for the requested
// spread.
//
// startProbe always plans the FULL PROBE_SEGMENTS layout here and slices
// the front of it when a smaller count is requested — it does NOT call
// this with a smaller `count` to get a re-centered layout. A reduced probe
// is never measured in isolation: it exists to be COMPARED against a full
// probe of the same clip (main.js corrects the bitrate from probe 1, then
// asks a cheaper probe 2 whether that correction actually fits). If probe
// 2 sampled different footage — e.g. a re-centered single midpoint segment
// instead of probe 1's first (1/4-mark) segment — the comparison would
// spend its margin on content variance between patches of the SAME clip
// rather than on the encoder's response to the bitrate change, and real
// footage varies more between patches than the margin allows. Slicing the
// shared layout makes the content term cancel: both probes' first segment
// is the exact same window.
function planSegments(durationSec, count) {
  const segs = [];
  for (let i = 0; i < count; i++) {
    const center = durationSec * (2 * i + 1) / (2 * count);
    let start = center - PROBE_SEGMENT_SEC / 2;
    start = Math.max(0, Math.min(start, durationSec - PROBE_SEGMENT_SEC));
    const end = Math.min(start + PROBE_SEGMENT_SEC, durationSec);
    if (end <= start) continue; // clip barely longer than one segment: drop it
    // Clamping can push two segments' windows into each other on a short
    // clip; when that happens, keep only the first and drop the rest so we
    // never double-count the same footage.
    const prev = segs[segs.length - 1];
    if (prev && start < prev.end) continue;
    segs.push({ start, end });
  }
  return segs;
}

/**
 * Encode short segments of the real clip at the planned settings and report
 * how many bytes they actually cost. Video only: audio is discarded, and the
 * caller adds the (stream-copied) audio bytes back when predicting.
 * @param {File} file
 * @param {{videoBitrate:number, out:{width:number,height:number}, outFps?:number|null}} plan
 * @param {number} durationSec source duration
 * @param {{onProgress?:(p:number)=>void, segments?:number}} [cb] onProgress
 *   reports 0..1 across the whole probe. `segments` overrides PROBE_SEGMENTS
 *   for this call — clamped to [1, PROBE_SEGMENTS] — for the cheap "does a
 *   lower bitrate actually cost less" re-probe. It reuses the FRONT of the
 *   same segment layout a full probe would use (not a re-centered layout
 *   for the smaller count), so a 1-segment re-probe samples exactly the
 *   same footage as a full probe's first segment — required for the two
 *   probes to be comparable at all; see the comment on planSegments.
 * @returns {{done:Promise<{probeBytes:number, probeSecs:number}>, cancel:() => Promise<void>}}
 */
export function startProbe(file, plan, durationSec, cb = {}) {
  if (testProbe) return testProbe(file, plan, durationSec, cb);
  const segmentCount = Math.min(PROBE_SEGMENTS, Math.max(1, cb.segments ?? PROBE_SEGMENTS));
  let conversion = null;
  let cancelled = false;
  const done = (async () => {
    const segments = planSegments(durationSec, PROBE_SEGMENTS).slice(0, segmentCount);
    const total = segments.length;
    let probeBytes = 0;
    let probeSecs = 0;
    for (let i = 0; i < total; i++) {
      if (cancelled) throw new Error('probe_cancelled');
      const { start, end } = segments[i];
      const mb = await loadMediabunny();
      const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
      const output = new mb.Output({
        format: new mb.Mp4OutputFormat(),
        target: new mb.BufferTarget(),
      });
      conversion = await mb.Conversion.init({
        input, output,
        trim: { start, end },
        video: {
          quality: new mb.Quality({ bitrate: plan.videoBitrate, bitrateMode: 'constant' }),
          width: plan.out.width,
          height: plan.out.height,
          fit: 'contain',
          keyFrameInterval: KEY_FRAME_INTERVAL_SEC,
          ...(plan.outFps ? { frameRate: plan.outFps } : {}),
        },
        audio: { discard: true },
      });
      if (cancelled) throw new Error('probe_cancelled');
      if (cb.onProgress) {
        conversion.onProgress = (p) => cb.onProgress((i + p) / total);
      }
      await conversion.execute();
      probeBytes += output.target.buffer.byteLength;
      // This is the REQUESTED trim window, not a frame-accurate readout of
      // the encoded output. Frame quantization can make the true encoded
      // duration up to one frame shorter per segment (~1.7% on a 2s segment
      // at 30fps), which would make this sum slightly OVERSTATE probeSecs
      // and so understate bytes-per-second when the caller extrapolates —
      // the unsafe direction for a tool whose job is staying under a target
      // size. Deriving the real encoded duration would mean re-parsing each
      // segment's output (an extra decode pass), which conflicts with
      // keeping this probe cheap; accepted as noise given plan-encode.js's
      // existing SAFETY margin, rather than corrected here.
      probeSecs += end - start;
    }
    return { probeBytes, probeSecs };
  })();
  // Swallow here only to avoid unhandled-rejection noise when the caller
  // cancels before awaiting; main.js still awaits `done` and handles it.
  done.catch(() => {});
  return {
    done,
    cancel: async () => {
      cancelled = true;
      if (conversion) await conversion.cancel();
    },
  };
}

// ---------- Test escape hatches ---------------------------------------------

/** Replace startProbe for specs. Pass null to clear. */
export function _setProbeEncodeForTest(fn) { testProbe = fn; }
