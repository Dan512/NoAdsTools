// sign-pdf/js/place-rect.js — PURE. Map a placement box in display px (top-left
// origin, from the pdfjs-rendered canvas) to a PDF-space rect (points,
// bottom-left origin) for pdf-lib drawImage. No DOM.
export function toPdfRect(box, { renderScale, pageWidthPt, pageHeightPt }) {
  const s = renderScale || 1;
  const w = box.w / s, h = box.h / s;
  const x = box.x / s;
  const y = pageHeightPt - (box.y + box.h) / s; // flip: display-top → pdf-bottom
  return { x, y, w, h };
}
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function clampBox(box, previewW, previewH) {
  const w = clampN(box.w, 1, previewW), h = clampN(box.h, 1, previewH);
  return { x: clampN(box.x, 0, previewW - w), y: clampN(box.y, 0, previewH - h), w, h };
}
