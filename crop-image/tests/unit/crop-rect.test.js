import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRect, moveRect, applyAspect, resizeByHandle, fitInitialRect, mapRect } from '../../js/crop-rect.js';

const B = { w: 1000, h: 800 };

test('clampRect keeps a rect inside bounds by shifting, capping if oversized', () => {
  assert.deepEqual(clampRect({ x: -10, y: 5, w: 100, h: 50 }, B), { x: 0, y: 5, w: 100, h: 50 });
  assert.deepEqual(clampRect({ x: 950, y: 5, w: 100, h: 50 }, B), { x: 900, y: 5, w: 100, h: 50 });
  assert.deepEqual(clampRect({ x: 0, y: 0, w: 2000, h: 50 }, B), { x: 0, y: 0, w: 1000, h: 50 });
});

test('moveRect translates and clamps', () => {
  assert.deepEqual(moveRect({ x: 100, y: 100, w: 200, h: 200 }, 50, -30, B), { x: 150, y: 70, w: 200, h: 200 });
  assert.deepEqual(moveRect({ x: 900, y: 0, w: 200, h: 200 }, 500, 0, B), { x: 800, y: 0, w: 200, h: 200 });
});

test('applyAspect fits the largest centered rect of the ratio, clamped', () => {
  // 1:1 on a rect centered in a landscape bound → square sized to min dimension of the source rect region
  const r = applyAspect({ x: 200, y: 200, w: 400, h: 200 }, 1, B); // center (400,300)
  assert.equal(r.w, r.h, 'square');
  // centered on the original center
  assert.equal(Math.round(r.x + r.w / 2), 400);
  assert.equal(Math.round(r.y + r.h / 2), 300);
  // stays in bounds
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= B.w && r.y + r.h <= B.h);
});

test('applyAspect with null ratio returns the rect unchanged (freeform)', () => {
  const rect = { x: 10, y: 20, w: 30, h: 40 };
  assert.deepEqual(applyAspect(rect, null, B), rect);
});

test('resizeByHandle SE corner grows w and h by the delta, clamped + min-size', () => {
  const r = resizeByHandle({ x: 100, y: 100, w: 200, h: 200 }, 'se', 50, 30, { ratio: null, minSize: 16, bounds: B });
  assert.deepEqual(r, { x: 100, y: 100, w: 250, h: 230 });
});

test('resizeByHandle NW corner moves the origin and shrinks, respecting minSize', () => {
  const r = resizeByHandle({ x: 100, y: 100, w: 200, h: 200 }, 'nw', 40, 40, { ratio: null, minSize: 16, bounds: B });
  assert.deepEqual(r, { x: 140, y: 140, w: 160, h: 160 });
});

test('resizeByHandle enforces minSize (never smaller than the floor)', () => {
  const r = resizeByHandle({ x: 100, y: 100, w: 200, h: 200 }, 'se', -300, -300, { ratio: null, minSize: 16, bounds: B });
  assert.equal(r.w, 16); assert.equal(r.h, 16);
});

test('resizeByHandle with an active ratio keeps w/h proportional', () => {
  const r = resizeByHandle({ x: 100, y: 100, w: 200, h: 200 }, 'se', 100, 0, { ratio: 1, minSize: 16, bounds: B });
  assert.equal(r.w, r.h, 'ratio 1:1 held even though only dx moved');
});

test('resizeByHandle clamps growth to bounds', () => {
  const r = resizeByHandle({ x: 900, y: 100, w: 90, h: 90 }, 'e', 500, 0, { ratio: null, minSize: 16, bounds: B });
  assert.equal(r.x + r.w, 1000);
});

test('resizeByHandle ratio-locked SE into a bound stays in-ratio (height-bound square)', () => {
  // Dragging the SE corner far right would blow past the 800-tall bound; a naive
  // per-dimension clamp gives {1000×800} (not square). It must scale DOWN keeping
  // the ratio, anchored at NW → {0,0,800,800}.
  const r = resizeByHandle({ x: 0, y: 0, w: 900, h: 100 }, 'se', 400, 0, { ratio: 1, minSize: 16, bounds: { w: 1000, h: 800 } });
  assert.deepEqual(r, { x: 0, y: 0, w: 800, h: 800 });
});

test('resizeByHandle ratio-locked SE into a bound stays in-ratio (16:9)', () => {
  // Height-bound at 360 → largest 16:9 rect anchored at NW is 640×360.
  const r = resizeByHandle({ x: 0, y: 0, w: 200, h: 50 }, 'se', 700, 0, { ratio: 16 / 9, minSize: 16, bounds: { w: 1000, h: 360 } });
  assert.deepEqual(r, { x: 0, y: 0, w: 640, h: 360 });
});

test('resizeByHandle ratio-locked NW into the left bound stays in-ratio', () => {
  // NW dragged hard left/up; anchor is the SE corner. Left-bound at x=0 caps the
  // width to 200 → a 200×200 square, not a distorted rect.
  const r = resizeByHandle({ x: 100, y: 700, w: 100, h: 80 }, 'nw', -500, -500, { ratio: 1, minSize: 16, bounds: { w: 1000, h: 800 } });
  assert.deepEqual(r, { x: 0, y: 580, w: 200, h: 200 });
});

test('resizeByHandle ratio-locked floor keeps BOTH dims ≥ minSize (min side floored)', () => {
  // A hard shrink under a 2:1 ratio must not floor only the driven dim (the old
  // bug produced {w:16,h:8}). The min side (h) hits 16 → w scales to 32.
  const r = resizeByHandle({ x: 100, y: 100, w: 200, h: 200 }, 'se', -500, -500, { ratio: 2, minSize: 16, bounds: { w: 1000, h: 800 } });
  assert.deepEqual(r, { x: 100, y: 100, w: 32, h: 16 });
});

test('fitInitialRect returns a centered rect within bounds at the ratio (or ~80% freeform)', () => {
  const free = fitInitialRect(B, null);
  assert.ok(free.w <= B.w && free.h <= B.h && free.x >= 0 && free.y >= 0);
  const sq = fitInitialRect(B, 1);
  assert.equal(sq.w, sq.h);
  assert.ok(sq.x + sq.w <= B.w && sq.y + sq.h <= B.h);
});

test('mapRect scales between source and display space round-trip', () => {
  const src = { x: 100, y: 200, w: 300, h: 400 };
  const disp = mapRect(src, 0.5);          // display = source * 0.5
  assert.deepEqual(disp, { x: 50, y: 100, w: 150, h: 200 });
  assert.deepEqual(mapRect(disp, 2), src); // inverse
});
