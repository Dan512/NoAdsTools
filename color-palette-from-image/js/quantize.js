// color-palette-from-image/js/quantize.js — PURE median-cut color quantization.
// Input: array of [r,g,b] samples. Output: up to N representative colors,
// ordered most-populous first. No DOM.

function bucketFor(samples) {
  let rmin=255,gmin=255,bmin=255,rmax=0,gmax=0,bmax=0;
  for (const [r,g,b] of samples) {
    if (r<rmin) rmin=r; if (r>rmax) rmax=r;
    if (g<gmin) gmin=g; if (g>gmax) gmax=g;
    if (b<bmin) bmin=b; if (b>bmax) bmax=b;
  }
  return { samples, ranges: [rmax-rmin, gmax-gmin, bmax-bmin] };
}

function splitBucket(bucket) {
  // Split along the channel with the widest range, at the median.
  const ch = bucket.ranges.indexOf(Math.max(...bucket.ranges));
  const sorted = bucket.samples.slice().sort((a,b) => a[ch]-b[ch]);
  const mid = sorted.length >> 1;
  const lo = sorted.slice(0, mid), hi = sorted.slice(mid);
  if (!lo.length || !hi.length) return null; // can't split (all equal on this axis)
  return [bucketFor(lo), bucketFor(hi)];
}

function averageColor(samples) {
  let r=0,g=0,b=0;
  for (const s of samples) { r+=s[0]; g+=s[1]; b+=s[2]; }
  const n = samples.length;
  return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
}

/** @returns {Array<[number,number,number]>} up to `count` colors, most-populous first. */
export function quantize(samples, count) {
  if (!samples || samples.length === 0) return [];
  let buckets = [bucketFor(samples)];
  while (buckets.length < count) {
    // Split the bucket with the largest population * range (biggest visual mass).
    let idx = -1, best = -1;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const score = b.samples.length * Math.max(...b.ranges);
      if (score > best && Math.max(...b.ranges) > 0) { best = score; idx = i; }
    }
    if (idx === -1) break; // nothing splittable
    const parts = splitBucket(buckets[idx]);
    if (!parts) break;
    buckets.splice(idx, 1, parts[0], parts[1]);
  }
  const seen = new Set();
  return buckets
    .sort((a, b) => b.samples.length - a.samples.length)
    .map((b) => averageColor(b.samples))
    .filter((c) => {
      const key = (c[0] << 16) | (c[1] << 8) | c[2];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Most-populous cluster's representative, or null for empty input. */
export function dominantColor(samples) {
  const pal = quantize(samples, 4);
  return pal.length ? pal[0] : null;
}
