// heic-to-jpg/tests/browser/heic-to-jpg.spec.js — the tool end-to-end.
//
// Coverage strategy (mirrors the editor's heic-import.spec.js):
//   - ONE test decodes the real committed fixture (tests/fixtures/sample.heic,
//     copied from photo-editor/tests/fixtures/) through the real vendored
//     libheif WASM at /vendor/libheif/ — proving the repointed loader works.
//   - The keep-metadata + ZIP flows use the `_setHeicDecoderForTest` escape
//     hatch + synthetic HEIC bytes (built in Node by ../unit/fixtures.js) so
//     they stay fast and deterministic; the metadata path operates on the real
//     file bytes either way, so the toggle assertion is genuine.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeHeicWithExif, makeHeicNoExif, makeCleanJpeg } from '../unit/fixtures.js';

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample.heic');

async function boot(page) {
  await page.goto('/heic-to-jpg/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Fake 16x16 solid-color decoder — keeps the wasm out of the fast tests. The
// loader module URL matches main.js's relative import, so it's the SAME
// module instance and main.js picks the fake up.
async function installFakeDecoder(page) {
  await page.evaluate(async () => {
    const { _setHeicDecoderForTest } = await import('/heic-to-jpg/js/heic-loader.js');
    _setHeicDecoderForTest({
      decode: async () => {
        const w = 16, h = 16;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 0xff; data[i + 1] = 0x80; data[i + 2] = 0x00; data[i + 3] = 0xff;
        }
        return { data, width: w, height: h };
      },
    });
  });
}

const heicFile = (name, bytes) => ({ name, mimeType: 'image/heic', buffer: Buffer.from(bytes) });

// Run shared/exif.js's detector in-page against a downloaded file's bytes.
async function metadataInPage(page, buf) {
  return await page.evaluate(async (byteArr) => {
    const { hasMetadata } = await import('/shared/exif.js');
    return await hasMetadata(new Blob([new Uint8Array(byteArr)]));
  }, Array.from(buf));
}

async function downloadBytes(page, triggerLocator) {
  const dlPromise = page.waitForEvent('download');
  await triggerLocator.click();
  const dl = await dlPromise;
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/heic-to-jpg/');
  await expect(page).toHaveTitle('HEIC to JPG Converter — Free, No Upload · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/heic-to-jpg/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('decoder loads lazily — no /vendor/libheif/ request at boot; inline note is visible', async ({ page }) => {
  const libheifRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/libheif/')) libheifRequests.push(r.url()); });
  await boot(page);
  expect(libheifRequests.length).toBe(0);
  await expect(page.locator('.decoder-note')).toContainText('1.1 MB decoder');
});

test('real fixture: decoder fetched on first file, row converts, downloads sample.jpg', async ({ page }) => {
  test.skip(!existsSync(FIXTURE_PATH), `Missing fixture: ${FIXTURE_PATH}`);
  const libheifRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/libheif/')) libheifRequests.push(r.url()); });
  await boot(page);
  expect(libheifRequests.length).toBe(0);
  await page.locator('#file-input').setInputFiles(heicFile('sample.heic', readFileSync(FIXTURE_PATH)));
  const row = page.locator('.result-row').first();
  // Wasm load + decode can take a while on slow runners.
  await expect(row.locator('.convert-ok')).toContainText('Converted to JPG', { timeout: 30000 });
  expect(libheifRequests.length).toBeGreaterThan(0); // glue JS + wasm
  await expect(row.locator('.result-thumb')).toHaveCount(1);
  const { name, bytes } = await downloadBytes(page, row.locator('.download-one'));
  expect(name).toBe('sample.jpg');
  // JPEG magic.
  expect(bytes[0]).toBe(0xFF);
  expect(bytes[1]).toBe(0xD8);
});

test('keep-metadata toggle: OFF strips EXIF, ON carries it into the JPG', async ({ page }) => {
  await boot(page);
  await installFakeDecoder(page);

  // Default (OFF): converted JPG must carry no EXIF.
  await expect(page.locator('#keep-metadata')).not.toBeChecked();
  await page.locator('#file-input').setInputFiles(heicFile('off.heic', makeHeicWithExif()));
  const rowOff = page.locator('.result-row').nth(0);
  await expect(rowOff.locator('.convert-ok')).toContainText('Converted', { timeout: 10000 });
  await expect(rowOff).toContainText('not carried over');
  const off = await downloadBytes(page, rowOff.locator('.download-one'));
  expect(off.name).toBe('off.jpg');
  const offMeta = await metadataInPage(page, off.bytes);
  expect(offMeta.exif).toBe(false);
  expect(offMeta.gps).toBe(false);

  // ON: the original EXIF (incl. GPS) is injected into the JPG.
  await page.locator('#keep-metadata').check();
  await page.locator('#file-input').setInputFiles(heicFile('on.heic', makeHeicWithExif()));
  const rowOn = page.locator('.result-row').nth(1);
  await expect(rowOn.locator('.convert-ok')).toContainText('Converted', { timeout: 10000 });
  await expect(rowOn).toContainText('Photo info kept');
  const on = await downloadBytes(page, rowOn.locator('.download-one'));
  expect(on.name).toBe('on.jpg');
  const onMeta = await metadataInPage(page, on.bytes);
  expect(onMeta.exif).toBe(true);
  expect(onMeta.gps).toBe(true);
});

test('keep-metadata ON with a metadata-free HEIC: converts anyway + honest note', async ({ page }) => {
  await boot(page);
  await installFakeDecoder(page);
  await page.locator('#keep-metadata').check();
  await page.locator('#file-input').setInputFiles(heicFile('bare.heic', makeHeicNoExif()));
  const row = page.locator('.result-row').first();
  await expect(row.locator('.convert-ok')).toContainText('Converted', { timeout: 10000 });
  await expect(row).toContainText('No photo info found to keep');
});

test('non-HEIC image gets the friendly "already a JPG" note — no fake work', async ({ page }) => {
  await boot(page);
  await page.locator('#file-input').setInputFiles({
    name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(makeCleanJpeg()),
  });
  const row = page.locator('.result-row').first();
  await expect(row).toContainText('Already a JPG — nothing to convert');
  await expect(row.locator('.download-one')).toHaveCount(0);
  // And the cross-link to remove-exif is there.
  await expect(row.locator('a[href="/remove-exif/"]')).toHaveCount(1);
});

test('JSZip loads lazily; ZIP downloads as noadstools-converted.zip', async ({ page }) => {
  await boot(page);
  await installFakeDecoder(page);
  const zipRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipRequests.push(r.url()); });
  await page.locator('#file-input').setInputFiles([
    heicFile('one.heic', makeHeicNoExif()),
    heicFile('two.heic', makeHeicNoExif()),
  ]);
  await expect(page.locator('.result-row .convert-ok')).toHaveCount(2, { timeout: 10000 });
  expect(zipRequests.length).toBe(0);
  const { name } = await downloadBytes(page, page.locator('#download-zip'));
  expect(name).toBe('noadstools-converted.zip');
  expect(zipRequests.length).toBeGreaterThan(0);
});

test('privacy panel opens with the tool rows', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle-header').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2').first()).toContainText('What this page loads');
  await expect(dialog).toContainText('libheif');
  await expect(dialog).toContainText('1.1 MB');
  await expect(dialog).toContainText('JSZip');
  await expect(dialog).toContainText('noadstools:settings:heic-to-jpg');
});
