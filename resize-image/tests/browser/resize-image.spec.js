// resize-image/tests/browser/resize-image.spec.js — the tool end-to-end.
//
// Fixtures are drawn in-page (canvas → JPEG bytes) so dimensions and sizes are
// deterministic without committing binaries. FIXTURE RULE: to assert a REAL
// resize under the default controls, a fixture must be WIDER than the prefilled
// 800 px width — an ≤800-wide image lands in kept-native by default. Tests that
// need a specific scale set an explicit width instead. Strengthen the fixture,
// never loosen an assertion.
//
// pica runs its resize in its own internal worker pool (workers + WASM inlined
// from the vendored bundle — no external fetch); the `/vendor/pica/` request
// assertions rely on Playwright surfacing the script-inject request, which it
// does for same-origin <script> loads owned by the page.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

async function boot(page) {
  await page.goto('/resize-image/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Deterministic block-noise canvas → high-entropy JPEG that shrinks when scaled
// down (fewer pixels ⇒ fewer bytes at the same quality).
async function makeFixtures(page) {
  return page.evaluate(async () => {
    const noiseCanvas = (w, h, block) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      let seed = 0x9e3779b9 >>> 0;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (let i = 0; i < w; i += block) for (let j = 0; j < h; j += block) {
        x.fillStyle = `rgb(${(rnd() * 256) | 0},${(rnd() * 256) | 0},${(rnd() * 256) | 0})`;
        x.fillRect(i, j, block, block);
      }
      return c;
    };
    const bytes = (c, type, q) => new Promise((res) => c.toBlob(
      async (b) => res([...new Uint8Array(await b.arrayBuffer())]), type, q));
    return {
      // 800×600 landscape — the base fixture (explicit-width tests scale it).
      big: await bytes(noiseCanvas(800, 600, 4), 'image/jpeg', 0.95),
      // 1200×900 — WIDER than the 800 prefill, so it actually resizes on drop
      // with no control changes (proves the prefill gives an immediate result).
      wide: await bytes(noiseCanvas(1200, 900, 4), 'image/jpeg', 0.95),
      // 400×300 — SMALLER than the 800 prefill: kept-native under the default.
      small: await bytes(noiseCanvas(400, 300, 4), 'image/jpeg', 0.95),
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

async function downloadBytes(page, triggerLocator) {
  const dlPromise = page.waitForEvent('download');
  await triggerLocator.click();
  const dl = await dlPromise;
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

const isJpeg = (b) => b[0] === 0xFF && b[1] === 0xD8;

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
  await page.goto('/resize-image/');
  await expect(page).toHaveTitle('Resize Image — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/resize-image/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. dimensions fit-box: width 400 on an 800×600 → "800×600 → 400×300", output smaller', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#target-w').fill('400'); // override the 800 prefill
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.big, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-dims')).toContainText('800×600');
  await expect(card.locator('.card-dims')).toContainText('400×300');

  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('photo.jpg');
  expect(isJpeg(bytes)).toBe(true);
  expect(bytes.length).toBeLessThan(fx.big.length); // genuinely smaller
});

test('2. percentage mode: 50% halves both dimensions', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('input[name="mode"][value="percentage"]').check();
  // #target-pct is prefilled to 50.
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.big, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-dims')).toContainText('800×600');
  await expect(card.locator('.card-dims')).toContainText('400×300');
});

test('3. prefill gives an immediate result: a >800 image resizes to 800 wide untouched controls', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  // No control changes — the 800 prefill drives the resize on drop.
  await dropFiles(page, [{ name: 'wide.jpg', bytes: fx.wide, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-dims')).toContainText('1200×900');
  await expect(card.locator('.card-dims')).toContainText('800×600');
});

test('4. upscale-off: a target larger than native keeps native size + note, original bytes untouched', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  // Default width prefill (800) is larger than this 400×300 image → kept native.
  await dropFiles(page, [{ name: 'small.jpg', bytes: fx.small, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-note.is-kept')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-dims')).toContainText('400×300');
  await expect(card.locator('.card-dims')).not.toContainText('800×600');

  // kept-native passes the ORIGINAL bytes through (no re-encode; metadata kept).
  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('small.jpg');
  expect(bytes.length).toBe(fx.small.length);
});

test('5. unlock: exact 400×400 on an 800×600 forces the size and flags "stretched"', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#aspect-lock').uncheck();
  await page.locator('#target-w').fill('400');
  await page.locator('#target-h').fill('400');
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.big, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-dims')).toContainText('400×400');
  await expect(card.locator('.card-note.is-stretched')).toBeVisible();
});

test('6. pica is lazy: 0 requests to /vendor/pica/ before the first resize, ≥1 after', async ({ page }) => {
  const picaReq = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/pica/')) picaReq.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#target-w').fill('400'); // forces a real resize (not kept-native)
  expect(picaReq.length).toBe(0); // nothing loaded at boot / on fixture draw

  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.big, type: 'image/jpeg' }]);
  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  expect(picaReq.length).toBeGreaterThan(0);
});

test('7. ZIP is lazy: no /vendor/jszip/ until Download all is clicked', async ({ page }) => {
  const zipReq = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipReq.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#target-w').fill('400');
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.big, type: 'image/jpeg' }]);

  const zipBtn = page.locator('#download-zip');
  await expect(zipBtn).toBeEnabled({ timeout: 30000 });
  expect(zipReq.length).toBe(0);

  const { name } = await downloadBytes(page, zipBtn);
  expect(name).toBe('resized-images.zip');
  expect(zipReq.length).toBeGreaterThan(0);
});

test('8. forced pica failure falls back to the canvas scaler, labeled, and still outputs', async ({ page }) => {
  // Every pica script fetch fails → the loader rejects → resize.js draws with
  // the browser's own high-quality scaler and labels the card honestly.
  await page.route('**/vendor/pica/**', (r) => r.abort());
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#target-w').fill('400');
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.big, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-note.is-fallback')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-note.is-fallback')).toContainText('lower-quality');
  // The output is still produced at the right size.
  await expect(card.locator('.card-dims')).toContainText('400×300');
  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('photo.jpg');
  expect(isJpeg(bytes)).toBe(true);
});

test('9. XSS filename is rendered inert in the card', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const fx = await makeFixtures(page);
  const xss = '<img src=x onerror=alert(1)>.jpg';
  await page.locator('#target-w').fill('400');
  await dropFiles(page, [{ name: xss, bytes: fx.big, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-name')).toHaveText(xss); // escaped → literal text
  await expect(page.locator('#cards .card-name img')).toHaveCount(0);
  await expect(page.locator('#cards img[src="x"]')).toHaveCount(0);
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  expect(dialogFired).toBe(false);
});

test('10. a11y: no serious/critical axe violations (initial + results); keyboard reaches Width + mode', async ({ page }) => {
  await boot(page);

  // Initial state.
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  // Keyboard reaches the Width input and the mode toggle (real tab stops).
  const width = page.locator('#target-w');
  await width.focus();
  await expect(width).toBeFocused();
  expect(await width.evaluate((el) => el.tabIndex >= 0)).toBe(true);
  const modeRadio = page.locator('input[name="mode"][value="dimensions"]');
  await modeRadio.focus();
  await expect(modeRadio).toBeFocused();
  expect(await modeRadio.evaluate((el) => el.tabIndex >= 0)).toBe(true);

  // With-results state.
  const fx = await makeFixtures(page);
  await width.fill('400');
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.big, type: 'image/jpeg' }]);
  await expect(page.locator('#cards .card .card-download')).toBeVisible({ timeout: 30000 });
  const withResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(withResults);
  if (blockers.length) {
    console.error('[a11y resize-image] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);
});
