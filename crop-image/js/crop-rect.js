// crop-image/js/crop-rect.js — PURE crop geometry. All coords are plain
// numbers; SOURCE-pixel rects are integers. No DOM.
const ri = (n) => Math.round(n);
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Keep a rect inside {w,h} bounds: cap size to bounds, then shift x/y in range. */
export function clampRect(rect, bounds) {
  const w = clampN(ri(rect.w), 1, bounds.w);
  const h = clampN(ri(rect.h), 1, bounds.h);
  const x = clampN(ri(rect.x), 0, bounds.w - w);
  const y = clampN(ri(rect.y), 0, bounds.h - h);
  return { x, y, w, h };
}

/** Translate by (dx,dy), keep size, clamp within bounds. */
export function moveRect(rect, dx, dy, bounds) {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);
}

/** Largest rect of `ratio` (w/h) centered on rect's center, clamped to bounds.
 *  ratio null → freeform (unchanged). */
export function applyAspect(rect, ratio, bounds) {
  if (!ratio) return rect;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  // Start from current width, derive height; if it overflows, derive from height.
  let w = rect.w, h = w / ratio;
  if (h > rect.h) { h = rect.h; w = h * ratio; }
  // Cap to bounds while preserving ratio.
  if (w > bounds.w) { w = bounds.w; h = w / ratio; }
  if (h > bounds.h) { h = bounds.h; w = h * ratio; }
  let x = cx - w / 2, y = cy - h / 2;
  return clampRect({ x, y, w, h }, bounds);
}

// Which edges each handle moves.
const EDGES = {
  nw: { l: 1, t: 1 }, n: { t: 1 }, ne: { r: 1, t: 1 }, e: { r: 1 },
  se: { r: 1, b: 1 }, s: { b: 1 }, sw: { l: 1, b: 1 }, w: { l: 1 },
};

/** Resize by dragging `handle` by (dx,dy) source px. Honors ratio, minSize, bounds. */
export function resizeByHandle(rect, handle, dx, dy, { ratio, minSize = 16, bounds }) {
  const e = EDGES[handle] || {};
  let left = rect.x, top = rect.y, right = rect.x + rect.w, bottom = rect.y + rect.h;
  if (e.l) left = clampN(left + dx, 0, right - minSize);
  if (e.r) right = clampN(right + dx, left + minSize, bounds.w);
  if (e.t) top = clampN(top + dy, 0, bottom - minSize);
  if (e.b) bottom = clampN(bottom + dy, top + minSize, bounds.h);

  // Freeform: independent per-edge clamp is exactly right.
  if (!ratio) {
    return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, bounds);
  }

  // Ratio-locked. The corner OPPOSITE the moving handle is the fixed anchor;
  // the rect grows from it toward the handle. Deriving w/h then clamping each
  // dimension INDEPENDENTLY (plain clampRect) would distort the ratio when a
  // dimension hits a bound — so instead we cap w PRESERVING the ratio against
  // the room available from the anchor in BOTH axes.
  const growLeft = !!e.l, growUp = !!e.t;
  const anchorX = growLeft ? right : left;   // left edge moves → right is fixed
  const anchorY = growUp ? bottom : top;     // top edge moves  → bottom is fixed

  // Desired size from the drag: drive from the dimension the handle changed.
  let w = right - left, h = bottom - top;
  const drivesW = e.l || e.r, drivesH = e.t || e.b;
  if (drivesW && !drivesH) h = w / ratio;
  else if (drivesH && !drivesW) w = h * ratio;
  else h = w / ratio; // corner: width drives height

  // Room from the anchor toward the growth direction, within bounds.
  const availW = growLeft ? anchorX : bounds.w - anchorX;
  const availH = growUp ? anchorY : bounds.h - anchorY;

  // Cap w to the tighter of: desired, horizontal room, vertical room (as width).
  let capW = Math.min(w, availW, availH * ratio);
  // Floor PRESERVING ratio: the min side must be ≥ minSize (so BOTH sides do).
  const minW = ratio >= 1 ? minSize * ratio : minSize;
  w = Math.max(minW, capW);
  h = w / ratio;

  const x = growLeft ? anchorX - w : anchorX;
  const y = growUp ? anchorY - h : anchorY;
  return clampRect({ x, y, w, h }, bounds);
}

/** Initial crop: centered, ratio-fit if given, else ~80% of bounds. */
export function fitInitialRect(bounds, ratio) {
  if (ratio) return applyAspect({ x: 0, y: 0, w: bounds.w, h: bounds.h }, ratio, bounds);
  const w = ri(bounds.w * 0.8), h = ri(bounds.h * 0.8);
  return clampRect({ x: (bounds.w - w) / 2, y: (bounds.h - h) / 2, w, h }, bounds);
}

/** Scale a rect by a factor (source→display when factor<1, display→source with the inverse). */
export function mapRect(rect, factor) {
  return { x: ri(rect.x * factor), y: ri(rect.y * factor), w: ri(rect.w * factor), h: ri(rect.h * factor) };
}
