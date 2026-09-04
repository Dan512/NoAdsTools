// split-audio/js/zip.js — lazy JSZip loader. 0 KB until "Download all";
// script-injected from /vendor/jszip/ (own origin). Same pattern as
// split-pdf/js/zip.js. A failed load must not poison the cache.
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
  cached.catch(() => { cached = null; });
  return cached;
}
