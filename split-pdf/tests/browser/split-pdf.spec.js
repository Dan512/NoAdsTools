// split-pdf/tests/browser/split-pdf.spec.js — the tool end-to-end.
//
// FIXTURES. Real, decodable PDFs are generated with the SAME vendored pdf-lib
// the tool ships (deterministic, no committed binaries). Two generation paths,
// deliberately:
//   • loadTenPagePdf() imports pdf-lib IN-PAGE and builds the File there — used
//     by every test that doesn't measure pdf-lib laziness.
//   • makePdfNode() builds bytes in Node (via the top-of-file import) so the
//     laziness test can add a PDF WITHOUT the harness itself pre-loading pdf-lib
//     in the page — otherwise the fixture generator would fire the very
//     /vendor/pdf-lib/ request that test asserts is absent until the first add.
// Page IDENTITY/ORDER is proven by DISTINCT PAGE WIDTHS: the 10-page fixture is
// built with width = 100 + pageNumber*10 (page 1 = 110 … page 10 = 200), so
// reading an output's per-page widths back in Node reveals exactly which source
// page each output page is, and in what order — verified structurally, not by
// trusting UI labels or filenames.
//
// ZIP outputs (ranges / every-N / burst) are reopened with the vendored JSZip.
// The repo is "type":"module", which makes a plain require() treat the UMD
// jszip.min.js as ESM (exports nothing); running it in a vm sandbox with a
// CommonJS shim reaches module.exports. Each entry is a STORE-compressed PDF,
// pulled out and re-parsed with pdf-lib.
//
// The encrypted fixture is hand-crafted bytes: pdf-lib CANNOT create an
// encrypted PDF, so encryptedPdfBytes() writes a minimal V1/R2 standard-handler
// document whose trailer references an /Encrypt dict; PDFDocument.load
// ({ ignoreEncryption:false }) rejects it and split.js classifies it 'locked'.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PDFDocument } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load the vendored JSZip in Node to reopen the tool's STORE zips. Run the UMD
// with a CommonJS shim (module/exports params) so it evaluates in THIS realm —
// a vm sandbox would run it in a separate realm, and JSZip's internal
// `instanceof Uint8Array` checks against the input would then fail cross-realm.
const JSZip = (() => {
  const code = readFileSync(resolve(__dir, '../../../vendor/jszip/jszip.min.js'), 'utf8');
  const factory = new Function('module', 'exports', `${code}\nreturn module.exports;`);
  const mod = { exports: {} };
  return factory(mod, mod.exports);
})();

// Width a page gets for its 1-based number in the 10-page fixture.
const widthFor = (p) => 100 + p * 10;

async function boot(page) {
  await page.goto('/split-pdf/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// --- Fixtures ----------------------------------------------------------------

// In-page: build an N-page PDF (distinct per-page widths) with pdf-lib, wrap as
// a File, feed the file input. Imports pdf-lib in the page (fine except for the
// laziness test).
async function loadPagePdf(page, { name = 'doc.pdf', pageCount = 10 } = {}) {
  await page.evaluate(async ({ name, pageCount }) => {
    const { PDFDocument } = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const doc = await PDFDocument.create();
    for (let p = 1; p <= pageCount; p++) doc.addPage([100 + p * 10, 300]);
    const bytes = await doc.save();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { name, pageCount });
}

async function loadTenPagePdf(page, name = 'doc.pdf') {
  await loadPagePdf(page, { name, pageCount: 10 });
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#doc-pages')).toContainText('10 pages');
}

// Node-built bytes via the vendored pdf-lib (no in-page pdf-lib import).
async function makePdfNode(pageCount) {
  const doc = await PDFDocument.create();
  for (let p = 1; p <= pageCount; p++) doc.addPage([widthFor(p), 300]);
  return [...(await doc.save())];
}

// Inject Node-provided raw bytes as a File (no in-page pdf-lib import).
async function addRawFile(page, name, bytes, type = 'application/pdf') {
  await page.evaluate(({ name, bytes, type }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { name, bytes, type });
}

// A minimal encrypted PDF (V1/R2 standard security handler). The /O and /U
// strings are dummy hex; what matters is the trailer's /Encrypt ref, which makes
// pdf-lib refuse the document as encrypted.
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

// Bytes that pass the .pdf allowlist but are not a real PDF → 'error'.
function corruptPdfBytes() {
  return [...new TextEncoder().encode('this file has a .pdf name but is not a PDF at all')];
}

// --- Reload helpers ----------------------------------------------------------

// Re-parse a PDF buffer in Node: page count + per-page widths (in order).
async function readPdf(buf) {
  const doc = await PDFDocument.load(new Uint8Array(buf));
  return { pageCount: doc.getPageCount(), widths: doc.getPages().map((p) => Math.round(p.getWidth())) };
}

// Reopen a STORE zip: ordered [{ name, bytes }] for each non-dir entry.
async function unzip(buf) {
  const zip = await JSZip.loadAsync(new Uint8Array(buf));
  const entries = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    entries.push({ name, bytes: await zip.files[name].async('uint8array') });
  }
  return entries;
}

async function runAndDownload(page) {
  const dlPromise = page.waitForEvent('download');
  await page.locator('#run').click();
  const dl = await dlPromise;
  const buf = readFileSync(await dl.path());
  return { name: dl.suggestedFilename(), buf };
}

const selectMode = (page, mode) => page.locator(`.mode-btn[data-mode="${mode}"]`).click();

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

// --- Chrome + SEO ------------------------------------------------------------

test('SEO head + minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await page.goto('/split-pdf/');
  await expect(page).toHaveTitle('Split PDF — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/split-pdf/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
});

// --- 1. Extract → single PDF, pages in order ---------------------------------

test('1. Extract "1-3,5" → single 4-page PDF, pages in the order listed', async ({ page }) => {
  await boot(page);
  await loadTenPagePdf(page);
  // Extract is the default mode.
  await expect(page.locator('.mode-btn[data-mode="extract"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#range-input').fill('1-3,5');
  await expect(page.locator('#preview')).toContainText('Extract 4 pages → 1 PDF');
  await expect(page.locator('#run')).toBeEnabled();

  const { name, buf } = await runAndDownload(page);
  expect(name).toBe('doc-pages.pdf');                       // single output → bare PDF
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const { pageCount, widths } = await readPdf(buf);
  expect(pageCount).toBe(4);
  expect(widths).toEqual([widthFor(1), widthFor(2), widthFor(3), widthFor(5)]); // 110,120,130,150
});

// --- 2. Ranges → ZIP of 2 PDFs (5+5) -----------------------------------------

test('2. Ranges "1-5,6-10" → ZIP with two 5-page PDFs, each holding its half', async ({ page }) => {
  await boot(page);
  await loadTenPagePdf(page);
  await selectMode(page, 'ranges');
  await page.locator('#range-input').fill('1-5, 6-10');
  await expect(page.locator('#preview')).toContainText('Split into 2 PDFs');

  const { name, buf } = await runAndDownload(page);
  expect(name).toBe('doc-split.zip');
  const entries = await unzip(buf);
  expect(entries.map((e) => e.name)).toEqual(['doc-1-5.pdf', 'doc-6-10.pdf']);
  const a = await readPdf(entries[0].bytes);
  const b = await readPdf(entries[1].bytes);
  expect(a.pageCount).toBe(5);
  expect(a.widths).toEqual([1, 2, 3, 4, 5].map(widthFor));
  expect(b.pageCount).toBe(5);
  expect(b.widths).toEqual([6, 7, 8, 9, 10].map(widthFor));
});

// --- 3. Every-3 → ZIP of 4 PDFs (3,3,3,1) ------------------------------------

test('3. Every-3 → ZIP with four PDFs sized 3,3,3,1', async ({ page }) => {
  await boot(page);
  await loadTenPagePdf(page);
  await selectMode(page, 'everyn');
  await page.locator('#n-input').fill('3');
  await expect(page.locator('#preview')).toContainText('Every 3 pages → 4 PDFs');

  const { name, buf } = await runAndDownload(page);
  expect(name).toBe('doc-split.zip');
  const entries = await unzip(buf);
  expect(entries.map((e) => e.name)).toEqual(['doc-part-1.pdf', 'doc-part-2.pdf', 'doc-part-3.pdf', 'doc-part-4.pdf']);
  const parsed = await Promise.all(entries.map((e) => readPdf(e.bytes)));
  expect(parsed.map((p) => p.pageCount)).toEqual([3, 3, 3, 1]);
  expect(parsed[0].widths).toEqual([1, 2, 3].map(widthFor));
  expect(parsed[3].widths).toEqual([widthFor(10)]);         // short final chunk = page 10
});

// --- 4. Burst → ZIP of 10 single-page PDFs -----------------------------------

test('4. Burst → ZIP with ten single-page PDFs, one per source page in order', async ({ page }) => {
  await boot(page);
  await loadTenPagePdf(page);
  await selectMode(page, 'burst');
  await expect(page.locator('#preview')).toContainText('Burst 10 pages → 10 PDFs');

  const { name, buf } = await runAndDownload(page);
  expect(name).toBe('doc-split.zip');
  const entries = await unzip(buf);
  expect(entries).toHaveLength(10);
  expect(entries.map((e) => e.name)).toEqual(
    Array.from({ length: 10 }, (_, i) => `doc-p${i + 1}.pdf`),
  );
  for (let i = 0; i < 10; i++) {
    const { pageCount, widths } = await readPdf(entries[i].bytes);
    expect(pageCount).toBe(1);
    expect(widths).toEqual([widthFor(i + 1)]);              // entry i is source page i+1
  }
});

// --- 5. Invalid range → inline error + Run disabled --------------------------

test('5. an invalid range ("5-3") shows an inline error and disables Run', async ({ page }) => {
  await boot(page);
  await loadTenPagePdf(page);
  await page.locator('#range-input').fill('5-3');
  await expect(page.locator('#range-error')).toBeVisible();
  await expect(page.locator('#range-error')).toContainText('reversed');
  await expect(page.locator('#run')).toBeDisabled();
});

// --- 6. Multi-mode collapsing to one output → bare PDF, not a ZIP ------------

test('6. Ranges "1-10" collapses to a single output → a bare PDF, not a ZIP', async ({ page }) => {
  await boot(page);
  await loadTenPagePdf(page);
  await selectMode(page, 'ranges');
  await page.locator('#range-input').fill('1-10');
  await expect(page.locator('#preview')).toContainText('Split into 1 PDF');

  const { name, buf } = await runAndDownload(page);
  expect(name).toBe('doc-1-10.pdf');                        // NOT doc-split.zip
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const { pageCount, widths } = await readPdf(buf);
  expect(pageCount).toBe(10);
  expect(widths).toEqual(Array.from({ length: 10 }, (_, i) => widthFor(i + 1)));
});

// --- 7. Laziness: pdf-lib until add, JSZip until a MULTI-output run -----------

test('7. pdf-lib loads only after a PDF is added; JSZip only for a multi-output run', async ({ page }) => {
  const pdflibReqs = [];
  const jszipReqs = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/vendor/pdf-lib/')) pdflibReqs.push(u);
    if (u.includes('/vendor/jszip/')) jszipReqs.push(u);
  });
  await boot(page);
  expect(pdflibReqs.length).toBe(0);                        // engine not fetched yet

  // Node-built fixture so the harness itself never imports pdf-lib in the page.
  await addRawFile(page, 'doc.pdf', await makePdfNode(10));
  await expect(page.locator('#doc-pages')).toContainText('10 pages');
  expect(pdflibReqs.length).toBeGreaterThan(0);             // adding a PDF pulled it

  // A single-output extract must never load JSZip, even after running.
  await page.locator('#range-input').fill('1-3,5');
  await runAndDownload(page);
  expect(jszipReqs.length).toBe(0);

  // Switch to a multi-output plan: JSZip still 0 until the run actually fires.
  await selectMode(page, 'ranges');
  await page.locator('#range-input').fill('1-5,6-10');
  await expect(page.locator('#preview')).toContainText('Split into 2 PDFs');
  expect(jszipReqs.length).toBe(0);
  await runAndDownload(page);
  expect(jszipReqs.length).toBeGreaterThan(0);              // the multi-output run pulled it
});

// --- 8. Unreadable / locked fixtures → honest error, no workspace ------------

test('8. a corrupt file and an encrypted file each give an honest error, no processing', async ({ page }) => {
  await boot(page);

  // Corrupt: passes the .pdf allowlist, is not a real PDF.
  await addRawFile(page, 'corrupt.pdf', corruptPdfBytes());
  await expect(page.locator('#intake-note')).toBeVisible();
  await expect(page.locator('#intake-note')).toContainText('corrupt');
  await expect(page.locator('#workspace')).toBeHidden();

  // Password-protected: honest, distinct message; still no workspace.
  await addRawFile(page, 'locked.pdf', encryptedPdfBytes());
  await expect(page.locator('#intake-note')).toBeVisible();
  await expect(page.locator('#intake-note')).toContainText('password-protected');
  await expect(page.locator('#workspace')).toBeHidden();
});

// --- 9. XSS filename is inert ------------------------------------------------

test('9. an XSS-crafted filename renders as inert text', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const xss = '<img src=x onerror=alert(1)>.pdf';
  await loadPagePdf(page, { name: xss, pageCount: 2 });
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#doc-name')).toHaveText(xss);   // escaped → literal text
  await expect(page.locator('#workspace img')).toHaveCount(0); // no element injected
  expect(dialogFired).toBe(false);                            // nothing executed
});

// --- 10. a11y: axe clean + keyboard reaches mode control, input, Run ---------

test('10. no serious/critical axe violations; keyboard reaches mode control, input and Run', async ({ page }) => {
  await boot(page);
  // Belt-and-braces settle: reduced motion + a couple of frames so nothing is
  // mid-transition when axe samples (the mode buttons also set transition:none).
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Empty state.
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  await loadTenPagePdf(page);
  await page.locator('#range-input').fill('1-3,5');           // enables Run, no range error
  await expect(page.locator('#run')).toBeEnabled();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const loaded = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(loaded);
  if (blockers.length) {
    console.error('[a11y split-pdf] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);

  // A mode button is a real, focusable native button.
  const modeBtn = page.locator('.mode-btn[data-mode="ranges"]');
  await modeBtn.focus();
  await expect(modeBtn).toBeFocused();
  expect(await modeBtn.evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);

  // The range input is reachable.
  await page.locator('#range-input').focus();
  await expect(page.locator('#range-input')).toBeFocused();

  // Run is reachable and focusable (it is enabled by the valid range above).
  const run = page.locator('#run');
  await run.focus();
  await expect(run).toBeFocused();
  expect(await run.evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);
});

// --- 11. 375px: no horizontal overflow after content loads -------------------

test('11. no horizontal overflow at 375px with a loaded PDF and a long name', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  await loadTenPagePdf(page, 'a-really-quite-long-document-filename-that-could-overflow.pdf');
  await selectMode(page, 'burst');                            // widest preview line
  await expect(page.locator('#preview')).toContainText('Burst 10 pages → 10 PDFs');

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
