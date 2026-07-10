// favicon-generator/tests/unit/intake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedImage } from '../../js/intake.js';

test('accepts PNG/JPEG/WebP by extension', () => {
  for (const n of ['a.jpg', 'b.jpeg', 'c.png', 'd.webp']) {
    assert.equal(isAcceptedImage(n, ''), true, n);
  }
});

test('accepts by MIME when the extension is missing', () => {
  assert.equal(isAcceptedImage('noext', 'image/jpeg'), true);
  assert.equal(isAcceptedImage('noext', 'image/png'), true);
  assert.equal(isAcceptedImage('noext', 'image/webp'), true);
});

test('extension wins over a misleading MIME', () => {
  assert.equal(isAcceptedImage('logo.png', 'application/octet-stream'), true);
});

test('rejects SVG, GIF, BMP, PDF, AVIF, and disguised executables', () => {
  for (const n of ['a.svg', 'b.gif', 'c.bmp', 'd.pdf', 'e.avif', 'logo.png.exe']) {
    assert.equal(isAcceptedImage(n, ''), false, n);
  }
  // Deferred/out-of-scope formats stay out even by MIME.
  assert.equal(isAcceptedImage('noext', 'image/svg+xml'), false);
  assert.equal(isAcceptedImage('noext', 'image/avif'), false);
  assert.equal(isAcceptedImage('noext', 'image/gif'), false);
  assert.equal(isAcceptedImage('data.bin', 'application/octet-stream'), false);
});
