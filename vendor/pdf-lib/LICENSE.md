# Vendored: pdf-lib 1.17.1 (pure-JS PDF creation & modification)

**License: MIT.** © 2019 Andrew Dillon. Full text below.

MIT is permissive and compatible with this project's AGPL-3.0 license (the
permissive terms are redistributed unmodified; AGPL-3.0 applies to our own
loader code in `shared/pdflib-loader.js`).

Shared across the V1.2 PDF cluster (merge / split / sign / watermark) via
`shared/pdflib-loader.js` — a memoized dynamic `import()` of the ESM below.

## Provenance

- Package: [`pdf-lib`](https://github.com/Hopding/pdf-lib) by Andrew Dillon,
  version **1.17.1**, npm tarball (MIT). Pure JavaScript — no WebAssembly, no
  native deps. Bundles `tslib` (Apache-2.0 runtime helpers) inline; that header
  is visible at the top of the ESM.
- npm tarball integrity (subresource, from the registry):
  `sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==`
- We vendor ONLY the pre-built ESM dist (`pdf-lib.esm.min.js`). It is
  self-contained: no bare-specifier imports, so a single same-origin dynamic
  `import()` resolves the whole library. Exposes `PDFDocument`, `StandardFonts`,
  `rgb`, `degrees`, and the rest of the public API as named exports.

| File | Source path in the npm tarball | Purpose |
| --- | --- | --- |
| `pdf-lib.esm.min.js` (523,417 B) | `dist/pdf-lib.esm.min.js` | Minified ES-module bundle. Named exports; no bare imports. |

## Pinned download URLs

- https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js
- https://unpkg.com/pdf-lib@1.17.1/LICENSE.md

## SHA-256 (unmodified upstream file, captured at download time)

- `pdf-lib.esm.min.js`
  `72c052d97b4d5d9fa6cdbdcb7ad709f03d4ddb1122390cb3afeba4d88651d969`

## Verification

In headless Chromium, `loadPdfLib()` created a 2-page document (`PDFDocument.create`,
`StandardFonts.Helvetica`, `drawText`), then `copyPages` merged two source docs
into a third and `save()` produced bytes starting with `%PDF`; reloading those
bytes reported the expected page count. Zero external-origin requests were made
(every byte served same-origin from `/vendor/pdf-lib/`). The file is
byte-for-byte upstream — no local modification.

## Runtime discipline

Loaded lazily only when a PDF operation runs (reading page counts on the first
added PDF, and on merge) — 0 bytes at page boot. All requests stay on this
origin (no third-party CDN), disclosed inline on the tool page and in its
privacy panel.

---

MIT License

Copyright (c) 2019 Andrew Dillon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
