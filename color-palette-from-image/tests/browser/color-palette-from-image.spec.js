// color-palette-from-image/tests/browser/color-palette-from-image.spec.js —
// the tool end-to-end. Fixtures are drawn in-page (canvas → PNG bytes) so the
// palette is deterministic without committing binaries. PNG (lossless) keeps
// flat blocks EXACT — the flat fixture's three colors survive as precise hexes,
// which is what the dedupe + dominant-in-palette guards below rely on.
//
// Two fixtures:
//  - flat3: three solid blocks, red dominant (60% area) > blue (25%) > green
//    (15%). Distinct, exact colors. Requesting MORE colors than are present
//    exercises median-cut's tendency to emit the same pure-color average from
//    multiple buckets — the exact bug the quantize dedupe fixes — so this
//    fixture guards "no padded duplicates" and "dominant appears in palette".
//  - noise: block-noise → many clusters, so changing the color-count control
//    actually changes how many swatches render.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

const HEX = /^#[0-9a-f]{6}$/;

async function boot(page) {
  await page.goto('/color-palette-from-image/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

async function makeFixtures(page) {
  return page.evaluate(async () => {
    const bytes = (c) => new Promise((res) => c.toBlob(
      async (b) => res([...new Uint8Array(await b.arrayBuffer())]), 'image/png'));

    // flat3: red 0–120, blue 120–170, green 170–200 (width). Red is the
    // most-populous region → the dominant. Colors chosen distinct + exact.
    const flat = document.createElement('canvas'); flat.width = 200; flat.height = 100;
    const fx = flat.getContext('2d');
    fx.fillStyle = '#cc2222'; fx.fillRect(0, 0, 120, 100);
    fx.fillStyle = '#2244cc'; fx.fillRect(120, 0, 50, 100);
    fx.fillStyle = '#22aa55'; fx.fillRect(170, 0, 30, 100);

    // noise: deterministic block noise → many distinct clusters.
    const noise = document.createElement('canvas'); noise.width = 200; noise.height = 200;
    const nx = noise.getContext('2d');
    let seed = 0x9e3779b9 >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 200; i += 10) for (let j = 0; j < 200; j += 10) {
      nx.fillStyle = `rgb(${(rnd() * 256) | 0},${(rnd() * 256) | 0},${(rnd() * 256) | 0})`;
      nx.fillRect(i, j, 10, 10);
    }
    return { flat: await bytes(flat), noise: await bytes(noise) };
  });
}

async function dropFile(page, name, bytes, type = 'image/png') {
  await page.evaluate(({ name, bytes, type }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type, lastModified: 1700000000000 }));
    document.getElementById('dropzone')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { name, bytes, type });
}

async function waitForSwatches(page) {
  await expect(page.locator('#swatch-grid .swatch').first()).toBeVisible({ timeout: 15000 });
}

async function swatchHexes(page) {
  return page.locator('#swatch-grid .swatch .swatch-hex').allTextContents();
}

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/color-palette-from-image/');
  await expect(page).toHaveTitle('Color Palette From Image — Free, No Upload · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/color-palette-from-image/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. flat fixture → dominant swatch + palette swatches, each with a hex label', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);

  // Dominant is called out with its hex/RGB/HSL. Red is the biggest region, so
  // the most-populous palette bucket is pure red — an exact, deterministic hex.
  await expect(page.locator('#dominant-hex')).toHaveText('#cc2222');
  await expect(page.locator('#dominant-rgb')).toContainText('RGB 204, 34, 34');
  await expect(page.locator('#dominant-hsl')).toContainText('HSL');

  // A palette of swatches renders, each carrying a real hex label. (Median-cut
  // can emit blends between the flat blocks, so the count isn't pinned to 3 —
  // what matters is every swatch shows a valid hex.)
  const hexes = await swatchHexes(page);
  expect(hexes.length).toBeGreaterThan(0);
  for (const h of hexes) expect(h).toMatch(HEX);
});

test('2. colorblind: every swatch carries its exact hex as TEXT (color is never the only signal)', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'noise.png', fx.noise);
  await waitForSwatches(page);

  const swatches = page.locator('#swatch-grid .swatch');
  const n = await swatches.count();
  expect(n).toBeGreaterThan(0);
  // Text hex label node exists on EVERY swatch and reads as a real hex value.
  const hexes = await swatchHexes(page);
  expect(hexes.length).toBe(n);
  for (const h of hexes) expect(h).toMatch(HEX);
  // Each swatch also carries its RGB triplet as text.
  const rgbs = await page.locator('#swatch-grid .swatch .swatch-rgb').allTextContents();
  expect(rgbs.length).toBe(n);
  for (const r of rgbs) expect(r).toMatch(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
});

test('3. the dominant hex ALSO appears among the palette swatches (dominant-in-palette guard)', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);

  const dominant = await page.locator('#dominant-hex').textContent();
  expect(dominant).toMatch(HEX);
  const hexes = await swatchHexes(page);
  expect(hexes).toContain(dominant); // the shown dominant is a real palette entry
});

test('4. flat fixture at a high color-count → palette has NO duplicate hexes (dedupe guard)', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);

  // Ask for far more colors than the image contains — pre-dedupe median-cut
  // over-splits the dominant regions and emits the SAME pure-color average from
  // multiple buckets (e.g. red twice). The dedupe must collapse those, so no
  // two swatches share a hex.
  await page.locator('#color-count').selectOption('12');
  await expect.poll(async () => (await swatchHexes(page)).length).toBeGreaterThan(0);

  const hexes = await swatchHexes(page);
  expect(new Set(hexes).size).toBe(hexes.length); // no duplicate swatches (no padded fakes)
});

test('5. changing the color-count changes how many swatches render', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'noise.png', fx.noise);
  await waitForSwatches(page);

  await page.locator('#color-count').selectOption('4');
  await expect.poll(async () => (await swatchHexes(page)).length).toBe(4);
  const four = (await swatchHexes(page)).length;

  await page.locator('#color-count').selectOption('12');
  await expect.poll(async () => (await swatchHexes(page)).length).toBeGreaterThan(four);
  const twelve = (await swatchHexes(page)).length;
  expect(twelve).toBeGreaterThan(four);
});

test('6. Copy hex list writes a comma-separated hex list to the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);

  await page.locator('#copy-hex').click();
  await expect(page.locator('#copy-hex')).toContainText('Copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toMatch(/#[0-9a-f]{6}(, #[0-9a-f]{6})+/);
});

test('7. Copy CSS variables writes a :root block to the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);

  await page.locator('#copy-css').click();
  await expect(page.locator('#copy-css')).toContainText('Copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(':root');
  expect(clip).toMatch(/--color-1:\s*#[0-9a-f]{6};/);
});

test('8. Download palette (PNG) fires a palette.png download', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);

  const dlPromise = page.waitForEvent('download');
  await page.locator('#download-png').click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('palette.png');
  // Bytes are a real PNG (signature 0x89 'P' 'N' 'G').
  const bytes = readFileSync(await dl.path());
  expect(bytes[0]).toBe(0x89);
  expect(bytes[1]).toBe(0x50);
  expect(bytes[2]).toBe(0x4e);
  expect(bytes[3]).toBe(0x47);
});

test('9. HEADLINE: NO third-party requests across the whole flow', async ({ page }) => {
  const offOrigin = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    let host = '';
    try { host = new URL(url).hostname; } catch { return; }
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') offOrigin.push(url);
  });

  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);
  await page.locator('#color-count').selectOption('12');
  await expect.poll(async () => (await swatchHexes(page)).length).toBeGreaterThan(0);
  // Exercise every copy path (local clipboard/textarea — never a network call).
  await page.locator('#copy-hex').click();
  await page.locator('#copy-css').click();
  await page.locator('#copy-json').click();
  // And the PNG export path.
  const dlPromise = page.waitForEvent('download');
  await page.locator('#download-png').click();
  await dlPromise;

  expect(offOrigin, `off-origin requests: ${JSON.stringify(offOrigin)}`).toEqual([]);
});

test('10. XSS filename is rendered inert', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const fx = await makeFixtures(page);
  const xss = '<img src=x onerror=alert(1)>.png';
  await dropFile(page, xss, fx.flat);
  await waitForSwatches(page);

  await expect(page.locator('#preview-name')).toHaveText(xss); // literal text, not markup
  await expect(page.locator('#preview-name img')).toHaveCount(0);
  await expect(page.locator('#result img[src="x"]')).toHaveCount(0);
  expect(dialogFired).toBe(false);
});

test('11. a11y: no serious/critical axe violations; keyboard reaches count + copy controls', async ({ page }) => {
  await boot(page);

  // Initial (dropzone-only) state.
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  const fx = await makeFixtures(page);
  await dropFile(page, 'flat.png', fx.flat);
  await waitForSwatches(page);

  // Keyboard reaches the color-count select and the copy buttons (real tab stops).
  const count = page.locator('#color-count');
  await count.focus();
  await expect(count).toBeFocused();
  expect(await count.evaluate((el) => el.tabIndex >= 0)).toBe(true);
  const copyHex = page.locator('#copy-hex');
  await copyHex.focus();
  await expect(copyHex).toBeFocused();
  expect(await copyHex.evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);

  // With-results state.
  const withResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(withResults);
  if (blockers.length) {
    console.error('[a11y color-palette-from-image] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);
});

test('12. 375px viewport: no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFile(page, 'noise.png', fx.noise);
  await waitForSwatches(page);
  await page.locator('#color-count').selectOption('12');
  await expect.poll(async () => (await swatchHexes(page)).length).toBeGreaterThan(0);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
