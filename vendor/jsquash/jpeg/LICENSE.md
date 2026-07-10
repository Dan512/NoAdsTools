# Vendored: @jsquash/jpeg 1.6.0 (mozjpeg encoder, WebAssembly)

**Wrapper license: Apache-2.0.** Full text in [`LICENSE`](./LICENSE).
**Codec license: BSD-3-Clause + IJG License + zlib License (libjpeg-turbo /
mozjpeg).** Full text in [`codec/LICENSE.codec.md`](./codec/LICENSE.codec.md).

Both are permissive and compatible with this project's AGPL-3.0 license
(permissive terms redistributed unmodified; AGPL-3.0 applies to our own
loader code).

## Provenance

- Package: [`@jsquash/jpeg`](https://github.com/jamsinclair/jSquash) by Jamie
  Sinclair, version **1.6.0**, npm tarball (Apache-2.0). Wraps Mozilla's
  **mozjpeg** encoder (built on libjpeg-turbo, Squoosh build) compiled to
  WebAssembly via Emscripten.
- We vendor ONLY the single-thread encoder. The decoder is NOT vendored —
  input images are decoded natively via `createImageBitmap` (see the recipe
  in docs/plans). mozjpeg has no `_mt` multithread build in this package.

| File | Source path in the npm tarball | Purpose |
| --- | --- | --- |
| `codec/enc/mozjpeg_enc.js` (37.5 KB) | `codec/enc/mozjpeg_enc.js` | Emscripten `MODULARIZE` glue. `export default` factory. No bare imports; uses `import.meta.url`. |
| `codec/enc/mozjpeg_enc.wasm` (245.6 KB) | `codec/enc/mozjpeg_enc.wasm` | Compiled mozjpeg single-thread encoder. Pre-fetched by our loader and handed over as a compiled `WebAssembly.Module`. |
| `LICENSE` (11.1 KB) | `LICENSE` | Apache-2.0 (wrapper). |
| `codec/LICENSE.codec.md` (5.1 KB) | `codec/LICENSE.codec.md` | BSD-3-Clause + IJG License + zlib License — libjpeg-turbo bundles three compatible permissive licenses (IJG for the API library, a BSD-3-Clause grant for libjpeg-turbo's own modifications, zlib License for some SIMD extensions). |

## Pinned download URLs

- https://unpkg.com/@jsquash/jpeg@1.6.0/codec/enc/mozjpeg_enc.js
- https://unpkg.com/@jsquash/jpeg@1.6.0/codec/enc/mozjpeg_enc.wasm
- https://unpkg.com/@jsquash/jpeg@1.6.0/LICENSE
- https://unpkg.com/@jsquash/jpeg@1.6.0/codec/LICENSE.codec.md

## SHA-256 (unmodified upstream files, captured at download time)

- `codec/enc/mozjpeg_enc.js`
  `93d3b28a4c9d3278acbbe0e23ff244ec3a6bfb13e51647b87eea311a8d747694`
- `codec/enc/mozjpeg_enc.wasm`
  `24d4177f1c4963e2058b107189249651c61fdef125570e79b1dfb63c8bb49326`

## Verification

Byte-for-byte upstream — no local modification. Integrity verified at vendor
time: WASM magic bytes (`\0asm`) confirmed, file sizes match the upstream
unpkg manifest (38,422 B / 251,524 B — not an HTML error/redirect page), and
the glue's `export default` factory signature was read and matches the
`shared/jsquash-loader.js` recipe (`factory({ noInitialRun, instantiateWasm,
...opts })`, embind-exposed `module.encode(data, width, height, options)`).
Functional encode verification (driving this glue to produce a real JPEG)
happens in the worker/browser tests (compress-images Task 5/8), since it is
not Node-unit-testable (WASM).

## Runtime discipline

Loaded lazily only when JPEG is chosen as an OUTPUT format — 0 bytes at page
boot. All requests stay on this origin (no third-party CDN), disclosed inline
on the tool page and in its privacy panel.
