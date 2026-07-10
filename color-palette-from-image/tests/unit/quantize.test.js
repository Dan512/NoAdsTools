// color-palette-from-image/tests/unit/quantize.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantize, dominantColor } from '../../js/quantize.js';

// Two tight clusters: near-red and near-blue.
const reds  = Array.from({ length: 50 }, (_, i) => [200 + (i % 10), 10, 12]);
const blues = Array.from({ length: 30 }, (_, i) => [8, 12, 200 + (i % 10)]);
const samples = reds.concat(blues);

test('quantize returns up to N representative colors near the clusters', () => {
  const pal = quantize(samples, 2);
  assert.equal(pal.length, 2);
  // one representative is reddish, one is bluish
  const isRed  = (c) => c[0] > 150 && c[2] < 80;
  const isBlue = (c) => c[2] > 150 && c[0] < 80;
  assert.ok(pal.some(isRed) && pal.some(isBlue), JSON.stringify(pal));
});

test('quantize never returns more colors than distinct input allows', () => {
  const twoColors = [[0,0,0],[0,0,0],[255,255,255],[255,255,255]];
  const pal = quantize(twoColors, 8);
  assert.ok(pal.length <= 2, `got ${pal.length}`);
});

test('quantize is deterministic for a fixed input', () => {
  assert.deepEqual(quantize(samples, 4), quantize(samples, 4));
});

test('quantize returns integer channel values in range', () => {
  for (const c of quantize(samples, 4)) {
    for (const v of c) { assert.ok(Number.isInteger(v) && v >= 0 && v <= 255); }
  }
});

test('dominantColor picks the most-populous cluster (red here, 50 > 30)', () => {
  const d = dominantColor(samples);
  assert.ok(d[0] > 150 && d[2] < 80, JSON.stringify(d));
});

test('empty input yields an empty palette / null dominant', () => {
  assert.deepEqual(quantize([], 6), []);
  assert.equal(dominantColor([]), null);
});

test('quantize dedupes identical representatives (flat regions return distinct colors, not padded duplicates)', () => {
  const green = Array.from({ length: 300 }, () => [40, 160, 70]);
  const red   = Array.from({ length: 40 }, () => [200, 30, 30]);
  const white = Array.from({ length: 20 }, () => [250, 250, 250]);
  const pal = quantize(green.concat(red, white), 8);
  const keys = pal.map((c) => c.join(','));
  assert.equal(new Set(keys).size, keys.length, 'palette has duplicates: ' + JSON.stringify(pal));
});
