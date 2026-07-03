// find-duplicate-photos/tests/unit/zip-set.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZipManifest } from '../../js/zip-set.js';

const it = (id, over = {}) => ({ id, relPath: `${id}.jpg`, size: 10, status: 'hashed', ...over });

test('manifest = keepers + non-clustered; marked duplicates excluded', () => {
  const items = [it('keep1'), it('dup1'), it('solo')];
  const groups = [{ key: 'k', matchType: 'exact',
    members: [{ id: 'keep1', keep: true }, { id: 'dup1', keep: false }] }];
  const m = buildZipManifest({ items, groups });
  assert.deepEqual(m.map(e => e.id).sort(), ['keep1', 'solo']);
});

test('failed items are excluded; exact-only items included', () => {
  const items = [it('ok'), it('bad', { status: 'failed' }), it('meh', { status: 'exact-only' })];
  const m = buildZipManifest({ items, groups: [] });
  assert.deepEqual(m.map(e => e.id).sort(), ['meh', 'ok']);
});

test('relative paths preserved; name collisions get " (2)" before the extension, case-insensitively', () => {
  const items = [
    it('a', { relPath: 'trip/IMG.jpg' }),
    it('b', { relPath: 'IMG.jpg' }),
    it('c', { relPath: 'img.JPG' }),   // collides with b case-insensitively (Windows unzip)
    it('d', { relPath: 'img.JPG' }),   // collides again
  ];
  const m = buildZipManifest({ items, groups: [] });
  const paths = Object.fromEntries(m.map(e => [e.id, e.zipPath]));
  assert.equal(paths.a, 'trip/IMG.jpg');
  assert.equal(paths.b, 'IMG.jpg');
  assert.equal(paths.c, 'img (2).JPG');
  assert.equal(paths.d, 'img (3).JPG');
});

test('totalBytes helper on the manifest entries', () => {
  const items = [it('a', { size: 7 }), it('b', { size: 5 })];
  const m = buildZipManifest({ items, groups: [] });
  assert.equal(m.reduce((s, e) => s + e.size, 0), 12);
});

test('collision suffix respects the basename — dotted directories and dotfiles survive', () => {
  const items = [
    it('a', { relPath: '2024.07 trip/IMG' }),
    it('b', { relPath: '2024.07 trip/IMG' }),
    it('c', { relPath: 'trip/.hidden' }),
    it('d', { relPath: 'trip/.hidden' }),
  ];
  const m = buildZipManifest({ items, groups: [] });
  const paths = Object.fromEntries(m.map(e => [e.id, e.zipPath]));
  assert.equal(paths.b, '2024.07 trip/IMG (2)');
  assert.equal(paths.d, 'trip/.hidden (2)');
});
