// color-palette-from-image/tests/unit/intake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedImage } from '../../js/intake.js';

test('accepts the broad raster set by extension', () => {
  for (const n of ['a.jpg', 'b.jpeg', 'c.png', 'd.webp', 'e.avif', 'f.gif', 'g.bmp']) {
    assert.equal(isAcceptedImage(n, ''), true, n);
  }
});

test('accepts by MIME when the extension is missing', () => {
  for (const m of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']) {
    assert.equal(isAcceptedImage('noext', m), true, m);
  }
});

test('extension wins over a conflicting/misleading MIME', () => {
  assert.equal(isAcceptedImage('photo.png', 'application/octet-stream'), true);
});

test('rejects SVG, PDF, and disguised executables', () => {
  for (const n of ['a.svg', 'b.pdf', 'photo.png.exe', 'notes.txt']) {
    assert.equal(isAcceptedImage(n, ''), false, n);
  }
  assert.equal(isAcceptedImage('noext', 'image/svg+xml'), false);
  assert.equal(isAcceptedImage('noext', 'application/pdf'), false);
  assert.equal(isAcceptedImage('data.bin', 'application/octet-stream'), false);
});
