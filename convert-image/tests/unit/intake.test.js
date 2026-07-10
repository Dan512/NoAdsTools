// convert-image/tests/unit/intake.test.js — pure intake allowlist coverage.
// Convert accepts SIX input formats (JPEG/PNG/WebP/AVIF/GIF/BMP), all of which
// decode natively via createImageBitmap, and reports a display label per source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedImage, sourceFormat } from '../../js/intake.js';

test('accepts the six allowlisted input formats by extension', () => {
  for (const n of ['a.jpg', 'b.jpeg', 'c.png', 'd.webp', 'e.avif', 'f.gif', 'g.bmp']) {
    assert.equal(isAcceptedImage(n, ''), true, n);
  }
});

test('accepts by MIME when the extension is missing', () => {
  assert.equal(isAcceptedImage('noext', 'image/jpeg'), true);
  assert.equal(isAcceptedImage('noext', 'image/png'), true);
  assert.equal(isAcceptedImage('noext', 'image/webp'), true);
  assert.equal(isAcceptedImage('noext', 'image/avif'), true);
  assert.equal(isAcceptedImage('noext', 'image/gif'), true);
  assert.equal(isAcceptedImage('noext', 'image/bmp'), true);
  assert.equal(isAcceptedImage('noext', 'image/x-ms-bmp'), true);
});

test('extension wins over a conflicting/misleading MIME', () => {
  assert.equal(isAcceptedImage('photo.jpg', 'application/octet-stream'), true);
});

test('rejects unsupported formats and disguised executables', () => {
  for (const n of ['a.svg', 'b.pdf', 'c.tiff', 'd.heic', 'photo.png.exe']) {
    assert.equal(isAcceptedImage(n, ''), false, n);
  }
  assert.equal(isAcceptedImage('data.bin', 'application/octet-stream'), false);
});

test('sourceFormat resolves a display label by extension', () => {
  assert.equal(sourceFormat('a.jpg', ''), 'JPEG');
  assert.equal(sourceFormat('a.JPEG', ''), 'JPEG');
  assert.equal(sourceFormat('a.png', ''), 'PNG');
  assert.equal(sourceFormat('a.webp', ''), 'WebP');
  assert.equal(sourceFormat('a.avif', ''), 'AVIF');
  assert.equal(sourceFormat('a.gif', ''), 'GIF');
  assert.equal(sourceFormat('a.bmp', ''), 'BMP');
});

test('sourceFormat falls back to MIME when the extension is missing', () => {
  assert.equal(sourceFormat('noext', 'image/png'), 'PNG');
  assert.equal(sourceFormat('noext', 'image/gif'), 'GIF');
  assert.equal(sourceFormat('noext', 'image/x-ms-bmp'), 'BMP');
});

test('sourceFormat returns null for a non-accepted file', () => {
  assert.equal(sourceFormat('a.svg', ''), null);
  assert.equal(sourceFormat('photo.png.exe', ''), null);
  assert.equal(sourceFormat('data.bin', 'application/octet-stream'), null);
});
