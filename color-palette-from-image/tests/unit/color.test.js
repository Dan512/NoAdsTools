// color-palette-from-image/tests/unit/color.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToHex, rgbToHsl, luminance, labelOn, hexList, cssVars, toJson } from '../../js/color.js';

test('rgbToHex zero-pads', () => {
  assert.equal(rgbToHex([26,43,60]), '#1a2b3c');
  assert.equal(rgbToHex([0,0,0]), '#000000');
});

test('rgbToHsl known values', () => {
  assert.deepEqual(rgbToHsl([255,0,0]), [0,100,50]);
  assert.deepEqual(rgbToHsl([255,255,255]), [0,0,100]);
});

test('labelOn picks black on light, white on dark', () => {
  assert.equal(labelOn([255,255,255]), '#000000');
  assert.equal(labelOn([0,0,0]), '#ffffff');
});

// The label must maximize contrast, not follow a luminance>0.5 guess. A mid
// green ([34,144,115]) reads ~3.95:1 in white but ~5.3:1 in black — so it must
// get black. Guards the WCAG-AA contrast of the on-swatch hex (colorblind).
test('labelOn maximizes contrast on mid-tones (mid green → black, not white)', () => {
  assert.equal(labelOn([34,144,115]), '#000000');
});

test('labelOn always clears AA (>=4.5:1) for any color', () => {
  const contrast = (rgb) => {
    const L = luminance(rgb);
    const chosen = labelOn(rgb) === '#000000' ? 0 : 1;
    const [hi, lo] = chosen > L ? [chosen, L] : [L, chosen];
    return (hi + 0.05) / (lo + 0.05);
  };
  // Sweep the color cube coarsely — worst case is a mid-tone near the crossover.
  for (let r = 0; r <= 255; r += 51)
    for (let g = 0; g <= 255; g += 51)
      for (let b = 0; b <= 255; b += 51)
        assert.ok(contrast([r, g, b]) >= 4.5, `low contrast on ${[r, g, b]}`);
});

test('luminance is 0 for black, 1 for white', () => {
  assert.equal(luminance([0,0,0]), 0);
  assert.equal(luminance([255,255,255]), 1);
});

test('hexList joins with comma-space', () => {
  assert.equal(hexList([[0,0,0],[255,255,255]]), '#000000, #ffffff');
});

test('cssVars emits :root block', () => {
  assert.match(cssVars([[0,0,0]]), /:root\s*\{\s*--color-1:\s*#000000;/);
});

test('toJson has hex/rgb/hsl per color', () => {
  const j = JSON.parse(toJson([[255,0,0]]));
  assert.equal(j[0].hex, '#ff0000');
  assert.deepEqual(j[0].rgb, [255,0,0]);
  assert.deepEqual(j[0].hsl, [0,100,50]);
});
