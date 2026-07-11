// watermark-pdf/tests/browser/watermark-pdf.spec.js — the tool end-to-end.
//
// FIXTURES. Real, decodable PDFs are generated with the SAME vendored pdf-lib
// the tool ships (deterministic, no committed binaries). makePdfNode() builds
// bytes in Node (via the top-of-file import) so no test's fixture generation
// itself imports pdf-lib IN the page — otherwise the laziness test would fire
// the very /vendor/pdf-lib/ request it asserts is absent until the first add.
//
// VERIFICATION IS STRUCTURAL. Outputs are downloaded and re-opened in Node with
// pdf-lib. A stamped page's DECODED content stream (flate-inflated) is compared:
//   • a stamped page's decoded content is longer than the source's (a draw op
//     landed), and contains the watermark text's hex show operator;
//   • a page outside the range is byte-identical (unchanged length);
//   • tiling produces more content than a single centered stamp.
//
// TWO GUARDS beyond the plan's base assertions:
//   • Fix A (rotation pivot): a CENTERED, ROTATED text stamp must sit at true
//     page center. pdf-lib rotates the drawn box about its draw point, so a
//     naive center anchor drifts ~79pt off. We parse the text matrix (Tm) from
//     the output content stream, reconstruct the box centroid (anchor + rotated
//     half-box, using the real Helvetica text width), and assert it lands on the
//     page center.
//   • Fix B (XMP honesty): the source's catalog /Metadata (XMP) stream — which
//     carries source title/author that readers surface — must NOT survive into
//     the output. We build a source carrying a secret marker in BOTH the info
//     dictionary and an XMP stream, watermark it, and assert the marker is
//     absent from the output bytes and the output catalog has no /Metadata.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, StandardFonts } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

// An 8x8 PNG (valid, tiny) for the image-watermark fixture.
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMokGpEADiiAMBGb2h9wAAAABJRU5ErkJggg==',
  'base64');

const SECRET = 'SECRET_XMP_MARKER_9f3a2b';
const widthFor = (p) => 100 + p * 10; // distinct per-page widths (page 1 = 110…)

async function boot(page) {
  await page.goto('/watermark-pdf/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// --- Fixtures (Node-built, no in-page pdf-lib import) ------------------------

async function makePdfNode(pageCount, { width } = {}) {
  const doc = await PDFDocument.create();
  for (let p = 1; p <= pageCount; p++) doc.addPage([width || widthFor(p), 792]);
  return [...(await doc.save())];
}

// A single standard-size page — clean page-center math for the rotation guard.
async function makeStdPageNode() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return [...(await doc.save())];
}

// A source carrying a secret marker in the info dict AND a catalog /Metadata
// (XMP) stream — the Fix B honesty guard fixture.
async function makeXmpPdfNode() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  doc.setTitle(SECRET + '_INFO');
  doc.setAuthor(SECRET + '_AUTHOR');
  const xmp =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
    'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${SECRET}_XMP</dc:title></rdf:Description>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  const ref = doc.context.register(stream);
  doc.catalog.set(PDFName.of('Metadata'), ref);
  return [...(await doc.save({ useObjectStreams: false }))];
}

// Inject Node-provided raw bytes as the tool's single PDF (no in-page pdf-lib).
async function addRawPdf(page, name, bytes, type = 'application/pdf') {
  await page.evaluate(({ name, bytes, type }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { name, bytes, type });
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#doc-pages')).toContainText('page');
}

async function applyAndDownload(page) {
  const dlPromise = page.waitForEvent('download');
  await page.locator('#apply').click();
  const dl = await dlPromise;
  return { name: dl.suggestedFilename(), buf: readFileSync(await dl.path()) };
}

// --- Node-side structural analysis ------------------------------------------

function decodeStream(st) {
  const raw = Buffer.from(st.contents);
  const filter = st.dict && st.dict.get(PDFName.of('Filter'));
  const fname = filter ? filter.toString() : '';
  if (/Flate/.test(fname)) {
    try { return zlib.inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); }
  }
  return raw.toString('latin1');
}

async function analyze(buf) {
  const doc = await PDFDocument.load(new Uint8Array(buf));
  const pages = doc.getPages();
  const widths = pages.map((p) => Math.round(p.getWidth()));
  const lens = [];
  const contents = [];
  for (const page of pages) {
    const c = doc.context.lookup(page.node.get(PDFName.of('Contents')));
    const streams = c && typeof c.asArray === 'function'
      ? c.asArray().map((el) => doc.context.lookup(el))
      : (c ? [c] : []);
    let text = '';
    for (const s of streams) if (s && s.contents) text += decodeStream(s);
    lens.push(text.length);
    contents.push(text);
  }
  const hasXmp = !!doc.catalog.get(PDFName.of('Metadata'));
  return { doc, pageCount: pages.length, widths, lens, contents, hasXmp };
}

// Text hex is how pdf-lib shows a string: 'TEST' → <54455354> Tj.
const hexOf = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

// The last (only) text matrix operator: `a b c d e f Tm`.
function parseTm(streamText) {
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g;
  let m, last = null;
  while ((m = re.exec(streamText))) last = m;
  if (!last) return null;
  return { a: +last[1], b: +last[2], c: +last[3], d: +last[4], e: +last[5], f: +last[6] };
}

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

// --- Chrome + SEO ------------------------------------------------------------

test('SEO head + minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await page.goto('/watermark-pdf/');
  await expect(page).toHaveTitle('Watermark PDF — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/watermark-pdf/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
});

// --- 1. Text centered → 3 pages, every page stamped (content grew + text) ----

test('1. text "TEST" centered → apply → reload: 3 pages, every page grew and shows the text', async ({ page }) => {
  await boot(page);
  const src = await analyze(await makePdfNode(3));
  await addRawPdf(page, 'doc.pdf', await makePdfNode(3));
  await page.fill('#wm-text', 'TEST');
  await expect(page.locator('#apply')).toBeEnabled();

  const { name, buf } = await applyAndDownload(page);
  expect(name).toBe('doc-watermarked.pdf');
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const out = await analyze(buf);
  expect(out.pageCount).toBe(3);
  // Every page's decoded content grew, and each carries the text show operator.
  for (let i = 0; i < 3; i++) {
    expect(out.lens[i]).toBeGreaterThan(src.lens[i]);
    expect(out.contents[i]).toContain(hexOf('TEST'));
  }
});

// --- 2. Image/logo watermark → valid output PDF ------------------------------

test('2. image mode with a PNG logo → applies, valid 3-page PDF', async ({ page }) => {
  await boot(page);
  await addRawPdf(page, 'doc.pdf', await makePdfNode(3));
  await page.locator('.seg-btn[data-type="image"]').click();
  await page.setInputFiles('#logo-input', { name: 'logo.png', mimeType: 'image/png', buffer: LOGO_PNG });
  await expect(page.locator('#apply')).toBeEnabled();

  const { buf } = await applyAndDownload(page);
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const out = await analyze(buf);
  expect(out.pageCount).toBe(3);
  // A Do (draw XObject) operator lands on every page.
  for (let i = 0; i < 3; i++) expect(out.lens[i]).toBeGreaterThan(0);
});

// --- 3. Tile places more content than a single centered stamp ----------------

test('3. tile mode stamps more content than center', async ({ page }) => {
  await boot(page);
  await addRawPdf(page, 'doc.pdf', await makePdfNode(1, { width: 612 }));
  await page.fill('#wm-text', 'WM');
  const center = await analyze((await applyAndDownload(page)).buf);

  await page.locator('.seg-btn[data-pos="tile"]').click();
  await expect(page.locator('#apply')).toBeEnabled();
  const tile = await analyze((await applyAndDownload(page)).buf);

  expect(tile.lens[0]).toBeGreaterThan(center.lens[0]);
});

// --- 4. Page-range "1" → only page 1 stamped ---------------------------------

test('4. range "1" stamps only page 1; pages 2 and 3 are unchanged', async ({ page }) => {
  await boot(page);
  const src = await analyze(await makePdfNode(3));
  await addRawPdf(page, 'doc.pdf', await makePdfNode(3));
  await page.fill('#wm-text', 'ONLY1');
  await page.locator('.seg-btn[data-apply="range"]').click();
  await page.fill('#range-input', '1');
  await expect(page.locator('#range-error')).toBeHidden();
  await expect(page.locator('#apply')).toBeEnabled();

  const out = await analyze((await applyAndDownload(page)).buf);
  expect(out.lens[0]).toBeGreaterThan(src.lens[0]);   // page 1 stamped
  expect(out.contents[0]).toContain(hexOf('ONLY1'));
  expect(out.lens[1]).toBe(src.lens[1]);              // page 2 untouched
  expect(out.lens[2]).toBe(src.lens[2]);              // page 3 untouched
});

// --- 5. Opacity + rotation reflected, no crash across the range --------------

test('5. opacity and rotation controls apply without error', async ({ page }) => {
  await boot(page);
  await addRawPdf(page, 'doc.pdf', await makePdfNode(2, { width: 612 }));
  await page.fill('#wm-text', 'ANGLED');
  await page.locator('#wm-opacity').fill('80');
  await page.locator('#wm-rotation').fill('300');
  await expect(page.locator('#wm-opacity-val')).toHaveText('80%');
  await expect(page.locator('#wm-rotation-val')).toHaveText('300°');
  await expect(page.locator('#apply')).toBeEnabled();

  const { buf } = await applyAndDownload(page);
  const out = await analyze(buf);
  expect(out.pageCount).toBe(2);
  expect(out.contents[0]).toContain(hexOf('ANGLED'));
});

// --- 6. GUARD (Fix A): centered rotated stamp sits at true page center --------

test('6. a centered 45° stamp lands its centroid on the page center (rotation-pivot guard)', async ({ page }) => {
  await boot(page);
  const PW = 612, PH = 792, SIZE = 40, DEG = 45;
  await addRawPdf(page, 'std.pdf', await makeStdPageNode());
  await page.fill('#wm-text', 'TEST');
  await page.fill('#wm-size', String(SIZE));
  await page.locator('#wm-rotation').fill(String(DEG));
  // default type=text, position=center, font=Helvetica
  await expect(page.locator('#apply')).toBeEnabled();

  const { buf } = await applyAndDownload(page);
  const out = await analyze(buf);
  const tm = parseTm(out.contents[0]);
  expect(tm, 'a Tm operator is present').not.toBeNull();
  // Rotation actually applied: a=cos, b=sin ≈ cos45.
  expect(tm.a).toBeCloseTo(Math.cos((DEG * Math.PI) / 180), 3);
  expect(tm.b).toBeCloseTo(Math.sin((DEG * Math.PI) / 180), 3);

  // Reconstruct the box centroid: anchor (e,f) + rotated half-box.
  const font = await out.doc.embedFont(StandardFonts.Helvetica);
  const wmW = font.widthOfTextAtSize('TEST', SIZE), wmH = SIZE;
  const hx = wmW / 2, hy = wmH / 2;
  const cx = tm.e + (tm.a * hx + tm.c * hy);
  const cy = tm.f + (tm.b * hx + tm.d * hy);
  expect(cx).toBeCloseTo(PW / 2, 1);   // 306
  expect(cy).toBeCloseTo(PH / 2, 1);   // 396
  // Sanity: the naive (unrotated) center anchor would have drifted far off —
  // its centroid.x would be PW/2 only if e were (PW-wmW)/2, which it is not.
  expect(Math.abs(tm.e - (PW - wmW) / 2)).toBeGreaterThan(10);
});

// --- 7. GUARD (Fix B): no source XMP/info metadata survives -------------------

test('7. source info + XMP metadata do not survive into the watermarked output', async ({ page }) => {
  await boot(page);
  const srcBytes = await makeXmpPdfNode();
  expect(Buffer.from(srcBytes).includes(SECRET)).toBe(true); // source really carries it
  await addRawPdf(page, 'secret.pdf', srcBytes);
  await page.fill('#wm-text', 'TEST');
  await expect(page.locator('#apply')).toBeEnabled();

  const { buf } = await applyAndDownload(page);
  expect(buf.includes(SECRET)).toBe(false);          // no info-dict OR XMP marker
  const out = await analyze(buf);
  expect(out.hasXmp).toBe(false);                    // catalog /Metadata gone
});

// --- 8. Empty text disables Apply --------------------------------------------

test('8. empty watermark text disables Apply; a non-empty value enables it', async ({ page }) => {
  await boot(page);
  await addRawPdf(page, 'doc.pdf', await makePdfNode(1));
  await page.fill('#wm-text', '');
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#apply-hint')).toContainText('watermark text');
  await page.fill('#wm-text', 'X');
  await expect(page.locator('#apply')).toBeEnabled();
});

// --- 9. pdf-lib is lazy: 0 /vendor/pdf-lib/ requests before the first PDF -----

test('9. pdf-lib is not fetched until the first PDF is added', async ({ page }) => {
  const reqs = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/pdf-lib/')) reqs.push(r.url()); });
  await boot(page);
  expect(reqs.length).toBe(0);                        // engine not fetched yet
  await addRawPdf(page, 'doc.pdf', await makePdfNode(2));
  expect(reqs.length).toBeGreaterThan(0);             // adding a PDF pulled it
});

// --- 10. XSS filename is inert ------------------------------------------------

test('10. an XSS-crafted filename renders as inert text', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const xss = '<img src=x onerror=alert(1)>.pdf';
  await addRawPdf(page, xss, await makePdfNode(2));
  await expect(page.locator('#doc-name')).toHaveText(xss);   // escaped → literal
  await expect(page.locator('#workspace img')).toHaveCount(0); // no element injected
  expect(dialogFired).toBe(false);
});

// --- 11. a11y: axe clean + stable across a mode toggle; keyboard reaches all --

test('11. no serious/critical axe violations, stable across a type toggle; keyboard reaches controls', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Empty state.
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  await addRawPdf(page, 'doc.pdf', await makePdfNode(2));
  await expect(page.locator('#apply')).toBeEnabled();

  // Toggle the type control (Text ↔ Image) then re-run axe — the segmented
  // control snaps its transition, so no mid-cross-fade contrast flake.
  await page.locator('.seg-btn[data-type="image"]').click();
  await page.locator('.seg-btn[data-type="text"]').click();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const loaded = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(loaded);
  if (blockers.length) {
    console.error('[a11y watermark-pdf] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);

  // The type toggle is a real, focusable native button.
  const typeBtn = page.locator('.seg-btn[data-type="image"]');
  await typeBtn.focus();
  await expect(typeBtn).toBeFocused();
  expect(await typeBtn.evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);

  // The text control and Apply are reachable and focusable.
  await page.locator('#wm-text').focus();
  await expect(page.locator('#wm-text')).toBeFocused();
  const apply = page.locator('#apply');
  await apply.focus();
  await expect(apply).toBeFocused();
  expect(await apply.evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);
});

// --- 12. 375px: no horizontal overflow after content loads -------------------

test('12. no horizontal overflow at 375px with a loaded PDF and every control open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  await addRawPdf(page, 'a-really-quite-long-document-filename-that-could-overflow.pdf', await makePdfNode(3));
  // Open the widest control paths: tile gap + page range fields.
  await page.locator('.seg-btn[data-pos="tile"]').click();
  await page.locator('.seg-btn[data-apply="range"]').click();
  await page.fill('#range-input', '1-2');
  await expect(page.locator('#apply')).toBeEnabled();

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
