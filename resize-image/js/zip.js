// resize-image/js/zip.js — lazy JSZip loader. 0 KB until "Download ZIP" is
// clicked; the UMD bundle is script-injected from /vendor/jszip/ (own origin).
// Same pattern as heic-to-jpg/js/zip.js.
let cached = null;
export function loadJSZip() {
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jszip/jszip.min.js';
    s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip missing after load'));
    s.onerror = () => reject(new Error('failed to load JSZip'));
    document.head.appendChild(s);
  });
  // A failed load must not poison the cache — reset so the next click retries.
  cached.catch(() => { cached = null; });
  return cached;
}
