// convert-image/tests/unit/out-name.test.js — pure filename extension swap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outName } from '../../js/out-name.js';

test('swaps the extension to the target format', () => {
  assert.equal(outName('photo.png', 'webp'), 'photo.webp');
});

test('is case-insensitive on the source extension, lowercases the new one', () => {
  assert.equal(outName('a.JPG', 'png'), 'a.png');
});

test('appends an extension when the name has none', () => {
  assert.equal(outName('noext', 'jpeg'), 'noext.jpg');
});

test('swaps only the last extension (earlier dots survive)', () => {
  assert.equal(outName('archive.tar.gz', 'png'), 'archive.tar.png');
});

test('jpeg maps to the .jpg canonical extension', () => {
  assert.equal(outName('photo.png', 'jpeg'), 'photo.jpg');
});

test('webp and avif keep their own extension', () => {
  assert.equal(outName('a.png', 'avif'), 'a.avif');
  assert.equal(outName('a.jpg', 'webp'), 'a.webp');
});

test('falls back to a generic base for an empty name', () => {
  assert.equal(outName('', 'png'), 'image.png');
});
