// qr-code-generator/tests/browser/qr-code-generator.spec.js — the tool
// end-to-end: chrome, SEO head, live canvas preview (pixel-checked), WiFi
// payload mode, PNG/SVG downloads, size/ECC re-render, privacy panel.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function boot(page) {
  await page.goto('/qr-code-generator/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Dark and light pixel counts of the preview canvas — a rendered QR has
// plenty of both; a blank canvas doesn't.
function canvasPixelStats(page) {
  return page.evaluate(() => {
    const cnv = document.getElementById('qr-canvas');
    const { data } = cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height);
    let dark = 0;
    let light = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 64 && data[i + 1] < 64 && data[i + 2] < 64) dark++;
      else if (data[i] > 192 && data[i + 1] > 192 && data[i + 2] > 192) light++;
    }
    return { dark, light, width: cnv.width, height: cnv.height };
  });
}

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/qr-code-generator/');
  await expect(page).toHaveTitle('QR Code Generator — Free, No Tracking · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/qr-code-generator/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('typing text renders a non-blank QR canvas (debounced live preview)', async ({ page }) => {
  await boot(page);
  // Before typing: empty hint shown, downloads disabled, no canvas.
  await expect(page.locator('#qr-empty')).toBeVisible();
  await expect(page.locator('#download-png')).toBeDisabled();
  await page.fill('#text-input', 'https://noadstools.com/');
  await expect(page.locator('#qr-canvas')).toBeVisible();
  await expect(page.locator('#qr-meta')).toContainText('modules');
  const px = await canvasPixelStats(page);
  expect(px.width).toBe(512); // default size
  expect(px.dark).toBeGreaterThan(1000);  // modules drawn
  expect(px.light).toBeGreaterThan(1000); // quiet zone + light modules
  await expect(page.locator('#download-png')).toBeEnabled();
  await expect(page.locator('#download-svg')).toBeEnabled();
});

test('WiFi tab: SSID renders a payload QR; None disables the password field', async ({ page }) => {
  await boot(page);
  await page.click('#tab-wifi');
  await expect(page.locator('#tab-wifi')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#tab-text')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#panel-text')).toBeHidden();
  // Empty SSID → hint, no code yet.
  await expect(page.locator('#qr-empty')).toContainText('SSID');
  await page.fill('#wifi-ssid', 'MyNetwork');
  await page.fill('#wifi-password', 'hunter22');
  await expect(page.locator('#qr-canvas')).toBeVisible();
  const px = await canvasPixelStats(page);
  expect(px.dark).toBeGreaterThan(1000);
  // Switching security to None disables the password input (and back re-enables).
  await page.selectOption('#wifi-encryption', 'None');
  await expect(page.locator('#wifi-password')).toBeDisabled();
  await page.selectOption('#wifi-encryption', 'WPA');
  await expect(page.locator('#wifi-password')).toBeEnabled();
});

test('PNG and SVG downloads carry the right filenames; SVG is module-only markup', async ({ page }) => {
  await boot(page);
  await page.fill('#text-input', 'hello world');
  await expect(page.locator('#qr-canvas')).toBeVisible();
  const pngDl = page.waitForEvent('download');
  await page.click('#download-png');
  expect((await pngDl).suggestedFilename()).toBe('qr-code.png');
  const svgDl = page.waitForEvent('download');
  await page.click('#download-svg');
  const svg = await svgDl;
  expect(svg.suggestedFilename()).toBe('qr-code.svg');
  const body = await readFile(await svg.path(), 'utf8');
  expect(body.startsWith('<svg')).toBe(true);
  expect(body).toContain('viewBox');
  // The typed payload must NOT appear in the SVG — modules only.
  expect(body).not.toContain('hello world');
});

test('size and ECC changes re-render the canvas', async ({ page }) => {
  await boot(page);
  await page.fill('#text-input', 'https://noadstools.com/');
  await expect(page.locator('#qr-canvas')).toBeVisible();
  const before = await canvasPixelStats(page);
  expect(before.width).toBe(512);
  await page.selectOption('#qr-size', '1024');
  await expect(page.locator('#qr-meta')).toContainText('1024 × 1024 px');
  const resized = await canvasPixelStats(page);
  expect(resized.width).toBe(1024);
  const dataBefore = await page.evaluate(() => document.getElementById('qr-canvas').toDataURL());
  await page.selectOption('#qr-ecc', 'H');
  await expect(page.locator('#qr-meta')).toContainText('modules');
  const dataAfter = await page.evaluate(() => document.getElementById('qr-canvas').toDataURL());
  expect(dataAfter).not.toBe(dataBefore); // denser code at High ECC
});

test('privacy panel opens with the tool rows', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle-header').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2').first()).toContainText('What this page loads');
  await expect(dialog).toContainText('qrcodegen');
  await expect(dialog).toContainText('noadstools:settings:qr-code-generator');
});
