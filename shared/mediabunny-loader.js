// shared/mediabunny-loader.js — lazy loader for the vendored mediabunny
// module (MPL-2.0, ~660 KB min ESM at /vendor/mediabunny/mediabunny.min.mjs).
// Used by compress-video and split-audio; 0 bytes at page boot, dynamic-
// imported on first use. A failed load must not poison the cache: the
// promise resets on rejection so the next attempt retries, and the retry
// cache-busts the specifier so the browser's per-specifier module map
// (which caches a failed import() for the life of the document) can't
// replay the old rejection without a real re-fetch.
let cached = null;   // Promise<module>
let attempt = 0;     // bumped on every attempt; arms the next call as a retry

// Swappable so tests can inject a fake import without touching the real
// vendored asset or relying on Node's inability to resolve an absolute
// specifier. The browser path always gets the real dynamic import() below.
let importer = (url) => import(url);

/** Inject a fake `(url) => Promise<module>` importer; pass null/undefined
 * to restore the real dynamic import() (tests only). */
export function _setImporterForTest(fn) { importer = fn || ((url) => import(url)); }

// One class so callers can split "our asset failed to load" (retryable,
// never the file's fault) from "this file can't be processed".
export class EngineLoadError extends Error {
  constructor(cause) {
    super('engine_load_failed');
    this.name = 'EngineLoadError';
    if (cause !== undefined) this.cause = cause;
  }
}

export async function loadMediabunny() {
  if (cached) return cached;
  // The FIRST attempt keeps the bare, HTTP-cacheable URL — only retries
  // append ?retry=N. Cache-busting every attempt would force a real
  // re-fetch of a 660 KB asset even when the browser already has it cached
  // and the failure was transient.
  const url = '/vendor/mediabunny/mediabunny.min.mjs' + (attempt ? `?retry=${attempt}` : '');
  attempt += 1;
  cached = importer(url).catch((e) => { throw new EngineLoadError(e); });
  cached.catch(() => { cached = null; });
  return cached;
}

/** Clears the cached promise, the retry counter, and any injected test
 * importer (tests only). Named _resetLoaderForTest rather than the sibling
 * loaders' _resetForTest because compress-video/js/engine.js re-exports
 * loadMediabunny/EngineLoadError from this module while ALSO exporting its
 * own _resetForTest for its own test doubles (testCompress, testAudioFloor
 * etc.) — the two names would collide on one star-export otherwise. */
export function _resetLoaderForTest() { cached = null; attempt = 0; importer = (url) => import(url); }
