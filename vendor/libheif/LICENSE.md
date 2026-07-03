# Vendored: libheif-js 1.19.8 (libheif HEIC/HEIF decoder, WebAssembly build)

**License: GNU Lesser General Public License v3.0 (LGPL-3.0).** Full license
text in [`LICENSE`](./LICENSE) in this directory.

## Provenance

- Packaging: [`libheif-js`](https://github.com/catdad-experiments/libheif-js)
  (catdad-experiments), version **1.19.8**, npm tarball.
- Underlying library: [`libheif`](https://github.com/strukturag/libheif)
  (strukturag), compiled to WebAssembly via Emscripten.
- Files vendored (the "split WASM" variant — see the editor's copy at
  `photo-editor/js/vendor/heic/.notice` for the full rationale):

| File | Source path in the npm tarball | Purpose |
| --- | --- | --- |
| `libheif.js` (~80 KB) | `libheif-wasm/libheif.js` | Emscripten JS glue. Loaded as a UMD `<script>`; assigns the `libheif` factory to `window.libheif`. |
| `libheif.wasm` (~1.0 MB) | `libheif-wasm/libheif.wasm` | The compiled libheif WebAssembly module. Fetched on demand (see `heic-to-jpg/js/heic-loader.js`). |
| `LICENSE` (~43 KB) | `libheif/LICENSE` | Full LGPL-3.0 license text. |

This is a copy of `photo-editor/js/vendor/heic/` promoted to the shared
`vendor/` root for the `/heic-to-jpg/` tool (same precedent as
`vendor/jszip`). The editor keeps its own copy for now; dedupe is a later
platform task.

## License compatibility

LGPL-3.0 is compatible with this project's AGPL-3.0 license: the LGPL portion
is redistributed unmodified under LGPL terms; AGPL-3.0 applies to our own
loader code (`heic-to-jpg/js/heic-loader.js`).

## Runtime discipline

Loaded lazily by `/heic-to-jpg/js/heic-loader.js` — nothing is fetched until
the user's first HEIC file lands. All requests stay on this origin (no
third-party CDN), disclosed inline on the tool page and in its privacy panel.
