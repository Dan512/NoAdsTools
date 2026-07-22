// pdf-to-jpg/tests/browser/pdf-to-jpg.spec.js — the tool end-to-end.
//
// FIXTURES. Real, decodable PDFs are built in Node with the vendored pdf-lib the
// PDF cluster already ships (deterministic, no committed binaries) and injected
// as one File to #file-input. pdf-to-jpg itself never imports pdf-lib — it only
// READS PDFs with pdfjs — so building fixtures in Node (top-of-file import) keeps
// the engine-laziness test honest: nothing pulls /vendor/pdfjs/ into the page
// until a PDF is actually opened.
//   • content:true draws a black bar on an otherwise WHITE page, so the pdfjs
//     render is provably non-blank AND the margins stay white — the white-plate
//     JPG check reads a corner pixel and demands it be light (a transparent-as-
//     black encode would make the whole image black).
//   • detail:true tiles pseudo-random greys so a JPEG's size responds to quality.
//
// HARNESS NOTES:
//   (a) pdfjs' display render is requestAnimationFrame-driven and stalls on a
//       throttled/backgrounded page (playbook §4). boot() shims rAF→timer so the
//       render always advances headless, and bringToFront() foregrounds the page.
//   (b) The tool's STORE zip is reopened with the vendored JSZip run through a
//       CommonJS shim (the repo is "type":"module", so a bare require() would
//       treat the UMD build as ESM and get nothing).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PDFDocument, rgb } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:4173';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Vendored JSZip, evaluated in THIS realm via a CommonJS shim so its internal
// `instanceof Uint8Array` checks pass (a vm sandbox would cross realms).
const JSZip = (() => {
  const code = readFileSync(resolve(__dir, '../../../vendor/jszip/jszip.min.js'), 'utf8');
  const factory = new Function('module', 'exports', `${code}\nreturn module.exports;`);
  const mod = { exports: {} };
  return factory(mod, mod.exports);
})();

async function boot(page) {
  // Replace rAF with a timer so pdfjs' render advances in headless/parallel runs
  // even if the tab is throttled (playbook §4). Applied before goto.
  await page.addInitScript(() => {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  });
  await page.goto('/pdf-to-jpg/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.bringToFront();
}

// --- Fixtures (Node-side pdf-lib) --------------------------------------------

// A deterministic PRNG so grey tiles are stable across runs.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

async function makePdfBytes({ pages = 3, w = 400, h = 560, content = true, detail = false } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    if (detail) {
      const rnd = lcg(1234 + i);
      const cols = 24, rows = 32, cw = w / cols, ch = h / rows;
      for (let gx = 0; gx < cols; gx++) for (let gy = 0; gy < rows; gy++) {
        const g = rnd();
        p.drawRectangle({ x: gx * cw, y: gy * ch, width: cw, height: ch, color: rgb(g, g, g) });
      }
    } else if (content) {
      // Black bar on a white page: non-blank render, white margins preserved.
      p.drawRectangle({ x: w * 0.2, y: h * 0.42, width: w * 0.6, height: h * 0.12, color: rgb(0, 0, 0) });
    }
  }
  return [...(await doc.save())];
}

async function loadBytes(page, bytes, name = 'doc.pdf') {
  await page.evaluate(({ bytes, name }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { bytes, name });
}

async function loadPdf(page, opts = {}) {
  const { name = 'doc.pdf', ...rest } = opts;
  await loadBytes(page, await makePdfBytes(rest), name);
}

async function waitCards(page, n) {
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('.page-card')).toHaveCount(n);
}

// --- Helpers -----------------------------------------------------------------

// Dark-pixel count in a card's rendered thumbnail canvas (proves a real render).
async function thumbDarkPixels(page, index) {
  return page.evaluate((i) => {
    const c = document.querySelectorAll('.page-card canvas')[i];
    if (!c || !c.width) return -1;
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let dark = 0;
    for (let p = 0; p < data.length; p += 4) if (data[p] < 120 && data[p + 1] < 120 && data[p + 2] < 120) dark++;
    return dark;
  }, index);
}

// Range inputs can't be Playwright-filled; set value + dispatch input.
async function setQuality(page, value) {
  await page.locator('#quality').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function downloadBytes(page, triggerLocator) {
  const dlPromise = page.waitForEvent('download');
  await triggerLocator.click();
  const dl = await dlPromise;
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

// Decode encoded image bytes in-page → size, dark/light counts, and a corner pixel.
async function decodeStats(page, bytes, mime) {
  return page.evaluate(async ({ bytes, mime }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let dark = 0, light = 0;
    for (let p = 0; p < data.length; p += 4) {
      const lum = (data[p] + data[p + 1] + data[p + 2]) / 3;
      if (lum < 60) dark++; else if (lum > 200) light++;
    }
    const idx = (2 * c.width + 2) * 4; // near-corner pixel (inside the white margin)
    return { w: c.width, h: c.height, dark, light, corner: [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]] };
  }, { bytes: [...bytes], mime });
}

async function unzip(buf) {
  const zip = await JSZip.loadAsync(new Uint8Array(buf));
  const entries = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    entries.push({ name, bytes: await zip.files[name].async('uint8array') });
  }
  return entries;
}

const isJpeg = (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

// --- Chrome + SEO ------------------------------------------------------------

test('SEO head + minimal chrome (single h1, no lang/settings, JSON-LD)', async ({ page }) => {
  await page.goto('/pdf-to-jpg/');
  await expect(page).toHaveTitle('PDF to JPG — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/pdf-to-jpg/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  expect(ld).toContain('"UtilitiesApplication"');
  expect(ld).toContain('"price": "0"');
  expect(ld).toContain('agpl-3.0');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
});

// --- 1. Thumbnails render non-blank ------------------------------------------

test('1. every selected page renders a non-blank thumbnail', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 3, content: true });
  await waitCards(page, 3);
  await expect(page.locator('#doc-pages')).toContainText('3 pages');
  for (let i = 0; i < 3; i++) await expect.poll(() => thumbDarkPixels(page, i), { timeout: 8000 }).toBeGreaterThan(0);
  // I1 guard: the global resolution hint is populated on load, not just after a toggle.
  await expect(page.locator('#res-hint')).toHaveText(/≈\s*\d+\s*×\s*\d+\s*px/, { timeout: 8000 });
});

// --- 2. JPG output is a valid, white-plated (not all-black) JPEG --------------

test('2. per-page JPG download is a valid JPEG that decodes on a white plate', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 1, content: true });
  await waitCards(page, 1);
  const dl = page.locator('.page-card').first().locator('.page-download');
  await expect(dl).toBeEnabled({ timeout: 8000 });

  const { name, bytes } = await downloadBytes(page, dl);
  expect(name).toBe('doc-p1.jpg');
  expect(isJpeg(bytes)).toBe(true);

  const stats = await decodeStats(page, bytes, 'image/jpeg');
  expect(stats.w).toBeGreaterThan(0);
  expect(stats.dark).toBeGreaterThan(0);   // the black bar rendered → NOT blank
  expect(stats.light).toBeGreaterThan(0);  // white margins survived → NOT all-black
  // The margin corner is a light pixel — the white-plate proof (would be black if
  // a transparent region were JPEG-encoded without the white fill).
  const [r, g, b] = stats.corner;
  expect((r + g + b) / 3).toBeGreaterThan(200);
});

// --- 3. PNG output is a valid PNG --------------------------------------------

test('3. switching to PNG yields a valid, non-blank PNG', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 1, content: true });
  await waitCards(page, 1);
  await page.locator('.seg-btn[data-format="png"]').click();
  await expect(page.locator('#quality-control')).toBeHidden(); // quality is JPG-only
  const dl = page.locator('.page-card').first().locator('.page-download');
  await expect(dl).toBeEnabled({ timeout: 8000 });

  const { name, bytes } = await downloadBytes(page, dl);
  expect(name).toBe('doc-p1.png');
  expect(isPng(bytes)).toBe(true);
  const stats = await decodeStats(page, bytes, 'image/png');
  expect(stats.dark).toBeGreaterThan(0);
  expect(stats.light).toBeGreaterThan(0);
});

// --- 4. Quality slider changes the JPG size ----------------------------------

test('4. a higher quality makes a larger JPG for the same page', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 1, detail: true }); // high-frequency content responds to quality
  await waitCards(page, 1);
  const dl = page.locator('.page-card').first().locator('.page-download');
  await expect(dl).toBeEnabled({ timeout: 8000 });

  await setQuality(page, 20);
  const low = await downloadBytes(page, dl);
  await setQuality(page, 95);
  const high = await downloadBytes(page, dl);

  expect(isJpeg(low.bytes)).toBe(true);
  expect(isJpeg(high.bytes)).toBe(true);
  expect(high.bytes.length).toBeGreaterThan(low.bytes.length);
});

// --- 5. A range renders only that subset -------------------------------------

test('5. a page range renders only the listed pages', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 5, content: true });
  await waitCards(page, 5);

  await page.locator('.seg-btn[data-pages="range"]').click();
  await page.locator('#range-input').fill('1, 3');
  await waitCards(page, 2);
  await expect(page.locator('.page-card .page-num').nth(0)).toHaveText('Page 1');
  await expect(page.locator('.page-card .page-num').nth(1)).toHaveText('Page 3');
});

// --- 6. Download all → a ZIP of N images (unzipped in-test) -------------------

test('6. Download all bundles every selected page into a ZIP', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 3, content: true });
  await waitCards(page, 3);
  const zipBtn = page.locator('#download-zip');
  await expect(zipBtn).toBeEnabled();

  const { name, bytes } = await downloadBytes(page, zipBtn);
  expect(name).toBe('doc-pages.zip');
  const entries = await unzip(bytes);
  expect(entries.map((e) => e.name)).toEqual(['doc-p1.jpg', 'doc-p2.jpg', 'doc-p3.jpg']);
  for (const e of entries) expect(isJpeg(e.bytes)).toBe(true);
});

// --- 7. A single selected page downloads as a bare image, not a ZIP ----------

test('7. one selected page → a bare image (no ZIP)', async ({ page }) => {
  await boot(page);
  await loadPdf(page, { pages: 1, content: true });
  await waitCards(page, 1);
  const zipBtn = page.locator('#download-zip');
  await expect(zipBtn).toHaveText('Download');            // relabelled for a single page
  const { name, bytes } = await downloadBytes(page, zipBtn);
  expect(name).toBe('doc-p1.jpg');                         // NOT doc-pages.zip
  expect(isJpeg(bytes)).toBe(true);
});

// --- 8. pdfjs/JSZip lazy; worker same-origin; nothing external ----------------

test('8. pdfjs 0 before open, JSZip 0 before ZIP; worker same-origin; no external', async ({ page }) => {
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  await boot(page);

  expect(reqs.filter((u) => u.includes('/vendor/pdfjs/'))).toEqual([]);
  expect(reqs.filter((u) => u.includes('/vendor/jszip/'))).toEqual([]);

  await loadPdf(page, { pages: 3, content: true });
  await waitCards(page, 3);

  // pdfjs is now loaded; JSZip is NOT (no ZIP built yet).
  expect(reqs.some((u) => u.includes('/vendor/pdfjs/'))).toBe(true);
  expect(reqs.filter((u) => u.includes('/vendor/jszip/'))).toEqual([]);

  // The multi-page Download-all pulls JSZip.
  await downloadBytes(page, page.locator('#download-zip'));
  expect(reqs.some((u) => u.includes('/vendor/jszip/'))).toBe(true);

  // Worker loaded same-origin (checked via requests + resource timing).
  const workerFromPerf = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('pdf.worker.min.mjs')));
  const workerAll = [...reqs.filter((u) => u.includes('pdf.worker.min.mjs')), ...workerFromPerf];
  expect(workerAll.length).toBeGreaterThan(0);
  for (const u of workerAll) expect(u.startsWith(BASE)).toBe(true);

  // No external-origin HTTP requests at all.
  const external = reqs.filter((u) => /^https?:\/\//.test(u) && !u.startsWith(BASE));
  expect(external).toEqual([]);
});

// --- 9. XSS filename is inert ------------------------------------------------

test('9. an XSS-crafted filename renders as inert text', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const xss = '<img src=x onerror=alert(1)>.pdf';
  await loadPdf(page, { pages: 1, content: true, name: xss });
  await waitCards(page, 1);
  await expect(page.locator('#doc-name')).toHaveText(xss);       // escaped → literal text
  await expect(page.locator('#doc-info img')).toHaveCount(0);     // no element injected
  expect(dialogFired).toBe(false);
});

// --- 10. a11y: axe stable across the format toggle + keyboard reaches controls -

test('10. no serious/critical axe violations across the format toggle; keyboard reaches controls', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const empty = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(empty)).toEqual([]);

  await loadPdf(page, { pages: 2, content: true });
  await waitCards(page, 2);
  const loaded = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const loadedBlockers = axeBlockers(loaded);
  if (loadedBlockers.length) for (const v of loadedBlockers) console.error(`[a11y pdf-to-jpg] ${v.id} (${v.impact}): ${v.help}`);
  expect(loadedBlockers).toEqual([]);

  // Toggle the format segmented control both ways — must stay axe-stable (transition:none).
  await page.locator('.seg-btn[data-format="png"]').click();
  await page.locator('.seg-btn[data-format="jpg"]').click();
  const toggled = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(toggled)).toEqual([]);

  // Keyboard reaches the format toggle, quality slider, and the range control.
  const png = page.locator('.seg-btn[data-format="png"]');
  await png.focus();
  await expect(png).toBeFocused();
  const quality = page.locator('#quality');
  await quality.focus();
  await expect(quality).toBeFocused();
  const rangeBtn = page.locator('.seg-btn[data-pages="range"]');
  await rangeBtn.focus();
  await expect(rangeBtn).toBeFocused();
  await rangeBtn.click();
  const rangeInput = page.locator('#range-input');
  await rangeInput.focus();
  await expect(rangeInput).toBeFocused();
});

// --- 11. 375px: no horizontal overflow with a loaded document ----------------

test('11. no horizontal overflow at 375px with a loaded document', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  await loadPdf(page, {
    pages: 2, content: true,
    name: 'a-really-quite-long-document-filename-that-could-overflow-the-narrow-layout.pdf',
  });
  await waitCards(page, 2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

// --- 12. Many-page PDF: grid capped + honest note (I2 guard) ------------------

test('12. a many-page PDF caps the grid to 150 cards and shows an honest note', async ({ page }) => {
  test.setTimeout(90000); // 150 sequential thumbnail renders
  await boot(page);
  await loadPdf(page, { pages: 160, w: 200, h: 260, content: false });
  await expect(page.locator('#doc-pages')).toContainText('160 pages');

  // Cards are built synchronously before the render loop, so the count settles fast.
  await expect(page.locator('.page-card')).toHaveCount(150);
  const note = page.locator('#grid-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('first 150 of 160 pages');
});

// --- 13. Engine-load failure is honest + retryable, never "corrupt" -----------

test('13. a pdf.js engine that fails to load gets an honest engine message, not "corrupt"', async ({ page }) => {
  await boot(page);
  // Simulate the vendored engine 404ing (the real production bug: the build/ dir
  // was gitignored out of the deploy). Abort the module request, then open a
  // GENUINELY VALID PDF — so the only failure is the engine, not the file.
  await page.route('**/vendor/pdfjs/legacy/build/pdf.min.mjs', (r) => r.abort());
  await loadBytes(page, await makePdfBytes({ pages: 1 }), 'real.pdf');
  const note = page.locator('#intake-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('engine');        // honest: blames the engine…
  await expect(note).not.toContainText('corrupt');   // …never the user's file
});
