// find-duplicate-photos/tests/unit/list-text.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDuplicateListText, prettyBytes } from '../../js/list-text.js';

test('prettyBytes drops the trailing .0', () => {
  assert.equal(prettyBytes(512), '512 B');
  assert.equal(prettyBytes(2048), '2 KB');
  assert.equal(prettyBytes(317_440), '310 KB');
  assert.equal(prettyBytes(3_355_443), '3.2 MB');
  assert.equal(prettyBytes(1_288_490_189), '1.2 GB');
});

test('list text groups KEEP/DELETE lines with paths, dims, sizes, match type', () => {
  const itemsById = new Map([
    ['a', { id: 'a', relPath: 'trip/IMG_1.jpg', width: 4032, height: 3024, size: 3_250_585 }],
    ['b', { id: 'b', relPath: 'trip/IMG_1 (1).jpg', width: 4032, height: 3024, size: 3_250_585 }],
    ['c', { id: 'c', relPath: 'IMG_2.jpg', width: 1024, height: 768, size: 317_440 }],
    ['d', { id: 'd', relPath: 'IMG_2-big.jpg', width: 4032, height: 3024, size: 2_936_012 }],
  ]);
  const groups = [
    { key: 'a|b', matchType: 'exact', members: [{ id: 'a', keep: true }, { id: 'b', keep: false }] },
    { key: 'c|d', matchType: 'similar', members: [{ id: 'd', keep: true }, { id: 'c', keep: false }] },
  ];
  const text = buildDuplicateListText({ groups, itemsById, scannedCount: 10 });
  assert.match(text, /noadstools\.com\/find-duplicate-photos/);
  assert.match(text, /Scanned 10 photos — 2 duplicate groups, 2 files marked as duplicates \(3\.4 MB\)\./);
  assert.match(text, /Group 1 — identical files:/);
  assert.match(text, /KEEP {4}trip\/IMG_1\.jpg {2}\(4032×3024, 3\.1 MB\)/);
  assert.match(text, /DELETE {2}trip\/IMG_1 \(1\)\.jpg {2}\(4032×3024, 3\.1 MB\)/);
  assert.match(text, /Group 2 — visually similar:/);
  assert.match(text, /DELETE {2}IMG_2\.jpg {2}\(1024×768, 310 KB\)/);
});

test('fully-kept groups are omitted from the list', () => {
  const itemsById = new Map([['a', { id: 'a', relPath: 'a.jpg', width: 1, height: 1, size: 1 }],
                            ['b', { id: 'b', relPath: 'b.jpg', width: 1, height: 1, size: 1 }]]);
  const groups = [{ key: 'a|b', matchType: 'exact', members: [{ id: 'a', keep: true }, { id: 'b', keep: true }] }];
  const text = buildDuplicateListText({ groups, itemsById, scannedCount: 2 });
  assert.doesNotMatch(text, /Group 1/);
  assert.match(text, /0 files marked as duplicates/);
});

test('undecoded members omit dimensions instead of printing 0×0', () => {
  const itemsById = new Map([
    ['a', { id: 'a', relPath: 'a.heic', width: 0, height: 0, size: 900 }],
    ['b', { id: 'b', relPath: 'b.heic', width: 0, height: 0, size: 900 }],
  ]);
  const groups = [{ key: 'a|b', matchType: 'exact', members: [{ id: 'a', keep: true }, { id: 'b', keep: false }] }];
  const text = buildDuplicateListText({ groups, itemsById, scannedCount: 2 });
  assert.match(text, /DELETE {2}b\.heic {2}\(900 B\)/);
  assert.doesNotMatch(text, /0×0/);
});
