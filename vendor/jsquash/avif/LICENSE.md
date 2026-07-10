# Vendored: @jsquash/avif 2.1.1 (AVIF encoder, WebAssembly, single-thread)

**Wrapper license: Apache-2.0.** Full text in [`LICENSE`](./LICENSE).
**Codec license: BSD-2-Clause (libavif) + AOM Patent License 1.0 (aom) +
BSD-2-Clause (dav1d).** Unlike the jpeg/webp encoders, the
`@jsquash/avif@2.1.1` npm tarball does NOT bundle a `codec/LICENSE.codec.md`
file — confirmed by fetching the unpkg `?meta` file manifest for this exact
version before treating the path as absent (it 404s, it was not silently
skipped). No codec-license file is vendored here as a result; the upstream
texts are linked below instead of being copied, since we cannot vendor text
the upstream package itself does not ship.

All are permissive and compatible with this project's AGPL-3.0 license
(permissive terms redistributed unmodified; AGPL-3.0 applies to our own
loader code). The AOM Patent License 1.0 grants a royalty-free patent
license conditioned on not asserting patents against AV1 implementations —
compatible with redistribution, not a copyleft term.

## Provenance

- Package: [`@jsquash/avif`](https://github.com/jamsinclair/jSquash) by
  Jamie Sinclair, version **2.1.1**, npm tarball (Apache-2.0). Wraps
  **libavif** (AOM's reference AV1 image format library, using the **aom**
  AV1 encoder, Squoosh build) compiled to WebAssembly via Emscripten.
- We vendor ONLY the single-thread encoder (`avif_enc.js`/`.wasm`). The
  `_mt` multithread variant (`avif_enc_mt.js`, needs SharedArrayBuffer +
  COOP/COEP cross-origin isolation) and the AVIF decoder (`avif_dec.*`) are
  NOT vendored — input images (including AVIF) are decoded natively via
  `createImageBitmap`, and multithreading is deliberately skipped so the
  site stays GitHub-Pages/Cloudflare-friendly with no isolation headers
  (see the recipe in docs/plans).

| File | Source path in the npm tarball | Purpose |
| --- | --- | --- |
| `codec/enc/avif_enc.js` (38.7 KB) | `codec/enc/avif_enc.js` | Emscripten `MODULARIZE` glue. `export default` factory. No bare imports; uses `import.meta.url`. |
| `codec/enc/avif_enc.wasm` (3.32 MB) | `codec/enc/avif_enc.wasm` | Compiled libavif/aom single-thread encoder. Pre-fetched by our loader and handed over as a compiled `WebAssembly.Module`. |
| `LICENSE` (11.1 KB) | `LICENSE` | Apache-2.0 (wrapper). |

## Upstream codec license texts (not bundled by jSquash — linked, not vendored)

- libavif — BSD-2-Clause: https://github.com/AOMediaCodec/libavif/blob/main/LICENSE
- aom (AV1 codec) — BSD-2-Clause + AOM Patent License 1.0:
  https://aomedia.googlesource.com/aom/+/refs/heads/main/LICENSE and
  https://aomedia.googlesource.com/aom/+/refs/heads/main/PATENTS
- dav1d — BSD-2-Clause: https://code.videolan.org/videolan/dav1d/-/blob/master/COPYING

## Pinned download URLs

- https://unpkg.com/@jsquash/avif@2.1.1/codec/enc/avif_enc.js
- https://unpkg.com/@jsquash/avif@2.1.1/codec/enc/avif_enc.wasm
- https://unpkg.com/@jsquash/avif@2.1.1/LICENSE

## SHA-256 (unmodified upstream files, captured at download time)

- `codec/enc/avif_enc.js`
  `c6805e62cae5c1b9870fcc0448437da9e4edfc58c3da264af52361281082c63c`
- `codec/enc/avif_enc.wasm`
  `d9f2a95164362af48558d176e619becfd49dd97b50b86c679b47100860522b3d`

## Verification

Byte-for-byte upstream — no local modification. Integrity verified at
vendor time: WASM magic bytes (`\0asm`) confirmed on both files, file sizes
match the upstream unpkg `?meta` manifest (39,621 B / 3,485,872 B — not an
HTML error/redirect page). Functional encode verification (driving this
glue via `shared/jsquash-loader.js` to produce a real AVIF file) happens in
the worker/browser tests (compress-images Task 5/8), since AVIF encoding is
not Node-unit-testable.

## Runtime discipline

Loaded lazily only when AVIF is chosen as an OUTPUT format — 0 bytes at page
boot. 3.32 MB is the heaviest vendored codec; the UI shows a codec-download
+ encoding progress state and discloses the size in the privacy panel. If
`avif_enc.wasm` fails to load, AVIF output is disabled and WebP is offered
instead — no silent failure. All requests stay on this origin (no
third-party CDN).
