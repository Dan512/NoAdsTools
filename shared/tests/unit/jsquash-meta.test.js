// shared/tests/unit/jsquash-meta.test.js — pins the CODEC_META contract that
// compress-images' worker + UI (and, next, convert-image) share, so drift
// between "what a codec produces" and "what the UI labels it as" is caught
// here instead of at runtime. Pure data — no WASM, no DOM, Node-testable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEC_META } from '../../jsquash-loader.js';

const EXPECTED = {
  jpeg: { label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true },
  webp: { label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true },
  avif: { label: 'AVIF', ext: 'avif', mime: 'image/avif', lossy: true },
  png: { label: 'PNG', ext: 'png', mime: 'image/png', lossy: false },
};

test('CODEC_META has exactly the four supported formats', () => {
  assert.deepEqual(Object.keys(CODEC_META).sort(), Object.keys(EXPECTED).sort());
});

for (const [key, expected] of Object.entries(EXPECTED)) {
  test(`CODEC_META.${key} has the right label/ext/mime/lossy`, () => {
    assert.deepEqual(CODEC_META[key], expected);
  });
}

test('lossy formats: jpeg, webp, avif; lossless: png only', () => {
  const lossy = Object.entries(CODEC_META).filter(([, v]) => v.lossy).map(([k]) => k).sort();
  const lossless = Object.entries(CODEC_META).filter(([, v]) => !v.lossy).map(([k]) => k).sort();
  assert.deepEqual(lossy, ['avif', 'jpeg', 'webp']);
  assert.deepEqual(lossless, ['png']);
});

test('CODEC_META is frozen (accidental mutation is caught, not silently allowed)', () => {
  assert.equal(Object.isFrozen(CODEC_META), true);
  for (const key of Object.keys(CODEC_META)) {
    assert.equal(Object.isFrozen(CODEC_META[key]), true);
  }
});
