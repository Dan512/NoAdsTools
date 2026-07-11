# Vendored: pdfjs-dist 6.1.200 (Mozilla PDF.js — PDF rendering & text extraction)

**Library license: Apache-2.0.** © Mozilla Foundation and pdf.js contributors.
Full text in [`LICENSE`](./LICENSE).
**cmaps license: BSD-3-Clause (Adobe CMap resources).**
**standard_fonts licenses:** Foxit (see
[`standard_fonts/LICENSE_FOXIT`](./standard_fonts/LICENSE_FOXIT)) and Liberation
SIL Open Font License 1.1 (see
[`standard_fonts/LICENSE_LIBERATION`](./standard_fonts/LICENSE_LIBERATION)).

All three are permissive and compatible with this project's AGPL-3.0 license
(the permissive terms are redistributed unmodified; AGPL-3.0 applies to our own
loader code in `shared/pdfjs-loader.js`).

Shared across the V1.2 PDF render/extract cluster (sign-pdf / pdf-to-jpg /
pdf-to-text) via `shared/pdfjs-loader.js` — a memoized dynamic `import()` of the
legacy ESM below, with `workerSrc`, `cMapUrl`, and `standardFontDataUrl` all
pointed at this same-origin directory.

## Provenance

- Package: [`pdfjs-dist`](https://github.com/mozilla/pdf.js) by the Mozilla
  Foundation and pdf.js contributors, version **6.1.200**, npm tarball
  (Apache-2.0).
- npm tarball integrity (subresource, from the registry):
  `sha512-o8MolyzirkkLrcdsae/HEOiIcXWI7DS5zGpvqW8xTC2YUsW30rltFw2bDGvw/fskUdEMrQm2br68jzDS5BH2vw==`
  (verified byte-for-byte at download time).
- We vendor the **legacy** build (`legacy/build/`), NOT the modern build. The
  modern build uses `Promise.withResolvers`, which needs iOS/Safari 17.4+; the
  legacy build is transpiled for older engines so signing works on iOS < 17.4.
  These legacy JS files therefore differ (different bytes, different SHA-256)
  from the modern `build/` files.
- We vendor only the minified files we run at runtime — `pdf.min.mjs` (main
  API, 509,635 B) and `pdf.worker.min.mjs` (the worker, 1,304,896 B), **≈1.73 MB
  combined** — plus the `cmaps/` (CJK/CID character maps, packed `.bcmap`) and
  `standard_fonts/` (the 14 standard PDF font substitutes) data directories, and
  the top-level `LICENSE`. The
  non-minified builds, source maps, `.d.mts` typings, sandbox build, `web/`
  viewer, and examples are NOT vendored.
- The two JS files are self-contained ES modules: **no bare-specifier imports**,
  so a single same-origin dynamic `import()` resolves the library. They
  reference `import.meta.url` (same-origin) and contain a `_createCDNWrapper`
  code path guarded by a same-origin check — used ONLY when `workerSrc` points
  at a *different* origin. Because our `workerSrc` is same-origin, that path is
  never taken and no external request is ever made.

| File(s) | Source path in the npm tarball | Purpose |
| --- | --- | --- |
| `legacy/build/pdf.min.mjs` (509,635 B) | `legacy/build/pdf.min.mjs` | Minified main API ES-module (legacy/transpiled). Named exports; no bare imports. |
| `legacy/build/pdf.worker.min.mjs` (1,304,896 B) | `legacy/build/pdf.worker.min.mjs` | Minified worker (legacy/transpiled). Loaded same-origin via `GlobalWorkerOptions.workerSrc`. |
| `cmaps/*.bcmap` (169 files, 1,167,747 B) | `cmaps/` | Packed Adobe CMap resources (BSD-3-Clause), fetched only for PDFs that need CID/CJK maps. |
| `standard_fonts/*` (16 files, 780,306 B) | `standard_fonts/` | Foxit + Liberation substitute fonts for the 14 standard PDF fonts, plus their `LICENSE_FOXIT` / `LICENSE_LIBERATION`. Fetched only when a PDF needs a standard-font substitute. |
| `LICENSE` (10,174 B) | `LICENSE` | Apache-2.0 (pdf.js). |

## Pinned download URLs

- https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.1.200.tgz (tarball — the source of every vendored file)
- https://unpkg.com/pdfjs-dist@6.1.200/legacy/build/pdf.min.mjs
- https://unpkg.com/pdfjs-dist@6.1.200/legacy/build/pdf.worker.min.mjs
- https://unpkg.com/pdfjs-dist@6.1.200/cmaps/
- https://unpkg.com/pdfjs-dist@6.1.200/standard_fonts/
- https://unpkg.com/pdfjs-dist@6.1.200/LICENSE

## SHA-256 (unmodified upstream files, captured at download time)

- `legacy/build/pdf.min.mjs`
  `1aa1611025bfb69ddebf9410ae4a7a8c269828496bd57d2fb9aacc66d09da0a3`
- `legacy/build/pdf.worker.min.mjs`
  `30237a42aa8bde8d87770bc5b55848d792953d6f1befe5958dc61314b3a67d51`

(The `cmaps/` and `standard_fonts/` files are extracted unmodified from the
integrity-verified tarball above.)

## Verification

In headless Chromium, `openPdf()` opened a 2-page PDF generated in-page with
pdf-lib: `getPage(1).render({ canvasContext, viewport, canvas })` produced a
canvas at the expected viewport dimensions with non-blank pixels, and
`getTextContent()` extracted the page's visible text. The pdfjs worker loaded
SAME-ORIGIN from `/vendor/pdfjs/legacy/build/pdf.worker.min.mjs`, and there were
ZERO external-origin requests (every byte served same-origin from
`/vendor/pdfjs/`). The files are byte-for-byte upstream — no local modification.

## Runtime discipline

Loaded lazily only when a PDF is opened — 0 bytes at page boot. `cmaps/` and
`standard_fonts/` are fetched on demand, only for PDFs that reference them. All
requests stay on this origin (no third-party CDN), disclosed inline on each tool
page and in its privacy panel.
