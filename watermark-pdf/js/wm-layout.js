// watermark-pdf/js/wm-layout.js — PURE watermark geometry + color. pdf-lib's
// coordinate origin is BOTTOM-LEFT; anchors are the draw point (text baseline /
// image bottom-left). No DOM/pdf-lib.
export function hexToRgb01(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  let r, g, b;
  if (/^[0-9a-fA-F]{3}$/.test(s)) { r = parseInt(s[0]+s[0],16); g = parseInt(s[1]+s[1],16); b = parseInt(s[2]+s[2],16); }
  else if (/^[0-9a-fA-F]{6}$/.test(s)) { r = parseInt(s.slice(0,2),16); g = parseInt(s.slice(2,4),16); b = parseInt(s.slice(4,6),16); }
  else return { r: 0, g: 0, b: 0 };
  return { r: r/255, g: g/255, b: b/255 };
}
export function centerAnchor(pageW, pageH, wmW, wmH) {
  return { x: (pageW - wmW) / 2, y: (pageH - wmH) / 2 };
}
// Anchor so a ROTATED watermark's centroid sits at true page center. pdf-lib
// rotates the drawn box about its draw point, so rotate the half-box offset by
// the angle before subtracting from center. Reduces to centerAnchor at 0°.
export function rotatedCenterAnchor(pageW, pageH, wmW, wmH, deg) {
  const t = (normalizeRotation(deg) * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t), hx = wmW / 2, hy = wmH / 2;
  return { x: pageW / 2 - (cos * hx - sin * hy),
           y: pageH / 2 - (sin * hx + cos * hy) };
}
export function cornerAnchor(pageW, pageH, wmW, wmH, corner, margin = 24) {
  const left = margin, right = pageW - wmW - margin;
  const bottom = margin, top = pageH - wmH - margin;
  switch (corner) {
    case 'tl': return { x: left,  y: top };
    case 'tr': return { x: right, y: top };
    case 'bl': return { x: left,  y: bottom };
    case 'br': return { x: right, y: bottom };
    default:   return centerAnchor(pageW, pageH, wmW, wmH);
  }
}
export function tilePositions(pageW, pageH, stepX, stepY, { marginX = 0, marginY = 0 } = {}) {
  const sx = Math.max(1, stepX), sy = Math.max(1, stepY);
  const out = [];
  for (let y = marginY; y < pageH; y += sy) for (let x = marginX; x < pageW; x += sx) out.push({ x, y });
  return out;
}
export const clampOpacity = (o) => Math.max(0, Math.min(1, Number(o)));
export const normalizeRotation = (deg) => ((Math.round(Number(deg) || 0) % 360) + 360) % 360;
