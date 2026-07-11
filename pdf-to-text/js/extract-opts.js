// pdf-to-text/js/extract-opts.js — PURE. OCR-need heuristic + text assembly. No DOM.
export function needsOcr(text, minChars = 8) {
  return String(text || '').replace(/\s+/g, '').length < minChars;
}
export function assembleText(pages) {
  return pages.map((p, i) => `--- Page ${p.page ?? (i + 1)} ---\n${p.text || ''}`).join('\n\n');
}
export const outName = (stem) => `${String(stem || 'document')}.txt`;
