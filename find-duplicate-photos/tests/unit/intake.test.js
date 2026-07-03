// find-duplicate-photos/tests/unit/intake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedImage, isHeic, itemKey } from '../../js/intake.js';

test('accepts the allowlisted image formats by extension or MIME', () => {
  for (const n of ['a.jpg', 'b.JPEG', 'c.png', 'd.webp', 'e.gif', 'f.avif', 'g.bmp', 'h.heic', 'i.HEIF']) {
    assert.equal(isAcceptedImage(n, ''), true, n);
  }
  assert.equal(isAcceptedImage('noext', 'image/png'), true, 'MIME rescues missing extension');
});

test('rejects non-image files', () => {
  for (const n of ['doc.pdf', 'movie.mp4', 'notes.txt', 'archive.zip', 'photo.jpg.exe']) {
    assert.equal(isAcceptedImage(n, ''), false, n);
  }
  assert.equal(isAcceptedImage('data.bin', 'application/octet-stream'), false);
});

test('isHeic detects by extension and MIME, and nothing else', () => {
  assert.equal(isHeic('x.heic', ''), true);
  assert.equal(isHeic('x.HEIF', ''), true);
  assert.equal(isHeic('x', 'image/heic'), true);
  assert.equal(isHeic('x.jpg', 'image/jpeg'), false);
});

test('itemKey is stable and distinguishes path, size, and mtime', () => {
  const a = itemKey('dir/a.jpg', 100, 1720000000000);
  assert.equal(a, itemKey('dir/a.jpg', 100, 1720000000000));
  assert.notEqual(a, itemKey('dir/b.jpg', 100, 1720000000000));
  assert.notEqual(a, itemKey('dir/a.jpg', 101, 1720000000000));
  assert.notEqual(a, itemKey('dir/a.jpg', 100, 1720000000001));
});
