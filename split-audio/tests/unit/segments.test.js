// The cut list is the tool's only editing state: sorted seconds strictly
// inside (0, duration). Everything else (segments, names, row times) derives
// from it, so these pins are what keep the timeline and the table agreeing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SEGMENT_SEC, MAX_CUTS, normalizeCuts, segmentsFromCuts, addCut, removeCut,
  clampCut, cutRange, moveCut, equalParts, everyN, formatTime, parseTime, splitName,
  chunkName, estimateBytes,
} from '../../js/segments.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('normalizeCuts sorts, dedupes, and drops cuts too close to the ends or each other', () => {
  assert.deepEqual(normalizeCuts([2, 1, 1, 0.05, 9.95, NaN], 10), [1, 2]);
  assert.deepEqual(normalizeCuts([1, 1 + MIN_SEGMENT_SEC / 2], 10), [1]);
  assert.deepEqual(normalizeCuts([], 10), []);
  assert.equal(normalizeCuts(Array.from({ length: 5000 }, (_, i) => 1 + i * 0.2), 5000).length, MAX_CUTS);
});

test('segmentsFromCuts covers [0, duration) with no gaps', () => {
  assert.deepEqual(segmentsFromCuts([1, 2.5], 4), [
    { index: 0, start: 0, end: 1 }, { index: 1, start: 1, end: 2.5 }, { index: 2, start: 2.5, end: 4 },
  ]);
  assert.deepEqual(segmentsFromCuts([], 4), [{ index: 0, start: 0, end: 4 }]);
});

test('addCut inserts in order and refuses an invalid position', () => {
  assert.deepEqual(addCut([1, 3], 2, 4), [1, 2, 3]);
  const cuts = [1, 3];
  assert.equal(addCut(cuts, 1.02, 4), cuts, 'too close to an existing cut: same array back');
  assert.equal(addCut(cuts, 0, 4), cuts);
  assert.equal(addCut(cuts, 4, 4), cuts);
});

test('removeCut drops by index', () => {
  assert.deepEqual(removeCut([1, 2, 3], 1), [1, 3]);
});

test('clampCut and moveCut keep a cut between its neighbours by MIN_SEGMENT_SEC', () => {
  near(clampCut([1, 2, 3], 1, 0.5, 4), 1 + MIN_SEGMENT_SEC);
  near(clampCut([1, 2, 3], 1, 3.7, 4), 3 - MIN_SEGMENT_SEC);
  near(clampCut([1, 2, 3], 0, -5, 4), MIN_SEGMENT_SEC);
  near(clampCut([1, 2, 3], 2, 99, 4), 4 - MIN_SEGMENT_SEC);
  assert.deepEqual(moveCut([1, 2, 3], 1, 2.4, 4), [1, 2.4, 3]);
});

test('cutRange never returns an empty range, so clampCut returns a cut at exactly MIN_SEGMENT_SEC spacing unchanged', () => {
  // 1.2 - 0.1 is 1.0999999999999999 in floating point: one ulp below lo.
  const { lo, hi } = cutRange([1, 1.1, 1.2], 1, 4);
  assert.ok(hi >= lo, `${hi} < ${lo}`);
  assert.equal(clampCut([1, 1.1, 1.2], 1, 1.1, 4), 1.1);
  const r = cutRange([1, 3], 0, 4);
  near(r.lo, 0.1); near(r.hi, 2.9);
  const last = cutRange([1, 3], 1, 4);
  near(last.lo, 1.1); near(last.hi, 3.9);
});

test('normalizeCuts returns no cuts for a duration that is not a positive finite number', () => {
  assert.deepEqual(normalizeCuts([1, 2], NaN), []);
  assert.deepEqual(normalizeCuts([1, 2], Infinity), []);
  assert.deepEqual(normalizeCuts([1, 2], 0), []);
  assert.deepEqual(normalizeCuts([1, 2], -5), []);
});

test('normalizeCuts, addCut and moveCut never mutate their input', () => {
  const cuts = [3, 1, 2];
  normalizeCuts(cuts, 10);
  assert.deepEqual(cuts, [3, 1, 2]);
  const sorted = [1, 2, 3];
  addCut(sorted, 2.5, 10);
  moveCut(sorted, 1, 2.4, 10);
  assert.deepEqual(sorted, [1, 2, 3]);
});

test('equalParts makes n-1 evenly spaced cuts', () => {
  const c = equalParts(4, 10);
  assert.equal(c.length, 3); near(c[0], 2.5); near(c[1], 5); near(c[2], 7.5);
  assert.deepEqual(equalParts(1, 10), []);
});

test('equalParts caps n so no part is shorter than MIN_SEGMENT_SEC', () => {
  assert.equal(equalParts(100, 3).length, 29, '3 s allows 30 parts');
  assert.equal(equalParts(50, 1).length, 9, '1 s allows 10');
  assert.equal(equalParts(3, 0.25).length, 1, '0.25 s allows 2');
  assert.deepEqual(equalParts(2, 0.15), [], 'shorter than two minimums: no cut');
});

test('everyN stops before the tail and never leaves an empty last chunk', () => {
  assert.deepEqual(everyN(3, 10), [3, 6, 9]);
  assert.deepEqual(everyN(5, 10), [5], 'exact multiple: no cut at 10');
  assert.deepEqual(everyN(0, 10), []);
  assert.deepEqual(everyN(-1, 10), []);
});

test('formatTime renders m:ss.s and h:mm:ss.s, and never shows :60.0', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(75.25), '1:15.3');
  assert.equal(formatTime(59.96), '1:00.0');
  assert.equal(formatTime(3600), '1:00:00.0');
  assert.equal(formatTime(3725.5), '1:02:05.5');
  assert.equal(formatTime(5, 0), '0:05');
});

test('parseTime accepts ss, m:ss, m:ss.s, h:mm:ss, h:mm:ss.s and rejects junk', () => {
  near(parseTime('5'), 5); near(parseTime('1:15'), 75); near(parseTime('1:15.3'), 75.3);
  near(parseTime('1:02:05'), 3725); near(parseTime('1:02:05.5'), 3725.5); near(parseTime(' 0:07.0 '), 7);
  assert.ok(Number.isNaN(parseTime(''))); assert.ok(Number.isNaN(parseTime('abc')));
  assert.ok(Number.isNaN(parseTime('1:2:3:4'))); assert.ok(Number.isNaN(parseTime('-1')));
});

test('splitName and chunkName', () => {
  assert.deepEqual(splitName('goblins.wav'), { base: 'goblins', ext: 'wav' });
  assert.deepEqual(splitName('my.mix.2024.mp3'), { base: 'my.mix.2024', ext: 'mp3' });
  assert.deepEqual(splitName('noext'), { base: 'noext', ext: '' });
  assert.deepEqual(splitName('.hidden'), { base: '.hidden', ext: '' });
  assert.equal(chunkName('goblins', 0, 3, 'wav'), 'goblins-01.wav');
  assert.equal(chunkName('goblins', 8, 9, 'wav'), 'goblins-09.wav');
  assert.equal(chunkName('goblins', 9, 10, 'wav'), 'goblins-10.wav');
  assert.equal(chunkName('goblins', 0, 100, 'wav'), 'goblins-001.wav');
});

test('estimateBytes is proportional and safe on zero duration', () => {
  assert.equal(estimateBytes(1000, 2.5, 10), 250);
  assert.equal(estimateBytes(1000, 1, 0), 0);
});
