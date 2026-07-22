// sign-pdf/tests/browser/sign-pdf.spec.js — the tool end-to-end.
//
// FIXTURES. Real, decodable PDFs are generated with the SAME vendored pdf-lib the
// tool ships (deterministic, no committed binaries). Two paths, deliberately:
//   • loadPdf() imports pdf-lib IN-PAGE and feeds one File to #file-input — used
//     by every test that doesn't measure engine laziness. `content:true` draws a
//     black bar so the pdfjs render is provably non-blank; `content:false` leaves
//     a WHITE page so the coordinate test can attribute every dark pixel to the
//     signature ink alone.
//   • makePdfNode() builds bytes in Node (top-of-file import) so the laziness
//     test can open a PDF WITHOUT the harness itself having pulled pdf-lib into
//     the page — otherwise the fixture generator would fire the very
//     /vendor/pdf-lib/ request that test asserts is absent until Apply.
//
// HARNESS NOTES (from the reviewer):
//   (a) page.mouse does NOT drive the PointerEvents draw pad — synthetic
//       PointerEvents with clientX/clientY + pointerId are dispatched to
//       #draw-canvas directly (see photo-editor/.../brushTool.spec.js).
//   (b) scrollIntoViewIfNeeded() (not scrollIntoView) keeps the pad/box on-screen.
//   (c) pdfjs' display render is requestAnimationFrame-driven and stalls on a
//       throttled/backgrounded page (playbook §4). boot() shims rAF→timer so the
//       render always advances headless, and bringToFront() foregrounds the page.
//   (d) the coordinate test places the box hard against the TOP of the page, then
//       re-renders the OUTPUT page with pdfjs and asserts the ink is in the top
//       band and the bottom band is clean — the real accuracy check for the
//       display→PDF-space Y-flip.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { PDFDocument } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

const BASE = 'http://localhost:4173';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function boot(page) {
  // pdfjs render only advances while requestAnimationFrame fires; a throttled or
  // occluded page would hang the render promise (playbook §4). Replace rAF with a
  // timer so it always advances in headless/parallel runs. Applied before goto.
  await page.addInitScript(() => {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  });
  await page.goto('/sign-pdf/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.bringToFront();
}

// --- Fixtures ----------------------------------------------------------------

// In-page: build one PDF with pdf-lib and feed it to the file input. content:true
// draws a black bar (non-blank render); content:false leaves white pages.
async function loadPdf(page, { pages = 1, w = 400, h = 560, name = 'doc.pdf', content = false } = {}) {
  await page.evaluate(async ({ pages, w, h, name, content }) => {
    const { PDFDocument, rgb } = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) {
      const p = doc.addPage([w, h]);
      if (content) p.drawRectangle({ x: w * 0.2, y: h * 0.42, width: w * 0.6, height: h * 0.12, color: rgb(0, 0, 0) });
    }
    const bytes = await doc.save();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { pages, w, h, name, content });
}

// Node-side deterministic PDF (no in-page pdf-lib import).
async function makePdfNode(pages, w, h) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([w, h]);
  return [...(await doc.save())];
}

async function loadRawPdf(page, bytes, name) {
  await page.evaluate(({ bytes, name }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { bytes, name });
}

async function waitLoaded(page, numPages) {
  await expect(page.locator('.page-frame')).toHaveCount(numPages);
  await expect(page.locator('#place-hint')).toBeVisible();
}

// Count dark pixels in a page-frame's rendered canvas (proves a real render).
async function frameDarkPixels(page, index) {
  return page.evaluate((i) => {
    const frame = document.querySelectorAll('.page-frame')[i];
    const c = frame && frame.querySelector('canvas');
    if (!c) return -1;
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let dark = 0;
    for (let p = 0; p < data.length; p += 4) if (data[p] < 200 && data[p + 1] < 200 && data[p + 2] < 200) dark++;
    return dark;
  }, index);
}

// Synthetic pointer drag across the draw pad (page.mouse does NOT drive it).
async function drawOnPad(page) {
  await page.locator('#draw-canvas').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const c = document.getElementById('draw-canvas');
    const r = c.getBoundingClientRect();
    const ev = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
    });
    const x0 = r.left + r.width * 0.15, y0 = r.top + r.height * 0.3;
    const x1 = r.left + r.width * 0.85, y1 = r.top + r.height * 0.7;
    c.dispatchEvent(ev('pointerdown', x0, y0));
    for (let i = 1; i <= 10; i++) { const t = i / 11; c.dispatchEvent(ev('pointermove', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)); }
    c.dispatchEvent(ev('pointerup', x1, y1));
  });
}

async function typeName(page, name) {
  await page.locator('.seg-btn[data-mode="type"]').click();
  await page.locator('#type-name').fill(name);
}

// Read the signature preview blob out of the placement box → PNG magic + length.
async function readSigPng(page) {
  return page.evaluate(async () => {
    const img = document.querySelector('.place-box .sig-preview');
    if (!img || !img.src.startsWith('blob:')) return { isPng: false, len: 0 };
    const buf = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    return { isPng: buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, len: buf.length };
  });
}

// Nudge the focused placement box to the very top of the page via the keyboard
// (Shift+ArrowUp = 10px; clampBox pins it at y=0). Exercises the a11y path too.
async function pinBoxTop(page) {
  const box = page.locator('.place-box');
  await box.scrollIntoViewIfNeeded();
  await box.focus();
  const top = await box.evaluate((el) => parseFloat(el.style.top) || 0);
  const presses = Math.ceil(top / 10) + 2;
  for (let i = 0; i < presses; i++) await page.keyboard.press('Shift+ArrowUp');
}

// Render one page (1-based) of a signed PDF with pdfjs in-page and measure dark
// pixels in a TOP band vs a BOTTOM band — the coordinate-accuracy probe.
async function renderAndScanBands(page, bytes, pageNum) {
  return page.evaluate(async ({ bytes, pageNum }) => {
    const { openPdf } = await import('/shared/pdfjs-loader.js');
    const pdf = await openPdf(new Uint8Array(bytes));
    const pg = await pdf.getPage(pageNum);
    const vp = pg.getViewport({ scale: 1 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    document.body.appendChild(c);
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp, canvas: c }).promise;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    const band = (y0, y1) => {
      const d = ctx.getImageData(0, y0, W, Math.max(1, y1 - y0)).data;
      let dark = 0;
      for (let p = 0; p < d.length; p += 4) if (d[p + 3] > 10 && d[p] < 200 && d[p + 1] < 200 && d[p + 2] < 200) dark++;
      return dark;
    };
    const top = band(0, Math.floor(H * 0.45));
    const bottom = band(Math.floor(H * 0.55), H);
    c.remove();
    return { top, bottom, W, H };
  }, { bytes, pageNum });
}

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

// --- Chrome + SEO ------------------------------------------------------------

test('SEO head + minimal chrome (single h1, no lang/settings, JSON-LD)', async ({ page }) => {
  await page.goto('/sign-pdf/');
  await expect(page).toHaveTitle('Sign PDF — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/sign-pdf/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  expect(ld).toContain('"UtilitiesApplication"');
  expect(ld).toContain('"price": "0"');
  expect(ld).toContain('agpl-3.0');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
});

// --- 1. Pages render to non-blank canvases -----------------------------------

test('1. every page renders to a non-blank canvas', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 2, w: 400, h: 560, content: true });
  await waitLoaded(page, 2);
  await expect.poll(() => frameDarkPixels(page, 0)).toBeGreaterThan(0);
  await expect.poll(() => frameDarkPixels(page, 1)).toBeGreaterThan(0);
});

// --- 2. Draw → non-empty signature PNG ---------------------------------------

test('2. drawing on the pad produces a non-empty signature PNG', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 1, w: 400, h: 560, content: true });
  await waitLoaded(page, 1);
  await drawOnPad(page);
  await expect(page.locator('.place-box')).toBeVisible();
  const sig = await readSigPng(page);
  expect(sig.isPng).toBe(true);
  expect(sig.len).toBeGreaterThan(50);
});

// --- 3. Type → non-empty signature PNG ---------------------------------------

test('3. typing a name produces a non-empty signature PNG', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 1, w: 400, h: 560, content: true });
  await waitLoaded(page, 1);
  await typeName(page, 'Alex Morgan');
  await expect(page.locator('.place-box')).toBeVisible();
  const sig = await readSigPng(page);
  expect(sig.isPng).toBe(true);
  expect(sig.len).toBeGreaterThan(50);
});

// --- 4. Place + Apply → signed PDF, page count preserved, coordinate-accurate -

test('4. place + Apply signs the PDF: page count kept and ink lands where placed', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 2, w: 400, h: 560, content: false, name: 'doc.pdf' });
  await waitLoaded(page, 2);

  await typeName(page, 'Alex Morgan');
  await expect(page.locator('.place-box')).toBeVisible();
  await pinBoxTop(page);
  const boxTop = await page.locator('.place-box').evaluate((el) => parseFloat(el.style.top));
  expect(boxTop).toBeLessThanOrEqual(1); // clearly OFF-CENTER: hard against the top

  await expect(page.locator('#apply')).toBeEnabled();
  const dlPromise = page.waitForEvent('download');
  await page.locator('#apply').click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('doc-signed.pdf');
  const buf = readFileSync(await dl.path());
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Structure: both pages survive (nothing dropped or duplicated).
  const outDoc = await PDFDocument.load(new Uint8Array(buf));
  expect(outDoc.getPageCount()).toBe(2);

  // Accuracy: re-render the SIGNED page 1 → ink is in the TOP band, none at the
  // bottom. A broken Y-flip would land the signature at the opposite edge.
  const region = await renderAndScanBands(page, [...buf], 1);
  expect(region.top).toBeGreaterThan(0);
  expect(region.bottom).toBe(0);
});

// --- 5. Empty signature → Apply disabled -------------------------------------

test('5. with no signature, Apply is disabled', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 1, w: 400, h: 560, content: true });
  await waitLoaded(page, 1);
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#apply-hint')).toContainText('Draw your signature');
});

// --- 6. pdfjs + pdf-lib lazy; worker same-origin; no external requests --------

test('6. pdfjs/pdf-lib are 0 before open; worker is same-origin; nothing external', async ({ page }) => {
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  await boot(page);

  // Before any PDF is opened, neither engine has been fetched.
  expect(reqs.filter((u) => u.includes('/vendor/pdfjs/'))).toEqual([]);
  expect(reqs.filter((u) => u.includes('/vendor/pdf-lib/'))).toEqual([]);

  // Open a Node-built PDF (so the harness itself never imports pdf-lib in-page).
  await loadRawPdf(page, await makePdfNode(2, 400, 560), 'lazy.pdf');
  await waitLoaded(page, 2);

  // pdfjs is now loaded; pdf-lib is NOT (it only loads on Apply).
  expect(reqs.some((u) => u.includes('/vendor/pdfjs/'))).toBe(true);
  expect(reqs.filter((u) => u.includes('/vendor/pdf-lib/'))).toEqual([]);

  // The worker loaded SAME-ORIGIN (checked via both request events and resource
  // timing, since worker-script fetches aren't always surfaced as page requests).
  const workerFromPerf = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('pdf.worker.min.mjs')));
  const workerAll = [...reqs.filter((u) => u.includes('pdf.worker.min.mjs')), ...workerFromPerf];
  expect(workerAll.length).toBeGreaterThan(0);
  for (const u of workerAll) expect(u.startsWith(BASE)).toBe(true);

  // No external-origin HTTP requests at all.
  const external = reqs.filter((u) => /^https?:\/\//.test(u) && !u.startsWith(BASE));
  expect(external).toEqual([]);
});

// --- 7. XSS filename is inert ------------------------------------------------

test('7. an XSS-crafted filename is rendered as inert text', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const xss = '<img src=x onerror=alert(1)>.pdf';
  await loadPdf(page, { pages: 1, w: 400, h: 560, content: true, name: xss });
  await waitLoaded(page, 1);
  await expect(page.locator('#doc-name')).toHaveText(xss); // escaped → literal text
  await expect(page.locator('#doc-info img')).toHaveCount(0); // no element injected
  expect(dialogFired).toBe(false);
});

// --- 8. a11y: axe stable across Draw/Type + keyboard reaches the controls -----

test('8. no serious/critical axe violations; keyboard reaches tabs, name, Apply', async ({ page }) => {
  await boot(page);

  // Empty state.
  const empty = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(empty)).toEqual([]);

  await loadPdf(page, { pages: 2, w: 400, h: 560, content: true });
  await waitLoaded(page, 2);
  const loaded = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const loadedBlockers = axeBlockers(loaded);
  if (loadedBlockers.length) for (const v of loadedBlockers) console.error(`[a11y sign-pdf] ${v.id} (${v.impact}): ${v.help}`);
  expect(loadedBlockers).toEqual([]);

  // Toggle the segmented control both ways — must stay axe-stable (transition:none).
  await page.locator('.seg-btn[data-mode="type"]').click();
  await page.locator('.seg-btn[data-mode="draw"]').click();
  const toggled = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(toggled)).toEqual([]);

  // Type a name so a signature exists and Apply is enabled (thus focusable).
  await typeName(page, 'Test User');
  await expect(page.locator('#apply')).toBeEnabled();

  const drawBtn = page.locator('.seg-btn[data-mode="draw"]');
  await drawBtn.focus();
  await expect(drawBtn).toBeFocused();
  const name = page.locator('#type-name');
  await name.focus();
  await expect(name).toBeFocused();
  const apply = page.locator('#apply');
  await apply.focus();
  await expect(apply).toBeFocused();
});

// --- 9. 375px: no horizontal overflow after content loads --------------------

test('9. no horizontal overflow at 375px with a loaded document', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  await loadPdf(page, {
    pages: 2, w: 400, h: 560, content: true,
    name: 'a-really-quite-long-document-filename-that-could-overflow-the-narrow-layout.pdf',
  });
  await waitLoaded(page, 2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

// --- 10. Lazy render (Fix I-1): far page renders on demand, placement works ---

test('10. a long document lazy-renders; a far page still renders + accepts a placement', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 14, w: 400, h: 560, content: true, name: 'long.pdf' });
  await waitLoaded(page, 14);

  // The long-document note is shown (page count exceeds the eager threshold).
  await expect(page.locator('#lazy-note')).toBeVisible();

  // Page 0 (eager) is rendered non-blank.
  await expect.poll(() => frameDarkPixels(page, 0)).toBeGreaterThan(0);

  // Select the LAST page (index 13, well beyond the eager window) → it renders.
  await page.locator('#page-select').selectOption('13');
  await expect.poll(() => frameDarkPixels(page, 13), { timeout: 5000 }).toBeGreaterThan(0);

  // Placement still works there: a typed signature places a box and enables Apply.
  await typeName(page, 'Far Page');
  await expect(page.locator('.place-box')).toBeVisible();
  await expect(page.locator('#apply')).toBeEnabled();
});

// --- Engine-load failure is honest + retryable, never "corrupt" ---------------

test('a pdf.js engine that fails to load gets an honest engine message, not "corrupt"', async ({ page }) => {
  await boot(page);
  // Simulate the vendored engine 404ing (the real production bug: the build/ dir
  // was gitignored out of the deploy). Abort the module request, then open a
  // GENUINELY VALID PDF — so the only failure is the engine, not the file.
  await page.route('**/vendor/pdfjs/legacy/build/pdf.min.mjs', (r) => r.abort());
  await loadRawPdf(page, await makePdfNode(1, 400, 560), 'real.pdf');
  const note = page.locator('#intake-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('engine');        // honest: blames the engine…
  await expect(note).not.toContainText('corrupt');   // …never the user's file
});
