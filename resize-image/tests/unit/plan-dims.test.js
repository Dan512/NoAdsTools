// resize-image/tests/unit/plan-dims.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDimensions } from '../../js/plan-dims.js';

const P = (over) => planDimensions({ mode:'dimensions', aspectLock:true, allowUpscale:false,
  targetW:0, targetH:0, percent:0, nativeW:4000, nativeH:3000, ...over });

test('fit-box: width-only constrains and preserves aspect', () => {
  const r = P({ targetW: 800 });
  assert.deepEqual([r.width, r.height], [800, 600]);
  assert.equal(r.action, 'resized');
});
test('fit-box: height-only constrains', () => {
  const r = P({ targetH: 600 });
  assert.deepEqual([r.width, r.height], [800, 600]);
});
test('fit-box: both → fits inside the box (min scale), preserves aspect', () => {
  const r = P({ targetW: 800, targetH: 800 }); // 4:3 → width-bound
  assert.deepEqual([r.width, r.height], [800, 600]);
});
test('upscale OFF: target larger than native keeps native', () => {
  const r = P({ targetW: 8000 });
  assert.deepEqual([r.width, r.height], [4000, 3000]);
  assert.equal(r.action, 'kept-native');
});
test('upscale ON: enlarges', () => {
  const r = P({ targetW: 8000, allowUpscale: true });
  assert.deepEqual([r.width, r.height], [8000, 6000]);
  assert.equal(r.action, 'enlarged');
});
test('percentage mode scales both dims', () => {
  const r = P({ mode:'percentage', percent: 50 });
  assert.deepEqual([r.width, r.height], [2000, 1500]);
  assert.equal(r.action, 'resized');
});
test('percentage > 100 with upscale OFF keeps native', () => {
  const r = P({ mode:'percentage', percent: 200 });
  assert.deepEqual([r.width, r.height], [4000, 3000]);
  assert.equal(r.action, 'kept-native');
});
test('unlock (exact) forces W×H, flags stretch when aspect differs', () => {
  const r = P({ aspectLock:false, targetW: 800, targetH: 800 });
  assert.deepEqual([r.width, r.height], [800, 800]);
  assert.equal(r.action, 'stretched');
});
test('unlock exact with matching aspect is not flagged stretched', () => {
  const r = P({ aspectLock:false, targetW: 800, targetH: 600 });
  assert.equal(r.action, 'resized');
});
test('never returns a zero or fractional dimension', () => {
  const r = P({ mode:'percentage', percent: 33, nativeW: 1000, nativeH: 1 });
  assert.ok(Number.isInteger(r.width) && r.width >= 1);
  assert.ok(Number.isInteger(r.height) && r.height >= 1);
});
test('fit-box: portrait → height-bound inside the box, preserves aspect', () => {
  const r = P({ nativeW: 3000, nativeH: 4000, targetW: 800, targetH: 800 }); // 3:4 → height-bound
  assert.deepEqual([r.width, r.height], [600, 800]);
  assert.equal(r.action, 'resized');
});
test('fit-box: neither dimension given keeps native (caller-guarded)', () => {
  const r = P({ targetW: 0, targetH: 0 });
  assert.deepEqual([r.width, r.height], [4000, 3000]);
});
test('fit-box: exact-fit (scale === 1) is a plain resize, not kept-native', () => {
  const r = P({ targetW: 4000 }); // 4000/4000 → scale exactly 1
  assert.deepEqual([r.width, r.height], [4000, 3000]);
  assert.equal(r.action, 'resized');
});
