// shared/jsquash-loader.js — lazy, per-codec, same-origin ENCODE loaders for
// the vendored @jsquash codecs under /vendor/jsquash/<codec>/. Consumed
// verbatim by compress-images (and, next, convert-image) so the codec-load
// logic lives in exactly one place (the shared/dedupe.js / shared/exif.js
// precedent).
//
// Drives the vendored glue DIRECTLY — never jSquash's own `encode.js` /
// `optimise.js` entry wrappers. Those wrappers `import 'wasm-feature-detect'`
// (a bare specifier) to pick SIMD/threaded variants; that import can't
// resolve with no bundler and no import map, so this project vendors ONLY
// the single-thread/SIMD encoder each codec ships and instantiates it
// itself:
//   - Emscripten codecs (jpeg, webp, avif): dynamic-`import()` the glue
//     module, `fetch()` + `WebAssembly.compile()` the .wasm ourselves (every
//     byte same-origin — the shared/heic-loader.js precedent), then call the
//     factory as `factory({ noInitialRun: true, instantiateWasm })` so the
//     glue instantiates OUR pre-compiled module instead of doing its own
//     fetch/streaming-compile. The resolved module exposes an embind
//     `encode(data, width, height, options)` that returns the encoded bytes.
//   - wasm-bindgen codec (oxipng): `import()` the glue, `await
//     glue.default(wasmBytes)` to instantiate (accepts raw bytes directly —
//     no separate compile step needed for this codec), then call
//     `glue.optimise(bytes, level, interlace, optimiseAlpha)` directly.
//
// Worker-only: no DOM dependency (createImageBitmap + OffscreenCanvas both
// exist in module Web Workers, which is where every caller of this module
// runs). Single-thread only for every codec, including AVIF — the `_mt`
// multithread builds are deliberately NOT vendored, so nothing here needs
// SharedArrayBuffer or COOP/COEP cross-origin-isolation headers.
//
// Each loader memoizes its promise in a module-level Map so repeated calls
// share one in-flight/resolved load; a REJECTED promise deletes itself from
// the cache so the next call retries instead of permanently poisoning the
// codec (heic-loader precedent).
//
// Returned encode-function shape:
//   loadJpegEncoder() / loadWebpEncoder() / loadAvifEncoder() resolve to
//     (imageData, opts) => ArrayBuffer
//   where imageData is `{ data, width, height }` (e.g. a canvas ImageData).
//   loadOxipng() resolves to
//     (pngBytes, opts) => ArrayBuffer
//   where pngBytes is an already-encoded PNG (ArrayBuffer | Uint8Array) to
//   losslessly shrink.

// The @jsquash encoders bind their options as an Emscripten embind
// `value_object`: EVERY registered field must be present on the JS object or
// the encode call throws `TypeError: Missing field: "<name>"` (verified in a
// browser — a partial `{ quality }` is NOT enough). So each *_DEFAULTS below
// is the FULL upstream jSquash `meta.ts` default option set for that codec at
// the vendored version; callers override only `quality` (and whatever else
// they choose). The field NAMES were confirmed against the vendored .wasm
// binaries; the VALUES mirror jSquash upstream defaults.
/** mozjpeg (@jsquash/jpeg@1.6.0) — 16 fields. */
const JPEG_DEFAULTS = Object.freeze({
  quality: 75,
  baseline: false,
  arithmetic: false,
  progressive: true,
  optimize_coding: true,
  smoothing: 0,
  color_space: 3,          // MozJpegColorSpace.YCbCr
  quant_table: 3,
  trellis_multipass: false,
  trellis_opt_zero: false,
  trellis_opt_table: false,
  trellis_loops: 1,
  auto_subsample: true,
  chroma_subsample: 2,
  separate_chroma_quality: false,
  chroma_quality: 75,
});
/** libwebp SIMD (@jsquash/webp@1.5.0) — full lossy WebPConfig option set. */
const WEBP_DEFAULTS = Object.freeze({
  quality: 75,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 0,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0,
});
/** libavif/aom single-thread (@jsquash/avif@2.1.1) — 13 fields (quality 0..100). */
const AVIF_DEFAULTS = Object.freeze({
  quality: 50,
  qualityAlpha: -1,        // -1 = same as `quality`
  denoiseLevel: 0,
  tileColsLog2: 0,
  tileRowsLog2: 0,
  speed: 6,
  subsample: 1,            // 4:2:0
  chromaDeltaQ: false,
  sharpness: 0,
  tune: 0,                 // AVIFTune.auto
  enableSharpYUV: false,
  bitDepth: 8,             // 8-bit output (this build requires the field explicitly)
  monochrome: false,
});
/** @type {{level: number, interlace: boolean, optimiseAlpha: boolean}} */
const OXIPNG_DEFAULTS = Object.freeze({ level: 2, interlace: false, optimiseAlpha: false });

/** @type {Map<string, Promise<Function>>} codec key -> in-flight/resolved loader promise */
const cache = new Map();

/**
 * Fetch + compile a same-origin .wasm file into a `WebAssembly.Module`.
 * @param {string} url
 * @returns {Promise<WebAssembly.Module>}
 */
async function compileWasm(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`jsquash_wasm_fetch_failed: ${url}`);
  const bytes = await resp.arrayBuffer();
  return WebAssembly.compile(bytes);
}

/**
 * Load an Emscripten-built @jsquash encoder (jpeg/webp/avif all share this
 * shape) and return an `(imageData, opts) => ArrayBuffer` closure.
 *
 * @param {string} glueUrl - absolute path to the codec's glue .js
 * @param {string} wasmUrl - absolute path to the codec's .wasm
 * @param {Record<string, unknown>} defaults - codec's default encode options
 * @param {(data: Uint8ClampedArray|Uint8Array) => Uint8Array} [prepareInput] -
 *   pixel-data adapter. jpeg/webp accept `imageData.data` (Uint8ClampedArray)
 *   as-is; the AVIF encoder's own upstream wrapper explicitly re-wraps it as
 *   a plain `Uint8Array` first, so callers that need that pass this hook.
 * @returns {Promise<(imageData: {data: Uint8ClampedArray|Uint8Array, width: number, height: number}, opts?: object) => ArrayBuffer>}
 */
async function loadEmscriptenEncoder(glueUrl, wasmUrl, defaults, prepareInput) {
  const [{ default: factory }, wasmModule] = await Promise.all([
    import(glueUrl),
    compileWasm(wasmUrl),
  ]);
  const instantiateWasm = (imports, receiveInstance) => {
    const instance = new WebAssembly.Instance(wasmModule, imports);
    receiveInstance(instance);
    return instance.exports;
  };
  const module = await factory({ noInitialRun: true, instantiateWasm });
  return (imageData, opts) => {
    const options = { ...defaults, ...opts };
    const pixels = prepareInput ? prepareInput(imageData.data) : imageData.data;
    const result = module.encode(pixels, imageData.width, imageData.height, options);
    if (!result) throw new Error('jsquash_encode_failed');
    // wasm can't run on SharedArrayBuffers — hard-cast to ArrayBuffer
    // (mirrors @jsquash/jpeg's own encode.js comment).
    return result.buffer;
  };
}

/** Get-or-create a memoized loader promise, evicting the entry on rejection. */
function getOrLoad(key, start) {
  if (!cache.has(key)) {
    const promise = start();
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return cache.get(key);
}

/**
 * Lazy-load the JPEG (mozjpeg) encoder. Resolves to
 * `(imageData, opts) => ArrayBuffer`. Default `{ quality: 75 }`.
 * @returns {Promise<Function>}
 */
export function loadJpegEncoder() {
  return getOrLoad('jpeg', () => loadEmscriptenEncoder(
    '/vendor/jsquash/jpeg/codec/enc/mozjpeg_enc.js',
    '/vendor/jsquash/jpeg/codec/enc/mozjpeg_enc.wasm',
    JPEG_DEFAULTS,
  ));
}

/**
 * Lazy-load the WebP (libwebp, SIMD) encoder. Resolves to
 * `(imageData, opts) => ArrayBuffer`. Default `{ quality: 75 }`.
 * @returns {Promise<Function>}
 */
export function loadWebpEncoder() {
  return getOrLoad('webp', () => loadEmscriptenEncoder(
    '/vendor/jsquash/webp/codec/enc/webp_enc_simd.js',
    '/vendor/jsquash/webp/codec/enc/webp_enc_simd.wasm',
    WEBP_DEFAULTS,
  ));
}

/**
 * Lazy-load the AVIF (libavif/aom, single-thread) encoder. Resolves to
 * `(imageData, opts) => ArrayBuffer`. Default `{ quality: 50, speed: 6 }`.
 * @returns {Promise<Function>}
 */
export function loadAvifEncoder() {
  return getOrLoad('avif', () => loadEmscriptenEncoder(
    '/vendor/jsquash/avif/codec/enc/avif_enc.js',
    '/vendor/jsquash/avif/codec/enc/avif_enc.wasm',
    AVIF_DEFAULTS,
    // View the exact pixel bytes. getImageData().data is full-buffer today,
    // but a subarray-backed source (convert-image reuse) would need the
    // offset/length form — so be explicit.
    (data) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  ));
}

/**
 * Lazy-load the oxipng (wasm-bindgen, single-thread) lossless PNG shrinker.
 * Resolves to `(pngBytes, opts) => ArrayBuffer`. Default
 * `{ level: 2, interlace: false, optimiseAlpha: false }`.
 * @returns {Promise<Function>}
 */
export function loadOxipng() {
  return getOrLoad('oxipng', async () => {
    const [glue, wasmResp] = await Promise.all([
      import('/vendor/jsquash/oxipng/codec/pkg/squoosh_oxipng.js'),
      fetch('/vendor/jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'),
    ]);
    if (!wasmResp.ok) throw new Error('jsquash_wasm_fetch_failed: oxipng');
    const wasmBytes = await wasmResp.arrayBuffer();
    await glue.default(wasmBytes);
    return (pngBytes, opts) => {
      const options = { ...OXIPNG_DEFAULTS, ...opts };
      const result = glue.optimise(new Uint8Array(pngBytes), options.level, options.interlace, options.optimiseAlpha);
      if (!result) throw new Error('jsquash_optimise_failed');
      return result.buffer;
    };
  });
}

/**
 * Shared format metadata for the UI + worker (avoids drift between the two).
 * @type {Readonly<Record<'jpeg'|'webp'|'avif'|'png', Readonly<{label: string, ext: string, mime: string, lossy: boolean}>>>}
 */
export const CODEC_META = Object.freeze({
  jpeg: Object.freeze({ label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true }),
  webp: Object.freeze({ label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true }),
  avif: Object.freeze({ label: 'AVIF', ext: 'avif', mime: 'image/avif', lossy: true }),
  png: Object.freeze({ label: 'PNG', ext: 'png', mime: 'image/png', lossy: false }),
});
