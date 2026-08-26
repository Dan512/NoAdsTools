// compress-video/tests/unit/plan-encode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planEncode, bandForBpp, evenDim, scaleToHeight, muxOverheadBytes,
  SAFETY, FLOOR_VIDEO_BPS, FLOOR_BPP, BANDS, STANDARD_HEIGHTS,
  correctedBitrate, chooseAuto, predictFromProbe,
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
  assert.deepEqual(pick, { height: 1080, fps: null });
});

test('chooseAuto: SRC_1080 worked example (25MB, fps 30 < 40 so no fps candidates) picks 720p/source-fps', () => {
  const pick = chooseAuto(SRC_1080);
  assert.deepEqual(pick, { height: 720, fps: null });
});

test('chooseAuto: field case (1080p60, 10MB/150s) now picks 480p/30fps over 360p/source-fps', () => {
  // Full pair walk (height desc, fps [source, 30] within each height), all
  // via planEncode so the test can't drift from the implementation's floor:
  //   1080/null unreachable | 1080/30 blocky | 720/null blocky | 720/30 blocky
  //   480/null blocky       | 480/30  SOFT    | 360/null blocky | 360/30 soft
  // Tier 1 (step>=3): none. Tier 2 (step>=2): first hit is 480/30.
  const heights = [1080, 720, 480, 360];
  const fpsCands = [null, 30]; // SRC_FIELD.fps (60) >= 40
  let firstTier2 = null;
  for (const h of heights) {
    for (const f of fpsCands) {
      const p = planEncode(SRC_FIELD, { outHeight: h, outFps: f });
      if (!p.unreachable && p.band.step >= 2) { firstTier2 = { height: h, fps: p.outFps }; break; }
    }
    if (firstTier2) break;
  }
  assert.deepEqual(firstTier2, { height: 480, fps: 30 });

  const pick = chooseAuto(SRC_FIELD);
  assert.deepEqual(pick, firstTier2);
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

  const pick = chooseAuto(src);
  assert.deepEqual(pick, { height: min.height, fps: min.fps });

  // Minor-4 contract: the picked pair's minTargetBytes IS that minimum.
  const picked = planEncode(src, { outHeight: pick.height, outFps: pick.fps });
  assert.equal(picked.minTargetBytes, min.minTargetBytes);
});

const SRC_SMALL = { targetBytes: 5_000_000, durationSec: 60, width: 426, height: 240, fps: 30, audioBytes: 500_000 };

test('chooseAuto: source below the standard ladder has only one height candidate, source fps (< 40)', () => {
  assert.deepEqual(chooseAuto(SRC_SMALL), { height: 240, fps: null });
  assert.deepEqual(chooseAuto({ ...SRC_SMALL, targetBytes: 200_000 }), { height: 240, fps: null });
});

test('chooseAuto: opts.outFps pin (explicit null) forces source fps — reproduces the old chooseAutoHeight answer', () => {
  const pick = chooseAuto(SRC_FIELD, { outFps: null });
  assert.deepEqual(pick, { height: 360, fps: null });
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
  assert.deepEqual(pick, { height: 720, fps: 30 });
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
  assert.deepEqual(defaultPick, { height: 720, fps: null }); // FLOOR_BPP never blocks this

  const floorBpp = 0.15; // above the ~0.1119 bpp at which 720p stops clearing this budget
  const measuredPick = chooseAuto(SRC_1080, { floorBpp });
  assert.deepEqual(measuredPick, { height: 480, fps: null });
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
