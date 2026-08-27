// compress-video/tests/unit/plan-encode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planEncode, bandForBpp, evenDim, scaleToHeight, muxOverheadBytes,
  SAFETY, FLOOR_VIDEO_BPS, FLOOR_BPP, BANDS, STANDARD_HEIGHTS,
  correctedBitrate, chooseAuto, predictFromProbe,
  resolveAudio, AUDIO_STEPS, FLOOR_AUDIO_BPS,
} from '../../js/plan-encode.js';

test('evenDim rounds to the nearest even number, floor 2', () => {
  assert.equal(evenDim(1919.4), 1920);
  assert.equal(evenDim(1080), 1080);
  assert.equal(evenDim(639), 640);
  assert.equal(evenDim(0.4), 2);
});

test('scaleToHeight preserves aspect and never upscales', () => {
  assert.deepEqual(scaleToHeight(1920, 1080, 720), { width: 1280, height: 720 });
  assert.deepEqual(scaleToHeight(1920, 1080, 2160), { width: 1920, height: 1080 });
  // odd source dims come out even
  assert.deepEqual(scaleToHeight(1921, 1081, 1081), { width: 1922, height: 1082 });
});

test('bandForBpp maps thresholds inclusively at the lower bound', () => {
  assert.equal(bandForBpp(0.20).id, 'near-original');
  assert.equal(bandForBpp(0.15).id, 'near-original');
  assert.equal(bandForBpp(0.1499).id, 'good');
  assert.equal(bandForBpp(0.10).id, 'good');
  assert.equal(bandForBpp(0.06).id, 'acceptable');
  assert.equal(bandForBpp(0.0599).id, 'soft');
  assert.equal(bandForBpp(0.03).id, 'soft');
  assert.equal(bandForBpp(0.0299).id, 'blocky');
  assert.equal(bandForBpp(0).id, 'blocky');
});

test('bands are ordered best-to-worst with steps 5..1', () => {
  assert.deepEqual(BANDS.map(b => b.step), [5, 4, 3, 2, 1]);
});

// The worked example from the spec: 60s 1080p30 with 1 MB of audio at a
// 25 MB target lands in "soft" at source res, and 720p fixes it to "good".
const SRC_1080 = {
  targetBytes: 25_000_000, durationSec: 60,
  width: 1920, height: 1080, fps: 30, audioBytes: 1_000_000,
};

test('planEncode: bitrate math is exact', () => {
  const p = planEncode(SRC_1080);
  const budget = Math.floor(25_000_000 * SAFETY) - 1_000_000 - muxOverheadBytes(60);
  assert.equal(p.unreachable, false);
  assert.equal(p.videoBitrate, Math.floor(budget * 8 / 60));
  assert.ok(Number.isInteger(p.videoBitrate) && p.videoBitrate > 0);
  assert.deepEqual(p.out, { width: 1920, height: 1080 });
  assert.ok(Math.abs(p.bpp - p.videoBitrate / (1920 * 1080 * 30)) < 1e-12);
});

test('planEncode: soft at 1080p, suggests 720p which lands good', () => {
  const p = planEncode(SRC_1080);
  assert.equal(p.band.id, 'soft');
  assert.ok(p.suggestion);
  assert.equal(p.suggestion.height, 720);
  assert.equal(p.suggestion.band.id, 'good');
});

test('planEncode: generous target is near-original with no suggestion', () => {
  const p = planEncode({ ...SRC_1080, targetBytes: 200_000_000 });
  assert.equal(p.band.id, 'near-original');
  assert.equal(p.suggestion, null);
});

test('planEncode: explicit outHeight is honored and improves bpp', () => {
  const at1080 = planEncode(SRC_1080);
  const at720 = planEncode(SRC_1080, { outHeight: 720 });
  assert.deepEqual(at720.out, { width: 1280, height: 720 });
  assert.ok(at720.bpp > at1080.bpp);
  assert.equal(at720.videoBitrate, at1080.videoBitrate); // budget unchanged
});

test('planEncode: unreachable when audio alone eats the target', () => {
  const p = planEncode({ ...SRC_1080, targetBytes: 900_000 }); // < audioBytes
  assert.equal(p.unreachable, true);
  assert.ok(p.minTargetBytes > 1_000_000);
  // and the reported minimum is itself reachable
  const retry = planEncode({ ...SRC_1080, targetBytes: p.minTargetBytes });
  assert.equal(retry.unreachable, false);
});

test('planEncode: floor bitrate defines the unreachable boundary', () => {
  const p = planEncode(SRC_1080);
  assert.ok(p.minTargetBytes >= Math.ceil(
    (1_000_000 + muxOverheadBytes(60) + FLOOR_VIDEO_BPS * 60 / 8) / SAFETY) - 1);
});

test('planEncode: throws on nonsense input', () => {
  assert.throws(() => planEncode({ ...SRC_1080, durationSec: 0 }), /plan_invalid_input/);
  assert.throws(() => planEncode({ ...SRC_1080, targetBytes: 0 }), /plan_invalid_input/);
  assert.throws(() => planEncode({ ...SRC_1080, fps: 0 }), /plan_invalid_input/);
});

test('planEncode: missing audio track (audioBytes 0) still plans', () => {
  const p = planEncode({ ...SRC_1080, audioBytes: 0 });
  assert.equal(p.unreachable, false);
  assert.ok(p.videoBitrate > planEncode(SRC_1080).videoBitrate);
});

test('STANDARD_HEIGHTS descend so the first hit is the tallest fix', () => {
  assert.deepEqual([...STANDARD_HEIGHTS], [1080, 720, 480, 360]);
});

// --- Resolution/fps-aware unreachable floor (FLOOR_BPP) -------------------
//
// Field bug: a 178 MB 1080p60 clip promised "10 MB" and produced 22 MB. The
// old FLOOR_VIDEO_BPS (100 kbps flat) never fired because it ignores
// resolution/fps. FLOOR_BPP scales the floor with output pixels x fps.

test('FLOOR_BPP is exported and set to the calibrated floor', () => {
  assert.equal(FLOOR_BPP, 0.005);
});

test('FLOOR_AUDIO_BPS is exported and set to the calibrated floor', () => {
  assert.equal(FLOOR_AUDIO_BPS, 32_000);
});

// The real field case: 178 MB 1080p60 clip, "10 MB" target.
const SRC_FIELD = {
  targetBytes: 10_000_000, durationSec: 150,
  width: 1920, height: 1080, fps: 60, audioBytes: 2_400_000,
};

test('planEncode: field case (1080p60, 10MB/150s) is unreachable at source res, suggests 720p', () => {
  const overhead = muxOverheadBytes(SRC_FIELD.durationSec);
  const budget = Math.floor(SRC_FIELD.targetBytes * SAFETY) - SRC_FIELD.audioBytes - overhead;
  const minVideoBps = Math.max(FLOOR_VIDEO_BPS,
    Math.ceil(FLOOR_BPP * SRC_FIELD.width * SRC_FIELD.height * SRC_FIELD.fps));
  assert.equal(minVideoBps, 622_080); // 0.005 * 1920 * 1080 * 60
  const minVideoBytes = Math.ceil(minVideoBps * SRC_FIELD.durationSec / 8);
  assert.ok(budget < minVideoBytes, 'the requested bitrate must sit under the resolution-aware floor');

  const p = planEncode(SRC_FIELD);
  assert.equal(p.unreachable, true);
  assert.deepEqual(p.out, { width: 1920, height: 1080 });

  const expectedMinTargetBytes = Math.ceil((SRC_FIELD.audioBytes + overhead + minVideoBytes) / SAFETY);
  assert.equal(p.minTargetBytes, expectedMinTargetBytes);

  // Suggestion: tallest standard height below source res that the SAME
  // budget clears against ITS OWN resolution-scaled floor.
  const candidateBitrate = Math.floor(budget * 8 / SRC_FIELD.durationSec);
  const alt720 = scaleToHeight(SRC_FIELD.width, SRC_FIELD.height, 720);
  const floor720 = Math.max(FLOOR_VIDEO_BPS,
    Math.ceil(FLOOR_BPP * alt720.width * alt720.height * SRC_FIELD.fps));
  assert.equal(floor720, 276_480); // 0.005 * 1280 * 720 * 60
  assert.ok(candidateBitrate >= floor720, '720p60 must be reachable at this budget');

  assert.ok(p.suggestion);
  assert.equal(p.suggestion.height, 720);
  assert.deepEqual(
    p.suggestion.band,
    bandForBpp(candidateBitrate / (alt720.width * alt720.height * SRC_FIELD.fps)),
  );
});

test('planEncode: field case rescued by an explicit lower output resolution', () => {
  const p = planEncode(SRC_FIELD, { outHeight: 720 });
  assert.equal(p.unreachable, false);
  assert.deepEqual(p.out, { width: 1280, height: 720 });
});

test('planEncode: field case at fps 30 is reachable at source resolution (fps-aware floor)', () => {
  const src30 = { ...SRC_FIELD, fps: 30 };
  const overhead = muxOverheadBytes(src30.durationSec);
  const budget = Math.floor(src30.targetBytes * SAFETY) - src30.audioBytes - overhead;
  const minVideoBps = Math.max(FLOOR_VIDEO_BPS,
    Math.ceil(FLOOR_BPP * src30.width * src30.height * src30.fps));
  assert.equal(minVideoBps, 311_040); // 0.005 * 1920 * 1080 * 30
  const minVideoBytes = Math.ceil(minVideoBps * src30.durationSec / 8);
  assert.ok(budget >= minVideoBytes, 'the same budget clears the floor at half the fps');

  const p = planEncode(src30);
  assert.equal(p.unreachable, false);
});

test('planEncode: minTargetBytes reported for the unreachable field case is itself reachable', () => {
  const p = planEncode(SRC_FIELD);
  assert.equal(p.unreachable, true);
  const retry = planEncode({ ...SRC_FIELD, targetBytes: p.minTargetBytes });
  assert.equal(retry.unreachable, false);
});

test('planEncode: unreachable with budget <= 0 (audio eats the target) has no suggestion', () => {
  const p = planEncode({ ...SRC_1080, targetBytes: 900_000 });
  assert.equal(p.unreachable, true);
  assert.equal(p.suggestion, null);
});

test('planEncode: SRC_1080 worked example is unaffected by the bpp floor', () => {
  // 25 MB / 60s / 1080p30 sits far above the bpp floor, so behavior must be
  // identical to before this change.
  const p = planEncode(SRC_1080);
  assert.equal(p.unreachable, false);
  assert.equal(p.band.id, 'soft');
});

// --- correctedBitrate: one-shot proportional re-compress -------------------

test('correctedBitrate: null when the encode already met or beat the target', () => {
  assert.equal(correctedBitrate({
    videoBitrate: 3_000_000, actualBytes: 20_000_000, targetBytes: 25_000_000,
    audioBytes: 1_000_000, durationSec: 60,
  }), null);
  // exactly-equal counts as "not over"
  assert.equal(correctedBitrate({
    videoBitrate: 3_000_000, actualBytes: 25_000_000, targetBytes: 25_000_000,
    audioBytes: 1_000_000, durationSec: 60,
  }), null);
});

test('correctedBitrate: proportional correction for an overshoot lands below the input bitrate', () => {
  const r = {
    videoBitrate: 3_093_853, actualBytes: 30_000_000, targetBytes: 25_000_000,
    audioBytes: 1_000_000, durationSec: 60,
  };
  // Pinned, not formula-mirrored: overhead 46,096; achievedVideo 28,953,904;
  // targetVideo 23,203,904 (verified in Node against these exact inputs).
  const b2 = correctedBitrate(r);
  assert.ok(Number.isInteger(b2));
  assert.ok(b2 < r.videoBitrate);
  assert.equal(b2, 2_405_056);
});

test('correctedBitrate: clamps up to FLOOR_VIDEO_BPS when that is still an improvement', () => {
  const r = {
    videoBitrate: 200_000, actualBytes: 200_000_000, targetBytes: 25_000_000,
    audioBytes: 1_000_000, durationSec: 60,
  };
  const overhead = muxOverheadBytes(r.durationSec);
  const achievedVideo = r.actualBytes - r.audioBytes - overhead;
  const targetVideo = Math.floor(r.targetBytes * SAFETY) - r.audioBytes - overhead;
  const rawB2 = Math.floor(r.videoBitrate * (targetVideo / achievedVideo) * SAFETY);
  assert.ok(rawB2 < FLOOR_VIDEO_BPS, 'the scenario must actually exercise the clamp');

  const b2 = correctedBitrate(r);
  assert.equal(b2, FLOOR_VIDEO_BPS);
  assert.ok(b2 < r.videoBitrate);
});

test('correctedBitrate: null when the clamped floor bitrate is not below the input', () => {
  // Same overshoot as above, but the input bitrate was already at/under the
  // floor: clamping to FLOOR_VIDEO_BPS would not lower it, so no correction.
  const r = {
    videoBitrate: 90_000, actualBytes: 200_000_000, targetBytes: 25_000_000,
    audioBytes: 1_000_000, durationSec: 60,
  };
  assert.equal(correctedBitrate(r), null);
});

test('correctedBitrate: null when achievedVideo or targetVideo collapses to zero or negative', () => {
  // achievedVideo <= 0: audio + overhead alone exceeds what was delivered.
  assert.equal(correctedBitrate({
    videoBitrate: 500_000, actualBytes: 1_000_001, targetBytes: 1_000_000,
    audioBytes: 5_000_000, durationSec: 10,
  }), null);
  // targetVideo <= 0: audio + overhead alone exceeds the safety-margined target.
  assert.equal(correctedBitrate({
    videoBitrate: 500_000, actualBytes: 2_000_000, targetBytes: 1_000_000,
    audioBytes: 990_000, durationSec: 10,
  }), null);
});

// --- planEncode: outFps (fps-reduction, tried before the next res drop) --

test('planEncode: outFps reduces the floor and exactly doubles bpp vs the same height at source fps', () => {
  const at480SourceFps = planEncode(SRC_FIELD, { outHeight: 480, outFps: null });
  const at480Reduced = planEncode(SRC_FIELD, { outHeight: 480, outFps: 30 });

  assert.equal(at480SourceFps.unreachable, false);
  assert.equal(at480SourceFps.outFps, null);

  assert.equal(at480Reduced.unreachable, false);
  assert.equal(at480Reduced.outFps, 30);
  // Halving fps exactly doubles bpp (same bitrate, same resolution, half the frames).
  assert.equal(at480Reduced.bpp, at480SourceFps.bpp * 2);
  // The floor is fps-scaled too: a lower effFps means a lower minTargetBytes.
  assert.ok(at480Reduced.minTargetBytes < at480SourceFps.minTargetBytes);
});

test('planEncode: outFps at or above source fps is ignored (never upsamples)', () => {
  assert.equal(planEncode(SRC_FIELD, { outHeight: 480, outFps: 120 }).outFps, null); // above source
  assert.equal(planEncode(SRC_FIELD, { outHeight: 480, outFps: 60 }).outFps, null);  // equal to source
  assert.equal(planEncode(SRC_FIELD, { outHeight: 480, outFps: 0 }).outFps, null);   // falsy/absent-like
});

test('planEncode: outFps at source resolution improves the quality band (1080p30 vs 1080p60)', () => {
  const src60 = { targetBytes: 25_000_000, durationSec: 60, width: 1920, height: 1080, fps: 60, audioBytes: 1_000_000 };
  const at60 = planEncode(src60, { outFps: null });
  const at30 = planEncode(src60, { outFps: 30 });
  assert.equal(at60.unreachable, false);
  assert.equal(at30.unreachable, false);
  assert.equal(at30.outFps, 30);
  assert.equal(at30.bpp, at60.bpp * 2);
  assert.equal(at60.band.id, 'blocky');
  assert.equal(at30.band.id, 'soft');
  assert.ok(at30.band.step > at60.band.step);
});

// --- chooseAuto: pure resolution+fps pick for "Auto (best fit)" ----------
//
// Signature note: chooseAuto(src, opts) reads targetBytes FROM src (like
// planEncode), fixing the reviewer-flagged asymmetry in the old
// chooseAutoHeight(src, targetBytes). SRC_1080 and SRC_FIELD already carry
// their own targetBytes field, so most calls below need no override.

test('chooseAuto: generous target keeps source resolution and source fps', () => {
  const pick = chooseAuto({ ...SRC_1080, targetBytes: 200_000_000 });
  assert.deepEqual(pick, { height: 1080, fps: null, audio: 'copy' });
});

test('chooseAuto: SRC_1080 worked example (25MB, fps 30 < 40 so no fps candidates) picks 720p/source-fps', () => {
  const pick = chooseAuto(SRC_1080);
  assert.deepEqual(pick, { height: 720, fps: null, audio: 'copy' });
});

test('chooseAuto: field case (1080p60, 10MB/150s) trims audio to reach 360p/30fps at acceptable', () => {
  // Behaviour change accepted by Dan 2026-08-26: the answer here was
  // { height: 480, fps: 30 } until Auto could spend the audio budget. This
  // is NOT a regression papered over — the walk below shows why it moved.
  //
  // With the audio copied, the full pair walk (height desc, fps [source,
  // 30] within each height), all via planEncode so the test can't drift
  // from the implementation's floor:
  //   1080/null unreachable | 1080/30 blocky | 720/null blocky | 720/30 blocky
  //   480/null blocky       | 480/30  SOFT    | 360/null blocky | 360/30 soft
  // Tier 1 (step>=3): none. Tier 2 (step>=2): first hit is 480/30, at bpp
  // 0.031 — and that is the best ANY setting reaches while audio is copied.
  const heights = [1080, 720, 480, 360];
  const fpsCands = [null, 30]; // SRC_FIELD.fps (60) >= 40
  let firstTier2 = null;
  for (const h of heights) {
    for (const f of fpsCands) {
      const p = planEncode(SRC_FIELD, { outHeight: h, outFps: f, audio: 'copy' });
      if (!p.unreachable && p.band.step >= 2) { firstTier2 = { height: h, fps: p.outFps }; break; }
    }
    if (firstTier2) break;
  }
  assert.deepEqual(firstTier2, { height: 480, fps: 30 });

  // 360p30 misses "acceptable" by a hair at copy — bpp 0.05549 against the
  // 0.06 line — so the clip sits a whole band down for the sake of 600 KB.
  // Dropping the audio to 96 kbps frees exactly that, lifting 360p30 to
  // 0.06011, and tier 1 then outranks tier 2: the acceptable 360p beats the
  // soft 480p. The band crossing is narrow, but the picture gain behind it
  // is not — 0.060 bpp is nearly double 480p30's 0.031.
  const at360Copy = planEncode(SRC_FIELD, { outHeight: 360, outFps: 30, audio: 'copy' });
  const at360Trimmed = planEncode(SRC_FIELD, { outHeight: 360, outFps: 30, audio: '96k' });
  const at480Copy = planEncode(SRC_FIELD, { outHeight: 480, outFps: 30, audio: 'copy' });
  assert.equal(at360Copy.band.step, 2);
  assert.equal(at360Trimmed.band.step, 3);
  assert.ok(at360Trimmed.bpp > at480Copy.bpp * 1.9, 'the trimmed 360p must buy nearly double the bpp of the copy-audio 480p it replaces');

  const pick = chooseAuto(SRC_FIELD);
  assert.deepEqual(pick, { height: 360, fps: 30, audio: '96k' });
});

test('chooseAuto: nothing reachable — picks the pair with the minimum minTargetBytes', () => {
  // budget <= 0 (900_000 target vs 2.4MB audio + overhead): every (height,
  // fps) pair is unreachable, so tier 4 applies. minTargetBytes doesn't
  // depend on target/budget, so brute-force every candidate directly.
  const src = { ...SRC_FIELD, targetBytes: 900_000 };
  const heights = [1080, 720, 480, 360];
  const fpsCands = [null, 30];
  let min = null;
  for (const h of heights) {
    for (const f of fpsCands) {
      const p = planEncode(src, { outHeight: h, outFps: f });
      assert.equal(p.unreachable, true); // sanity: budget <= 0 means nothing is reachable
      if (min === null || p.minTargetBytes < min.minTargetBytes) min = { height: h, fps: p.outFps, minTargetBytes: p.minTargetBytes };
    }
  }

  // Audio: with nothing reachable at any step, every step's outcome tuple
  // has band 0 and the same height/fps (audioBytes shifts all pairs'
  // minTargetBytes by a constant, so the argmin pair never moves). The
  // tuples therefore all match and the below-acceptable rule takes the most
  // aggressive step — which is also the one with the smallest
  // minTargetBytes, i.e. the closest this clip gets to achievable.
  const pick = chooseAuto(src);
  assert.deepEqual(pick, { height: min.height, fps: min.fps, audio: '64k-mono' });

  // Minor-4 contract: the picked pair's minTargetBytes IS that minimum.
  const picked = planEncode(src, { outHeight: pick.height, outFps: pick.fps });
  assert.equal(picked.minTargetBytes, min.minTargetBytes);
});

const SRC_SMALL = { targetBytes: 5_000_000, durationSec: 60, width: 426, height: 240, fps: 30, audioBytes: 500_000 };

test('chooseAuto: source below the standard ladder has only one height candidate, source fps (< 40)', () => {
  assert.deepEqual(chooseAuto(SRC_SMALL), { height: 240, fps: null, audio: 'copy' });
  // The 200 KB target leaves 240p below acceptable however the budget is
  // split, so the below-acceptable rule hands the picture every spare bit.
  assert.deepEqual(chooseAuto({ ...SRC_SMALL, targetBytes: 200_000 }), { height: 240, fps: null, audio: '64k-mono' });
});

test('chooseAuto: opts.outFps pin (explicit null) forces source fps — reproduces the old chooseAutoHeight answer', () => {
  const pick = chooseAuto(SRC_FIELD, { outFps: null });
  assert.deepEqual(pick, { height: 360, fps: null, audio: '64k-mono' });
});

test('chooseAuto: opts.outHeight pin frees only fps — tier 3 (max bpp) picks the reduced-fps variant', () => {
  // At height 720 fixed: (720,null) is blocky, (720,30) bpp ~0.01387 is also
  // blocky (step 1) — neither clears tier 1/2, so tier 3 (max bpp among
  // reachable) applies and (720,30) wins since it has the higher bpp.
  const p720Source = planEncode(SRC_FIELD, { outHeight: 720, outFps: null });
  const p720Reduced = planEncode(SRC_FIELD, { outHeight: 720, outFps: 30 });
  assert.ok(!p720Source.unreachable && p720Source.band.step < 2);
  assert.ok(!p720Reduced.unreachable && p720Reduced.band.step < 2);
  assert.ok(p720Reduced.bpp > p720Source.bpp);

  const pick = chooseAuto(SRC_FIELD, { outHeight: 720 });
  assert.deepEqual(pick, { height: 720, fps: 30, audio: '64k-mono' });
});

test('chooseAuto: contract with planEncode — the auto choice is always encodable when any candidate is', () => {
  const cases = [
    { ...SRC_1080, targetBytes: 200_000_000 },
    SRC_1080,
    SRC_FIELD,
  ];
  for (const src of cases) {
    const pick = chooseAuto(src);
    const p = planEncode(src, { outHeight: pick.height, outFps: pick.fps });
    assert.equal(p.unreachable, false,
      `pick=${JSON.stringify(pick)} should be reachable for targetBytes=${src.targetBytes}`);
  }
});

test('chooseAuto: throws on nonsense input', () => {
  assert.throws(() => chooseAuto({ ...SRC_1080, fps: 0 }), /plan_invalid_input/);
  assert.throws(() => chooseAuto({ ...SRC_1080, durationSec: 0 }), /plan_invalid_input/);
  assert.throws(() => chooseAuto({ ...SRC_1080, targetBytes: 0 }), /plan_invalid_input/);
});

// --- planEncode/chooseAuto: opts.floorBpp (calibration-probe override) ---
//
// FLOOR_BPP (0.005) is a guessed floor; a calibration probe measures the
// encoder's REAL content-dependent floor, which is usually much higher.
// opts.floorBpp lets a caller substitute that measured value everywhere
// FLOOR_BPP would otherwise apply, with no other change to the math.

test('planEncode: floorBpp override makes the SRC_1080 worked example unreachable', () => {
  const overhead = muxOverheadBytes(SRC_1080.durationSec);
  const budget = Math.floor(SRC_1080.targetBytes * SAFETY) - SRC_1080.audioBytes - overhead;
  const floorBpp = 0.08;
  const minVideoBps = Math.max(FLOOR_VIDEO_BPS,
    Math.ceil(floorBpp * SRC_1080.width * SRC_1080.height * SRC_1080.fps));
  assert.equal(minVideoBps, 4_976_640); // 0.08 * 1920 * 1080 * 30
  const minVideoBytes = Math.ceil(minVideoBps * SRC_1080.durationSec / 8);
  assert.ok(budget < minVideoBytes, 'the ~3.1 Mbps plan budget must sit under the measured-floor minimum');

  const p = planEncode(SRC_1080, { floorBpp });
  assert.equal(p.unreachable, true);
  assert.deepEqual(p.out, { width: 1920, height: 1080 });

  const expectedMinTargetBytes = Math.ceil((SRC_1080.audioBytes + overhead + minVideoBytes) / SAFETY);
  assert.equal(p.minTargetBytes, expectedMinTargetBytes);

  // Suggestion must also be computed at the MEASURED floor, not FLOOR_BPP.
  const candidateBitrate = Math.floor(budget * 8 / SRC_1080.durationSec);
  const alt720 = scaleToHeight(SRC_1080.width, SRC_1080.height, 720);
  const floor720 = Math.max(FLOOR_VIDEO_BPS, Math.ceil(floorBpp * alt720.width * alt720.height * SRC_1080.fps));
  assert.ok(candidateBitrate >= floor720, '720p must clear the measured floor for this budget');
  assert.ok(p.suggestion);
  assert.equal(p.suggestion.height, 720);
  assert.deepEqual(
    p.suggestion.band,
    bandForBpp(candidateBitrate / (alt720.width * alt720.height * SRC_1080.fps)),
  );
});

test('planEncode: floorBpp <= 0, absent, or non-finite falls back to FLOOR_BPP', () => {
  const base = planEncode(SRC_1080);
  assert.deepEqual(planEncode(SRC_1080, { floorBpp: 0 }), base);
  assert.deepEqual(planEncode(SRC_1080, { floorBpp: -5 }), base);
  assert.deepEqual(planEncode(SRC_1080, { floorBpp: NaN }), base);
  assert.deepEqual(planEncode(SRC_1080, { floorBpp: Infinity }), base);
  assert.deepEqual(planEncode(SRC_1080, {}), base);
});

test('chooseAuto: a high floorBpp can force a lower pick than the default floor gives', () => {
  const defaultPick = chooseAuto(SRC_1080);
  assert.deepEqual(defaultPick, { height: 720, fps: null, audio: 'copy' }); // FLOOR_BPP never blocks this

  const floorBpp = 0.15; // above the ~0.1119 bpp at which 720p stops clearing this budget
  const measuredPick = chooseAuto(SRC_1080, { floorBpp });
  assert.deepEqual(measuredPick, { height: 480, fps: null, audio: 'copy' });
  assert.ok(measuredPick.height < defaultPick.height, 'the measured floor must push the pick to a smaller resolution');

  // The contract that makes the feature useful: what it picks is reachable
  // under that SAME floor (not just under the old, too-optimistic default).
  const check = planEncode(SRC_1080, { outHeight: measuredPick.height, outFps: measuredPick.fps, floorBpp });
  assert.equal(check.unreachable, false);
});

// --- predictFromProbe: turn a calibration probe into a full-encode prediction ---

const PROBE = {
  probeBytes: 144_750, probeSecs: 2, durationSec: 180,
  audioBytes: 500_000, out: { width: 640, height: 360 }, fps: 30,
};

test('predictFromProbe: exact arithmetic', () => {
  const r = predictFromProbe(PROBE);
  assert.equal(r.achievedVideoBps, 579_000); // round(144750 * 8 / 2)
  assert.equal(r.achievedBpp, 579_000 / (640 * 360 * 30));
  assert.equal(r.predictedBytes, 13_527_500); // ceil(144750 * (180/2)) + ceil(500000)
});

test('predictFromProbe: audioBytes is added on top of the extrapolated video bytes', () => {
  const withAudio = predictFromProbe(PROBE);
  const withoutAudio = predictFromProbe({ ...PROBE, audioBytes: 0 });
  assert.equal(withAudio.predictedBytes - withoutAudio.predictedBytes, Math.ceil(PROBE.audioBytes));
  // The video-only extrapolation itself is unaffected by audioBytes.
  assert.equal(withAudio.achievedVideoBps, withoutAudio.achievedVideoBps);
  assert.equal(withAudio.achievedBpp, withoutAudio.achievedBpp);
});

test('predictFromProbe: achievedBpp scales inversely with the effective fps (exactly 2x at half fps)', () => {
  const at30 = predictFromProbe({ ...PROBE, fps: 30 });
  const at60 = predictFromProbe({ ...PROBE, fps: 60 });
  assert.equal(at30.achievedVideoBps, at60.achievedVideoBps); // fps doesn't affect the measured bitrate itself
  assert.equal(at30.achievedBpp, at60.achievedBpp * 2);
});

test('predictFromProbe: throws on invalid input', () => {
  assert.throws(() => predictFromProbe({ ...PROBE, probeSecs: 0 }), /probe_invalid_input/);
  assert.throws(() => predictFromProbe({ ...PROBE, durationSec: 0 }), /probe_invalid_input/);
  assert.throws(() => predictFromProbe({ ...PROBE, fps: 0 }), /probe_invalid_input/);
  assert.throws(() => predictFromProbe({ ...PROBE, out: { width: 0, height: 360 } }), /probe_invalid_input/);
  assert.throws(() => predictFromProbe({ ...PROBE, out: { width: 640, height: 0 } }), /probe_invalid_input/);
  assert.throws(() => predictFromProbe({ ...PROBE, out: null }), /probe_invalid_input/);
  assert.throws(() => predictFromProbe({ ...PROBE, probeBytes: -1 }), /probe_invalid_input/);
});

test('round trip: a measured floor from predictFromProbe feeds chooseAuto to a pair planEncode confirms reachable', () => {
  // SRC_1080's default plan (FLOOR_BPP = 0.005) is reachable...
  const defaultPlan = planEncode(SRC_1080);
  assert.equal(defaultPlan.unreachable, false);

  // ...but a calibration probe on real content measures a MUCH higher floor.
  const probeResult = predictFromProbe(PROBE);
  assert.ok(probeResult.achievedBpp > FLOOR_BPP * 10, 'the probe must measure a floor far above the guessed default');

  const pick = chooseAuto(SRC_1080, { floorBpp: probeResult.achievedBpp });
  const confirmed = planEncode(SRC_1080, {
    outHeight: pick.height, outFps: pick.fps, floorBpp: probeResult.achievedBpp,
  });
  assert.equal(confirmed.unreachable, false);
});

// --- resolveAudio: audio step -> what to ask the encoder for, and its cost --
//
// 100s so bytes math is easy to eyeball: bps × 100 / 8 = bps × 12.5
const AUDIO_BASE = {
  hasAudio: true, durationSec: 100, audioBytes: 1_600_000,
  audioBitrate: 128_000, audioCopyable: true,
};

test('resolveAudio: no audio track resolves to zero bytes, copy mode', () => {
  const a = resolveAudio({ hasAudio: false, durationSec: 100 }, 'copy');
  assert.equal(a.mode, 'copy');
  assert.equal(a.id, 'copy');
  assert.equal(a.bps, null);
  assert.equal(a.bytes, 0);
});

test('resolveAudio: no audio track does not require durationSec (sparse srcs stay legal)', () => {
  assert.doesNotThrow(() => resolveAudio({ hasAudio: false }, 'copy'));
});

test('resolveAudio: none removes the track: zero bytes, remove mode', () => {
  const a = resolveAudio(AUDIO_BASE, 'none');
  assert.equal(a.mode, 'remove');
  assert.equal(a.id, 'none');
  assert.equal(a.bps, 0);
  assert.equal(a.bytes, 0);
});

test('resolveAudio: copy on a carriable codec keeps the measured bytes exactly', () => {
  const a = resolveAudio(AUDIO_BASE, 'copy');
  assert.equal(a.mode, 'copy');
  assert.equal(a.id, 'copy');
  assert.equal(a.bps, null);
  assert.equal(a.bytes, 1_600_000);
});

test('resolveAudio: a negative measured audioBytes clamps to zero rather than inflating the budget', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioBytes: -5 }, 'copy');
  assert.equal(a.mode, 'copy');
  assert.equal(a.bytes, 0);
});

test('resolveAudio: copy on an uncarriable codec becomes a forced re-encode at min(source, 128k)', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioCopyable: false, audioBitrate: 192_000, audioBytes: 2_400_000 }, 'copy');
  assert.equal(a.mode, 'encode');
  assert.equal(a.id, 'copy');
  assert.equal(a.bps, 128_000);
  assert.equal(a.bytes, 1_600_000); // 128000 × 100 / 8
});

test('resolveAudio: forced transcode is flagged forced:true; a normal copy is not', () => {
  const forced = resolveAudio({ ...AUDIO_BASE, audioCopyable: false, audioBitrate: 192_000, audioBytes: 2_400_000 }, 'copy');
  assert.equal(forced.forced, true);
  const normal = resolveAudio(AUDIO_BASE, 'copy');
  assert.ok(!normal.forced);
});

test('resolveAudio: forced transcode never asks below FLOOR_AUDIO_BPS (AMR-NB-like 8kbps source)', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioCopyable: false, audioBitrate: 8_000, audioBytes: 100_000 }, 'copy');
  assert.equal(a.mode, 'encode');
  assert.equal(a.bps, FLOOR_AUDIO_BPS);
  assert.equal(a.bytes, Math.ceil(FLOOR_AUDIO_BPS * AUDIO_BASE.durationSec / 8));
});

test('resolveAudio: a forced transcode clamps up to the MEASURED floor, not the constant', () => {
  // Uncarriable codec + a source below the browser's measured floor. Asking
  // for 64k on a 96k-floor engine gets the config rejected and the track
  // discarded, so the forced transcode must clamp to the measurement.
  const a = resolveAudio(
    { ...AUDIO_BASE, audioCopyable: false, audioBitrate: 64_000, audioFloorBps: 96_000 },
    'copy',
  );
  assert.equal(a.mode, 'encode');
  assert.equal(a.forced, true);
  assert.equal(a.bps, 96_000);
});

test('resolveAudio: a bitrate step also floors at FLOOR_AUDIO_BPS when the (uncarriable) source is even lower', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioCopyable: false, audioBitrate: 8_000, audioBytes: 100_000 }, '64k-mono');
  assert.equal(a.mode, 'encode');
  assert.equal(a.bps, FLOOR_AUDIO_BPS);
});

test('resolveAudio: a bitrate step encodes at that rate: 96k stereo', () => {
  const a = resolveAudio(AUDIO_BASE, '96k');
  assert.equal(a.mode, 'encode');
  assert.equal(a.id, '96k');
  assert.equal(a.bps, 96_000);
  assert.equal(a.channels, null);
  assert.equal(a.bytes, 1_200_000);
});

test('resolveAudio: 64k-mono carries channels: 1', () => {
  const a = resolveAudio(AUDIO_BASE, '64k-mono');
  assert.equal(a.id, '64k-mono');
  assert.equal(a.bps, 64_000);
  assert.equal(a.channels, 1);
  assert.equal(a.bytes, 800_000);
});

test('resolveAudio: a step at or above the source bitrate collapses to copy (never upsample)', () => {
  const a = resolveAudio(AUDIO_BASE, '128k'); // source is exactly 128k
  assert.equal(a.mode, 'copy');
  assert.equal(a.id, 'copy');
  assert.equal(a.bps, null);
  assert.equal(a.bytes, 1_600_000);
});

test('resolveAudio: unknown source bitrate does NOT collapse a step to copy', () => {
  // srcBps must read as "could be arbitrarily high", not "0" — otherwise
  // every step looks like it beats the source and the feature no-ops.
  // probeFile does report audioBitrate now, so this is no longer the shape
  // of every real file — but it is still the shape of every SPARSE src:
  // unit fixtures, and any caller assembling a src by hand. The Infinity
  // sentinel is what keeps those from silently no-opping, so it stays
  // pinned here.
  const a = resolveAudio({ hasAudio: true, durationSec: 100, audioBytes: 1_600_000 }, '128k');
  assert.equal(a.mode, 'encode');
  assert.equal(a.id, '128k');
  assert.equal(a.bps, 128_000);
  assert.equal(a.bytes, 1_600_000);
});

test('resolveAudio: capability fields absent default to permissive (audioFloorBps unset still reaches encode)', () => {
  const a = resolveAudio({ hasAudio: true, durationSec: 100, audioBytes: 1_600_000, audioBitrate: 128_000 }, '96k');
  assert.equal(a.mode, 'encode');
  assert.equal(a.bps, 96_000);
});

test('resolveAudio: on an uncarriable codec a step clamps to the source bitrate instead', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioCopyable: false, audioBitrate: 96_000, audioBytes: 1_200_000 }, '128k');
  assert.equal(a.mode, 'encode');
  assert.equal(a.id, '128k');
  assert.equal(a.bps, 96_000);
});

test('resolveAudio: no AAC encoder at all (audioFloorBps: null): bitrate steps degrade to the copy resolution', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioFloorBps: null }, '96k');
  assert.equal(a.mode, 'copy');
  assert.equal(a.id, 'copy');
  assert.equal(a.bps, null);
  assert.equal(a.bytes, 1_600_000);
});

test('resolveAudio: no encoder AND uncarriable codec: the audio cannot be kept at all', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioFloorBps: null, audioCopyable: false }, 'copy');
  assert.equal(a.mode, 'remove');
  assert.equal(a.id, 'copy');
  assert.equal(a.bps, 0);
  assert.equal(a.bytes, 0);
});

test('resolveAudio: the compound-corner drop is also flagged forced:true (id still reads copy)', () => {
  // Same corner as above: without forced:true a caller reading `id` alone
  // would see 'copy' while the track is actually being dropped entirely.
  const a = resolveAudio({ ...AUDIO_BASE, audioFloorBps: null, audioCopyable: false }, 'copy');
  assert.equal(a.forced, true);
  // Reached via recursion from a bitrate step too (not just an explicit 'copy').
  const viaStep = resolveAudio({ ...AUDIO_BASE, audioFloorBps: null, audioCopyable: false }, '96k');
  assert.equal(viaStep.mode, 'remove');
  assert.equal(viaStep.forced, true);
});

// --- resolveAudio: audioFloorBps (measured per-browser AAC floor) ----------
//
// Chromium 148 measured 2026-08-26: AAC rejects any bitrate below 96 kbps
// (mono or stereo), so '64k-mono' (bps 64_000) is unusable there even
// though the browser CAN encode AAC. A single "can encode AAC" boolean
// can't express that; audioFloorBps carries the actual measured number.

test('resolveAudio: a rung below the measured floor collapses to copy rather than being clamped up', () => {
  // '64k-mono' asks for 64_000 bps; a measured floor of 96_000 makes that
  // rung undeliverable AT ITS LABEL. Clamping bps up to 96_000 while still
  // reporting id:'64k-mono' would show a number the encoder never targets
  // and silently disagree with the byte accounting, so it must fall all
  // the way back to copy instead — same shape as the whole-codec-off case.
  const a = resolveAudio({ ...AUDIO_BASE, audioFloorBps: 96_000 }, '64k-mono');
  assert.equal(a.mode, 'copy');
  assert.equal(a.id, 'copy');
  assert.equal(a.bps, null);
  assert.equal(a.bytes, 1_600_000);
});

test('resolveAudio: a rung exactly AT the measured floor is admitted (boundary)', () => {
  const a = resolveAudio({ ...AUDIO_BASE, audioFloorBps: 96_000 }, '96k');
  assert.equal(a.mode, 'encode');
  assert.equal(a.id, '96k');
  assert.equal(a.bps, 96_000);
  assert.equal(a.bytes, 1_200_000);
});

test('resolveAudio: audioFloorBps: null still collapses every AUDIO_STEPS rung to copy, not just one', () => {
  for (const step of AUDIO_STEPS) {
    if (step.id === 'copy') continue;
    const a = resolveAudio({ ...AUDIO_BASE, audioFloorBps: null }, step.id);
    assert.equal(a.mode, 'copy', `${step.id} should collapse to copy`);
    assert.equal(a.id, 'copy');
  }
});

test('resolveAudio: hasAudio absent is inferred from audioBytes (legacy srcs keep working)', () => {
  const a = resolveAudio({ durationSec: 100, audioBytes: 500_000 }, 'copy');
  assert.equal(a.id, 'copy');
  assert.equal(a.bytes, 500_000);
});

test('resolveAudio: missing durationSec throws instead of silently producing NaN bytes', () => {
  assert.throws(() => resolveAudio({ hasAudio: true, audioBytes: 1_600_000 }, 'copy'), /plan_invalid_input/);
});

test('resolveAudio: an unknown step id throws plan_invalid_input', () => {
  assert.throws(() => resolveAudio(AUDIO_BASE, 'surround'), /plan_invalid_input/);
});

test('AUDIO_STEPS: ladder order is pinned (chooseAuto\'s back-off depends on it, Task 3)', () => {
  assert.deepEqual(AUDIO_STEPS.map(s => s.id), ['copy', '128k', '96k', '64k-mono']);
});

test('resolveAudio: fractional byte costs round up (96k over a non-round duration)', () => {
  // 96000 bps * 10.0001s / 8 = 120001.2 exactly; ceil'd to 120002.
  // Literal computed by running: node -e "console.log(Math.ceil(96000*10.0001/8))"
  const a = resolveAudio({ hasAudio: true, durationSec: 10.0001, audioBytes: 0, audioBitrate: 128_000 }, '96k');
  assert.equal(a.bytes, 120_002);
});

// ---------- planEncode: audio choice ----------------------------------------

const AUDIO_SRC = {
  targetBytes: 10_485_760, durationSec: 100, width: 1280, height: 720,
  fps: 30, audioBytes: 1_600_000, audioBitrate: 128_000,
  hasAudio: true, audioCopyable: true,
};

test('a lower audio step hands its exact savings to the video bitrate', () => {
  const copy = planEncode(AUDIO_SRC, {});
  const mono = planEncode(AUDIO_SRC, { audio: '64k-mono' });
  // 1_600_000 − 800_000 saved bytes × 8 / 100s = exactly 64_000 bps
  assert.equal(mono.videoBitrate - copy.videoBitrate, 64_000);
});

test('planEncode returns the resolved audio step and its planned bytes', () => {
  const p = planEncode(AUDIO_SRC, { audio: '64k-mono' });
  assert.equal(p.audio.id, '64k-mono');
  assert.equal(p.audio.mode, 'encode');
  assert.equal(p.audioBytes, 800_000);
});

test('planEncode default is copy: audioBytes equals the measured source bytes', () => {
  const p = planEncode(AUDIO_SRC, {});
  assert.equal(p.audio.mode, 'copy');
  assert.equal(p.audioBytes, 1_600_000);
});

test('minTargetBytes falls when the audio track is removed', () => {
  const tiny = { ...AUDIO_SRC, targetBytes: 1 };
  const withAudio = planEncode(tiny, {});
  const without = planEncode(tiny, { audio: 'none' });
  assert.ok(withAudio.unreachable && without.unreachable);
  assert.ok(without.minTargetBytes < withAudio.minTargetBytes);
  assert.equal(without.audioBytes, 0);
});

test('an unreachable plan still reports its audio decision', () => {
  const p = planEncode({ ...AUDIO_SRC, targetBytes: 1 }, { audio: '64k-mono' });
  assert.equal(p.unreachable, true);
  assert.equal(p.audio.id, '64k-mono');
  assert.equal(p.audioBytes, 800_000);
});

// ---------- chooseAuto: audio back-off --------------------------------------

test('trivial audio share at Acceptable-or-better: audio untouched', () => {
  // 1080p30, 60s, 128kbps audio (960 KB of a 40 MB target = 2.3%).
  // copy and 64k-mono both land step 3 at 1080p — equal tuple at step >= 3,
  // so the mildest wins.
  const src = {
    targetBytes: 41_943_040, durationSec: 60, width: 1920, height: 1080,
    fps: 30, audioBytes: 960_000, audioBitrate: 128_000,
    hasAudio: true, audioCopyable: true,
  };
  const pick = chooseAuto(src);
  assert.equal(pick.audio, 'copy');
  assert.equal(pick.height, 1080);
});

test('picks the mildest step that buys the better band', () => {
  // 1080p30, 120s, 256kbps audio, 100 MB target. copy lands at
  // bpp 0.09974 (step 3); every reduction crosses 0.10 into step 4.
  // Mildest step matching the aggressive outcome: '128k'.
  const src = {
    targetBytes: 100_000_000, durationSec: 120, width: 1920, height: 1080,
    fps: 30, audioBytes: 3_840_000, audioBitrate: 256_000,
    hasAudio: true, audioCopyable: true,
  };
  const pick = chooseAuto(src);
  assert.equal(pick.audio, '128k');
  assert.equal(pick.height, 1080);
});

test('below Acceptable, crushes audio even when the band label cannot move', () => {
  // The spec's flagship case: 5 min, 720p30, 128kbps audio, 10 MB target.
  // Both copy and 64k-mono end Blocky at 360p (equal tuple), but 64k-mono
  // buys ~46% more video bitrate — below step 3 the rule takes the most
  // aggressive equal-tuple step.
  const src = {
    targetBytes: 10_485_760, durationSec: 300, width: 1280, height: 720,
    fps: 30, audioBytes: 4_800_000, audioBitrate: 128_000,
    hasAudio: true, audioCopyable: true,
  };
  const pick = chooseAuto(src);
  assert.equal(pick.audio, '64k-mono');
  assert.equal(pick.height, 360);
  assert.notEqual(pick.audio, 'none'); // Auto never removes the track
});

test('flagship case under Chromium\'s real measured audio floor: 96k replaces 64k-mono', () => {
  // Same fixture as the test above, but with the audio floor Chromium 148
  // actually measures (96 kbps — see engine.js's probeAudioFloorBps and
  // its dated comment). '64k-mono' collapses to copy under that floor, so
  // it never enters chooseAuto's ladder; '96k' is the mildest step that
  // still frees any bytes. Height is unaffected (still 360p, still
  // Blocky) — only the audio choice and the bitrate it buys change.
  const src = {
    targetBytes: 10_485_760, durationSec: 300, width: 1280, height: 720,
    fps: 30, audioBytes: 4_800_000, audioBitrate: 128_000,
    hasAudio: true, audioCopyable: true, audioFloorBps: 96_000,
  };
  const pick = chooseAuto(src);
  assert.equal(pick.audio, '96k');
  assert.notEqual(pick.audio, '64k-mono');
  assert.equal(pick.height, 360);

  // Verified 2026-08-26: video bitrate drops from 201,522 bps (64k-mono
  // available) to 169,522 bps (96k is the floor) — 32,000 bps less picture,
  // exactly the extra 1,200,000 audio bytes this rung costs over 300s.
  const plan = planEncode(src, { outHeight: pick.height, outFps: pick.fps, audio: pick.audio });
  assert.equal(plan.videoBitrate, 169_522);
  assert.equal(plan.audio.bps, 96_000);
  assert.equal(plan.audioBytes, 3_600_000);
  assert.equal(plan.band.id, 'blocky');
});

test('a manual audio pin restricts the search to that step', () => {
  const src = {
    targetBytes: 10_485_760, durationSec: 300, width: 1280, height: 720,
    fps: 30, audioBytes: 4_800_000, audioBitrate: 128_000,
    hasAudio: true, audioCopyable: true,
  };
  assert.equal(chooseAuto(src, { audio: 'copy' }).audio, 'copy');
  assert.equal(chooseAuto(src, { audio: 'none' }).audio, 'none');
});

test('without an AAC encoder Auto only considers copy', () => {
  const src = {
    targetBytes: 10_485_760, durationSec: 300, width: 1280, height: 720,
    fps: 30, audioBytes: 4_800_000, audioBitrate: 128_000,
    hasAudio: true, audioCopyable: true, audioFloorBps: null,
  };
  assert.equal(chooseAuto(src).audio, 'copy');
});

test('a silent source reports copy even below Acceptable', () => {
  // The target is deliberately tight enough to land below step 3, so the
  // below-Acceptable branch runs. That branch takes the MOST aggressive
  // matching step, so a silent source that wrongly entered the ladder would
  // come back '64k-mono' — audio steps on a file with no audio track all
  // resolve to 0 bytes and therefore all tie.
  const src = {
    targetBytes: 2_000_000, durationSec: 60, width: 1920, height: 1080,
    fps: 30, audioBytes: 0, hasAudio: false,
  };
  const pick = chooseAuto(src);
  assert.equal(pick.audio, 'copy');
  const p = planEncode(src, { outHeight: pick.height, outFps: pick.fps });
  assert.ok(p.unreachable || p.band.step < 3, 'the fixture must exercise the below-Acceptable branch');
});

test('Auto never removes the track even when removal alone buys a whole band', () => {
  // 360p30, 10s, 128kbps audio, 600 KB target. Audio is a big enough share
  // here that dropping it entirely lifts the picture from Noticeably soft
  // (step 2) to Acceptable (step 3) — a strictly better outcome tuple than
  // ANY allowed step reaches. Auto must still refuse: removing the track is
  // a deliberate user choice, enforced by 'none' being absent from
  // AUDIO_STEPS. It takes the most aggressive allowed step instead.
  const src = {
    targetBytes: 600_000, durationSec: 10, width: 640, height: 360,
    fps: 30, audioBytes: 160_000, audioBitrate: 128_000,
    hasAudio: true, audioCopyable: true,
  };
  // The premise: every allowed step is stuck at step 2, 'none' reaches step 3.
  for (const id of AUDIO_STEPS.map(s => s.id)) {
    const p = planEncode(src, { audio: id });
    assert.equal(p.unreachable, false);
    assert.equal(p.band.step, 2, `${id} must be stuck below Acceptable for this test to mean anything`);
  }
  const removed = planEncode(src, { audio: 'none' });
  assert.equal(removed.band.step, 3, 'removing the track must demonstrably reach a better band');

  const pick = chooseAuto(src);
  assert.equal(pick.audio, '64k-mono');
  assert.equal(pick.height, 360);
});

test('the ladder skips rungs that would COST more than copy (unknown source bitrate)', () => {
  // 720p30, 60s, a ~32 kbps track measured at 240 KB, and NO audioBitrate.
  // probeFile reports one now, so this is the SPARSE-src shape — unit
  // fixtures and any hand-assembled caller — not a real probed file. The
  // ladder filter still has to hold for them, because nothing in the type
  // makes audioBitrate required. srcBps is
  // then Infinity, so resolveAudio's never-upsample guard can't fire and
  // every rung "downgrades" the audio to something DEARER than the source:
  // 64k-mono costs 480 KB against copy's 240 KB. All four outcomes tie at
  // (2, 360, null), so the below-Acceptable rule would hand the win to the
  // most aggressive rung — spending 240 KB more on audio and taking it out
  // of the picture. Only steps strictly cheaper than copy belong on the
  // ladder.
  const src = {
    targetBytes: 3_000_000, durationSec: 60, width: 1280, height: 720,
    fps: 30, audioBytes: 240_000, hasAudio: true,
  };
  const copyBytes = planEncode(src, { audio: 'copy' }).audioBytes;
  for (const id of ['128k', '96k', '64k-mono']) {
    assert.ok(planEncode(src, { audio: id }).audioBytes > copyBytes,
      `${id} must cost MORE than copy for this fixture to mean anything`);
  }
  // And the cost lands on the picture: copy buys the higher video bitrate.
  assert.ok(planEncode(src, { outHeight: 360, audio: 'copy' }).videoBitrate
    > planEncode(src, { outHeight: 360, audio: '64k-mono' }).videoBitrate);

  assert.equal(chooseAuto(src).audio, 'copy');
});

test('a milder step reaching a better band wins: Auto never trades band 5 for band 3', () => {
  // 4K30, 60s, 320 kbps audio. The tier search is NOT monotone in budget:
  // at copy, 2160p misses Acceptable and the first tier-1 hit is 1080p at
  // band 5 (near-original). Freeing audio bytes lifts 2160p to band 3, and
  // because tier 1 takes the TALLEST qualifying pair, the extra budget
  // DEMOTES the answer from (5, 1080) to (3, 2160). Picking the most
  // aggressive step outright would degrade the audio to land a WORSE band,
  // contradicting the rule that audio only gives way when it buys picture.
  const src = {
    targetBytes: 116_400_000, durationSec: 60, width: 3840, height: 2160,
    fps: 30, audioBytes: 2_400_000, audioBitrate: 320_000,
    hasAudio: true, audioCopyable: true,
  };
  // The premise: copy is band 5 at 1080p, 64k-mono is band 3 at 2160p.
  assert.equal(planEncode(src, { outHeight: 1080, audio: 'copy' }).band.step, 5);
  assert.ok(planEncode(src, { outHeight: 2160, audio: 'copy' }).band.step < 3);
  assert.equal(planEncode(src, { outHeight: 2160, audio: '64k-mono' }).band.step, 3);

  const pick = chooseAuto(src);
  assert.deepEqual(pick, { height: 1080, fps: null, audio: 'copy' });
});

test('an audio pin is recognised by KEY PRESENCE, not truthiness', () => {
  // Relaxing `('audio' in opts)` to `opts.audio` would leave every call
  // working — a pin with a real id still pins, and no key still searches —
  // while silently turning `{audio: undefined}` from a pin into a search.
  // That is the shape a caller hits when it writes
  // `pins.audio = auto ? undefined : sel`, so the mutation would disable
  // the pin exactly where a caller is most likely to reach for it.
  const src = {
    targetBytes: 10_485_760, durationSec: 300, width: 1280, height: 720,
    fps: 30, audioBytes: 4_800_000, audioBitrate: 128_000,
    hasAudio: true, audioCopyable: true,
  };
  assert.equal(chooseAuto(src).audio, '64k-mono');              // no key: search runs
  assert.equal(chooseAuto(src, { audio: undefined }).audio, undefined); // key present: pinned
});

test('the outcome tuple compares HEIGHT, not just band step', () => {
  // 1920x1200p30, 60s, 320 kbps audio. copy tops out at 1200p's smaller
  // sibling 1080p (band 3); trimming audio lets the full 1200p reach band 3
  // too. Same band, more pixels — so the trimmed answer is genuinely
  // better and the tuple must be able to see it. Drop height from the
  // comparison and every step ties at band 3, handing the win to copy at
  // the SHORTER 1080p.
  const src = {
    targetBytes: 33_000_000, durationSec: 60, width: 1920, height: 1200,
    fps: 30, audioBytes: 2_400_000, audioBitrate: 320_000,
    hasAudio: true, audioCopyable: true,
  };
  assert.equal(planEncode(src, { outHeight: 1080, audio: 'copy' }).band.step, 3);
  assert.ok(planEncode(src, { outHeight: 1200, audio: 'copy' }).band.step < 3);
  assert.equal(planEncode(src, { outHeight: 1200, audio: '96k' }).band.step, 3);

  assert.deepEqual(chooseAuto(src), { height: 1200, fps: null, audio: '96k' });
});

test('the outcome tuple compares FPS, not just band step and height', () => {
  // 1080p60, 60s, with audio so heavy (1536 kbps PCM-ish) that trimming it
  // nearly doubles the video bitrate. At copy, 720p only reaches band 3 by
  // giving up half the frames (720/30); trimmed, 720p holds band 3 at the
  // SOURCE frame rate. Same band, same height, twice the motion — visible
  // only if the tuple carries fps.
  const src = {
    targetBytes: 27_000_000, durationSec: 60, width: 1920, height: 1080,
    fps: 60, audioBytes: 11_520_000, audioBitrate: 1_536_000,
    hasAudio: true, audioCopyable: true,
  };
  assert.ok(planEncode(src, { outHeight: 720, outFps: null, audio: 'copy' }).band.step < 3);
  assert.equal(planEncode(src, { outHeight: 720, outFps: 30, audio: 'copy' }).band.step, 3);
  assert.equal(planEncode(src, { outHeight: 720, outFps: null, audio: '128k' }).band.step, 3);

  assert.deepEqual(chooseAuto(src), { height: 720, fps: null, audio: '128k' });
});

test('an unreachable step ranks below every reachable one', () => {
  // 1080p30, 60s, 2.4 MB of audio, 1.35 MB target: copying the audio leaves
  // no reachable pair at any height, while 64k-mono frees enough for 360p.
  // The rank's `unreachable ? 0` sentinel is what lets a reachable band 1
  // (the lowest real step) outrank a whole unreachable search. Reading
  // plan.band.step directly instead would throw on the unreachable branch,
  // where planEncode returns no band at all.
  const src = {
    targetBytes: 1_350_000, durationSec: 60, width: 1920, height: 1080,
    fps: 30, audioBytes: 2_400_000, audioBitrate: 320_000,
    hasAudio: true, audioCopyable: true,
  };
  for (const h of [1080, 720, 480, 360]) {
    assert.equal(planEncode(src, { outHeight: h, audio: 'copy' }).unreachable, true);
  }
  assert.equal(planEncode(src, { outHeight: 360, audio: '64k-mono' }).unreachable, false);

  const pick = chooseAuto(src);
  assert.equal(pick.audio, '64k-mono');
  assert.equal(pick.height, 360);
});

test('mildest-wins walks AUDIO_STEPS in order: a mid-ladder step can win outright', () => {
  // 1080p30, 120s, 320kbps audio, 98 MB target. The 0.10 bpp "Good"
  // boundary falls BETWEEN 128k and 96k: copy (0.09664) and 128k (0.09972)
  // are step 3; 96k (0.100236) and 64k-mono (0.100750) are step 4. The
  // aggressive tuple is (4, 1080, null), matched by 96k and 64k-mono only,
  // and step 4 >= 3 so the mildest of THOSE wins. This is the case that
  // fails if the rule ever collapses to "first step" or "last step".
  const src = {
    targetBytes: 98_000_000, durationSec: 120, width: 1920, height: 1080,
    fps: 30, audioBytes: 4_800_000, audioBitrate: 320_000,
    hasAudio: true, audioCopyable: true,
  };
  assert.equal(planEncode(src, { audio: 'copy' }).band.step, 3);
  assert.equal(planEncode(src, { audio: '128k' }).band.step, 3);
  assert.equal(planEncode(src, { audio: '96k' }).band.step, 4);
  assert.equal(planEncode(src, { audio: '64k-mono' }).band.step, 4);

  const pick = chooseAuto(src);
  assert.equal(pick.audio, '96k');
  assert.notEqual(pick.audio, '128k');    // not the mildest overall
  assert.notEqual(pick.audio, '64k-mono'); // not the most aggressive overall
  assert.equal(pick.height, 1080);
});

test('chooseAuto: a rung that merely TIES copy is not admitted', () => {
  const src = { targetBytes: 4_677_816, durationSec: 314, width: 1920, height: 1080, fps: 24,
    audioBytes: 2_512_000, audioBitrate: 64_000, hasAudio: true, audioCopyable: true };
  assert.equal(chooseAuto(src).audio, 'copy');
});
