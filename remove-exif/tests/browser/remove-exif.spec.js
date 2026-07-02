// remove-exif/tests/browser/remove-exif.spec.js — the tool end-to-end.
// Fixtures are built in Node (pure fixtures.js) and handed to the file input.
import { test, expect } from '@playwright/test';
import { makeJpegWithMetadata, makeJpegWithTrailing, makeHeicBytes } from '../unit/fixtures.js';

async function boot(page) {
  await page.goto('/remove-exif/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}
const jpegFile = () => ({ name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(makeJpegWithMetadata()) });

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/remove-exif/');
  await expect(page).toHaveTitle('Remove EXIF Data — Free, No Upload · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/remove-exif/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('file -> report shows GPS warning + camera fields -> verified clean', async ({ page }) => {
  await boot(page);
  await page.locator('#file-input').setInputFiles(jpegFile());
  const row = page.locator('.result-row').first();
  await expect(row.locator('.report-gps')).toContainText('Location (GPS)');
  await expect(row.locator('.report-camera')).toContainText('TestCam');
  await expect(row.locator('.verified-clean')).toContainText('Verified clean', { timeout: 5000 });
  await expect(row.locator('.result-note')).toContainText('pixels untouched');
});

test('download produces a cleaned file with the original name', async ({ page }) => {
  await boot(page);
  await page.locator('#file-input').setInputFiles(jpegFile());
  await expect(page.locator('.result-row .verified-clean').first()).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.locator('.result-row .download-one').first().click();
  expect((await dl).suggestedFilename()).toBe('holiday.jpg');
});

test('JSZip loads lazily — only after Download ZIP is clicked', async ({ page }) => {
  await boot(page);
  const zipRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipRequests.push(r.url()); });
  await page.locator('#file-input').setInputFiles([jpegFile(), { ...jpegFile(), name: 'two.jpg' }]);
  await expect(page.locator('.result-row')).toHaveCount(2);
  expect(zipRequests.length).toBe(0);
  const dl = page.waitForEvent('download');
  await page.locator('#download-zip').click();
  expect((await dl).suggestedFilename()).toBe('noadstools-clean.zip');
  expect(zipRequests.length).toBeGreaterThan(0);
});

test('HEIC is refused with the friendly pointer', async ({ page }) => {
  await boot(page);
  await page.locator('#file-input').setInputFiles({ name: 'img.heic', mimeType: 'image/heic', buffer: Buffer.from(makeHeicBytes()) });
  await expect(page.locator('.result-row .result-error')).toContainText('HEIC');
  await expect(page.locator('.result-row .result-error')).toContainText('HEIC to JPG');
});

test('privacy panel opens with the tool rows', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle-header').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2').first()).toContainText('What this page loads');
  await expect(dialog).toContainText('JSZip');
  await expect(dialog).toContainText('noadstools:settings:remove-exif');
});

test('multi-file: each row downloads its OWN file (regression: stale-closure download)', async ({ page }) => {
  await boot(page);
  await page.locator('#file-input').setInputFiles([jpegFile(), { ...jpegFile(), name: 'two.jpg' }]);
  await expect(page.locator('.result-row .download-one')).toHaveCount(2);
  const dl = page.waitForEvent('download');
  await page.locator('.result-row').first().locator('.download-one').click();
  expect((await dl).suggestedFilename()).toBe('holiday.jpg');
});

test('motion-photo trailer: reports trailing-data removal and still verifies clean', async ({ page }) => {
  await boot(page);
  await page.locator('#file-input').setInputFiles({ name: 'motion.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(makeJpegWithTrailing()) });
  const row = page.locator('.result-row').first();
  await expect(row.locator('.report-trailing')).toContainText('Trailing data removed');
  await expect(row.locator('.verified-clean')).toContainText('Verified clean', { timeout: 5000 });
});
