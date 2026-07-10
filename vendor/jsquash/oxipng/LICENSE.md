# Vendored: @jsquash/oxipng 2.3.0 (oxipng PNG optimizer, WebAssembly, single-thread)

**Wrapper license: Apache-2.0.** Full text in [`LICENSE`](./LICENSE).
**Codec license: MIT (oxipng, © 2016 Joshua Holmer).** Full text in
[`codec/LICENSE.codec.md`](./codec/LICENSE.codec.md).

Both are permissive and compatible with this project's AGPL-3.0 license
(permissive terms redistributed unmodified; AGPL-3.0 applies to our own
loader code).

## Provenance

- Package: [`@jsquash/oxipng`](https://github.com/jamsinclair/jSquash) by
  Jamie Sinclair, version **2.3.0**, npm tarball (Apache-2.0). Wraps
  **oxipng** (lossless PNG re-compressor, Rust, Squoosh build) compiled to
  WebAssembly via `wasm-bindgen` (NOT Emscripten — see the loader note
  below).
- We vendor ONLY the single-thread build (`codec/pkg/`). The multithread
  `codec/pkg-parallel/` build (needs `wasm-bindgen-rayon` +
  SharedArrayBuffer/COOP+COEP) is NOT vendored. There is no separate
  decoder — oxipng re-compresses PNG bytes losslessly; native
  `canvas.convertToBlob('image/png')` produces the PNG bytes it shrinks.
- **wasm-bindgen, not Emscripten**: unlike jpeg/webp/avif, this codec's glue
  is a `wasm-bindgen` module, not an Emscripten `MODULARIZE` factory. Our
  loader calls `await glue.default(wasmBytes)` (not the
  `instantiateWasm`/`factory({...})` Emscripten pattern), then calls
  `glue.optimise(pngBytes, level, interlace, optimiseAlpha)` directly.

| File | Source path in the npm tarball | Purpose |
| --- | --- | --- |
| `codec/pkg/squoosh_oxipng.js` (6.2 KB) | `codec/pkg/squoosh_oxipng.js` | `wasm-bindgen` glue. `export default` init function plus named `optimise`/`optimise_raw` exports. |
| `codec/pkg/squoosh_oxipng_bg.wasm` (160.3 KB) | `codec/pkg/squoosh_oxipng_bg.wasm` | Compiled oxipng single-thread WASM. Pre-fetched by our loader and handed to `glue.default()` as raw bytes. |
| `LICENSE` (11.1 KB) | `LICENSE` | Apache-2.0 (wrapper). |
| `codec/LICENSE.codec.md` (1.1 KB) | `codec/LICENSE.codec.md` | MIT (oxipng). |

## Pinned download URLs

- https://unpkg.com/@jsquash/oxipng@2.3.0/codec/pkg/squoosh_oxipng.js
- https://unpkg.com/@jsquash/oxipng@2.3.0/codec/pkg/squoosh_oxipng_bg.wasm
- https://unpkg.com/@jsquash/oxipng@2.3.0/LICENSE
- https://unpkg.com/@jsquash/oxipng@2.3.0/codec/LICENSE.codec.md

## SHA-256 (unmodified upstream files, captured at download time)

- `codec/pkg/squoosh_oxipng.js`
  `ac29a688c0311c09a809e33d06c9702e84c9242169f81a04589d69a8ad6a782b`
- `codec/pkg/squoosh_oxipng_bg.wasm`
  `5ea3e53c0b4fc1b4e8d1511d35b89329d9376bec75a9c4d3c054774487e5f9a3`

## Verification

Byte-for-byte upstream — no local modification. Integrity verified at
vendor time: WASM magic bytes (`\0asm`) confirmed, file size matches the
upstream unpkg manifest (164,172 B — not an HTML error/redirect page), and
the glue's exported `optimise(data, level, interlace, optimize_alpha)`
signature was read and matches the `shared/jsquash-loader.js` recipe.
Functional optimize verification (driving this glue to shrink a real PNG)
happens in the worker/browser tests (compress-images Task 5/8); this codec
is not Node-unit-testable (WASM).

## Runtime discipline

Loaded lazily only when a PNG is compressed (every PNG output goes through
oxipng after `canvas.convertToBlob('image/png')`) — 0 bytes at page boot.
All requests stay on this origin (no third-party CDN), disclosed inline on
the tool page and in its privacy panel.
