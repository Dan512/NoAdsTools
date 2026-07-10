# Vendored: @jsquash/webp 1.5.0 (libwebp encoder, WebAssembly + SIMD)

**Wrapper license: Apache-2.0.** Full text in [`LICENSE`](./LICENSE).
**Codec license: BSD-3-Clause (libwebp, © Google).** Full text in
[`codec/LICENSE.codec.md`](./codec/LICENSE.codec.md).

Both are permissive and compatible with this project's AGPL-3.0 license
(permissive terms redistributed unmodified; AGPL-3.0 applies to our own
loader code).

## Provenance

- Package: [`@jsquash/webp`](https://github.com/jamsinclair/jSquash) by Jamie
  Sinclair, version **1.5.0**, npm tarball (Apache-2.0). Wraps Google's
  **libwebp** (Squoosh build) compiled to WebAssembly via Emscripten.
- We vendor ONLY the SIMD encoder variant (all target browsers support WASM
  SIMD). The decoder is NOT vendored — input images are decoded natively via
  `createImageBitmap` (see the recipe in docs/plans).

| File | Source path in the npm tarball | Purpose |
| --- | --- | --- |
| `codec/enc/webp_enc_simd.js` (37 KB) | `codec/enc/webp_enc_simd.js` | Emscripten `MODULARIZE` glue. `export default` factory. No bare imports; uses `import.meta.url`. |
| `codec/enc/webp_enc_simd.wasm` (338 KB) | `codec/enc/webp_enc_simd.wasm` | Compiled libwebp SIMD encoder. Pre-fetched by our loader and handed over as a compiled `WebAssembly.Module`. |
| `LICENSE` (11 KB) | `LICENSE` | Apache-2.0 (wrapper). |
| `codec/LICENSE.codec.md` (1.5 KB) | `codec/LICENSE.codec.md` | BSD-3-Clause (libwebp). |

## Pinned download URLs

- https://unpkg.com/@jsquash/webp@1.5.0/codec/enc/webp_enc_simd.js
- https://unpkg.com/@jsquash/webp@1.5.0/codec/enc/webp_enc_simd.wasm
- https://unpkg.com/@jsquash/webp@1.5.0/LICENSE
- https://unpkg.com/@jsquash/webp@1.5.0/codec/LICENSE.codec.md

## SHA-256 (unmodified upstream files, captured at download time)

- `codec/enc/webp_enc_simd.js`
  `3038e60ebba6252baba08c691e31d1efe5036a185435daa7b4afaef3cc9273f9`
- `codec/enc/webp_enc_simd.wasm`
  `39c279269ec1163b987b6d69749458e3d5b03b9585f58b6ca5455b76b504a305`

## Verification

Encoded a 2×2 RGBA buffer to a valid 72-byte WebP (`RIFF`…`WEBP`…`VP8 `) in
headless Chromium, driving the glue directly (no `wasm-feature-detect`,
wasm pre-fetched and instantiated via `instantiateWasm`). Files are
byte-for-byte upstream — no local modification.

## Runtime discipline

Loaded lazily only when WebP is chosen as an OUTPUT format — 0 bytes at page
boot. All requests stay on this origin (no third-party CDN), disclosed inline
on the tool page and in its privacy panel.
