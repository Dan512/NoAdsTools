// crop-image/tests/unit/intake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedImage, sourceFormat } from '../../js/intake.js';

test('accepts the three allowlisted formats by extension', () => {
  for (const n of ['a.jpg', 'b.jpeg', 'c.png', 'd.webp']) {
    assert.equal(isAcceptedImage(n, ''), true, n);
  }
});

test('accepts by MIME when the extension is missing', () => {
  assert.equal(isAcceptedImage('noext', 'image/jpeg'), true);
  assert.equal(isAcceptedImage('noext', 'image/png'), true);
  assert.equal(isAcceptedImage('noext', 'image/webp'), true);
});

test('extension wins over a conflicting/misleading MIME', () => {
  assert.equal(isAcceptedImage('photo.jpg', 'application/octet-stream'), true);
});

test('rejects AVIF, GIF, BMP, PDF, and disguised executables', () => {
  for (const n of ['a.avif', 'b.gif', 'c.bmp', 'd.pdf', 'photo.jpg.exe']) {
    assert.equal(isAcceptedImage(n, ''), false, n);
  }
  // AVIF is out of scope in v1 even by MIME.
  assert.equal(isAcceptedImage('noext', 'image/avif'), false);
  assert.equal(isAcceptedImage('data.bin', 'application/octet-stream'), false);
});

test('sourceFormat resolves the format key by extension (jpg/jpeg → jpeg)', () => {
  assert.equal(sourceFormat('a.jpg', ''), 'jpeg');
  assert.equal(sourceFormat('a.JPEG', ''), 'jpeg');
  assert.equal(sourceFormat('a.png', ''), 'png');
  assert.equal(sourceFormat('a.webp', ''), 'webp');
});

test('sourceFormat falls back to MIME when the extension is missing', () => {
  assert.equal(sourceFormat('noext', 'image/png'), 'png');
  assert.equal(sourceFormat('noext', 'image/webp'), 'webp');
});

test('sourceFormat returns null for a non-accepted file', () => {
  assert.equal(sourceFormat('a.avif', ''), null);
  assert.equal(sourceFormat('a.gif', ''), null);
  assert.equal(sourceFormat('photo.jpg.exe', ''), null);
  assert.equal(sourceFormat('data.bin', 'application/octet-stream'), null);
});
