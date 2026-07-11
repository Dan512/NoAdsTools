// pdf-to-jpg/js/render-opts.js — PURE. DPI→pdfjs scale, output naming, px
// estimate, and a canvas-size clamp (browsers cap canvas area; iOS ~4096²). No DOM.
export const scaleForDpi = (dpi) => (Number(dpi) || 72) / 72;
export const outName = (stem, pageNum, fmt) => `${stem}-p${pageNum}.${fmt === 'png' ? 'png' : 'jpg'}`;
export function estPx(pageWidthPt, pageHeightPt, scale) {
  return { w: Math.round(pageWidthPt * scale), h: Math.round(pageHeightPt * scale) };
}
/** Reduce scale so max(w,h) ≤ maxDim. @returns {{scale:number,clamped:boolean}} */
export function clampScaleForCanvas(scale, pageWidthPt, pageHeightPt, maxDim = 4096) {
  const longest = Math.max(pageWidthPt, pageHeightPt) * scale;
  if (longest <= maxDim) return { scale, clamped: false };
  return { scale: (maxDim / Math.max(pageWidthPt, pageHeightPt)), clamped: true };
}
