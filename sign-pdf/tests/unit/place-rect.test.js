import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPdfRect, clampBox } from '../../js/place-rect.js';

// A page preview rendered at scale 1.5: a 300x200-pt PDF page → 450x300 display px.
// A signature box at display (60,45) size 150x60 → PDF-space (bottom-left origin).
test('toPdfRect maps a display box to PDF points, flipping the Y origin', () => {
  const r = toPdfRect({ x: 60, y: 45, w: 150, h: 60 }, { renderScale: 1.5, pageWidthPt: 300, pageHeightPt: 200 });
  // x = 60/1.5 = 40; w = 150/1.5 = 100; h = 60/1.5 = 40; y = 200 - (45+60)/1.5 = 200 - 70 = 130
  assert.deepEqual(r, { x: 40, y: 130, w: 100, h: 40 });
});
test('toPdfRect at scale 1 is a pure Y-flip', () => {
  const r = toPdfRect({ x: 0, y: 0, w: 10, h: 10 }, { renderScale: 1, pageWidthPt: 100, pageHeightPt: 100 });
  assert.deepEqual(r, { x: 0, y: 90, w: 10, h: 10 });
});
test('clampBox keeps the box inside the preview, capping oversize', () => {
  assert.deepEqual(clampBox({ x: -5, y: 5, w: 50, h: 20 }, 400, 300), { x: 0, y: 5, w: 50, h: 20 });
  assert.deepEqual(clampBox({ x: 380, y: 5, w: 50, h: 20 }, 400, 300), { x: 350, y: 5, w: 50, h: 20 });
  assert.deepEqual(clampBox({ x: 0, y: 0, w: 999, h: 20 }, 400, 300), { x: 0, y: 0, w: 400, h: 20 });
});
