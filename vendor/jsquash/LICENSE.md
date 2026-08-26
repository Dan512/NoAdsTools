# jSquash codecs (vendored)

Four independent [jSquash](https://github.com/jamsinclair/jSquash) packages by
Jamie Sinclair, each wrapping a Squoosh-built WebAssembly image encoder. They
are vendored side by side under this directory and share one loader,
`shared/jsquash-loader.js`. **Each codec directory carries its own detailed
`LICENSE.md`** — the table below is the index; the per-codec files hold the
upstream codec-license chain, the pinned download URLs, and the verification
notes.

- **License:** Apache-2.0 for all four wrappers (identical text, sha256
  `8c3690b09c168f196446cf5904332023bbc15eb92b6a7cee470ac829e6a65d20`, one copy
  per codec directory at `<codec>/LICENSE`). Each bundled codec carries its own
  permissive license — see the per-codec column below.
- **Source:** https://github.com/jamsinclair/jSquash (npm `@jsquash/*`)
- **Installed by:** hand-vendored — there is **no `scripts/install-jsquash.mjs`**.
  Files were fetched from the pinned unpkg URLs listed in each per-codec
  `LICENSE.md` and verified against the SHA-256 values below.
- **Consumers:** `/compress-images/` and `/convert-image/`, both via
  `shared/jsquash-loader.js` (lazy, per codec, on first encode to that format).

| Package | Version | Wrapper | Bundled codec + its license | Files | Provenance |
| --- | --- | --- | --- | --- | --- |
| `@jsquash/jpeg`   | 1.6.0 | Apache-2.0 | **mozjpeg** / libjpeg-turbo — BSD-3-Clause + IJG + zlib | `jpeg/codec/enc/mozjpeg_enc.{js,wasm}` (~283 KB) | [`jpeg/LICENSE.md`](./jpeg/LICENSE.md) |
| `@jsquash/webp`   | 1.5.0 | Apache-2.0 | **libwebp** (Google) — BSD-3-Clause | `webp/codec/enc/webp_enc_simd.{js,wasm}` (~375 KB) | [`webp/LICENSE.md`](./webp/LICENSE.md) |
| `@jsquash/avif`   | 2.1.1 | Apache-2.0 | **libavif / aom / dav1d** — BSD-2-Clause + AOM Patent License 1.0 | `avif/codec/enc/avif_enc.{js,wasm}` (~3.36 MB) | [`avif/LICENSE.md`](./avif/LICENSE.md) |
| `@jsquash/oxipng` | 2.3.0 | Apache-2.0 | **oxipng** (© 2016 Joshua Holmer) — MIT | `oxipng/codec/pkg/squoosh_oxipng{.js,_bg.wasm}` (~166 KB) | [`oxipng/LICENSE.md`](./oxipng/LICENSE.md) |

Every license above is permissive and compatible with this project's AGPL-3.0
license: the permissive terms are redistributed unmodified, and AGPL-3.0
applies to our own loader code in `shared/jsquash-loader.js`.

## sha256 (unmodified upstream files, re-verified on disk 2026-08-26)

- `jpeg/codec/enc/mozjpeg_enc.js`
  `93d3b28a4c9d3278acbbe0e23ff244ec3a6bfb13e51647b87eea311a8d747694`
- `jpeg/codec/enc/mozjpeg_enc.wasm`
  `24d4177f1c4963e2058b107189249651c61fdef125570e79b1dfb63c8bb49326`
- `webp/codec/enc/webp_enc_simd.js`
  `3038e60ebba6252baba08c691e31d1efe5036a185435daa7b4afaef3cc9273f9`
- `webp/codec/enc/webp_enc_simd.wasm`
  `39c279269ec1163b987b6d69749458e3d5b03b9585f58b6ca5455b76b504a305`
- `avif/codec/enc/avif_enc.js`
  `c6805e62cae5c1b9870fcc0448437da9e4edfc58c3da264af52361281082c63c`
- `avif/codec/enc/avif_enc.wasm`
  `d9f2a95164362af48558d176e619becfd49dd97b50b86c679b47100860522b3d`
- `oxipng/codec/pkg/squoosh_oxipng.js`
  `ac29a688c0311c09a809e33d06c9702e84c9242169f81a04589d69a8ad6a782b`
- `oxipng/codec/pkg/squoosh_oxipng_bg.wasm`
  `5ea3e53c0b4fc1b4e8d1511d35b89329d9376bec75a9c4d3c054774487e5f9a3`

## What is deliberately NOT vendored

Encoders only, single-thread only. No decoders (input images are decoded
natively via `createImageBitmap`), and no `_mt` multithread builds — those need
SharedArrayBuffer plus COOP/COEP cross-origin isolation, which would cost the
site its plain-static-hosting property. `shared/jsquash-loader.js` therefore
drives the vendored Emscripten/wasm-bindgen glue directly rather than jSquash's
own `encode.js` / `optimise.js` entry wrappers, which `import
'wasm-feature-detect'` (a bare specifier that cannot resolve with no bundler
and no import map).

## Runtime discipline

Loaded lazily, per codec, only when that output format is actually produced —
0 bytes at page boot. Every byte is served from this origin; no third-party CDN
is contacted at runtime. Sizes are disclosed on `/privacy` (the
`#compress-images` and `#convert-image` rows).
