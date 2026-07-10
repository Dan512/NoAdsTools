// compress-images/js/plan-quality.js — PURE. Target-size binary search over an
// injected async encodeAt(quality) → sizeBytes, plus savings math. No WASM/DOM.

/**
 * Binary-search the highest integer quality in [minQ,maxQ] whose encoded size
 * is ≤ targetBytes, assuming size increases monotonically with quality.
 * @returns {Promise<{quality:number,size:number,ok:boolean}>} ok=false when even
 *          minQ overshoots (returns the minQ best effort).
 */
export async function searchQualityForTarget({ encodeAt, targetBytes, minQ = 40, maxQ = 95, maxPasses = 7 }) {
  let lo = minQ, hi = maxQ, passes = 0;
  // Check the floor first — if minQ already overshoots, nothing fits.
  const floorSize = await encodeAt(minQ); passes++;
  if (floorSize > targetBytes) return { quality: minQ, size: floorSize, ok: false };
  let best = { quality: minQ, size: floorSize, ok: true };
  while (lo <= hi && passes < maxPasses) {
    const mid = (lo + hi) >> 1;
    if (mid === best.quality) { // avoid a redundant re-encode of an already-measured q
      if (mid >= hi) break; else { lo = mid + 1; continue; }
    }
    const size = await encodeAt(mid); passes++;
    if (size <= targetBytes) { best = { quality: mid, size, ok: true }; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return best;
}

/** @returns {{savedBytes:number,percent:number}} clamped at 0 when new ≥ original. */
export function savings(originalBytes, newBytes) {
  const saved = Math.max(0, originalBytes - newBytes);
  const percent = originalBytes > 0 ? Math.round((saved / originalBytes) * 100) : 0;
  return { savedBytes: saved, percent };
}
