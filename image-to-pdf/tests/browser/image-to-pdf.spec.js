// image-to-pdf/tests/browser/image-to-pdf.spec.js — the tool end-to-end.
// Image fixtures are generated IN-PAGE (canvas → File → DataTransfer →
// change event) so they're guaranteed decodable by the browser under test;
// the HEIC refusal fixture is Node-built bytes (never decoded — only sniffed).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

async function boot(page) {
  await page.goto('/image-to-pdf/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// specs: [{ name, type, w, h, color }]
async function addImages(page, specs) {
  await page.evaluate(async (specList) => {
    const dt = new DataTransfer();
    for (const s of specList) {
      const c = document.createElement('canvas');
      c.width = s.w; c.height = s.h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = s.color;
      ctx.fillRect(0, 0, s.w, s.h);
      const blob = await new Promise((res) => c.toBlob(res, s.type, 0.92));
      dt.items.add(new File([blob], s.name, { type: s.type }));
    }
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, specs);
}

const jpegSpec = { name: 'a.jpg', type: 'image/jpeg', w: 40, h: 30, color: '#c00' };
const pngSpec = { name: 'b.png', type: 'image/png', w: 30, h: 40, color: '#060' };
const webpSpec = { name: 'c.webp', type: 'image/webp', w: 20, h: 20, color: '#008' };

// Minimal ISO-BMFF header: [size][ftyp][heic brand] — enough for the sniffer.
const heicFile = () => ({
  name: 'photo.heic', mimeType: 'image/heic',
  buffer: Buffer.concat([
    Buffer.from([0, 0, 0, 20]), Buffer.from('ftypheic'),
    Buffer.from([0, 0, 0, 0]), Buffer.from('heic'),
  ]),
});

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/image-to-pdf/');
  await expect(page).toHaveTitle('Image to PDF — Free, No Upload · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/image-to-pdf/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('adding images renders rows in order with honest embed notes', async ({ page }) => {
  await boot(page);
  await addImages(page, [jpegSpec, pngSpec]);
  await expect(page.locator('.pdf-row')).toHaveCount(2);
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['a.jpg', 'b.png']);
  await expect(page.locator('.pdf-row .row-meta').first()).toContainText('embedded without re-encoding');
  await expect(page.locator('.pdf-row .row-meta').nth(1)).toContainText('PNG');
  await expect(page.locator('.pdf-row .row-thumb')).toHaveCount(2);
  await expect(page.locator('#create-pdf')).toBeEnabled();
});

test('Move buttons reorder rows; edges are disabled; aria-labels name the file', async ({ page }) => {
  await boot(page);
  await addImages(page, [jpegSpec, pngSpec]);
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['a.jpg', 'b.png']);
  // Edge state before the move: first row can't go up, last can't go down.
  await expect(page.getByRole('button', { name: 'Move a.jpg up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move b.png down' })).toBeDisabled();
  await page.getByRole('button', { name: 'Move a.jpg down' }).click();
  await expect(page.locator('.pdf-row .row-name')).toHaveText(['b.png', 'a.jpg']);
  // Edge state follows the new order.
  await expect(page.getByRole('button', { name: 'Move b.png up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move a.jpg down' })).toBeDisabled();
  // Focus restoration after the re-render: a.jpg's Down is now edge-disabled,
  // so focus falls to that row's still-usable button — keyboard users keep
  // their place on the moved row.
  await expect(page.getByRole('button', { name: 'Move a.jpg up' })).toBeFocused();
});

test('Remove empties the list; Create is unavailable without convertible images', async ({ page }) => {
  await boot(page);
  await addImages(page, [jpegSpec]);
  await expect(page.locator('#create-pdf')).toBeEnabled();
  await page.getByRole('button', { name: 'Remove a.jpg' }).click();
  await expect(page.locator('.pdf-row')).toHaveCount(0);
  await expect(page.locator('#builder')).toBeHidden();
  // A refusal-only list keeps Create disabled (nothing to put in a PDF).
  await page.locator('#file-input').setInputFiles(heicFile());
  await expect(page.locator('.pdf-row')).toHaveCount(1);
  await expect(page.locator('#create-pdf')).toBeDisabled();
});

test('jsPDF loads lazily on Create; download is a real PDF (%PDF- magic)', async ({ page }) => {
  await boot(page);
  const pdfRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jspdf/')) pdfRequests.push(r.url()); });
  await addImages(page, [jpegSpec, pngSpec, webpSpec]);
  await expect(page.locator('.pdf-row')).toHaveCount(3);
  await expect(page.locator('.pdf-row .row-meta').nth(2)).toContainText('re-encoded');
  expect(pdfRequests.length).toBe(0); // nothing fetched before the click
  const dlPromise = page.waitForEvent('download');
  await page.locator('#create-pdf').click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('noadstools-images.pdf');
  const buf = fs.readFileSync(await dl.path());
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buf.length).toBeGreaterThan(1000);
  expect(pdfRequests.length).toBeGreaterThan(0);
  // A4 exercises the pt-unit branch (oriented page, 36 pt margin math).
  await page.locator('#page-size').selectOption('a4');
  const dlPromise2 = page.waitForEvent('download');
  await page.locator('#create-pdf').click();
  const dl2 = await dlPromise2;
  const buf2 = fs.readFileSync(await dl2.path());
  expect(buf2.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('EXIF-rotated JPEG is re-encoded (honest label); untagged JPEG keeps passthrough', async ({ page }) => {
  await boot(page);
  // Build a real 40×30 canvas JPEG, then splice in an APP1 Exif segment whose
  // IFD0 holds a single Orientation (0x0112) = 6 entry ("rotate 90° CW").
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40; c.height = 30;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#c60';
    ctx.fillRect(0, 0, 40, 30);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    const plain = new Uint8Array(await blob.arrayBuffer());
    const app1 = Uint8Array.from([
      0xFF, 0xE1, 0x00, 0x22,                         // APP1, length 34
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,             // 'Exif\0\0'
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF header (II)
      0x01, 0x00,                                     // IFD0: 1 entry
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, // tag 0x0112, SHORT, count 1
      0x06, 0x00, 0x00, 0x00,                         // value 6
      0x00, 0x00, 0x00, 0x00,                         // next IFD: none
    ]);
    const tagged = new Uint8Array(plain.length + app1.length);
    tagged.set(plain.subarray(0, 2), 0);              // SOI stays first
    tagged.set(app1, 2);
    tagged.set(plain.subarray(2), 2 + app1.length);
    const dt = new DataTransfer();
    dt.items.add(new File([tagged], 'rotated.jpg', { type: 'image/jpeg' }));
    dt.items.add(new File([plain], 'plain.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.pdf-row')).toHaveCount(2);
  const metas = page.locator('.pdf-row .row-meta');
  await expect(metas.first()).toContainText('rotated + re-encoded');
  await expect(metas.first()).toContainText('30 × 40'); // rotation baked into dims
  await expect(metas.nth(1)).toContainText('embedded without re-encoding');
  const dlPromise = page.waitForEvent('download');
  await page.locator('#create-pdf').click();
  const buf = fs.readFileSync(await (await dlPromise).path());
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // Two DISTINCT embedded images (regression guard: jsPDF's auto-alias hashes
  // only half the bytes and can collide for same-encoder JPEGs, silently
  // reusing page 1's picture on page 2 — we pass explicit per-row aliases).
  const xobjects = buf.toString('latin1').match(/\/Subtype \/Image/g) || [];
  expect(xobjects.length).toBe(2);
});

test('HEIC is refused with a row linking the converter', async ({ page }) => {
  await boot(page);
  await page.locator('#file-input').setInputFiles(heicFile());
  const row = page.locator('.pdf-row').first();
  await expect(row.locator('.result-error')).toContainText('HEIC');
  await expect(row.locator('a[href="/heic-to-jpg/"]')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Remove photo.heic' })).toBeVisible();
});

test('privacy panel opens with the tool rows', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle-header').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2').first()).toContainText('What this page loads');
  await expect(dialog).toContainText('jsPDF');
  await expect(dialog).toContainText('noadstools:settings:image-to-pdf');
});
