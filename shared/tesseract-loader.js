// shared/tesseract-loader.js — lazy Tesseract.js OCR (Apache-2.0). ~22 MB,
// loaded ONLY when a page needs OCR. All assets same-origin (/vendor/tesseract/).
let cached = null, testOcr = null;
/** Inject a fake `{ recognize(canvasOrImage) → Promise<{text}> }` for tests. */
export function _setOcrForTest(o) { testOcr = o ? Promise.resolve(o) : null; }
export function _resetForTest() { cached = null; testOcr = null; }
export function loadOcr() {
  if (testOcr) return testOcr;
  if (cached) return cached;
  cached = (async () => {
    if (!window.Tesseract) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = '/vendor/tesseract/tesseract.min.js';
        s.onload = res; s.onerror = () => rej(new Error('tesseract_script_failed'));
        document.head.appendChild(s);
      });
      if (!window.Tesseract) throw new Error('tesseract_global_missing');
    }
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath:   '/vendor/tesseract/core/',
      langPath:   '/vendor/tesseract/lang/',
    });
    return { recognize: async (src) => (await worker.recognize(src)).data };
  })();
  cached.catch(() => { cached = null; }); // failed load must not poison the cache
  return cached;
}
