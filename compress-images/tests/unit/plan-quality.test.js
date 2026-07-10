import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchQualityForTarget, savings } from '../../js/plan-quality.js';

// Monotonic synthetic encoder: size grows with quality. sizeAt(q) = q * 1000 bytes.
const sizeAt = (q) => q * 1000;
const enc = (q) => Promise.resolve(sizeAt(q));

test('finds the highest quality whose size fits under the target', async () => {
  const r = await searchQualityForTarget({ encodeAt: enc, targetBytes: 55_000, minQ: 40, maxQ: 95 });
  assert.equal(r.ok, true);
  assert.ok(r.size <= 55_000, 'result under target');
  assert.ok(r.quality >= 40 && r.quality <= 95);
  // highest q with q*1000 <= 55000 is 55; search is bounded so accept within a small band
  assert.ok(r.quality >= 50 && r.quality <= 55, `got q=${r.quality}`);
});

test('unreachable target → best effort at minQ, ok:false', async () => {
  const r = await searchQualityForTarget({ encodeAt: enc, targetBytes: 10_000, minQ: 40, maxQ: 95 });
  assert.equal(r.ok, false);
  assert.equal(r.quality, 40);
  assert.equal(r.size, 40_000);
});

test('bounded pass count (never exceeds maxPasses encode calls)', async () => {
  let calls = 0;
  const counted = (q) => { calls++; return Promise.resolve(sizeAt(q)); };
  await searchQualityForTarget({ encodeAt: counted, targetBytes: 55_000, minQ: 40, maxQ: 95, maxPasses: 7 });
  assert.ok(calls <= 7, `made ${calls} encode calls`);
});

test('savings math', () => {
  assert.deepEqual(savings(1000, 250), { savedBytes: 750, percent: 75 });
  assert.deepEqual(savings(1000, 1000), { savedBytes: 0, percent: 0 });
  // larger-than-original clamps to 0 (caller keeps original)
  assert.deepEqual(savings(1000, 1200), { savedBytes: 0, percent: 0 });
});
