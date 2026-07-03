// find-duplicate-photos/tests/unit/report.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroups } from '../../js/report.js';

// Hash helpers: identical sha ⇒ exact; near dhash ⇒ similar at normal (≤8 bits).
const H = (lo) => ({ hi: 0, lo });
const item = (id, over = {}) => ({
  id, name: `${id}.jpg`, relPath: `${id}.jpg`, size: 100, order: 0,
  status: 'hashed', width: 100, height: 100,
  sha256: `sha-${id}`, dhash: H(0), phash: H(0), ...over,
});

test('byte-identical files form an exact group; keeper is the first-seen on full tie', () => {
  const items = [
    item('a', { sha256: 'same', order: 0 }),
    item('b', { sha256: 'same', order: 1, dhash: H(0xffff), phash: H(0xffff) }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: {} });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].matchType, 'exact');
  const keep = r.groups[0].members.filter(m => m.keep).map(m => m.id);
  assert.deepEqual(keep, ['a']);
  assert.equal(r.reclaimableBytes, 100);
  assert.equal(r.duplicateCount, 1);
});

test('perceptually-near items form a similar group; most pixels wins keeper', () => {
  const items = [
    item('small', { dhash: H(0b0011), width: 10, height: 10, size: 10, order: 0 }),
    item('big',   { dhash: H(0b0111), width: 100, height: 100, size: 50, order: 1 }),
    item('other', { dhash: H(0x7fffffff | 0), phash: H(0x12345678), order: 2 }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: {} });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].matchType, 'similar');
  assert.deepEqual(r.groups[0].members.filter(m => m.keep).map(m => m.id), ['big']);
  assert.equal(r.reclaimableBytes, 10);
});

test('exact-group members are excluded from the perceptual pass', () => {
  // a+b byte-identical AND perceptually near c — but a/b must stay an exact
  // pair, and c (near only a/b) forms no group on its own.
  const items = [
    item('a', { sha256: 'same', dhash: H(0), order: 0 }),
    item('b', { sha256: 'same', dhash: H(0), order: 1 }),
    item('c', { sha256: 'diff', dhash: H(1), order: 2 }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: {} });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].matchType, 'exact');
  assert.deepEqual(r.groups[0].members.map(m => m.id).sort(), ['a', 'b']);
});

test('overrides flip keep flags and the reclaimable math follows', () => {
  const items = [
    item('a', { sha256: 'same', size: 100, order: 0 }),
    item('b', { sha256: 'same', size: 200, order: 1 }),
  ];
  // Auto keeper is b (larger bytes). Override: keep BOTH.
  const r = buildGroups({ items, sensitivity: 'normal', overrides: { a: true } });
  assert.deepEqual(r.groups[0].members.filter(m => m.keep).map(m => m.id).sort(), ['a', 'b']);
  assert.equal(r.reclaimableBytes, 0);
  assert.equal(r.duplicateCount, 0);
});

test('groups sort by reclaimable bytes, largest first; stable keys', () => {
  const items = [
    item('a1', { sha256: 's1', size: 10, order: 0 }), item('a2', { sha256: 's1', size: 10, order: 1 }),
    item('b1', { sha256: 's2', size: 900, order: 2 }), item('b2', { sha256: 's2', size: 900, order: 3 }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: {} });
  assert.equal(r.groups[0].key, 'b1|b2');
  assert.equal(r.groups[1].key, 'a1|a2');
});

test('failed and pending items never appear in groups', () => {
  const items = [
    item('a', { sha256: 'same' }),
    item('b', { sha256: 'same', status: 'failed' }),
    item('c', { sha256: 'same', status: 'pending' }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: {} });
  assert.equal(r.groups.length, 0);
});

test('exact-only items (no perceptual hashes) still join exact groups', () => {
  const items = [
    item('a', { sha256: 'same', status: 'exact-only', dhash: null, phash: null }),
    item('b', { sha256: 'same' }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: {} });
  assert.equal(r.groups.length, 1);
});

test('strict sensitivity splits what loose merges', () => {
  const items = [
    item('a', { dhash: H(0), order: 0 }),
    item('b', { dhash: H(0b111111111111), phash: H(0b111111111111), order: 1 }), // 12 bits away
  ];
  assert.equal(buildGroups({ items, sensitivity: 'strict', overrides: {} }).groups.length, 0);
  assert.equal(buildGroups({ items, sensitivity: 'loose',  overrides: {} }).groups.length, 1);
});

test('exact-only items never join the perceptual pass, even with a stray hash', () => {
  const items = [
    item('a', { sha256: 's1', dhash: H(0), status: 'exact-only' }),
    item('b', { sha256: 's2', dhash: H(1), order: 1 }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: {} });
  assert.equal(r.groups.length, 0);
});

test('buildGroups tolerates a missing overrides argument', () => {
  const items = [item('a', { sha256: 'same' }), item('b', { sha256: 'same', order: 1 })];
  const r = buildGroups({ items, sensitivity: 'normal' });
  assert.equal(r.groups.length, 1);
});

test('duplicateGroupCount excludes fully-kept groups', () => {
  const items = [
    item('a', { sha256: 's1' }), item('b', { sha256: 's1', order: 1 }),
    item('c', { sha256: 's2', order: 2 }), item('d', { sha256: 's2', order: 3 }),
  ];
  const r = buildGroups({ items, sensitivity: 'normal', overrides: { b: true } });
  assert.equal(r.groups.length, 2);
  assert.equal(r.duplicateGroupCount, 1);
});
