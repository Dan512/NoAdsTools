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

// A GUESS at the lowest bitrate an AAC encoder will accept — the same role
// FLOOR_BPP plays for video, and replaced the same way: whenever a probe
// has actually measured a browser's floor (engine.js's probeAudioFloorBps,
// carried on src.audioFloorBps), that measurement is used everywhere this
// constant would otherwise apply, in both resolveAudio branches below.
// Only reachable today for a codec MP4 can't carry, where transcoding UP is
// the only way to keep the track at all — a copyable source this quiet
// collapses to copy before the clamp is reached, so this never wastes
// budget.
export const FLOOR_AUDIO_BPS = 32_000;

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

// Audio choices, mildest first — the order chooseAuto's back-off walks.
// 'none' is deliberately NOT in this table — that omission is what keeps
// chooseAuto from ever removing the track. It reaches resolveAudio and
// planEncode only as an explicit manual selection.
export const AUDIO_STEPS = Object.freeze([
  Object.freeze({ id: 'copy',     bps: null,    channels: null }),
  Object.freeze({ id: '128k',     bps: 128_000, channels: null }),
  Object.freeze({ id: '96k',      bps: 96_000,  channels: null }),
  Object.freeze({ id: '64k-mono', bps: 64_000,  channels: 1 }),
]);

// A forced transcode (uncarriable codec, 'copy' requested) targets the
// ladder's top rung rather than a separately-chosen number, so bumping
// AUDIO_STEPS (e.g. adding a 160k rung above 128k) can't leave a stale
// cap behind — the two would silently drift apart otherwise.
const FORCED_TRANSCODE_CAP_BPS = AUDIO_STEPS.find(s => s.id === '128k').bps;

/**
 * Resolve an audio step id against the probed source facts into what the
 * encoder should be asked for and what it will cost. The .bytes field is
 * the number planEncode subtracts from the budget — measured bytes for a
 * true stream-copy, bitrate × duration for anything re-encoded, which
 * holds only because the engine pins the audio encoder to constant
 * bitrate mode (see engine.js audioOptions, which states and keeps that
 * pin).
 * @param {{hasAudio?:boolean, durationSec:number, audioBytes?:number,
 *   audioBitrate?:number, audioCopyable?:boolean, audioFloorBps?:number|null}} src
 *   hasAudio absent = inferred from audioBytes > 0 (legacy callers);
 *   audioCopyable absent = assumed true. audioFloorBps is the browser's
 *   MEASURED lowest encodable AAC bitrate (engine.js's probeAudioFloorBps):
 *   absent = permissive, same as today (legacy callers keep working); null
 *   = this browser cannot encode AAC at all; a number REPLACES
 *   FLOOR_AUDIO_BPS as the floor everywhere it applies, including which
 *   AUDIO_STEPS rungs are even reachable. durationSec is only required
 *   when hasAudio resolves true (a sparse no-audio src is fine without it).
 * @param {string} [id] one of AUDIO_STEPS ids or 'none'; absent = 'copy'
 * @returns {{id:string, mode:'copy'|'encode'|'remove', bps:number|null,
 *   channels:number|null, bytes:number, forced?:true}} id reports the
 *   RESOLVED step in every branch except two: the forced-transcode one
 *   (uncarriable codec, AAC available — id stays 'copy' while the audio is
 *   actually transcoded) and the compound-corner one (uncarriable codec,
 *   NO AAC encoder either — id stays 'copy' while the audio is actually
 *   dropped). `forced: true` flags both so a caller reading `id` alone
 *   doesn't under-report what will happen to the track.
 * @throws {Error} 'plan_invalid_input' on an unknown step id, or on a
 *   missing/non-positive durationSec while an audio track is present.
 */
export function resolveAudio(src, id = 'copy') {
  const hasAudio = src.hasAudio ?? ((src.audioBytes || 0) > 0);
  if (!hasAudio) return { id: 'copy', mode: 'copy', bps: null, channels: null, bytes: 0 };
  if (!(src.durationSec > 0)) throw new Error('plan_invalid_input');
  if (id === 'none') return { id: 'none', mode: 'remove', bps: 0, channels: null, bytes: 0 };
  // No measured audioBitrate (a src that omits audioBitrate — sparse
  // callers and unit fixtures) must read as "the source could be
  // arbitrarily high", not "the source is 0 bps" —
  // Infinity is the sentinel for that. Simplifying this to `|| 0` would
  // make every bitrate step look like it already beats an unknown source
  // and collapse straight to copy, silently no-opping the whole feature
  // with zero test failures (see the "unknown source bitrate" test below).
  const srcBps = (src.audioBitrate > 0) ? src.audioBitrate : Infinity;
  const copyable = src.audioCopyable !== false;
  // "Can this browser encode AAC at all" — absent audioFloorBps is
  // permissive (today's default, legacy callers keep working); an
  // explicit null is the MEASURED "no usable AAC bitrate anywhere" case
  // (Firefox: AudioEncoder exists but accepts none; WebKit: no
  // AudioEncoder at all — measured 2026-08-26, see probeAudioFloorBps).
  const encodable = src.audioFloorBps !== null;
  // A guessed floor is replaced by whatever was actually measured, exactly
  // as planEncode's floorBpp replaces FLOOR_BPP.
  const floor = (Number.isFinite(src.audioFloorBps) && src.audioFloorBps > 0) ? src.audioFloorBps : FLOOR_AUDIO_BPS;
  if (id === 'copy') {
    if (copyable) {
      return { id, mode: 'copy', bps: null, channels: null, bytes: Math.max(0, Math.ceil(src.audioBytes || 0)) };
    }
    // mediabunny can't stream-copy this codec into MP4: it transcodes no
    // matter what we ask, so charge the budget for the transcode we
    // request rather than the copy we won't get. Compound corner — also no
    // AAC encoder to transcode TO — so the track is dropped instead.
    // `forced: true` for the same reason as the transcode branch below: a
    // caller reading `id` alone sees 'copy' while the track is actually
    // gone.
    if (!encodable) return { id, mode: 'remove', bps: 0, channels: null, bytes: 0, forced: true };
    const bps = Math.max(floor, Math.min(srcBps, FORCED_TRANSCODE_CAP_BPS));
    return { id, mode: 'encode', bps, channels: null, bytes: Math.ceil(bps * src.durationSec / 8), forced: true };
  }
  const step = AUDIO_STEPS.find(s => s.id === id);
  if (!step) throw new Error('plan_invalid_input');
  // Recursing into the 'copy' branch above (rather than duplicating its
  // remove/encode logic here) is what makes the compound corner — no AAC
  // encoder AND an uncarriable codec — resolve all the way to 'remove'
  // instead of stopping at a state that promises audio no path can deliver.
  if (!encodable) return resolveAudio(src, 'copy');
  if (copyable && step.bps >= srcBps) return resolveAudio(src, 'copy');
  // A rung below the browser's measured floor cannot be delivered AT its
  // labeled bitrate. Clamping it UP (the way the line below clamps a step
  // that undercuts the SOURCE) would silently ship more bytes than the
  // label promises — a UI reading '64k-mono' with a 96 kbps floor would
  // show a number the encoder never targets, and the byte accounting would
  // quietly disagree with what's actually produced. Collapse to copy
  // instead, exactly like the whole-codec-unencodable case above.
  if (step.bps < floor) return resolveAudio(src, 'copy');
  const bps = Math.max(floor, Math.min(step.bps, srcBps));
  return { id: step.id, mode: 'encode', bps, channels: step.channels, bytes: Math.ceil(bps * src.durationSec / 8) };
}

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
 *   height:number, fps:number, audioBytes:number, hasAudio?:boolean,
 *   audioBitrate?:number, audioCopyable?:boolean, audioFloorBps?:number|null}}
 *   src probed source facts. Every audio field is read — through
 *   resolveAudio, whose JSDoc holds the details — and each of them can change
 *   the returned plan, not just audioBytes: hasAudio absent is inferred from
 *   audioBytes > 0, audioCopyable absent is assumed true, audioFloorBps
 *   absent is permissive while null means this browser cannot encode AAC at
 *   all, and audioBitrate absent reads as an arbitrarily loud source.
 * @param {{outHeight?:number|null, outFps?:number|null, floorBpp?:number,
 *   audio?:string}} [opts] chosen output height (null/absent = keep source
 *   resolution), output fps (null/absent, or a value >= source fps, = keep
 *   source fps; never upsamples), floorBpp — a calibration-probe-measured
 *   floor that REPLACES FLOOR_BPP everywhere it applies (falls back to
 *   FLOOR_BPP when absent, <= 0, or non-finite) — and audio, an AUDIO_STEPS
 *   id or 'none' (absent = 'copy') passed straight through to resolveAudio
 * @returns {{unreachable:true, minTargetBytes:number,
 *   out:{width:number,height:number}, outFps:number|null,
 *   audio:{id:string,mode:'copy'|'encode'|'remove',bps:number|null,
 *     channels:number|null,bytes:number,forced?:true}, audioBytes:number,
 *   suggestion:{height:number,band:object}|null} | {unreachable:false,
 *   minTargetBytes:number, videoBitrate:number,
 *   out:{width:number,height:number}, outFps:number|null, bpp:number,
 *   band:{id:string,label:string,min:number,step:number},
 *   audio:{id:string,mode:'copy'|'encode'|'remove',bps:number|null,
 *     channels:number|null,bytes:number,forced?:true}, audioBytes:number,
 *   suggestion:{height:number,band:object}|null}}
 * @throws {Error} 'plan_invalid_input' on non-positive targetBytes/
 *   durationSec/dimensions/fps, or an unknown opts.audio id.
 */
export function planEncode(src, opts = {}) {
  const { targetBytes, durationSec, width, height, fps } = src;
  if (!(targetBytes > 0) || !(durationSec > 0) || !(width > 0)
      || !(height > 0) || !(fps > 0)) {
    throw new Error('plan_invalid_input');
  }
  const audio = resolveAudio(src, opts.audio);
  const audioBytes = audio.bytes;
  const overhead = muxOverheadBytes(durationSec);
  const budget = Math.floor(targetBytes * SAFETY) - audioBytes - overhead;
  const out = scaleToHeight(width, height, opts.outHeight ?? height);
  const outFps = (opts.outFps && opts.outFps < fps) ? opts.outFps : null;
  const effFps = outFps ?? fps;
  // A measured floor (from a calibration probe) overrides the guessed
  // FLOOR_BPP constant everywhere the floor is computed below.
  const floorBpp = (Number.isFinite(opts.floorBpp) && opts.floorBpp > 0) ? opts.floorBpp : FLOOR_BPP;
  const minVideoBps = Math.max(FLOOR_VIDEO_BPS, Math.ceil(floorBpp * out.width * out.height * effFps));
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
      const altMinVideoBps = Math.max(FLOOR_VIDEO_BPS, Math.ceil(floorBpp * alt.width * alt.height * effFps));
      if (candidateBitrate >= altMinVideoBps) {
        suggestion = { height: h, band: bandForBpp(candidateBitrate / (alt.width * alt.height * effFps)) };
        break;
      }
    }
    return { unreachable: true, minTargetBytes, out, outFps, audio, audioBytes, suggestion };
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
  return { unreachable: false, minTargetBytes, videoBitrate, out, outFps, bpp, band, audio, audioBytes, suggestion };
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
 *
 * That (height, fps) search runs once PER audio step, and an explicit
 * back-off picks between the results (see the comment in the body).
 * chooseAuto never returns 'none': AUDIO_STEPS excludes it, so removing the
 * track stays a deliberate user choice.
 * @param {{targetBytes:number, durationSec:number, width:number,
 *   height:number, fps:number, audioBytes:number, hasAudio?:boolean,
 *   audioBitrate?:number, audioCopyable?:boolean, audioFloorBps?:number|null}}
 *   src probed source facts (targetBytes included, exactly like planEncode).
 *   audioFloorBps: see resolveAudio's JSDoc — absent is permissive, null
 *   means no AAC encoder at all, a number is the measured floor rungs are
 *   filtered against below.
 * @param {{outHeight?:number, outFps?:number|null, floorBpp?:number,
 *   audio?:string}} [opts] pins: outHeight restricts the height search to
 *   that one value; outFps (present, even as null) restricts the fps search
 *   to that one value; audio (present, even as 'none') restricts the audio
 *   search to that one step, exactly as outFps pins fps. All three pins are
 *   recognized by KEY PRESENCE, not truthiness — `{audio: undefined}` pins
 *   just as `{audio: 'none'}` does, so a caller assembling pins must OMIT
 *   the key to mean "auto", never assign undefined. floorBpp (a
 *   calibration-probe measurement) is threaded through to every planEncode
 *   call so every candidate is evaluated against the SAME measured floor
 *   instead of the guessed FLOOR_BPP.
 * @returns {{height:number, fps:number|null, audio:string}} fps null = keep
 *   source fps; audio is an AUDIO_STEPS id (or the pinned id when pinned)
 * @throws {Error} 'plan_invalid_input' on non-positive targetBytes/
 *   durationSec/dimensions/fps, or an unknown pinned opts.audio id.
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

  const hasAudio = src.hasAudio ?? ((src.audioBytes || 0) > 0);
  const encodable = src.audioFloorBps !== null;
  // The back-off below assumes the ladder is monotone — that each rung
  // frees bytes the one before it didn't — and that is NOT free. With no
  // measured src.audioBitrate (a src that omits audioBitrate — sparse
  // callers and unit fixtures), resolveAudio reads the source as Infinity
  // bps, so its never-upsample collapse cannot fire and a quiet source's
  // "downgrade" to 64 kbps mono costs MORE than the copy it replaces: audio
  // grows, the picture shrinks.
  // That Infinity sentinel has now produced two separate surprises, so the
  // ladder is filtered on resolved BYTES rather than trusted. The same
  // filter drops any rung that silently resolves back to copy — whether
  // because it's at or above the source rate, or because resolveAudio
  // collapsed it for sitting below the browser's measured audio floor —
  // which is what makes the returned id always name what the encoder is
  // really asked for.
  const copyBytes = resolveAudio(src, 'copy').bytes;
  const audioIds = ('audio' in opts) ? [opts.audio]
    : (hasAudio && encodable)
      ? ['copy', ...AUDIO_STEPS
          .filter(s => s.id !== 'copy' && resolveAudio(src, s.id).bytes < copyBytes)
          .map(s => s.id)]
      : ['copy'];

  // The existing tier logic, per audio step: tallest pair reaching step 3,
  // else step 2, else best bpp, else smallest minTargetBytes.
  const evalAudio = (audioId) => {
    const pairs = [];
    for (const h of heights) {
      for (const f of fpsCands) {
        const plan = planEncode(src, { outHeight: h, outFps: f, floorBpp: opts.floorBpp, audio: audioId });
        pairs.push({ height: h, fps: plan.outFps, plan });
      }
    }
    for (const minStep of [3, 2]) {
      const hit = pairs.find(c => !c.plan.unreachable && c.plan.band.step >= minStep);
      if (hit) return hit;
    }
    const reachable = pairs.filter(c => !c.plan.unreachable);
    if (reachable.length > 0) {
      return reachable.reduce((a, c) => (c.plan.bpp > a.plan.bpp ? c : a));
    }
    return pairs.reduce((a, c) => (c.plan.minTargetBytes < a.plan.minTargetBytes ? c : a));
  };

  // Back-off: rank every step's outcome as (band step, height, fps) — fps
  // null meaning "keep source fps" is the BEST fps, hence Infinity — and
  // take the best. The mildest step matching that outcome then wins, so
  // audio is only degraded when it buys a visibly different result. Below
  // Acceptable every bit belongs to the picture, so the MOST aggressive
  // matching step wins instead: down there two steps can share an outcome
  // while differing ~46% in video bitrate, which the outcome cannot see.
  //
  // The best outcome is found by ranking, NOT by assuming the most
  // aggressive step wins it. The tier search is not monotone in budget:
  // tier 1 takes the TALLEST pair clearing Acceptable, so freeing audio
  // bytes can promote a tall mediocre pair over a short excellent one and
  // DEMOTE the answer (band 5 at 1080p becomes band 3 at 2160p). Trusting
  // the last rung would then degrade audio to land a worse band.
  //
  // Audio is deliberately NOT a free axis in the band search. The band
  // scores the PICTURE only, so an optimizer free to trade audio away sees
  // every notch down as better-or-equal and never stops — it would crush
  // audio to the floor on every clip. This back-off is what stops that.
  const picks = audioIds.map(id => ({ id, pick: evalAudio(id) }));
  const rank = ({ pick }) => [
    pick.plan.unreachable ? 0 : pick.plan.band.step,
    pick.height,
    pick.fps ?? Infinity,
  ];
  const better = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  // Ties keep the earlier (milder) step, though only `matching` order below
  // decides the winner. tupleOf derives from rank so the two can't drift.
  const bestPick = picks.reduce((a, c) => (better(c, a) ? c : a));
  const tupleOf = (p) => rank(p).join('|');
  const bestTuple = tupleOf(bestPick);
  const matching = picks.filter(p => tupleOf(p) === bestTuple);
  const bandStep = bestPick.pick.plan.unreachable ? 0 : bestPick.pick.plan.band.step;
  const chosen = bandStep >= 3 ? matching[0] : matching[matching.length - 1];
  return { height: chosen.pick.height, fps: chosen.pick.fps, audio: chosen.id };
}

/**
 * Turn a calibration probe's measured bytes into a prediction for the full
 * encode, plus the bits-per-pixel the encoder actually delivered.
 *
 * The probe encodes short segments of the real clip at the planned settings
 * (video only, audio discarded), so `probeBytes` is video payload plus a
 * little container overhead. Extrapolating linearly over-predicts slightly
 * (measured 0 to 13% high, always high), which is the safe direction for a
 * promise that the output lands UNDER the target.
 *
 * @param {{probeBytes:number, probeSecs:number, durationSec:number,
 *   audioBytes:number, out:{width:number,height:number}, fps:number}} p
 *   `fps` is the EFFECTIVE output fps (plan.outFps ?? source fps).
 * @returns {{predictedBytes:number, achievedVideoBps:number, achievedBpp:number}}
 * @throws {Error} 'probe_invalid_input' on non-positive probeSecs/durationSec/
 *   fps/dimensions or negative probeBytes.
 */
export function predictFromProbe(p) {
  const { probeBytes, probeSecs, durationSec, audioBytes, out, fps } = p;
  if (!(probeSecs > 0) || !(durationSec > 0) || !(fps > 0)
      || !out || !(out.width > 0) || !(out.height > 0) || !(probeBytes >= 0)) {
    throw new Error('probe_invalid_input');
  }
  const achievedVideoBps = Math.round(probeBytes * 8 / probeSecs);
  const achievedBpp = achievedVideoBps / (out.width * out.height * fps);
  const predictedBytes = Math.ceil(probeBytes * (durationSec / probeSecs)) + Math.ceil(audioBytes || 0);
  return { predictedBytes, achievedVideoBps, achievedBpp };
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
