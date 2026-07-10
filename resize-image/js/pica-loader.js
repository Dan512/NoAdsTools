// resize-image/js/pica-loader.js — lazy script-inject loader for the vendored
// pica resizer. 0 KB until the first resize; the UMD bundle is script-injected
// from /vendor/pica/ (own origin) and assigns a `window.pica` factory. pica
// runs its own internal worker pool (workers built from inlined Blob URLs) and
// instantiates its WASM from inlined base64 — no external worker/wasm fetch, so
// it works offline and same-origin. Same pattern as heic-to-jpg/js/zip.js.
let cached = null;
export function loadPica() {
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/pica/pica.min.js';
    s.onload = () => (typeof window.pica === 'function'
      ? resolve(window.pica)
      : reject(new Error('pica missing after load')));
    s.onerror = () => reject(new Error('failed to load pica'));
    document.head.appendChild(s);
  });
  // A failed load must not poison the cache — reset so the next resize retries.
  cached.catch(() => { cached = null; });
  return cached;
}
