// heic-to-jpg/js/heic-loader.js — lazy ES-module wrapper for the vendored
// libheif-js (LGPL-3.0) HEIC/HEIF decoder at /vendor/libheif/. The ~1.1 MB
// load (81 KB JS glue + 1.03 MB WASM) happens only when the first HEIC file
// lands — 0 bytes at page boot.
//
// Adapted from photo-editor/js/vendor/heic-loader.js with the consent modal
// removed: decoding HEIC is this tool's stated purpose, so the disclosure is
// an inline note under the dropzone + a privacy-panel row instead of a modal
// (spec §3.1). Same split-WASM strategy — the JS glue is script-injected
// (UMD assigns the `libheif` factory to `window.libheif`), the WASM bytes
// are pre-fetched by us and handed to Emscripten as `wasmBinary`, keeping
// every request on this origin.
//
// Public surface:
//   loadHeicDecoder()        → Promise<{ decode(arrayBuffer) }>
//   _setHeicDecoderForTest() → test escape hatch (inject a fake decoder)
//   _resetForTest()          → wipes the cached promise + test decoder

let cached = null;      // Promise<{ decode }>
let testDecoder = null; // injected by _setHeicDecoderForTest

/**
 * Lazy-load the vendored HEIC decoder. Resolves to `{ decode }` where
 * `decode(arrayBuffer)` returns an ImageData-like
 * `{ data: Uint8ClampedArray, width, height }` for the first image in the
 * file (libheif applies EXIF/irot/imir orientation during decode).
 */
export async function loadHeicDecoder() {
  if (testDecoder) return testDecoder;
  if (cached) return cached;

  cached = (async () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('heic_loader_no_dom');
    }
    // 1. Script-inject the UMD glue (assigns window.libheif = factory).
    if (!window.libheif) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/libheif/libheif.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('heic_script_failed'));
        document.head.appendChild(s);
      });
      if (!window.libheif) throw new Error('heic_global_missing');
    }
    // 2. Pre-fetch the wasm bytes ourselves and hand them to Emscripten as
    //    `wasmBinary` — avoids the glue's own sync-XHR fallback path.
    const wasmResp = await fetch('/vendor/libheif/libheif.wasm');
    if (!wasmResp.ok) throw new Error('heic_wasm_fetch_failed');
    const wasmBinary = new Uint8Array(await wasmResp.arrayBuffer());

    // 3. Instantiate. `onRuntimeInitialized` can fire SYNCHRONOUSLY inside
    //    the factory call, so we resolve with the config object itself —
    //    Emscripten mutates the passed config into the Module instance.
    const module = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok, m) => {
        if (settled) return;
        settled = true;
        ok ? resolve(m) : reject(m);
      };
      const config = {
        wasmBinary,
        locateFile: (name) => `/vendor/libheif/${name}`,
        onRuntimeInitialized() { finish(true, config); },
        onAbort(reason) { finish(false, new Error('heic_wasm_abort: ' + reason)); },
      };
      try {
        const inst = window.libheif(config);
        // Belt-and-braces: some Emscripten outputs resolve a thenable too.
        if (inst && typeof inst.then === 'function') {
          inst.then(m => finish(true, m), e => finish(false, e));
        }
      } catch (err) {
        finish(false, err);
      }
    });
    if (!module || typeof module.HeifDecoder !== 'function') {
      throw new Error('heic_module_missing_decoder');
    }
    return { decode: (ab) => decodeOne(module, ab) };
  })();

  // A failed load must not poison the cache — reset so the next file retries.
  cached.catch(() => { cached = null; });
  return cached;
}

/** Decode the first image in a HEIC/HEIF ArrayBuffer → ImageData-like. */
async function decodeOne(module, arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer
    : new Uint8Array(arrayBuffer);
  const decoder = new module.HeifDecoder();
  // `decode` returns an array of HeifImage objects (camera HEICs hold a
  // single primary image; sequences yield several — we take the first).
  const images = decoder.decode(bytes);
  if (!images || images.length === 0) throw new Error('heic_no_images');
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('heic_invalid_dimensions');
  }
  const imageData = {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
  await new Promise((resolve, reject) => {
    image.display(imageData, (dd) => {
      if (!dd) reject(new Error('heic_display_failed'));
      else resolve();
    });
  });
  return imageData;
}

// ---------- Test escape hatches ---------------------------------------------

/**
 * Inject a fake decoder so specs don't need the real wasm. Pass `null` to clear.
 * @param {{ decode: (ab: ArrayBuffer) => Promise<{data:Uint8ClampedArray,width:number,height:number}> } | null} dec
 */
export function _setHeicDecoderForTest(dec) {
  testDecoder = dec ? Promise.resolve(dec) : null;
}

/** Test-only reset: clears the cached load + test decoder. */
export function _resetForTest() {
  cached = null;
  testDecoder = null;
}
