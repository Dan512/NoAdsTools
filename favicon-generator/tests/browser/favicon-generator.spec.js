// favicon-generator/tests/browser/favicon-generator.spec.js — the favicon
// package builder end-to-end. Fixtures are drawn in-page (canvas → PNG/JPEG
// bytes) so source dimensions are deterministic without committing binaries.
//
// HARNESS NOTES (load-bearing, do not remove):
//  1. JSZip is lazy — the request recorder is attached BEFORE boot so the
//     "0 requests before, ≥1 after" assertion cannot miss an early fetch.
//  2. The package is unzipped IN-PAGE via window.JSZip (the loader sets it as a
//     global after the first "Download package" click), so the ZIP is verified
//     with the same library that wrote it — no Node unzip dependency.
//  3. The 375px no-overflow test narrows the viewport AFTER loading an image
//     (900 → 375); a fresh-load-at-375 would pass while missing a stale-render
//     overflow that only shows post-narrow.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

async function boot(page) {
  await page.goto('/favicon-generator/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Draw a valid, non-trivial, fully opaque image (gradient + vertical bars) at a
// known size. Opaque everywhere so a square source fills the whole padded
// square (every previewed pixel has alpha ≠ 0 → a robust "rendered" probe).
async function makeFixtures(page) {
  return page.evaluate(async () => {
    const draw = (w, h) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#204060'); g.addColorStop(1, '#a0c0e0');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.fillStyle = '#e0b040';
      for (let i = 0; i < w; i += 40) x.fillRect(i, 0, 20, h);
      return c;
    };
    const bytes = (c, type, q) => new Promise((res) => c.toBlob(
      async (b) => res([...new Uint8Array(await b.arrayBuffer())]), type, q));
    return {
      square: await bytes(draw(512, 512), 'image/png'),       // 512×512 square PNG
      wide: await bytes(draw(800, 400), 'image/jpeg', 0.92),  // 800×400 non-square JPEG
    };
  });
}

async function dropFiles(page, files /* [{name, bytes, type}] */) {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) {
      dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type, lastModified: 1700000000000 }));
    }
    document.getElementById('dropzone')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, files);
}

// Drop one source image and wait for the editor + status line to reflect it.
async function loadImage(page, file) {
  await dropFiles(page, [file]);
  await expect(page.locator('#editor')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#status-line')).toContainText('Source:', { timeout: 30000 });
}

async function downloadBytes(page, triggerLocator) {
  const dlPromise = page.waitForEvent('download');
  await triggerLocator.click();
  const dl = await dlPromise;
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

// Unzip the package in-page with the same JSZip the tool used to write it.
async function readPackage(page, bytes) {
  return page.evaluate(async (arr) => {
    const zip = await window.JSZip.loadAsync(new Uint8Array(arr));
    const names = Object.keys(zip.files).sort();
    const u8 = async (n) => [...(await zip.file(n).async('uint8array'))];
    return {
      names,
      ico: await u8('favicon.ico'),
      png192: await u8('favicon-192x192.png'),
      manifestText: await zip.file('site.webmanifest').async('string'),
      snippetText: await zip.file('favicon-snippet.html').async('string'),
    };
  }, [...bytes]);
}

async function decodeDims(page, bytes) {
  return page.evaluate(async (arr) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(arr)]));
    const d = { w: bmp.width, h: bmp.height };
    bmp.close();
    return d;
  }, [...bytes]);
}

// True if the canvas has any non-transparent pixel (i.e. something was drawn).
const canvasHasInk = (page, sel) => page.locator(sel).evaluate((c) => {
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  return false;
});

// Set a native color input and fire its input event (fill() is unreliable on
// <input type="color">).
async function setColor(page, sel, value) {
  await page.locator(sel).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

const noOverflow = (page) => page.evaluate(() => {
  const el = document.documentElement;
  return el.scrollWidth <= el.clientWidth + 1;
});

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter((v) => FAIL.has(v.impact || ''));
}

const PACKAGE_ENTRIES = [
  'apple-touch-icon.png',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-48x48.png',
  'favicon-192x192.png',
  'favicon-512x512.png',
  'favicon-snippet.html',
  'favicon.ico',
  'site.webmanifest',
].sort();

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/favicon-generator/');
  await expect(page).toHaveTitle('Favicon Generator — Free, No Upload · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/favicon-generator/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. drop a square source → previews render at 16 / 32 / 180', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'logo.png', bytes: fx.square, type: 'image/png' });

  for (const [sel, size] of [['#prev-16', 16], ['#prev-32', 32], ['#prev-180', 180]]) {
    const dims = await page.locator(sel).evaluate((c) => ({ w: c.width, h: c.height }));
    expect(dims).toEqual({ w: size, h: size });
    expect(await canvasHasInk(page, sel)).toBe(true);
  }
  expect(await canvasHasInk(page, '#tab-favicon')).toBe(true);
});

test('2. controls (site name / theme / bg / fit) are reflected in the UI', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'logo.png', bytes: fx.square, type: 'image/png' });

  // Site name → tab-mock title (textContent).
  await page.locator('#site-name').fill('Acme Corp');
  await expect(page.locator('#tab-title')).toHaveText('Acme Corp');

  // Theme color → hex readout.
  await setColor(page, '#theme-color', '#123456');
  await expect(page.locator('#theme-color-hex')).toHaveText('#123456');

  // Background: Color mode reveals the color row.
  await expect(page.locator('#bg-color-row')).toBeHidden();
  await page.locator('#bg-mode .fg-opt[data-bg="color"]').click();
  await expect(page.locator('#bg-color-row')).toBeVisible();
  await expect(page.locator('#bg-mode .fg-opt[data-bg="color"]')).toHaveAttribute('aria-pressed', 'true');

  // Fit: Crop presses crop, releases pad.
  await page.locator('#fit-mode .fg-opt[data-fit="crop"]').click();
  await expect(page.locator('#fit-mode .fg-opt[data-fit="crop"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#fit-mode .fg-opt[data-fit="pad"]')).toHaveAttribute('aria-pressed', 'false');
});

test('3. controls and the download button are keyboard-reachable (focusable)', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'logo.png', bytes: fx.square, type: 'image/png' });

  // Reveal the bg color input so it is a real focus target.
  await page.locator('#bg-mode .fg-opt[data-bg="color"]').click();

  for (const sel of ['#site-name', '#theme-color', '#bg-color',
                     '#fit-mode .fg-opt[data-fit="pad"]', '#download-package']) {
    const el = page.locator(sel).first();
    await el.focus();
    await expect(el).toBeFocused();
  }
});

test('4. JSZip is lazy: 0 requests to /vendor/jszip/ before download, ≥1 after', async ({ page }) => {
  const zipReq = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipReq.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'logo.png', bytes: fx.square, type: 'image/png' });

  const btn = page.locator('#download-package');
  await expect(btn).toBeVisible();
  expect(zipReq.length).toBe(0);

  const { name } = await downloadBytes(page, btn);
  expect(name).toBe('favicon-package.zip');
  expect(zipReq.length).toBeGreaterThan(0);
});

test('5. package contains the 9 expected entries; ico header + manifest icons are valid', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'logo.png', bytes: fx.square, type: 'image/png' });

  const { bytes } = await downloadBytes(page, page.locator('#download-package'));
  const pkg = await readPackage(page, bytes);

  // (a) all nine entries present, exactly.
  expect(pkg.names).toEqual(PACKAGE_ENTRIES);

  // (b) favicon.ico starts with the ICO header 00 00 01 00.
  expect(pkg.ico.slice(0, 4)).toEqual([0x00, 0x00, 0x01, 0x00]);

  // (c) site.webmanifest parses and lists the 192 + 512 icons.
  const m = JSON.parse(pkg.manifestText);
  const sizes = m.icons.map((i) => i.sizes).sort();
  expect(sizes).toEqual(['192x192', '512x512']);
  expect(m.display).toBe('standalone');

  // (d) the snippet file carries the paste-in tags.
  expect(pkg.snippetText).toContain('<link rel="manifest" href="/site.webmanifest">');
});

test('6. a non-square source yields a SQUARE png (padded, not distorted)', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'wide.jpg', bytes: fx.wide, type: 'image/jpeg' }); // 800×400

  // Pad is the default → the whole image is centered on a square, no stretching.
  await expect(page.locator('#source-note')).toBeVisible();

  const { bytes } = await downloadBytes(page, page.locator('#download-package'));
  const pkg = await readPackage(page, bytes);
  const dims = await decodeDims(page, pkg.png192);
  expect(dims).toEqual({ w: 192, h: 192 }); // square output from a 2:1 source
});

test('7. XSS in the site name AND the filename stays inert', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const fx = await makeFixtures(page);
  const xssName = '<img src=x onerror=alert(1)>.png';
  await loadImage(page, { name: xssName, bytes: fx.square, type: 'image/png' });

  const xssSite = '</script><img src=x onerror=alert(2)>';
  await page.locator('#site-name').fill(xssSite);
  await expect(page.locator('#tab-title')).toHaveText(xssSite); // literal text, not markup

  // Neither the filename (status line) nor the site name injected an <img>.
  await expect(page.locator('#tool img[src="x"]')).toHaveCount(0);
  await expect(page.locator('#status-line')).toContainText('Source:');
  expect(dialogFired).toBe(false);
});

test('8. a11y: no serious/critical axe violations (initial + with an image loaded)', async ({ page }) => {
  await boot(page);
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'logo.png', bytes: fx.square, type: 'image/png' });
  const loaded = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(loaded);
  if (blockers.length) {
    console.error('[a11y favicon-generator] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);
});

test('9. no horizontal overflow at 375px after narrowing with an image loaded', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImage(page, { name: 'logo.png', bytes: fx.square, type: 'image/png' });

  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(250);
  expect(await noOverflow(page)).toBe(true);
});
