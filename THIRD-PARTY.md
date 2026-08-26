# Third-party code in NoAdsTools

Everything listed here is **vendored** — the source files live under our own
repository and are served from our own origin. We never load any of these from
a third-party CDN at runtime. The brand stance ("ad-free, tracker-free,
self-hosted") requires that the runtime never makes a network request to a
third-party host.

If you are auditing this site, [`/privacy`](privacy.html) mirrors this list with
a plain-language summary of what each library does, when it downloads, and what
(if anything) it sends over the network. None of the libraries below have any
network traffic.

## Where vendored code lives

There are **two vendor roots**, a historical split rather than a design:

- **`vendor/`** — the shared tree, used by the standalone tools. ~32 MB.
- **`photo-editor/js/vendor/`** — the photo editor's own tree, which predates
  the shared one and still holds the ML models. ~177 MB.

Four libraries are vendored **twice**, once in each tree. Every such pair is
byte-identical (SHA-256 verified 2026-08-26) and is written in this table as
"Two byte-identical copies: A and B", naming which install script — if any —
writes which copy. See [Libraries vendored twice](#libraries-vendored-twice).

## Vendored at build time

| Library                                              | Version | License        | Selected | Location                              | Purpose |
| ---------------------------------------------------- | ------- | -------------- | -------- | ------------------------------------- | --- |
| [JSZip](https://stuk.github.io/jszip/)               | 3.10.1  | MIT or GPL-3.0 | **MIT**  | Two byte-identical copies: `photo-editor/js/vendor/jszip.min.js` (photo editor) and `vendor/jszip/jszip.min.js` (shared tools, + [`LICENSE.md`](vendor/jszip/LICENSE.md)), each 97,630 B, sha256 `acc7e414…d59e`. Hand-vendored — no install script. | Batch export ZIP archive (Phase 10) in the editor; "Download all (ZIP)" in ten shared tools: compress-images, convert-image, crop-image, favicon-generator, find-duplicate-photos, heic-to-jpg, pdf-to-jpg, remove-exif, resize-image, split-pdf. |
| [jsPDF](https://github.com/parallax/jsPDF)           | 3.0.4   | MIT            | MIT      | Two byte-identical copies: `photo-editor/js/vendor/jspdf/` (photo editor, + `LICENSE` + `.notice`) and `vendor/jspdf/` (shared tools, + [`LICENSE.md`](vendor/jspdf/LICENSE.md)), each holding `jspdf.umd.min.js` (419,224 B, sha256 `0e2ca540…5131`). Hand-vendored — no install script. | Image-to-PDF export (v1.1 Feature 4) in the editor; `/image-to-pdf/` for the shared tools. |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.19.8  | LGPL-3.0       | LGPL-3.0 | Two byte-identical copies: `photo-editor/js/vendor/heic/` (photo editor) and `vendor/libheif/` (shared tools), each holding `libheif.js` (~80 KB) + `libheif.wasm` (~1.0 MB) + `LICENSE`. Vendored 2026-05-20. `node scripts/install-heic.mjs` writes both. | HEIC/HEIF input decoder (v1.1 Feature 5). Wraps [strukturag/libheif](https://github.com/strukturag/libheif). |
| [@imgly/background-removal](https://github.com/imgly/background-removal-js) | 1.7.0   | AGPL-3.0      | AGPL-3.0 | `photo-editor/js/vendor/bgremove/index.mjs` (~170 KB) + chunked data assets (~117 MB across 33 hash-named binary files + `resources.json`). See [`photo-editor/js/vendor/bgremove/.notice`](photo-editor/js/vendor/bgremove/.notice). | Browser-side ML background removal (Phase 11) |
| [@imgly/background-removal-data](https://github.com/imgly/background-removal-js) (data assets) | 1.7.0 (from `staticimgly.com`) | AGPL-3.0 | AGPL-3.0 | Co-located under `photo-editor/js/vendor/bgremove/` (resources.json + 33 binary chunks for the CPU-only `isnet_fp16` model + the `ort-wasm-simd-threaded` runtime + the WebGPU/JSEP variant). | ISNET fp16 segmentation model + ONNX Runtime Web SIMD WASM kernel (data half of the bg-removal feature). |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime/tree/main/js/web) | 1.21.0  | MIT            | MIT      | `photo-editor/js/vendor/onnxruntime-web/ort.bundle.min.mjs` (~400 KB) + `ort.webgpu.bundle.min.mjs` (~400 KB) + the threaded JSEP WASM kernels `ort-wasm-simd-threaded.{jsep,}.{wasm,mjs}` (~36 MB total) + `LICENSE`. Resolved at runtime via an import map in `index.html`. Re-vendor with `node scripts/install-ort.mjs`. | JS + WASM halves of the ONNX runtime. Used by @imgly/background-removal AND the BlazeFace face-detect model (Feature 1). |
| [MediaPipe BlazeFace](https://github.com/google/mediapipe) (via [Qualcomm AI Hub Models](https://huggingface.co/qualcomm/MediaPipe-Face-Detection)) | QAI v0.54.0 | Apache-2.0 | Apache-2.0 | `photo-editor/js/vendor/blazeface/face_detector.onnx` (~78 KB) + `face_detector.data` (~517 KB) + `qualcomm-metadata.json` + `.notice`. Vendored 2026-05-22. Install via `node scripts/install-blazeface.mjs`. | "Auto-detect faces" redact button (v1.2 Feature 1). Runs against the existing vendored ORT — no extra runtime download. Tile-based multi-scale scan catches small faces in crowded group photos. |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | 7.0.0 | Apache-2.0 | Apache-2.0 | Two byte-identical copies: `vendor/tesseract/` (shared tools, + [`LICENSE.md`](vendor/tesseract/LICENSE.md)) and `photo-editor/js/vendor/tesseract/` (photo editor, + `.notice`), each holding `tesseract.min.js` (62,961 B) + `worker.min.js` (111,307 B). Vendored 2026-05-22. `node scripts/install-tesseract.mjs` writes **only the shared copy**; the editor's is refreshed by hand. | OCR engine for the editor's "Detect text" redact button (v1.2 Feature 4) + preview-select mode with PII regex auto-marking; and for `/pdf-to-text/` (via `shared/tesseract-loader.js`) when a PDF page has no text layer. |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | 7.0.0 | Apache-2.0 | Apache-2.0 | `core/tesseract-core-{,simd-,relaxedsimd-}lstm.{wasm,wasm.js}` — 3 LSTM-only variants × 2 files = 6 files, ~19.3 MB — inside **each** of the two Tesseract copies above. Tesseract.js auto-picks the best variant per browser at runtime. Single-threaded — no SharedArrayBuffer / COOP / COEP required, works on plain static hosting. | WASM-compiled Tesseract OCR engine; data half of the OCR feature. |
| [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) | HEAD on 2024-08-01 (commit `87416418657359cb625c412a48b6e1d6d41c29bd`) | Apache-2.0 | Apache-2.0 | `lang/eng.traineddata.gz` (1,962,155 B gzipped; ~4 MB raw) inside **each** of the two Tesseract copies above. Gzipped during install. | English-language LSTM model for OCR. Other languages can be vendored on demand by extending `scripts/install-tesseract.mjs`. |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | 1.55.2 | MPL-2.0 | MPL-2.0 | `vendor/mediabunny/mediabunny.min.mjs` (~660 KB) + `LICENSE` + `LICENSE.md`. Vendored 2026-08-25. Install via `node scripts/install-mediabunny.mjs`. | Video compression engine for compress-video, consumed lazily on first file. |
| [@jsquash/jpeg](https://github.com/jamsinclair/jSquash) (wraps **mozjpeg**) | 1.6.0 | Apache-2.0 (wrapper) + BSD-3-Clause / IJG / zlib (mozjpeg) | as upstream | `vendor/jsquash/jpeg/codec/enc/mozjpeg_enc.{js,wasm}` (~283 KB) + `LICENSE` + `codec/LICENSE.codec.md` + [`LICENSE.md`](vendor/jsquash/jpeg/LICENSE.md). Hand-vendored — no install script. | JPEG encoder for `/compress-images/` and `/convert-image/`, via `shared/jsquash-loader.js`. |
| [@jsquash/webp](https://github.com/jamsinclair/jSquash) (wraps **libwebp**) | 1.5.0 | Apache-2.0 (wrapper) + BSD-3-Clause (libwebp) | as upstream | `vendor/jsquash/webp/codec/enc/webp_enc_simd.{js,wasm}` (~375 KB) + `LICENSE` + `codec/LICENSE.codec.md` + [`LICENSE.md`](vendor/jsquash/webp/LICENSE.md). Hand-vendored — no install script. | WebP encoder (SIMD build) for `/compress-images/` and `/convert-image/`. |
| [@jsquash/avif](https://github.com/jamsinclair/jSquash) (wraps **libavif / aom**) | 2.1.1 | Apache-2.0 (wrapper) + BSD-2-Clause + AOM Patent License 1.0 (codec) | as upstream | `vendor/jsquash/avif/codec/enc/avif_enc.{js,wasm}` (~3.36 MB) + `LICENSE` + [`LICENSE.md`](vendor/jsquash/avif/LICENSE.md). Upstream ships no `codec/LICENSE.codec.md` for this package, so the codec texts are linked rather than copied. Hand-vendored — no install script. | AVIF encoder for `/compress-images/` and `/convert-image/`. Heaviest single vendored codec. |
| [@jsquash/oxipng](https://github.com/jamsinclair/jSquash) (wraps **oxipng**) | 2.3.0 | Apache-2.0 (wrapper) + MIT (oxipng) | as upstream | `vendor/jsquash/oxipng/codec/pkg/squoosh_oxipng{.js,_bg.wasm}` (~166 KB) + `LICENSE` + `codec/LICENSE.codec.md` + [`LICENSE.md`](vendor/jsquash/oxipng/LICENSE.md). `wasm-bindgen`, not Emscripten. Hand-vendored — no install script. | Lossless PNG re-compression for `/compress-images/` and `/convert-image/`. |
| [pdfjs-dist (PDF.js)](https://github.com/mozilla/pdf.js) | 6.1.200 | Apache-2.0 (library) + BSD-3-Clause (cmaps) + Foxit & OFL-1.1 (standard fonts) | as upstream | `vendor/pdfjs/legacy/build/pdf.min.mjs` (509,635 B) + `pdf.worker.min.mjs` (1,304,896 B) + `cmaps/` (169 files, 1,167,747 B) + `standard_fonts/` (16 files, 780,306 B) + `LICENSE` + [`LICENSE.md`](vendor/pdfjs/LICENSE.md). Hand-vendored — no install script. | PDF page rendering + text extraction for `/sign-pdf/`, `/pdf-to-jpg/`, `/pdf-to-text/`, via `shared/pdfjs-loader.js`. We vendor the **legacy** (transpiled) build so signing works on iOS/Safari < 17.4. |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | MIT | `vendor/pdf-lib/pdf-lib.esm.min.js` (523,417 B) + [`LICENSE.md`](vendor/pdf-lib/LICENSE.md). Hand-vendored — no install script. | PDF creation + modification for `/merge-pdf/`, `/split-pdf/`, `/sign-pdf/`, `/watermark-pdf/`, via `shared/pdflib-loader.js`. Pure JS, no WASM. |
| [pica](https://github.com/nodeca/pica) | 10.0.2 | MIT | MIT | `vendor/pica/pica.min.js` (54,180 B) + [`LICENSE.md`](vendor/pica/LICENSE.md). Hand-vendored — no install script. | High-quality Lanczos / gamma-correct resize for `/resize-image/`, via `resize-image/js/pica-loader.js`. WASM is base64-inlined and workers spawn from Blob URLs, so there is no extra file to fetch. |
| [qrcodegen](https://github.com/nayuki/QR-Code-generator) | v1.5.0 | MIT | MIT | `vendor/qrcodegen/qrcodegen.js` (43,442 B) + [`LICENSE.md`](vendor/qrcodegen/LICENSE.md). **Locally modified**: the unmodified upstream file with a provenance header prepended and an ES-module export footer appended. Hand-vendored — no install script. | QR code generation for `/qr-code-generator/`. |

## Libraries vendored twice

Four libraries exist as a pair of byte-identical copies, one per vendor root.
The duplication is deliberate for now: each tree's loader resolves assets
relative to its own directory, so a single copy would mean one of the two
loaders reaching across trees. Deduping is a pending platform task.

The rule for this file is: **one row per library, not one row per copy.** The
Location cell opens with "Two byte-identical copies: A and B", names what each
copy carries that the other does not, and says which install script writes
which copy. A reader auditing a license needs to know both paths are the same
bytes; two rows would invite them to drift.

| Library | Copy A (shared) | Copy B (photo editor) | Written by | Verified identical |
| --- | --- | --- | --- | --- |
| JSZip 3.10.1 | `vendor/jszip/jszip.min.js` | `photo-editor/js/vendor/jszip.min.js` | hand-vendored (no script) | sha256 `acc7e414…d59e` |
| jsPDF 3.0.4 | `vendor/jspdf/` | `photo-editor/js/vendor/jspdf/` | hand-vendored (no script) | sha256 `0e2ca540…5131` |
| libheif-js 1.19.8 | `vendor/libheif/` | `photo-editor/js/vendor/heic/` | `scripts/install-heic.mjs` writes **both** | sha256 `fdc7bcb6…a34f8` (js), `615bfe84…7fb3` (wasm) |
| Tesseract 7.0.0 (9 files) | `vendor/tesseract/` | `photo-editor/js/vendor/tesseract/` | `scripts/install-tesseract.mjs` writes **only the shared copy** | all 9 files, per the pins in [`vendor/tesseract/LICENSE.md`](vendor/tesseract/LICENSE.md) |

All four pairs were re-verified byte-for-byte on 2026-08-26. Tesseract is the
one to watch: its installer refreshes a single copy, so a version bump silently
leaves the editor's tree on the old version until someone updates it by hand.

## License selections

- **JSZip** is dual-licensed (MIT-or-GPL-3.0). We pick **MIT**, the more
  permissive option. Attribution preserved in the unmodified
  `jszip.min.js` header comment in both copies. `vendor/jszip/LICENSE.md`
  records the selection for the shared copy.
- **jsPDF** is **MIT**. Attribution preserved in the unmodified
  `jspdf.umd.min.js` header comment in both copies, plus `LICENSE` beside the
  editor's copy and `LICENSE.md` beside the shared one. We vendor the UMD build
  rather than the ES build because the ES build's bare imports (`fflate`,
  `fast-png`, `@babel/runtime/*`) would require additional vendoring.
- **libheif-js** is **LGPL-3.0** (the wrapper) packaging upstream **libheif**
  (also LGPL-3.0). LGPL is compatible with our AGPL-3.0 license — the LGPL
  half is redistributed unmodified under LGPL terms (full text at
  `LICENSE` in each of the two vendored directories). We vendor the SPLIT wasm variant
  (`libheif-wasm/libheif.js` + `libheif-wasm/libheif.wasm`) rather than the
  pre-bundled `libheif-bundle.mjs` (which base64-inlines the WASM): the split
  is ~30% smaller and lets the browser stream the native binary instead of
  decoding a string at boot. Each loader — `photo-editor/js/vendor/heic-loader.js`
  (first-use consent modal) and `shared/heic-loader.js` (no modal, used by
  `/heic-to-jpg/` and `/find-duplicate-photos/`) — sets `locateFile` so the WASM
  resolves to its own vendored directory. No third-party CDN at runtime.
- **@imgly/background-removal** is **AGPL-3.0** only. Vendoring this library
  is the reason the *entire* NoAdsTools project is licensed AGPL-3.0
  (see `LICENSE`). The deployed site MUST link to its own source repository
  (this is done in the footer and on `/privacy`).
- **onnxruntime-web** is **MIT**. Microsoft's license text is preserved at
  `photo-editor/js/vendor/onnxruntime-web/LICENSE`. The threaded JSEP WASM kernels are
  required by BOTH the @imgly bg-remove pipeline AND our BlazeFace face-
  detect, hence vendored here (~36 MB) rather than under either feature's
  own directory.
- **MediaPipe BlazeFace (Qualcomm AI Hub redistribution)** is **Apache-2.0**
  via the chain: MediaPipe → `zmurez/MediaPipePyTorch` → Qualcomm AI Hub.
  Each link of the chain redistributes under Apache-2.0; the upstream
  attributions live at the Qualcomm Hugging Face repo. Provenance + SHA-256
  hashes pinned at `photo-editor/js/vendor/blazeface/.notice`.
- **Tesseract.js + tesseract.js-core** are both **Apache-2.0** by Naptha.
  Provenance at [`vendor/tesseract/LICENSE.md`](vendor/tesseract/LICENSE.md)
  (shared copy) and `photo-editor/js/vendor/tesseract/.notice` (editor copy).
  We vendor LSTM-only builds (Tesseract 5+ legacy mode dropped) which saves
  ~24 MB vs vendoring all 12 variants. **Open gap:** neither copy ships a full
  Apache-2.0 text — the two `.md`/`.notice` files link upstream instead — and
  the `tesseract.min.js.LICENSE.txt` that the bundle's header points at is not
  vendored. Fetching both in `scripts/install-tesseract.mjs` would close it.
- **tessdata_fast (English LSTM model)** is **Apache-2.0** by the
  Tesseract OCR project. Commit pinned for reproducibility in
  `scripts/install-tesseract.mjs`.
- **mediabunny** is **MPL-2.0**, a file-level copyleft license that is
  AGPL-3.0-compatible. We ship the unmodified upstream minified bundle
  (`vendor/mediabunny/mediabunny.min.mjs`) with its license text alongside
  (`vendor/mediabunny/LICENSE`).
- **The four @jsquash codecs** are each **Apache-2.0** wrappers (identical
  license text, one copy per codec directory at `vendor/jsquash/<codec>/LICENSE`)
  around a permissively-licensed encoder: mozjpeg (BSD-3-Clause + IJG + zlib),
  libwebp (BSD-3-Clause), libavif/aom/dav1d (BSD-2-Clause + AOM Patent License
  1.0), oxipng (MIT). The AOM Patent License grants a royalty-free patent
  license conditioned on not asserting patents against AV1 implementations —
  a redistribution-compatible term, not a copyleft one. Index at
  [`vendor/jsquash/LICENSE.md`](vendor/jsquash/LICENSE.md); the full chain per
  codec is in each `vendor/jsquash/<codec>/LICENSE.md`. We vendor **encoders
  only, single-thread only**: decoding rides native `createImageBitmap`, and
  the `_mt` multithread builds would require COOP/COEP cross-origin isolation,
  which would cost the site its plain-static-hosting property.
- **pdfjs-dist (PDF.js)** carries three licenses: **Apache-2.0** for the
  library (© Mozilla Foundation), **BSD-3-Clause** for the Adobe CMap
  resources under `cmaps/`, and **Foxit** + **SIL OFL 1.1** for the substitute
  fonts under `standard_fonts/`. All permissive, all AGPL-3.0-compatible; full
  texts vendored alongside. Details at
  [`vendor/pdfjs/LICENSE.md`](vendor/pdfjs/LICENSE.md).
- **pdf-lib** is **MIT** (© 2019 Andrew Dillon), bundling `tslib`
  (Apache-2.0) inline. Full text at
  [`vendor/pdf-lib/LICENSE.md`](vendor/pdf-lib/LICENSE.md).
- **pica** is **MIT** (© 2014–2017 Vitaly Puzrin). Full text at
  [`vendor/pica/LICENSE.md`](vendor/pica/LICENSE.md).
- **qrcodegen** is **MIT** (Project Nayuki). We pin **v1.5.0**, the last
  release shipping the pure-JavaScript port; later releases replaced it with a
  TypeScript port. This is the one vendored file we modify: a provenance
  header is prepended and an ES-module export footer appended, leaving the
  upstream code itself untouched. Full text at
  [`vendor/qrcodegen/LICENSE.md`](vendor/qrcodegen/LICENSE.md).

## Loading discipline

- JSZip, jsPDF, and libheif-js are loaded **lazily** — the `<script>` (or
  dynamic `import()`) is only fetched when the user takes the action that
  needs it (Export queue ZIP / PDF export / first HEIC import respectively).
  Users who never use those features never pay the bandwidth or CPU cost.
  libheif-js additionally goes through a one-time consent modal on first
  use so the ~1.1 MB download is disclosed up front.
- @imgly/background-removal is loaded **lazily** via dynamic `import()` of
  `photo-editor/js/vendor/bgremove/index.mjs` (~170 KB) on the first "Remove background"
  click. That import in turn triggers a chained dynamic
  `import("onnxruntime-web")` — resolved via the import map in `index.html`
  to `photo-editor/js/vendor/onnxruntime-web/ort.bundle.min.mjs` (~400 KB).
- The bg-removal model + WASM data — `resources.json` plus the 33
  content-addressable binary chunks under `photo-editor/js/vendor/bgremove/` totalling
  ~117 MB — is fetched chunk-by-chunk by the @imgly bundle the first time
  the user runs the model. Subsequent runs are served from the browser
  cache. Everything is served from this origin only — no third-party CDN
  at runtime.
- **BlazeFace** is loaded **lazily** on first "Auto-detect faces" click,
  gated by a one-time consent modal that discloses the ~600 KB download.
  Subsequent runs reuse the ORT session.
- **Tesseract.js** is loaded **lazily** on first "Detect text" click, gated
  by a one-time consent modal that discloses the ~6 MB total (lib + English
  language data + the one matching WASM variant). Subsequent runs reuse the
  warmed worker.
- The threaded JSEP WASM kernels under `photo-editor/js/vendor/onnxruntime-web/` load
  on demand the first time EITHER bg-remove OR face-detect runs (whichever
  the user invokes first). One-time per browser session; subsequent ORT
  features reuse the same loaded WASM.

Everything in the shared `vendor/` tree is lazy too — every standalone tool
page boots with **0 bytes** of vendored library:

- **@jsquash codecs** load per codec, the first time that output format is
  produced. AVIF (~3.36 MB) is the one worth knowing about on mobile data, so
  `/compress-images/` and `/convert-image/` show a codec-download progress
  state; if `avif_enc.wasm` fails, AVIF output is disabled and WebP offered
  instead rather than failing silently.
- **PDF.js** loads when a PDF is opened. `cmaps/` and `standard_fonts/` are
  fetched separately and only for documents that reference them — so an
  unusual PDF can trigger a second request after the engine has arrived.
- **pdf-lib** loads when a PDF operation actually runs (reading page counts on
  the first added PDF, and on merge / split / sign / watermark).
- **Tesseract** on `/pdf-to-text/` loads only when a page has no text layer and
  needs OCR. A normal digital PDF never triggers it.
- **pica** loads on resize; **qrcodegen** on `/qr-code-generator/`; **JSZip**
  only when a multi-file download is requested; **jsPDF** on "Create PDF";
  **libheif-js** on the first HEIC file; **mediabunny** on the first video.

## Disk footprint

Measured on disk 2026-08-26 as the sum of file sizes (not block allocation).

### `photo-editor/js/vendor/` — 176.9 MB, 69 files

- `bgremove/` is ~117.6 MB (170 KB code + 34 KB license + 9 KB
  manifest + ~117 MB of chunked binary data for the CPU + WebGPU ORT
  kernels and the ISNET fp16 model).
- `onnxruntime-web/` is ~35.7 MB (CPU bundle + WebGPU bundle +
  4 threaded JSEP WASM kernel files + LICENSE).
- `tesseract/` is ~21.4 MB (174 KB lib JS + 6 LSTM-only WASM files +
  1.9 MB gzipped English language data + `.notice`).
- `heic/` is ~1.11 MB (80 KB JS + 1.0 MB WASM + 43 KB LICENSE).
- `blazeface/` is ~0.57 MB (78 KB ONNX graph + 517 KB external
  weights + 3 KB metadata + `.notice`).
- `jspdf/` is ~0.40 MB (UMD bundle + LICENSE + `.notice`).
- `jszip.min.js` is 97,630 B; the three `*-loader.js` files add ~15 KB.

### `vendor/` — 32.1 MB, 234 files

- `tesseract/` is ~21.4 MB — a byte-identical copy of the editor's, and by
  itself two-thirds of this tree.
- `jsquash/` is ~4.2 MB across four codecs: avif ~3.38 MB, webp ~0.38 MB,
  jpeg ~0.30 MB, oxipng ~0.18 MB (each including its Apache-2.0 `LICENSE`).
- `pdfjs/` is ~3.6 MB across 189 files (1.73 MB of JS + 1.17 MB of `cmaps/` +
  780 KB of `standard_fonts/` + licenses).
- `libheif/` is ~1.11 MB — a byte-identical copy of the editor's `heic/`.
- `mediabunny/` is ~0.64 MB (660 KB minified bundle + ~17 KB LICENSE).
- `pdf-lib/` is ~0.50 MB (523 KB ESM bundle + LICENSE.md).
- `jspdf/` is ~0.40 MB — a byte-identical copy of the editor's.
- `pica/` is ~57 KB, `qrcodegen/` ~45 KB, `jszip/` ~98 KB (a byte-identical
  copy of the editor's).

### Total

**~209 MB across both trees**, dominated by the chunked ML models + the ORT
WASM kernels. About **22.9 MB of that is duplication** — the four
byte-identical pairs, of which Tesseract alone is 21.4 MB. A `git clone` of
this repo is consequently larger than a typical static-site repo. The trade
is: zero deploy-time install, every feature works immediately on a freshly
cloned site.

## Vendoring notes

When upgrading `@imgly/background-removal`:
1. Update `IMGLY_VERSION` (and `ORT_VERSION` if the peer dep changed) at
   the top of `scripts/install-bgremove.mjs`.
2. Run `node scripts/install-bgremove.mjs` — fetches the new chunks and
   refreshes `resources.json` automatically (existing chunks with matching
   hashes are skipped).
3. Bump the version in this table and in
   [`photo-editor/js/vendor/bgremove/.notice`](photo-editor/js/vendor/bgremove/.notice).
4. Bump `MODEL_HASH` in `photo-editor/js/ops/bgremove.js` so users re-consent.
5. Update the size disclosure in `privacy.html` if the new model size differs.
6. Re-verify the consent modal copy still reflects the chosen model.

## Fonts and other assets

- The **Onest** font (variable-weight, OFL-licensed) is self-hosted under
  `fonts/`. We do not request fonts from Google Fonts or any third-party
  service.

## Adding a new third-party library

Three things must land together — all three are user-facing claims:

1. **A `LICENSE.md` beside the vendored files**, following the shape of
   [`vendor/mediabunny/LICENSE.md`](vendor/mediabunny/LICENSE.md): version,
   license, source, SHA-256 of every file, what installed it, and which tool
   consumes it. If the upstream ships a license text, vendor that too, as
   `LICENSE` in the same directory.
2. **A row in the table above**, linking to that `LICENSE.md`. One row per
   library — if it lands in both vendor roots, use the "Two byte-identical
   copies" phrasing rather than adding a second row.
3. **A row in the per-tool table on [`/privacy`](privacy.html)**, saying what
   downloads and when, in plain language and in kilobytes.
