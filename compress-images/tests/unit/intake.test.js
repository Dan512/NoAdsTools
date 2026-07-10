// compress-images/tests/unit/intake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedImage, sourceFormat, defaultOutFormat } from '../../js/intake.js';

test('accepts the four allowlisted formats by extension', () => {
  for (const n of ['a.jpg', 'b.jpeg', 'c.png', 'd.webp', 'e.avif']) {
    assert.equal(isAcceptedImage(n, ''), true, n);
  }
});

test('accepts by MIME when the extension is missing', () => {
  assert.equal(isAcceptedImage('noext', 'image/jpeg'), true);
  assert.equal(isAcceptedImage('noext', 'image/png'), true);
  assert.equal(isAcceptedImage('noext', 'image/webp'), true);
  assert.equal(isAcceptedImage('noext', 'image/avif'), true);
});

test('extension wins over a conflicting/misleading MIME', () => {
  assert.equal(isAcceptedImage('photo.jpg', 'application/octet-stream'), true);
});

test('rejects unsupported formats and disguised executables', () => {
  for (const n of ['a.gif', 'b.bmp', 'c.tiff', 'd.pdf', 'e.heic', 'photo.jpg.exe']) {
    assert.equal(isAcceptedImage(n, ''), false, n);
  }
  assert.equal(isAcceptedImage('data.bin', 'application/octet-stream'), false);
});

test('sourceFormat resolves the codec key by extension (jpg/jpeg → jpeg)', () => {
  assert.equal(sourceFormat('a.jpg', ''), 'jpeg');
  assert.equal(sourceFormat('a.JPEG', ''), 'jpeg');
  assert.equal(sourceFormat('a.png', ''), 'png');
  assert.equal(sourceFormat('a.webp', ''), 'webp');
  assert.equal(sourceFormat('a.avif', ''), 'avif');
});

test('sourceFormat falls back to MIME when the extension is missing', () => {
  assert.equal(sourceFormat('noext', 'image/png'), 'png');
  assert.equal(sourceFormat('noext', 'image/avif'), 'avif');
});

test('sourceFormat returns null for a non-accepted file', () => {
  assert.equal(sourceFormat('a.gif', ''), null);
  assert.equal(sourceFormat('photo.jpg.exe', ''), null);
  assert.equal(sourceFormat('data.bin', 'application/octet-stream'), null);
});

test('defaultOutFormat is the "keep original" alias for sourceFormat', () => {
  assert.equal(defaultOutFormat, sourceFormat);
  assert.equal(defaultOutFormat('photo.webp', ''), 'webp');
});
