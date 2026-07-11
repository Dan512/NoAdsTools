import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb01, centerAnchor, rotatedCenterAnchor, cornerAnchor, tilePositions, clampOpacity, normalizeRotation } from '../../js/wm-layout.js';

const near = (a, b) => Math.abs(a - b) < 1e-6;

// Where the drawn box's centroid lands: pdf-lib rotates the box about its
// draw point (anchor) by `deg`, so the anchor-relative centroid (hx,hy) maps to
// (cos*hx - sin*hy, sin*hx + cos*hy). Add it to the anchor for the true centroid.
function centroidOf(anchor, wmW, wmH, deg) {
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t), hx = wmW / 2, hy = wmH / 2;
  return { x: anchor.x + (cos * hx - sin * hy), y: anchor.y + (sin * hx + cos * hy) };
}

test('hexToRgb01 parses #rrggbb and #rgb, tolerates missing #', () => {
  const c = hexToRgb01('#3366cc');
  assert.ok(near(c.r, 51/255) && near(c.g, 102/255) && near(c.b, 204/255));
  assert.deepEqual(hexToRgb01('#fff'), { r: 1, g: 1, b: 1 });
  assert.deepEqual(hexToRgb01('000000'), { r: 0, g: 0, b: 0 });
});
test('hexToRgb01 falls back to black on invalid input', () => {
  assert.deepEqual(hexToRgb01('nope'), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb01(''), { r: 0, g: 0, b: 0 });
});
test('centerAnchor centers the watermark box (bottom-left origin)', () => {
  assert.deepEqual(centerAnchor(600, 800, 200, 50), { x: 200, y: 375 });
});
test('cornerAnchor honors the margin for each corner (bottom-left origin)', () => {
  assert.deepEqual(cornerAnchor(600, 800, 100, 40, 'bl', 20), { x: 20, y: 20 });
  assert.deepEqual(cornerAnchor(600, 800, 100, 40, 'tr', 20), { x: 480, y: 740 });
});
test('rotatedCenterAnchor reduces to centerAnchor at 0°', () => {
  assert.deepEqual(rotatedCenterAnchor(600, 800, 200, 50, 0), centerAnchor(600, 800, 200, 50));
});
test('rotatedCenterAnchor puts the ROTATED centroid at true page center (45°)', () => {
  const pageW = 612, pageH = 792, wmW = 300, wmH = 48, deg = 45;
  const anchor = rotatedCenterAnchor(pageW, pageH, wmW, wmH, deg);
  // A naive (unrotated) center anchor would pivot about its bottom-left corner
  // and drift the centroid off-center — this asserts the compensation works.
  const c = centroidOf(anchor, wmW, wmH, deg);
  assert.ok(near(c.x, pageW / 2), `centroid.x ${c.x} ≈ ${pageW / 2}`);
  assert.ok(near(c.y, pageH / 2), `centroid.y ${c.y} ≈ ${pageH / 2}`);
});
test('tilePositions covers the page on a fixed step grid', () => {
  const pts = tilePositions(400, 400, 200, 200);
  assert.ok(pts.length >= 4);
  assert.ok(pts.every(p => p.x >= 0 && p.y >= 0 && p.x < 400 && p.y < 400));
});
test('clampOpacity and normalizeRotation', () => {
  assert.equal(clampOpacity(1.5), 1); assert.equal(clampOpacity(-0.5), 0); assert.equal(clampOpacity(0.3), 0.3);
  assert.equal(normalizeRotation(405), 45); assert.equal(normalizeRotation(-90), 270); assert.equal(normalizeRotation(0), 0);
});
