# NoAdsTools

**[noadstools.com](https://noadstools.com)** — twenty-one free tools for images,
PDFs, documents and video that run entirely in your browser.

Your files are read from your device, processed there, and handed back. They
are not uploaded, not queued on a server, and not stored anywhere. There are no
ads, no analytics, no cookies and no accounts, and there never will be.

That claim is easy to make and rarely proved, so this repo and the
[privacy page](https://noadstools.com/privacy) exist to prove it.

## The tools

**Image:**
[Photo Editor](https://noadstools.com/photo-editor/) ·
[Remove EXIF data](https://noadstools.com/remove-exif/) ·
[HEIC to JPG](https://noadstools.com/heic-to-jpg/) ·
[Find Duplicate Photos](https://noadstools.com/find-duplicate-photos/) ·
[Compress images](https://noadstools.com/compress-images/) ·
[Resize Image](https://noadstools.com/resize-image/) ·
[Convert Image](https://noadstools.com/convert-image/) ·
[Crop Image](https://noadstools.com/crop-image/) ·
[Color Palette From Image](https://noadstools.com/color-palette-from-image/) ·
[Favicon Generator](https://noadstools.com/favicon-generator/)

**PDF:**
[Image to PDF](https://noadstools.com/image-to-pdf/) ·
[Merge PDF](https://noadstools.com/merge-pdf/) ·
[Split PDF](https://noadstools.com/split-pdf/) ·
[Watermark PDF](https://noadstools.com/watermark-pdf/) ·
[Sign PDF](https://noadstools.com/sign-pdf/) ·
[PDF to JPG](https://noadstools.com/pdf-to-jpg/) ·
[PDF to Text](https://noadstools.com/pdf-to-text/)

**Documents and generators:**
[Resume Builder](https://noadstools.com/resume-builder/) ·
[Cover Letter Generator](https://noadstools.com/cover-letter-generator/) ·
[QR Code Generator](https://noadstools.com/qr-code-generator/)

**Video:**
[Compress Video](https://noadstools.com/compress-video/)

## The privacy claim is enforced by the browser, not just promised

Most privacy-first tools ask you to trust a sentence in a footer. This site
ships a Content-Security-Policy with `connect-src 'self'`, which means the
browser itself refuses any request to another origin. A compromised build or a
malicious dependency could not upload your file, because the browser would
block it before it left the machine.

The policy is generated from the tool manifest by
[`scripts/gen-headers.mjs`](scripts/gen-headers.mjs) and lives in
[`_headers`](_headers). `scripts/serve.js` replays it locally so the test suite
runs under the real policy rather than a policy that only exists in production.

Two honest caveats, both stated on the privacy page as well:

- A web server still sends you the page and sees that request, including your
  IP, the way every web server does. Code comes down to your device; your data
  never goes up.
- `/photo-editor/` is the one page allowed `'unsafe-eval'`, because the
  vendored background-removal bundle compiles kernels with `new Function`. Its
  `connect-src` is still `'self'`, so the no-upload guarantee holds there too.

### Checking for yourself

Open any tool, open DevTools, select the Network tab, and use it. You will see
files arriving from noadstools.com. You will not see a request carrying your
file anywhere. [The privacy page](https://noadstools.com/privacy) lists, per
tool, exactly what gets downloaded and what triggers each download.

## How it is built

- **Vanilla JavaScript. No framework, no bundler, no build step.** Native ES
  modules, loaded directly by the browser. Editing a file and reloading is the
  entire development loop.
- **A shared shell** in [`shared/`](shared/) provides the topbar, footer,
  settings, theme and i18n. [`shared/tools.js`](shared/tools.js) is the single
  manifest that drives the tools dropdown, the homepage grid, the category
  pages, the sitemap, the CSP and the publish include-set. Adding a tool means
  adding one entry there.
- **Everything is self-hosted.** No third-party CDN, not even for fonts. Google
  Fonts logs the IP of every visitor who loads a font from it, which is exactly
  the sort of thing this site exists to avoid.
- **Heavy engines load lazily**, only when you use the feature that needs them,
  and always from this origin. A tool you never use costs you nothing.
- **Static hosting.** The repo lives on GitHub and the site is deployed by
  Cloudflare Pages from a published mirror.

## Repo size

A clone is roughly **350 MB**: about 216 MB of tracked files plus about 133 MB
of git history. Around 180 MB of that is pre-vendored binary assets under
`photo-editor/js/vendor/`, mostly the background-removal model and the ONNX
Runtime WASM kernels.

That is far larger than a typical static site, and it is deliberate. The
alternative is fetching model weights from someone else's CDN at runtime, which
would break the one promise the project is built on. Vendoring means a fresh
clone works immediately with no download step, and every byte the browser
fetches comes from an origin we control.

There are two vendor trees, which is worth knowing before you go looking:

- [`vendor/`](vendor/) holds the platform-shared libraries used by the
  nineteen newer tools: pdf.js, pdf-lib, jsQuash codecs, pica, libheif, JSZip,
  qrcodegen and Tesseract.
- [`photo-editor/js/vendor/`](photo-editor/js/vendor/) holds the photo
  editor's own set, which predates the shared tree: @imgly/background-removal
  plus the ISNET model, ONNX Runtime Web, MediaPipe BlazeFace, Tesseract,
  jsPDF and libheif. Some libraries therefore exist in both.

[THIRD-PARTY.md](THIRD-PARTY.md) has the full inventory with licenses, and
[`photo-editor/js/vendor/bgremove/.notice`](photo-editor/js/vendor/bgremove/.notice)
covers re-vendoring the model.

## Local development

Requires Node 22 (see [`.nvmrc`](.nvmrc)).

```
nvm use && npm install     # dev dependencies only (Playwright, axe-core)
npm run serve              # static server on http://localhost:4173
npm test                   # unit tests, Node's built-in runner
npm run test:browser       # Playwright (run test:browser:install first)
```

The browser suite runs five projects; chromium is the one that gates. There is
one known failure, `photo-editor/tests/browser/perf-budget.spec.js`: that page
loads about 1.7 MB against a 1.2 MB budget, which is a real problem rather than
a flaky test.

Generators that must be re-run when the manifest changes, both guarded by tests
so you cannot forget:

```
node scripts/gen-headers.mjs        # rebuild _headers (CSP) from the manifest
node scripts/gen-breadcrumbs.mjs    # rebuild BreadcrumbList JSON-LD
```

Other scripts: `install-bgremove`, `install-blazeface`, `install-tesseract`,
`install-ort` and `install-heic` re-fetch vendored assets (already committed;
only needed after bumping a pinned version), `build-icons` re-renders the app
icons from the logo, and `measure-weight` prints the initial-load wire byte
count.

## Publishing

`node scripts/publish.mjs` mirrors the tracked tree into a sibling public repo,
which Cloudflare Pages deploys. `--dry-run` reports what would be copied and
runs two guards: one fails if any published file would be swallowed by the
mirror's `.gitignore`, and one fails if a load-bearing engine file is missing.
Both exist because a bare `build/` rule once silently dropped the pdf.js engine
from the deployed site while every local check passed.

## License

[GNU AGPL v3.0](LICENSE). The AGPL's source-availability requirement is why the
running site links back to this repository from its footer and its privacy
page.

Source: <https://github.com/Dan512/NoAdsTools>
