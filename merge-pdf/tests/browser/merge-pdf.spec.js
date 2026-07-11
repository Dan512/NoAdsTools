// merge-pdf/tests/browser/merge-pdf.spec.js — the tool end-to-end.
//
// FIXTURES. Real, decodable PDFs are generated with the SAME vendored pdf-lib
// the tool ships (deterministic, no committed binaries). Two generation paths,
// deliberately:
//   • addGeneratedPdfs() imports pdf-lib IN-PAGE and builds the File objects
//     there — used by every test that doesn't measure pdf-lib laziness.
//   • makePdfNode() builds bytes in Node (via the top-of-file import) so the
//     laziness test can add a PDF WITHOUT the harness itself having pre-loaded
//     pdf-lib in the page — otherwise the fixture generator would fire the very
//     /vendor/pdf-lib/ request that test asserts is absent until the first add.
// Ordering is proven by DISTINCT PAGE WIDTHS: each source PDF is built with a
// unique page width, so reading the merged file's per-page widths back (in Node,
// via pdf-lib) reveals exactly which source each output page came from — the
// reorder is verified structurally, not by trusting the UI labels.
//
// The password-protected fixture is hand-crafted bytes: pdf-lib CANNOT create an
// encrypted PDF, so encryptedPdfBytes() writes a minimal V1/R2 standard-handler
// document whose trailer references an /Encrypt dict. pdf-lib's PDFDocument.load
// ({ ignoreEncryption:false }) rejects it, and merge.js classifies it 'locked'.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { PDFDocument } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

async function boot(page) {
  await page.goto('/merge-pdf/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// --- Fixture generators ------------------------------------------------------

// In-page: build each PDF with pdf-lib, wrap as a File, feed the file input.
// specs: [{ name, pages: [{ w, h }] }]
async function addGeneratedPdfs(page, specs) {
  await page.evaluate(async (specList) => {
    const { PDFDocument } = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const dt = new DataTransfer();
    for (const s of specList) {
      const doc = await PDFDocument.create();
      for (const p of s.pages) doc.addPage([p.w, p.h]);
      const bytes = await doc.save();
      dt.items.add(new File([bytes], s.name, { type: 'application/pdf' }));
    }
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, specs);
}

// Inject Node-provided raw bytes (no in-page pdf-lib import). files: [{name, bytes:number[], type}]
async function addRawFiles(page, files) {
  await page.evaluate((fileList) => {
    const dt = new DataTransfer();
    for (const f of fileList) {
      dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    }
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, files);
}

// Node-side deterministic PDF via the vendored pdf-lib. pages: [{w,h}]
async function makePdfNode(pages) {
  const doc = await PDFDocument.create();
  for (const p of pages) doc.addPage([p.w, p.h]);
  return [...(await doc.save())];
}

// A minimal encrypted PDF (V1/R2 standard security handler). The /O and /U
// strings are dummy 32-byte hex; what matters is the trailer's /Encrypt ref,
// which makes pdf-lib refuse the document as encrypted.
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

// Bytes that pass the .pdf allowlist but are not a real PDF → 'error' row.
function corruptPdfBytes() {
  return [...new TextEncoder().encode('this file has a .pdf name but is not a PDF at all')];
}

// Re-parse a merged download in Node: page count + per-page widths (in order).
async function readMerged(buf) {
  const doc = await PDFDocument.load(new Uint8Array(buf));
  const widths = doc.getPages().map((p) => Math.round(p.getWidth()));
  return { pageCount: doc.getPageCount(), widths };
}

const rowByName = (page, name) => page.locator('.pdf-row').filter({ hasText: name });

// Realistic pointer drag: page.mouse drives genuine pointerdown/move/up (with
// pointer capture) in Chromium. Drags the named row above the current first row.
async function dragRowToTop(page, name) {
  const handle = rowByName(page, name).locator('.drag-handle');
  const hb = await handle.boundingBox();
  const firstRow = page.locator('.pdf-row').first();
  const fb = await firstRow.boundingBox();
  const x = hb.x + hb.width / 2;
  await page.mouse.move(x, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, fb.y + 3, { steps: 6 });
  await page.mouse.up();
}

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

// --- Chrome + SEO ------------------------------------------------------------

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/merge-pdf/');
  await expect(page).toHaveTitle('Merge PDF — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/merge-pdf/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

// --- 1. Rows show page counts + ordinals -------------------------------------

test('1. two PDFs render rows with page counts and 1,2 ordinals', async ({ page }) => {
  await boot(page);
  await addGeneratedPdfs(page, [
    { name: 'two.pdf', pages: [{ w: 200, h: 100 }, { w: 200, h: 100 }] },
    { name: 'three.pdf', pages: [{ w: 400, h: 100 }, { w: 400, h: 100 }, { w: 400, h: 100 }] },
  ]);
  await expect(page.locator('.pdf-row')).toHaveCount(2);
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['two.pdf', 'three.pdf']);
  await expect(page.locator('.pdf-row .row-meta').nth(0)).toContainText('2 pages');
  await expect(page.locator('.pdf-row .row-meta').nth(1)).toContainText('3 pages');
  await expect(page.locator('.pdf-row .ord')).toHaveText(['1', '2']);
  await expect(page.locator('#summary')).toHaveText('Merging 2 files → 5 pages');
  await expect(page.locator('#merge')).toBeEnabled();
});

// --- 2. Reorder via ▲/▼ AND a drag updates ordinals + summary ----------------

test('2. reorder with Move buttons and with a drag updates order + ordinals', async ({ page }) => {
  await boot(page);
  await addGeneratedPdfs(page, [
    { name: 'first.pdf', pages: [{ w: 150, h: 100 }] },
    { name: 'second.pdf', pages: [{ w: 300, h: 100 }] },
  ]);
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['first.pdf', 'second.pdf']);

  // Move buttons: first → down.
  await page.getByRole('button', { name: 'Move first.pdf down' }).click();
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['second.pdf', 'first.pdf']);
  await expect(page.locator('.pdf-row .ord')).toHaveText(['1', '2']);
  // Summary count is order-invariant but must stay correct.
  await expect(page.locator('#summary')).toHaveText('Merging 2 files → 2 pages');

  // Drag: pull first.pdf (now last) back to the top.
  await dragRowToTop(page, 'first.pdf');
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['first.pdf', 'second.pdf']);
  await expect(page.locator('.pdf-row .ord')).toHaveText(['1', '2']);
});

// --- 3. Merge → merged.pdf; page count === sum AND order matches the reorder --

test('3. merge outputs merged.pdf whose page order follows the reordered widths', async ({ page }) => {
  await boot(page);
  // Distinct widths per source: A=150 (1p), B=300 (2p), C=450 (1p).
  await addGeneratedPdfs(page, [
    { name: 'A.pdf', pages: [{ w: 150, h: 100 }] },
    { name: 'B.pdf', pages: [{ w: 300, h: 100 }, { w: 300, h: 100 }] },
    { name: 'C.pdf', pages: [{ w: 450, h: 100 }] },
  ]);
  await expect(page.locator('.pdf-row')).toHaveCount(3);

  // Reorder with BOTH mechanisms: drag C to the top, then Move A down one slot.
  await dragRowToTop(page, 'C.pdf');
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['C.pdf', 'A.pdf', 'B.pdf']);
  await page.getByRole('button', { name: 'Move A.pdf down' }).click();
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['C.pdf', 'B.pdf', 'A.pdf']);
  await expect(page.locator('#summary')).toHaveText('Merging 3 files → 4 pages');

  const dlPromise = page.waitForEvent('download');
  await page.locator('#merge').click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('merged.pdf');
  const buf = readFileSync(await dl.path());
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  const { pageCount, widths } = await readMerged(buf);
  expect(pageCount).toBe(4); // 1 + 2 + 1
  // Order = reordered sequence C(450), B(300,300), A(150).
  expect(widths).toEqual([450, 300, 300, 150]);
});

// --- 4. Corrupt fixture → error row + excluded; merge works on the rest ------

test('4. a non-PDF disguised as .pdf becomes an excluded error row; the rest still merge', async ({ page }) => {
  await boot(page);
  await addGeneratedPdfs(page, [
    { name: 'good1.pdf', pages: [{ w: 200, h: 100 }] },
    { name: 'good2.pdf', pages: [{ w: 200, h: 100 }] },
  ]);
  await expect(page.locator('.pdf-row')).toHaveCount(2);
  await addRawFiles(page, [{ name: 'corrupt.pdf', bytes: corruptPdfBytes(), type: 'application/pdf' }]);
  await expect(page.locator('.pdf-row')).toHaveCount(3);

  const badRow = rowByName(page, 'corrupt.pdf');
  await expect(badRow).toHaveClass(/is-error/);
  await expect(badRow.locator('.row-meta')).toContainText('Couldn’t read this PDF');
  await expect(badRow.locator('.row-meta')).toContainText('excluded');
  await expect(badRow.locator('.ord')).toHaveText('—'); // no merge-order number

  // Two readable PDFs remain → merge still enabled and produces a 2-page file.
  await expect(page.locator('#merge')).toBeEnabled();
  const dlPromise = page.waitForEvent('download');
  await page.locator('#merge').click();
  const buf = readFileSync(await (await dlPromise).path());
  const { pageCount } = await readMerged(buf);
  expect(pageCount).toBe(2);
});

// --- 5. Password-protected fixture → locked row + excluded; the rest merge ----

test('5. an encrypted PDF is flagged password-protected and excluded; the rest still merge', async ({ page }) => {
  await boot(page);
  await addGeneratedPdfs(page, [
    { name: 'clear1.pdf', pages: [{ w: 200, h: 100 }] },
    { name: 'clear2.pdf', pages: [{ w: 200, h: 100 }] },
  ]);
  await expect(page.locator('.pdf-row')).toHaveCount(2);
  await addRawFiles(page, [{ name: 'locked.pdf', bytes: encryptedPdfBytes(), type: 'application/pdf' }]);
  await expect(page.locator('.pdf-row')).toHaveCount(3);

  const lockedRow = rowByName(page, 'locked.pdf');
  await expect(lockedRow).toHaveClass(/is-locked/);
  await expect(lockedRow.locator('.row-meta')).toContainText('Password-protected');
  await expect(lockedRow.locator('.row-meta')).toContainText('excluded');
  await expect(lockedRow.locator('.ord')).toHaveText('—');

  await expect(page.locator('#merge')).toBeEnabled();
  const dlPromise = page.waitForEvent('download');
  await page.locator('#merge').click();
  const buf = readFileSync(await (await dlPromise).path());
  const { pageCount } = await readMerged(buf);
  expect(pageCount).toBe(2); // the locked file contributed nothing
});

// --- 6. pdf-lib is lazy: 0 /vendor/pdf-lib/ requests before the first PDF -----

test('6. pdf-lib is not fetched until the first PDF is added', async ({ page }) => {
  const pdflibReqs = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/pdf-lib/')) pdflibReqs.push(r.url()); });
  await boot(page);
  // Nothing added yet → the engine must not have been fetched. (Fixtures here
  // are Node-built so the harness itself never imports pdf-lib in this page.)
  expect(pdflibReqs.length).toBe(0);

  await addRawFiles(page, [{ name: 'lazy.pdf', bytes: await makePdfNode([{ w: 200, h: 100 }, { w: 200, h: 100 }]), type: 'application/pdf' }]);
  await expect(page.locator('.pdf-row')).toHaveCount(1);
  await expect(page.locator('.pdf-row .row-meta').first()).toContainText('2 pages');
  expect(pdflibReqs.length).toBeGreaterThan(0); // adding a PDF pulled the engine
});

// --- 7. Fewer than 2 readable PDFs → Merge disabled --------------------------

test('7. Merge is disabled with only one readable PDF', async ({ page }) => {
  await boot(page);
  await addGeneratedPdfs(page, [{ name: 'solo.pdf', pages: [{ w: 200, h: 100 }] }]);
  await expect(page.locator('.pdf-row')).toHaveCount(1);
  await expect(page.locator('#merge')).toBeDisabled();
  await expect(page.locator('#merge-hint')).toContainText('Add at least one more PDF');
});

// --- 8. XSS filename is inert ------------------------------------------------

test('8. an XSS-crafted filename is rendered as inert text', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const xss = '<img src=x onerror=alert(1)>.pdf';
  await addGeneratedPdfs(page, [{ name: xss, pages: [{ w: 200, h: 100 }] }]);
  await expect(page.locator('.pdf-row')).toHaveCount(1);
  await expect(page.locator('.pdf-row .row-name')).toHaveText(xss); // escaped → literal text
  await expect(page.locator('#list img')).toHaveCount(0);            // no element injected
  expect(dialogFired).toBe(false);                                   // nothing executed
});

// --- 9. a11y: axe + keyboard reaches the move buttons and Merge --------------

test('9. no serious/critical axe violations; keyboard reaches move buttons and Merge', async ({ page }) => {
  await boot(page);
  // Empty state.
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  await addGeneratedPdfs(page, [
    { name: 'p.pdf', pages: [{ w: 200, h: 100 }] },
    { name: 'q.pdf', pages: [{ w: 300, h: 100 }] },
  ]);
  await expect(page.locator('.pdf-row')).toHaveCount(2);

  // With rows present (the interactive surface).
  const withRows = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(withRows);
  if (blockers.length) {
    console.error('[a11y merge-pdf] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);

  // A move button is a real, focusable native button.
  const moveDown = page.getByRole('button', { name: 'Move p.pdf down' });
  await moveDown.focus();
  await expect(moveDown).toBeFocused();
  expect(await moveDown.evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);

  // Merge is reachable and focusable too.
  const merge = page.locator('#merge');
  await merge.focus();
  await expect(merge).toBeFocused();
  expect(await merge.evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);
});

// --- 10. 375px: no horizontal overflow after content loads -------------------

test('10. no horizontal overflow at 375px with a mixed, loaded list', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  // A long name + an excluded (locked) row stress wrapping at the narrow width.
  await addGeneratedPdfs(page, [
    { name: 'a-really-quite-long-document-filename-that-could-overflow.pdf', pages: [{ w: 200, h: 100 }] },
    { name: 'plain.pdf', pages: [{ w: 200, h: 100 }] },
  ]);
  await expect(page.locator('.pdf-row')).toHaveCount(2);
  await addRawFiles(page, [{ name: 'locked.pdf', bytes: encryptedPdfBytes(), type: 'application/pdf' }]);
  await expect(page.locator('.pdf-row')).toHaveCount(3);

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
