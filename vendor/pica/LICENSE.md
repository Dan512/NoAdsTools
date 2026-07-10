# Vendored: pica 10.0.2 (high-quality image resize in browser)

**License: MIT** (© 2014-2017 Vitaly Puzrin). Permissive and compatible with
this project's AGPL-3.0 license (permissive terms redistributed unmodified;
AGPL-3.0 applies to our own loader code). Full MIT text below.

## Provenance

- Package: [`pica`](https://github.com/nodeca/pica) by Vitaly Puzrin and
  Alexander Rodin, version **10.0.2**, MIT. High-quality resize with Lanczos
  filtering and gamma-correct downscaling.
- We vendor ONLY the pre-built UMD bundle `dist/pica.min.js`. It is fully
  self-contained: its WASM is inlined as base64 (compiled via
  `WebAssembly.Module`/`compile` at runtime) and its worker pool is created
  from **inlined Blob URLs** — there is no external `.wasm` or worker file to
  fetch. It therefore runs standalone, same-origin, and offline.

| File | Source path on unpkg | Purpose |
| --- | --- | --- |
| `pica.min.js` (54,180 bytes) | `dist/pica.min.js` | UMD bundle. Assigns a `window.pica` factory. Inlined WASM + Blob-URL workers; no bare imports, no external fetch. |

## Pinned download URL

- https://unpkg.com/pica@10.0.2/dist/pica.min.js

## SHA-256 (unmodified upstream file, captured at download time)

- `pica.min.js`
  `7c972ba274e50b8cd7dcc3a9de53560ab2db2e03c08b9fae3c94137eaea42fb0`

## Verification

Loaded the bundle standalone in headless Chromium, called
`pica().resize(src, dst)` on a generated 800×600 canvas into a 400×300 canvas,
and confirmed the destination had the correct dimensions and non-blank pixels
with **zero requests to any external origin** (workers spawn from inlined Blob
URLs; WASM instantiates from inlined base64). The file is byte-for-byte
upstream — no local modification.

## Runtime discipline

Loaded lazily only when you resize an image — 0 bytes at page boot. All
requests stay on this origin (no third-party CDN), disclosed inline on the tool
page and in its privacy panel.

## MIT License

```
(The MIT License)

Copyright (C) 2014-2017 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
