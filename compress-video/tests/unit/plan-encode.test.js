// compress-video/tests/unit/plan-encode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planEncode, bandForBpp, evenDim, scaleToHeight, muxOverheadBytes,
  SAFETY, FLOOR_VIDEO_BPS, BANDS, STANDARD_HEIGHTS,
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
