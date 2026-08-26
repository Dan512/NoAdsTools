# Tesseract.js OCR engine (vendored)

- **Version:** tesseract.js **7.0.0** + tesseract.js-core **7.0.0** +
  tessdata_fast English model at commit
  `87416418657359cb625c412a48b6e1d6d41c29bd` (HEAD on 2024-08-01)
- **License:** Apache-2.0 for all three. See "License texts" below.
- **Source:**
  - https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz
    (integrity `sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==`)
  - https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz
    (integrity `sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==`)
  - https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata
    (gzipped locally during install — Tesseract's loader expects `.traineddata.gz`)
- **Installed by:** `node scripts/install-tesseract.mjs`, which writes **this**
  directory (`vendor/tesseract/`) and enforces every SHA-256 below.
- **Consumer:** `/pdf-to-text/` via `shared/tesseract-loader.js` — lazily, and
  only when a PDF page has no text layer and needs OCR. A normal digital PDF
  never triggers it.

## Second copy

`photo-editor/js/vendor/tesseract/` holds a **byte-identical** copy of all nine
files (verified 2026-08-26), serving the photo editor's "Detect text"
auto-redact feature via `photo-editor/js/ops/textDetect.js`. That copy also
carries a longer prose `.notice` covering the variant-selection rationale.

`scripts/install-tesseract.mjs` currently writes **only this shared copy** — it
does not refresh the editor's. Re-running the installer after a version bump
therefore leaves the two copies out of sync until the editor's copy is updated
by hand. Deduping the two trees is a pending platform task; until then, treat
the SHA-256 list below as the pin for both.

## Files

| File | From | Purpose |
| --- | --- | --- |
| `tesseract.min.js` (62,961 B) | `tesseract.js` dist | Main library, UMD bundle. |
| `worker.min.js` (111,307 B) | `tesseract.js` dist | Web-worker harness. |
| `core/tesseract-core-lstm.wasm{,.js}` (~6.75 MB) | `tesseract.js-core` | LSTM-only engine, no SIMD (fallback for old browsers). |
| `core/tesseract-core-simd-lstm.wasm{,.js}` (~6.76 MB) | `tesseract.js-core` | LSTM-only engine with WASM SIMD (mid-range mobiles). |
| `core/tesseract-core-relaxedsimd-lstm.wasm{,.js}` (~6.77 MB) | `tesseract.js-core` | LSTM-only engine with relaxed SIMD (modern Chrome/Firefox/Safari). |
| `lang/eng.traineddata.gz` (1,962,155 B) | `tessdata_fast` | English LSTM model, gzipped at install time. |

Tesseract.js auto-detects WASM feature support at runtime and loads exactly one
of the three core variants. All three are **single-threaded** — no
SharedArrayBuffer, no COOP/COEP requirement, so the site stays plain-static
hostable. The non-`-lstm` core variants (which additionally bundle Tesseract's
legacy integer-only OCR paths, ~600 KB larger each) are deliberately NOT
vendored; we never enter legacy mode.

## sha256 (unmodified upstream files, re-verified on disk 2026-08-26)

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

## License texts

Apache-2.0, redistributed unmodified, and compatible with this project's
AGPL-3.0 license (AGPL-3.0 applies to our own loader code in
`shared/tesseract-loader.js`).

- Tesseract.js (Naptha): https://github.com/naptha/tesseract.js/blob/master/LICENSE
- tesseract.js-core (Naptha): https://github.com/naptha/tesseract.js-core/blob/master/LICENSE
- tessdata_fast (Tesseract OCR project): https://github.com/tesseract-ocr/tessdata_fast

**Known gap:** unlike every other library under `vendor/`, no full Apache-2.0
text is vendored alongside these files — neither copy of the tree ships a
`LICENSE` file, and `tesseract.min.js` opens with a pointer to a
`tesseract.min.js.LICENSE.txt` that the installer does not fetch. The links
above are currently the whole attribution. Vendoring the Apache-2.0 text plus
that upstream `LICENSE.txt` (into both copies, via
`scripts/install-tesseract.mjs`) would close it.

## Runtime discipline

0 bytes at page boot. On `/pdf-to-text/` the engine loads only when OCR is
actually needed, behind a disclosure of the ~22 MB total (lib + English data +
the one matching WASM variant). Every byte is served from this origin — no
third-party CDN at runtime. Disclosed on `/privacy` (the `#pdf-to-text` row).
