# Tesseract.js OCR engine (vendored)

- **Version:** tesseract.js **7.0.0** + tesseract.js-core **7.0.0** +
  tessdata_fast English model at commit
  `87416418657359cb625c412a48b6e1d6d41c29bd` (HEAD on 2024-08-01)
- **License:** Apache-2.0 for all three, plus four permissive licenses for
  libraries bundled inside the minified files. See "License texts" below.
- **Source:**
  - https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz
    (integrity `sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==`)
  - https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz
    (integrity `sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==`)
  - https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata
    (gzipped locally during install — Tesseract's loader expects `.traineddata.gz`)
- **Installed by:** `node scripts/install-tesseract.mjs`, which writes **both**
  vendored copies (see below) and enforces every SHA-256 below against each.
- **Consumer:** `/pdf-to-text/` via `shared/tesseract-loader.js` — lazily, and
  only when a PDF page has no text layer and needs OCR. A normal digital PDF
  never triggers it.

## Second copy

`photo-editor/js/vendor/tesseract/` holds a **byte-identical** copy of all
thirteen vendored files, serving the photo editor's "Detect text" auto-redact
feature via `photo-editor/js/ops/textDetect.js`. That copy also carries a
longer prose `.notice` covering the variant-selection rationale; this one
carries the `LICENSE.md` you are reading.

Each loader hardcodes its own URL prefix, so neither copy can be dropped
without repointing its loader. `scripts/install-tesseract.mjs` fans every file
out to both directories and verifies both, so a version bump cannot strand one
of them on stale bytes. (It wrote only the shared copy until 2026-08-26.)
Deduping the two trees is still a pending platform task.

## Files

Thirteen files per copy: nine runtime artifacts and four license texts.

| File | From | Purpose |
| --- | --- | --- |
| `tesseract.min.js` (62,961 B) | `tesseract.js` dist | Main library, UMD bundle. |
| `worker.min.js` (111,307 B) | `tesseract.js` dist | Web-worker harness. |
| `core/tesseract-core-lstm.wasm{,.js}` (~6.75 MB) | `tesseract.js-core` | LSTM-only engine, no SIMD (fallback for old browsers). |
| `core/tesseract-core-simd-lstm.wasm{,.js}` (~6.76 MB) | `tesseract.js-core` | LSTM-only engine with WASM SIMD (mid-range mobiles). |
| `core/tesseract-core-relaxedsimd-lstm.wasm{,.js}` (~6.77 MB) | `tesseract.js-core` | LSTM-only engine with relaxed SIMD (modern Chrome/Firefox/Safari). |
| `lang/eng.traineddata.gz` (1,962,155 B) | `tessdata_fast` | English LSTM model, gzipped at install time. |
| `LICENSE` (11,357 B) | `tesseract.js` `LICENSE.md` | Apache-2.0 text for tesseract.js. Renamed on the way in so this `LICENSE.md` keeps its name. |
| `core/LICENSE` (11,358 B) | `tesseract.js-core` `LICENSE` | Apache-2.0 text for tesseract.js-core. |
| `tesseract.min.js.LICENSE.txt` (149 B) | `tesseract.js` dist | Webpack-extracted banner for the library bundled into `tesseract.min.js`. |
| `worker.min.js.LICENSE.txt` (466 B) | `tesseract.js` dist | Webpack-extracted banners for the libraries bundled into `worker.min.js`. |

The two `.LICENSE.txt` sidecars must keep their filenames: each minified bundle
opens with `/*! For license information please see <name>.LICENSE.txt */`, a
bare-filename pointer that only resolves if the sidecar sits beside the bundle.

Tesseract.js auto-detects WASM feature support at runtime and loads exactly one
of the three core variants. All three are **single-threaded** — no
SharedArrayBuffer, no COOP/COEP requirement, so the site stays plain-static
hostable. The non-`-lstm` core variants (which additionally bundle Tesseract's
legacy integer-only OCR paths, ~600 KB larger each) are deliberately NOT
vendored; we never enter legacy mode. The license texts are never fetched by
the browser — they ship for attribution, not for the runtime.

## sha256 (unmodified upstream files, verified in both copies 2026-08-26)

- `tesseract.min.js`
  `000c27d9cd0def655f77b36c72a389c0ab13793aa31cb4d7aab56d09c0afbc7e`
- `worker.min.js`
  `576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d`
- `lang/eng.traineddata.gz`
  `b130d16b69e3888bc099133991a50a5b50e1da0e3ff6ca31a5496fab0fb386c3`
- `core/tesseract-core-lstm.wasm`
  `66b17df6e20c5329a17ffa9c202a47eaa3e32500b253d4c7f38e7f2bc01457c3`
- `core/tesseract-core-lstm.wasm.js`
  `eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680`
- `core/tesseract-core-simd-lstm.wasm`
  `34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea`
- `core/tesseract-core-simd-lstm.wasm.js`
  `c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38`
- `core/tesseract-core-relaxedsimd-lstm.wasm`
  `7985c92d4c64e7267d24cadffe1b2a1da6bf8aa55fdcaf953fe94fe122a24545`
- `core/tesseract-core-relaxedsimd-lstm.wasm.js`
  `861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3`
- `LICENSE`
  `b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1`
- `core/LICENSE`
  `c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08`
- `tesseract.min.js.LICENSE.txt`
  `cdf963ced7d25a0f98901a547647b4d6e2dbe0197fd78c87a059a87b0e542fe2`
- `worker.min.js.LICENSE.txt`
  `45f54171aeaa1d10c0c1a66f374b7bba1f02472b1487fbe892eec04f840002ac`

## License texts

All seven licenses below are permissive and compatible with this project's
AGPL-3.0 license: each is redistributed unmodified, and AGPL-3.0 applies to our
own loader code in `shared/tesseract-loader.js`.

**Vendored here** (full text on disk, in both copies):

| License | Covers | File |
| --- | --- | --- |
| Apache-2.0 | tesseract.js (Naptha) | `LICENSE` |
| Apache-2.0 | tesseract.js-core (Naptha) | `core/LICENSE` |
| MIT | regenerator-runtime (© Facebook), bundled into `tesseract.min.js` | `tesseract.min.js.LICENSE.txt` |
| MIT | buffer (© Feross Aboukhadijeh), bundled into `worker.min.js` | `worker.min.js.LICENSE.txt` |
| BSD-3-Clause | ieee754 (© Feross Aboukhadijeh), bundled into `worker.min.js` | `worker.min.js.LICENSE.txt` |
| MIT | regenerator-runtime + zlib.js (© imaya), bundled into `worker.min.js` | `worker.min.js.LICENSE.txt` |

The last four are the reason the sidecars matter: `tesseract.min.js` and
`worker.min.js` are webpack bundles that inline those libraries, so shipping
the bundles without their banners would redistribute four MIT/BSD projects with
no attribution at all.

**Linked, not vendored:** the tessdata_fast English model is Apache-2.0 by the
Tesseract OCR project, which publishes the license per repository rather than
inside the data file — https://github.com/tesseract-ocr/tessdata_fast.

Upstream canonical copies, for comparison against the vendored bytes:

- https://github.com/naptha/tesseract.js/blob/master/LICENSE
- https://github.com/naptha/tesseract.js-core/blob/master/LICENSE

## Runtime discipline

0 bytes at page boot. On `/pdf-to-text/` the engine loads only when OCR is
actually needed, behind a disclosure of the ~22 MB total (lib + English data +
the one matching WASM variant). Every byte is served from this origin — no
third-party CDN at runtime. Disclosed on `/privacy` (the `#pdf-to-text` row).
