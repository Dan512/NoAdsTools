import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRanges } from '../../js/ranges.js';

test('parses mixed single + range tokens (1-based), builds groups + deduped flat', () => {
  const r = parseRanges('1-3, 5, 8-10', 10);
  assert.deepEqual(r.groups, [[1,3],[5,5],[8,10]]);
  assert.deepEqual(r.flat, [1,2,3,5,8,9,10]);
  assert.deepEqual(r.errors, []);
});
test('whitespace tolerant', () => {
  assert.deepEqual(parseRanges('  1 - 3 ,5 ', 10).flat, [1,2,3,5]);
});
test('dedups flat but keeps groups as written', () => {
  const r = parseRanges('1,1,2', 10);
  assert.deepEqual(r.groups, [[1,1],[1,1],[2,2]]);
  assert.deepEqual(r.flat, [1,2]);
});
test('clamps a partially-out-of-range token to the page count', () => {
  const r = parseRanges('8-15', 10);
  assert.deepEqual(r.groups, [[8,10]]);
  assert.deepEqual(r.flat, [8,9,10]);
});
test('errors on reversed, zero, non-numeric, and fully-out-of-range tokens', () => {
  assert.ok(parseRanges('5-3', 10).errors.length >= 1);   // reversed
  assert.ok(parseRanges('0', 10).errors.length >= 1);     // zero
  assert.ok(parseRanges('abc', 10).errors.length >= 1);   // non-numeric
  assert.ok(parseRanges('15-20', 10).errors.length >= 1); // fully out of range
  // a bad token doesn't kill the good ones
  const mixed = parseRanges('1-3, zzz, 5', 10);
  assert.deepEqual(mixed.flat, [1,2,3,5]);
  assert.equal(mixed.errors.length, 1);
});
test('empty / whitespace-only input → no pages, no error', () => {
  assert.deepEqual(parseRanges('', 10), { groups: [], flat: [], errors: [] });
});
