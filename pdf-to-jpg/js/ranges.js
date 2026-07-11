// pdf-to-jpg/js/ranges.js — PURE. Parse a page-range string into a deduped flat
// page list, clamped to [1,pageCount]. Copied from split-pdf/js/ranges.js
// (parseRanges only — this tool offers All / a range, not chunk/burst modes).
// No DOM / no pdfjs.

/** @returns {{groups:number[][], flat:number[], errors:string[]}} */
export function parseRanges(str, pageCount) {
  const out = { groups: [], flat: [], errors: [] };
  const seen = new Set();
  const raw = String(str || '').trim();
  if (!raw) return out;
  for (const tokRaw of raw.split(',')) {
    const tok = tokRaw.trim();
    if (!tok) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(tok) || /^(\d+)$/.exec(tok);
    if (!m) { out.errors.push(`"${tok}" is not a page or range`); continue; }
    let a = parseInt(m[1], 10);
    let b = m[2] != null ? parseInt(m[2], 10) : a;
    if (a === 0 || b === 0) { out.errors.push(`page numbers start at 1 ("${tok}")`); continue; }
    if (b < a) { out.errors.push(`"${tok}" is reversed`); continue; }
    if (a > pageCount) { out.errors.push(`"${tok}" is past the last page (${pageCount})`); continue; }
    b = Math.min(b, pageCount); // clamp a partial overshoot
    out.groups.push([a, b]);
    for (let p = a; p <= b; p++) if (!seen.has(p)) { seen.add(p); out.flat.push(p); }
  }
  return out;
}
