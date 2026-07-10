// convert-image/js/out-name.js — PURE. Swap a filename's extension to the
// target format's canonical extension. No DOM. Collisions (two inputs mapping
// to the same output name) are handled one layer up, at the ZIP stage.
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
export function outName(name, targetFmt) {
  const ext = EXT[targetFmt] || targetFmt;
  const base = String(name || 'image').replace(/\.[a-z0-9]+$/i, '');
  return `${base}.${ext}`;
}
