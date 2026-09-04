// split-audio/js/segments.js — pure cut-list arithmetic. No DOM, no
// mediabunny; Node-tested. The cut list (sorted seconds strictly inside
// (0, duration)) is the tool's only editing state; the timeline, the table,
// the presets and the chunk names all derive from it.
export const MIN_SEGMENT_SEC = 0.1;
export const MAX_CUTS = 999;
const EPS = 1e-9;   // floating-point slack: 0.3 / 0.1 is 2.9999999999999996, and 3 - 0.1 is not quite 2.9

/** Sort, dedupe, clamp away from the ends, enforce MIN_SEGMENT_SEC spacing, cap at MAX_CUTS. */
export function normalizeCuts(cuts, duration) {
  if (!(Number.isFinite(duration) && duration > 0)) return [];
  const lo = MIN_SEGMENT_SEC;
  const hi = duration - MIN_SEGMENT_SEC;
  const out = [];
  for (const t of [...cuts].filter(Number.isFinite).sort((a, b) => a - b)) {
    if (t < lo - EPS || t > hi + EPS) continue;
    if (out.length && t - out[out.length - 1] < MIN_SEGMENT_SEC - EPS) continue;
    out.push(t);
    if (out.length === MAX_CUTS) break;
  }
  return out;
}

/** @returns {{index:number, start:number, end:number}[]} */
export function segmentsFromCuts(cuts, duration) {
  const bounds = [0, ...cuts, duration];
  const segs = [];
  for (let i = 0; i + 1 < bounds.length; i++) segs.push({ index: i, start: bounds[i], end: bounds[i + 1] });
  return segs;
}

/** Returns a new array with the cut, or the SAME array when the position is invalid. */
export function addCut(cuts, t, duration) {
  const next = normalizeCuts([...cuts, t], duration);
  return next.length > cuts.length ? next : cuts;
}

export function removeCut(cuts, i) {
  return cuts.filter((_, k) => k !== i);
}

/**
 * Where cut i may go: between its neighbours (or the file ends), MIN_SEGMENT_SEC
 * away from each. Neighbours exactly MIN_SEGMENT_SEC apart are legal (EPS), and
 * then lo and hi cross by one ulp; hi is raised to lo so the range is never empty.
 */
export function cutRange(cuts, i, duration) {
  const lo = (i > 0 ? cuts[i - 1] : 0) + MIN_SEGMENT_SEC;
  const hi = (i + 1 < cuts.length ? cuts[i + 1] : duration) - MIN_SEGMENT_SEC;
  return { lo, hi: Math.max(lo, hi) };
}

/** Clamp t into cutRange(cuts, i, duration). */
export function clampCut(cuts, i, t, duration) {
  const { lo, hi } = cutRange(cuts, i, duration);
  return Math.min(Math.max(t, lo), hi);
}

export function moveCut(cuts, i, t, duration) {
  const next = cuts.slice();
  next[i] = clampCut(cuts, i, t, duration);
  return next;
}

/** n-1 evenly spaced cuts. n is capped at floor(duration / MIN_SEGMENT_SEC) so no part is shorter than the minimum; the caller reports cuts.length + 1, never n. */
export function equalParts(n, duration) {
  const max = Math.floor(duration / MIN_SEGMENT_SEC + EPS);
  const parts = Math.min(Math.max(1, Math.floor(n) || 1), max);
  const cuts = [];
  for (let k = 1; k < parts; k++) cuts.push(duration * k / parts);
  return normalizeCuts(cuts, duration);
}

/** Cuts at step, 2·step, … strictly below duration - MIN_SEGMENT_SEC, so an exact multiple leaves no empty tail. */
export function everyN(stepSec, duration) {
  if (!(stepSec > 0)) return [];
  const cuts = [];
  for (let t = stepSec; t < duration - MIN_SEGMENT_SEC && cuts.length < MAX_CUTS; t += stepSec) cuts.push(t);
  return normalizeCuts(cuts, duration);
}

/** m:ss.s below an hour, h:mm:ss.s from an hour. Rounds FIRST so 59.96 is 1:00.0, never 0:60.0. */
export function formatTime(sec, decimals = 1) {
  const p = 10 ** decimals;
  const r = Math.round(Math.max(0, sec || 0) * p) / p;
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const s = (r % 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Accepts ss, m:ss, m:ss.s, h:mm:ss, h:mm:ss.s. Returns NaN for anything else. */
export function parseTime(str) {
  const parts = String(str ?? '').trim().split(':');
  if (parts.length < 1 || parts.length > 3) return NaN;
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function splitName(filename) {
  const i = filename.lastIndexOf('.');
  if (i <= 0) return { base: filename, ext: '' };
  return { base: filename.slice(0, i), ext: filename.slice(i + 1) };
}

/** goblins-01.wav; zero-padded to the width of the count, at least 2. */
export function chunkName(base, index, count, ext) {
  const width = Math.max(2, String(count).length);
  return `${base}-${String(index + 1).padStart(width, '0')}.${ext}`;
}

/** Proportional to file size (labelled ≈ in the UI because VBR). */
export function estimateBytes(fileSize, segDuration, totalDuration) {
  return totalDuration > 0 ? Math.round(fileSize * segDuration / totalDuration) : 0;
}
