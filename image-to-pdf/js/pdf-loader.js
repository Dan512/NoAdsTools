// image-to-pdf/js/pdf-loader.js — lazy jsPDF loader. 0 KB until "Create PDF"
// is clicked; the UMD bundle is script-injected from /vendor/jspdf/ (own
// origin, never a third-party CDN). Same pattern as remove-exif's zip.js.
let cached = null;
export function loadJsPdf() {
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jspdf/jspdf.umd.min.js';
    s.onload = () => (window.jspdf && window.jspdf.jsPDF)
      ? resolve(window.jspdf.jsPDF)
      : reject(new Error('jsPDF missing after load'));
    s.onerror = () => reject(new Error('failed to load jsPDF'));
    document.head.appendChild(s);
  });
  // A failed load must not poison the cache — reset so the next click retries.
  cached.catch(() => { cached = null; });
  return cached;
}
