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
 * @param {{outHeight?:number|null}} [opts] chosen output height (null/absent
 *   = keep source resolution)
 * @returns {{unreachable:true, minTargetBytes:number} | {unreachable:false,
 *   minTargetBytes:number, videoBitrate:number,
 *   out:{width:number,height:number}, bpp:number,
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
  const minVideoBytes = Math.ceil(FLOOR_VIDEO_BPS * durationSec / 8);
  const minTargetBytes = Math.ceil((audioBytes + overhead + minVideoBytes) / SAFETY);

  if (budget < minVideoBytes) return { unreachable: true, minTargetBytes };

  const out = scaleToHeight(width, height, opts.outHeight ?? height);
  const videoBitrate = Math.floor(budget * 8 / durationSec);
  const bpp = videoBitrate / (out.width * out.height * fps);
  const band = bandForBpp(bpp);

  // Advice: only when the chosen resolution lands below "acceptable" and a
  // smaller standard height clears it. First hit = tallest fix.
  let suggestion = null;
  if (band.step < 3) {
    for (const h of STANDARD_HEIGHTS) {
      if (h >= out.height) continue;
      const alt = scaleToHeight(width, height, h);
      const altBand = bandForBpp(videoBitrate / (alt.width * alt.height * fps));
      if (altBand.step >= 3) { suggestion = { height: h, band: altBand }; break; }
    }
  }
  return { unreachable: false, minTargetBytes, videoBitrate, out, bpp, band, suggestion };
}
