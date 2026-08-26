// compress-video/js/plan-encode.js — pure size→bitrate→quality planning.
// No DOM, no mediabunny: everything here is Node-testable.
//
// Contract: given probed source facts and a target byte count, compute the
// video bitrate that lands the output UNDER the target, the bits-per-pixel
// that bitrate buys at the chosen output resolution, the quality band that
// bpp falls in, and (when the band is poor) the tallest standard height that
// would fix it.

// Land under the cap, not on it: encoders overshoot an average-bitrate
// target a little, and "24.9 MB" succeeds where "25.2 MB" fails.
export const SAFETY = 0.97;

// Below this video bitrate we call the target unreachable rather than emit
// slideshow output. 100 kbps of H.264 is miserable at any resolution.
export const FLOOR_VIDEO_BPS = 100_000;

// The encoder's practical minimum: below ~this many bits per pixel per
// frame, H.264 encoders sit at their worst allowed quality and IGNORE the
// requested bitrate (output size then scales with frame count, not the
// request). Calibrated 2026-08-25: real 1080p phone footage bottomed out
// near 0.008 bpp on hardware encoders; worst-case noise near 0.095. 0.005
// refuses only targets no encoder will honor; moderate overshoot is
// handled by the post-encode re-compress pass instead.
export const FLOOR_BPP = 0.005;

// MP4 container overhead: a base for ftyp/moov plus per-second sample-table
// bookkeeping. PROVISIONAL constants — calibrated against real mediabunny
// output in the calibration pass (plan Task 10) before ship.
export function muxOverheadBytes(durationSec) {
  return 4096 + Math.ceil(durationSec * 700);
}

// Quality bands by bits-per-pixel-per-frame. PROVISIONAL thresholds; the
// band MECHANISM is the contract, the numbers get calibrated in Task 10.
// `step` is the 1-based position on the 5-step meter (5 = best) so the UI
// can mark position + label without relying on hue (colorblind rule).
export const BANDS = Object.freeze([
  { id: 'near-original', label: 'Near-original quality', min: 0.15, step: 5 },
  { id: 'good',          label: 'Good quality',          min: 0.10, step: 4 },
  { id: 'acceptable',    label: 'Acceptable quality',    min: 0.06, step: 3 },
  { id: 'soft',          label: 'Noticeably soft',       min: 0.03, step: 2 },
  { id: 'blocky',        label: 'Blocky, poor quality',  min: 0,    step: 1 },
]);

// Descending, so the FIRST height that clears "acceptable" is the tallest.
export const STANDARD_HEIGHTS = Object.freeze([1080, 720, 480, 360]);

// H.264 wants even dimensions.
export function evenDim(n) {
  return Math.max(2, 2 * Math.round(n / 2));
}

export function bandForBpp(bpp) {
  return BANDS.find(b => bpp >= b.min) ?? BANDS[BANDS.length - 1];
}

// Scale to a target height preserving aspect; never upscale.
export function scaleToHeight(width, height, outHeight) {
  if (outHeight >= height) return { width: evenDim(width), height: evenDim(height) };
  return { width: evenDim(width * (outHeight / height)), height: evenDim(outHeight) };
}

/**
 * @param {{targetBytes:number, durationSec:number, width:number,
 *   height:number, fps:number, audioBytes:number}} src probed source facts
 * @param {{outHeight?:number|null, outFps?:number|null}} [opts] chosen
 *   output height (null/absent = keep source resolution) and output fps
 *   (null/absent, or a value >= source fps, = keep source fps; never
 *   upsamples)
 * @returns {{unreachable:true, minTargetBytes:number,
 *   out:{width:number,height:number}, outFps:number|null,
 *   suggestion:{height:number,band:object}|null} | {unreachable:false,
 *   minTargetBytes:number, videoBitrate:number,
 *   out:{width:number,height:number}, outFps:number|null, bpp:number,
 *   band:{id:string,label:string,min:number,step:number},
 *   suggestion:{height:number,band:object}|null}}
 */
export function planEncode(src, opts = {}) {
  const { targetBytes, durationSec, width, height, fps } = src;
  const audioBytes = Math.ceil(src.audioBytes || 0);
  if (!(targetBytes > 0) || !(durationSec > 0) || !(width > 0)
      || !(height > 0) || !(fps > 0)) {
    throw new Error('plan_invalid_input');
  }
  const overhead = muxOverheadBytes(durationSec);
  const budget = Math.floor(targetBytes * SAFETY) - audioBytes - overhead;
  const out = scaleToHeight(width, height, opts.outHeight ?? height);
  const outFps = (opts.outFps && opts.outFps < fps) ? opts.outFps : null;
  const effFps = outFps ?? fps;
  const minVideoBps = Math.max(FLOOR_VIDEO_BPS, Math.ceil(FLOOR_BPP * out.width * out.height * effFps));
  const minVideoBytes = Math.ceil(minVideoBps * durationSec / 8);
  const minTargetBytes = Math.ceil((audioBytes + overhead + minVideoBytes) / SAFETY);

  if (budget < minVideoBytes) {
    // Suggestion: the tallest standard height below the CHOSEN output
    // height at which this same budget clears that height's own
    // resolution/fps-scaled floor. First hit (heights descend) wins.
    const candidateBitrate = Math.floor(budget * 8 / durationSec);
    let suggestion = null;
    for (const h of STANDARD_HEIGHTS) {
      if (h >= out.height) continue;
      const alt = scaleToHeight(width, height, h);
      const altMinVideoBps = Math.max(FLOOR_VIDEO_BPS, Math.ceil(FLOOR_BPP * alt.width * alt.height * effFps));
      if (candidateBitrate >= altMinVideoBps) {
        suggestion = { height: h, band: bandForBpp(candidateBitrate / (alt.width * alt.height * effFps)) };
        break;
      }
    }
    return { unreachable: true, minTargetBytes, out, outFps, suggestion };
  }

  const videoBitrate = Math.floor(budget * 8 / durationSec);
  const bpp = videoBitrate / (out.width * out.height * effFps);
  const band = bandForBpp(bpp);

  // Advice: only when the chosen resolution lands below "acceptable" and a
  // smaller standard height clears it. First hit = tallest fix.
  let suggestion = null;
  if (band.step < 3) {
    for (const h of STANDARD_HEIGHTS) {
      if (h >= out.height) continue;
      const alt = scaleToHeight(width, height, h);
      const altBand = bandForBpp(videoBitrate / (alt.width * alt.height * effFps));
      if (altBand.step >= 3) { suggestion = { height: h, band: altBand }; break; }
    }
  }
  return { unreachable: false, minTargetBytes, videoBitrate, out, outFps, bpp, band, suggestion };
}

/**
 * Pick the output height AND fps for "Auto (best fit)": walk candidate
 * (height, fps) pairs — tallest height first, source fps before a 30fps
 * drop within each height — evaluating each pair THROUGH planEncode (no
 * duplicated floor/band math, so this can't drift from it). Prefers the
 * first pair reaching "acceptable" quality; failing that, the first
 * reaching "soft"; failing that, the reachable pair with the highest bpp
 * (best picture the budget can buy); failing that (nothing reachable),
 * the pair with the smallest minTargetBytes. fps is only ever dropped to
 * 30 (never upsampled), and only offered as a candidate when the source
 * is high-fps (>= 40) — trying that drop BEFORE the next resolution step
 * down, since 1080p30 usually beats 720p60 for a given byte budget.
 * @param {{targetBytes:number, durationSec:number, width:number,
 *   height:number, fps:number, audioBytes:number}} src probed source facts
 *   (targetBytes included, exactly like planEncode)
 * @param {{outHeight?:number, outFps?:number|null}} [opts] pins: outHeight
 *   restricts the height search to that one value; outFps (present, even
 *   as null) restricts the fps search to that one value
 * @returns {{height:number, fps:number|null}} fps null = keep source fps
 */
export function chooseAuto(src, opts = {}) {
  const { targetBytes, durationSec, width, height, fps } = src;
  if (!(targetBytes > 0) || !(durationSec > 0) || !(width > 0)
      || !(height > 0) || !(fps > 0)) {
    throw new Error('plan_invalid_input');
  }

  const heights = opts.outHeight
    ? [opts.outHeight]
    : [height, ...STANDARD_HEIGHTS.filter(h => h < height)];
  const fpsCands = ('outFps' in opts)
    ? [opts.outFps]
    : (fps >= 40 ? [null, 30] : [null]);

  const pairs = [];
  for (const h of heights) {
    for (const f of fpsCands) {
      const plan = planEncode(src, { outHeight: h, outFps: f });
      pairs.push({ height: h, fps: plan.outFps, plan });
    }
  }

  for (const minStep of [3, 2]) {
    const hit = pairs.find(c => !c.plan.unreachable && c.plan.band.step >= minStep);
    if (hit) return { height: hit.height, fps: hit.fps };
  }

  const reachable = pairs.filter(c => !c.plan.unreachable);
  if (reachable.length > 0) {
    let best = reachable[0];
    for (const c of reachable.slice(1)) {
      if (c.plan.bpp > best.plan.bpp) best = c;
    }
    return { height: best.height, fps: best.fps };
  }

  let best = pairs[0];
  for (const c of pairs.slice(1)) {
    if (c.plan.minTargetBytes < best.plan.minTargetBytes) best = c;
  }
  return { height: best.height, fps: best.fps };
}

/**
 * After an encode lands OVER the target, compute a corrected (lower)
 * bitrate for one automatic second pass, scaled by how far the encoder
 * overshot. Returns a positive integer strictly below the previous
 * bitrate, or null when no meaningful correction exists (already under
 * target, or the correction cannot go lower).
 * @param {{videoBitrate:number, actualBytes:number, targetBytes:number,
 *   audioBytes:number, durationSec:number}} r
 */
export function correctedBitrate(r) {
  if (!(r.actualBytes > r.targetBytes)) return null;
  const overhead = muxOverheadBytes(r.durationSec);
  const achievedVideo = r.actualBytes - r.audioBytes - overhead;
  const targetVideo = Math.floor(r.targetBytes * SAFETY) - r.audioBytes - overhead;
  if (achievedVideo <= 0 || targetVideo <= 0) return null;
  let b2 = Math.floor(r.videoBitrate * (targetVideo / achievedVideo) * SAFETY);
  b2 = Math.max(FLOOR_VIDEO_BPS, b2);
  return b2 < r.videoBitrate ? b2 : null;
}
