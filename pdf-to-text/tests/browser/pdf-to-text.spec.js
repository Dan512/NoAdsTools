// pdf-to-text/tests/browser/pdf-to-text.spec.js — the tool end-to-end.
//
// FIXTURES. Real, decodable PDFs are built in Node with the vendored pdf-lib the
// PDF cluster already ships (deterministic, no committed binaries) and injected
// as one File to #file-input. pdf-to-text itself never imports pdf-lib — it only
// READS PDFs with pdfjs — so building fixtures in Node (top-of-file import) keeps
// the engine-laziness tests honest: nothing pulls /vendor/pdfjs/ or
// /vendor/tesseract/ into the page until a PDF is opened / a page needs OCR.
//   • makeTextPdfBytes draws one line of real, selectable text per page (a true
//     text layer), so the digital-extract path is exercised for real.
//
// HARNESS NOTES (playbook §4):
//   (a) pdfjs' display render is requestAnimationFrame-driven and stalls on a
//       throttled/backgrounded page. boot() shims rAF→timer so the OCR-render
//       always advances headless, and bringToFront() foregrounds the page.
//   (b) OCR is faked via the loader's `_setOcrForTest` hatch — the SAME module
//       instance main.js imports (/shared/tesseract-loader.js) — so the ~22 MB
//       engine is never fetched. The lazy-Tesseract network assertion stays 0.
//   (c) Clipboard read needs an explicit grant (chromium-only).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument, StandardFonts, rgb } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

const BASE = 'http://localhost:4173';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function boot(page) {
  // Replace rAF with a timer so pdfjs' OCR render advances in headless/parallel
  // runs even if the tab is throttled (playbook §4). Applied before goto.
  await page.addInitScript(() => {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  });
  await page.goto('/pdf-to-text/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.bringToFront();
}

// --- Fixtures (Node-side pdf-lib) --------------------------------------------

// One line of real selectable text per page. `lines[i]` is page i+1's text layer.
async function makeTextPdfBytes(lines, { w = 420, h = 560 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const p = doc.addPage([w, h]);
    p.drawText(line, { x: 40, y: h - 80, size: 18, font, color: rgb(0, 0, 0) });
  }
  return [...(await doc.save())];
}

// Bytes that pass the .pdf allowlist but are not a real PDF → corrupt/error path.
function corruptPdfBytes() {
  return [...new TextEncoder().encode('this file has a .pdf name but is not a PDF at all')];
}

// A minimal encrypted PDF (V1/R2 standard security handler). The /O and /U
// strings are dummy; what matters is the trailer's /Encrypt ref, which makes
// pdfjs raise a PasswordException → the tool classifies it 'locked'.
function encryptedPdfBytes() {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>';
  const O = '28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A';
  const U = '00000000000000000000000000000000000000000000000000000000000000AA';
  objs[4] = `<< /Filter /Standard /V 1 /R 2 /O <${O}> /U <${U}> /P -44 >>`;
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 4; i++) { offsets[i] = body.length; body += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefStart = body.length;
  body += 'xref\n0 5\n0000000000 65535 f \n';
  for (let i = 1; i <= 4; i++) body += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  body += 'trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<0102030405060708090A0B0C0D0E0F10> <0102030405060708090A0B0C0D0E0F10>] >>\n';
  body += `startxref\n${xrefStart}\n%%EOF`;
  return [...new TextEncoder().encode(body)];
}

// --- Helpers -----------------------------------------------------------------

async function loadBytes(page, bytes, name = 'doc.pdf') {
  await page.evaluate(({ bytes, name }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { bytes, name });
}

async function loadTextPdf(page, lines, name = 'doc.pdf', dims) {
  await loadBytes(page, await makeTextPdfBytes(lines, dims), name);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#extract')).toBeEnabled({ timeout: 10000 });
}

async function extract(page) {
  await page.locator('#extract').click();
  await expect(page.locator('#output')).toBeVisible({ timeout: 20000 });
}

const outText = (page) => page.locator('#out').inputValue();

// Inject a fake OCR worker into the SAME loader module main.js uses, so the real
// ~22 MB engine is never fetched. `text` is what the fake "recognises".
async function installFakeOcr(page, text) {
  await page.evaluate(async (t) => {
    const { _setOcrForTest } = await import('/shared/tesseract-loader.js');
    _setOcrForTest({ recognize: async () => ({ text: t }) });
  }, text);
}

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

// --- Chrome + SEO ------------------------------------------------------------

test('SEO head + minimal chrome (single h1, no lang/settings, JSON-LD)', async ({ page }) => {
  await page.goto('/pdf-to-text/');
  await expect(page).toHaveTitle('PDF to Text — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/pdf-to-text/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  expect(ld).toContain('"UtilitiesApplication"');
  expect(ld).toContain('"price": "0"');
  expect(ld).toContain('agpl-3.0');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
});

// --- 1. Digital text PDF → Auto extract → exact text + --- Page N --- ---------

test('1. a digital PDF extracts its exact text, page-separated', async ({ page }) => {
  await boot(page);
  await loadTextPdf(page, ['Alpha bravo charlie', 'Delta echo foxtrot']);
  await expect(page.locator('#doc-pages')).toContainText('2 pages');
  await extract(page);

  const out = await outText(page);
  expect(out).toMatch(/--- Page 1 ---\nAlpha bravo charlie/);
  expect(out).toMatch(/--- Page 2 ---\nDelta echo foxtrot/);
  // Auto found a real text layer on both pages → no OCR badge.
  await expect(page.locator('.ocr-badge')).toHaveCount(0);
});

// --- 2. Copy → clipboard has the extracted text ------------------------------

test('2. Copy writes the extracted text to the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await loadTextPdf(page, ['Alpha bravo charlie', 'Delta echo foxtrot']);
  await extract(page);

  await page.locator('#copy').click();
  await expect(page.locator('#copy')).toHaveText('Copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const norm = (s) => s.replace(/\r\n/g, '\n');
  expect(norm(clip)).toBe(norm(await outText(page)));
  expect(norm(clip)).toContain('Alpha bravo charlie');
});

// --- 3. Download → <stem>.txt ------------------------------------------------

test('3. Download saves a .txt named after the PDF', async ({ page }) => {
  await boot(page);
  await loadTextPdf(page, ['Alpha bravo charlie'], 'report.pdf');
  await extract(page);

  const dlPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('report.txt');
});

// --- 4. A page range labels sections by SOURCE page number (Fix 1 guard) ------

test('4. a range extracts only those pages, headed by their source numbers', async ({ page }) => {
  await boot(page);
  await loadTextPdf(page, [
    'Page one alpha', 'Page two bravo', 'Page three charlie', 'Page four delta', 'Page five echo',
  ]);
  await expect(page.locator('#doc-pages')).toContainText('5 pages');

  await page.locator('.seg-btn[data-pages="range"]').click();
  await page.locator('#range-input').fill('3-4');
  await extract(page);

  const out = await outText(page);
  // Headings carry the ORIGINAL page numbers, not 1/2.
  expect(out).toMatch(/--- Page 3 ---\nPage three charlie/);
  expect(out).toMatch(/--- Page 4 ---\nPage four delta/);
  expect(out).not.toContain('--- Page 1 ---');
  expect(out).not.toContain('--- Page 2 ---');
  expect(out).not.toContain('--- Page 5 ---');
  // The per-page chips match the headings (source page numbers).
  const chips = page.locator('#page-badges .page-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText('Page 3');
  await expect(chips.nth(1)).toContainText('Page 4');
});

// --- 5. Text-layer extract never fetches Tesseract; pdfjs lazy + same-origin --

test('5. text-only extract fetches 0 /vendor/tesseract/; pdfjs worker same-origin', async ({ page }) => {
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  await boot(page);

  // Nothing heavy before a PDF is opened.
  expect(reqs.filter((u) => u.includes('/vendor/pdfjs/'))).toEqual([]);
  expect(reqs.filter((u) => u.includes('/vendor/tesseract/'))).toEqual([]);

  await loadTextPdf(page, ['Alpha bravo charlie', 'Delta echo foxtrot']);
  await extract(page); // Auto, on a real text layer → never needs OCR

  // pdfjs loaded on open; Tesseract NEVER (the text layer was enough).
  expect(reqs.some((u) => u.includes('/vendor/pdfjs/'))).toBe(true);
  expect(reqs.filter((u) => u.includes('/vendor/tesseract/'))).toEqual([]);

  // Worker loaded same-origin.
  const workerFromPerf = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('pdf.worker.min.mjs')));
  const workerAll = [...reqs.filter((u) => u.includes('pdf.worker.min.mjs')), ...workerFromPerf];
  expect(workerAll.length).toBeGreaterThan(0);
  for (const u of workerAll) expect(u.startsWith(BASE)).toBe(true);

  // No external-origin HTTP requests at all.
  const external = reqs.filter((u) => /^https?:\/\//.test(u) && !u.startsWith(BASE));
  expect(external).toEqual([]);
});

// --- 6. OCR-all: fake OCR OVERRIDES a long text layer + badge shows (Fix 2) ---

test('6. OCR all pages uses the OCR text over a long text layer, marks the badge, no real engine fetch', async ({ page }) => {
  const tessReqs = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/tesseract/')) tessReqs.push(r.url()); });
  await boot(page);
  await installFakeOcr(page, 'FAKEOCR');

  const longLayer = 'This is a genuinely long real digital text layer that OCR must override in ocr-all mode';
  await loadTextPdf(page, [longLayer]);

  // Force OCR on every page.
  await page.locator('.seg-btn[data-mode="ocr-all"]').click();
  await extract(page);

  const out = await outText(page);
  expect(out).toContain('FAKEOCR');          // the (shorter) OCR text WON
  expect(out).not.toContain(longLayer);      // the long text layer was discarded
  // The badge is truthful: it shows because the shown text came from OCR.
  await expect(page.locator('.ocr-badge')).toHaveCount(1);
  // The fake bypassed the loader, so the real ~22 MB engine was never fetched.
  expect(tessReqs).toEqual([]);
});

// --- 7. Password + corrupt PDFs get honest, distinct messages ----------------

test('7. a corrupt PDF and a password-protected PDF each get an honest message', async ({ page }) => {
  await boot(page);

  // Corrupt: valid .pdf name, junk bytes.
  await loadBytes(page, corruptPdfBytes(), 'corrupt.pdf');
  await expect(page.locator('#intake-note')).toBeVisible();
  await expect(page.locator('#intake-note')).toContainText('corrupt');

  // Password-protected: encrypted structure → pdfjs raises PasswordException.
  await loadBytes(page, encryptedPdfBytes(), 'locked.pdf');
  await expect(page.locator('#intake-note')).toContainText('password-protected');
});

// --- 7b. Engine-load failure is honest + retryable, never "corrupt" ----------

test('7b. a pdf.js engine that fails to load gets an honest engine message, not "corrupt"', async ({ page }) => {
  await boot(page);
  // Simulate the vendored engine 404ing (the real production bug: the build/ dir
  // was gitignored out of the deploy). Abort the module request, then open a
  // GENUINELY VALID PDF — so the only failure is the engine, not the file.
  await page.route('**/vendor/pdfjs/legacy/build/pdf.min.mjs', (r) => r.abort());
  await loadBytes(page, await makeTextPdfBytes(['The engine is down but this file is fine']), 'real.pdf');
  const note = page.locator('#intake-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('engine');        // honest: blames the engine…
  await expect(note).not.toContainText('corrupt');   // …never the user's file
});

test('7c. a pdf.js WORKER that fails to load is also honest, not "corrupt" (openPdf reclassifies)', async ({ page }) => {
  await boot(page);
  // The engine MODULE loads fine, but the worker (lazily fetched at getDocument,
  // and in the same build/ dir) 404s — a partial-deploy fault. openPdf must
  // reclassify the worker-setup rejection as an engine failure.
  await page.route('**/vendor/pdfjs/legacy/build/pdf.worker.min.mjs', (r) => r.abort());
  await loadBytes(page, await makeTextPdfBytes(['Worker down, file fine']), 'real.pdf');
  const note = page.locator('#intake-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('engine');
  await expect(note).not.toContainText('corrupt');
});

// --- 8. XSS filename is inert ------------------------------------------------

test('8. an XSS-crafted filename renders as inert text', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const xss = '<img src=x onerror=alert(1)>.pdf';
  await loadTextPdf(page, ['Alpha bravo charlie'], xss);
  await expect(page.locator('#doc-name')).toHaveText(xss);   // escaped → literal text
  await expect(page.locator('#doc-info img')).toHaveCount(0); // no element injected
  expect(dialogFired).toBe(false);
});

// --- 9. a11y: axe stable across the mode toggle + keyboard reaches controls ---

test('9. no serious/critical axe violations across the mode toggle; keyboard reaches controls', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const empty = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(empty)).toEqual([]);

  await loadTextPdf(page, ['Alpha bravo charlie', 'Delta echo foxtrot']);
  const loaded = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const loadedBlockers = axeBlockers(loaded);
  if (loadedBlockers.length) for (const v of loadedBlockers) console.error(`[a11y pdf-to-text] ${v.id} (${v.impact}): ${v.help}`);
  expect(loadedBlockers).toEqual([]);

  // Toggle the mode segmented control across all three — must stay axe-stable
  // (transition:none guards the mid-transition contrast flake, playbook §4).
  await page.locator('.seg-btn[data-mode="text"]').click();
  await page.locator('.seg-btn[data-mode="ocr-all"]').click();
  await page.locator('.seg-btn[data-mode="auto"]').click();
  const toggled = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(toggled)).toEqual([]);

  // Keyboard reaches the mode toggle and the range control.
  const textMode = page.locator('.seg-btn[data-mode="text"]');
  await textMode.focus();
  await expect(textMode).toBeFocused();
  const rangeBtn = page.locator('.seg-btn[data-pages="range"]');
  await rangeBtn.focus();
  await expect(rangeBtn).toBeFocused();
  await rangeBtn.click();
  const rangeInput = page.locator('#range-input');
  await rangeInput.focus();
  await expect(rangeInput).toBeFocused();
});

// --- 10. 375px: no horizontal overflow with a loaded document ----------------

test('10. no horizontal overflow at 375px with a loaded document', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  await loadTextPdf(
    page,
    ['Alpha bravo charlie', 'Delta echo foxtrot'],
    'a-really-quite-long-document-filename-that-could-overflow-the-narrow-layout.pdf',
  );
  await extract(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
