// convert-image/tests/browser/convert-image.spec.js — the tool end-to-end.
//
// Convert is the any-to-any sibling of compress-images: the user picks ONE
// output format (JPEG/PNG/WebP/AVIF) + a quality, and every input is re-encoded
// to it. Fixtures are drawn in-page (canvas → PNG bytes) so sizes are
// deterministic without committing binaries. FIXTURE RULE: keep them high-
// entropy (deterministic block noise) so a lossy target at a low quality is
// reliably smaller than at a high one. Strengthen the fixture, never loosen an
// assertion.
//
// The decode + @jsquash-encode pipeline runs inside a module Web Worker. The
// `/vendor/jsquash/<codec>/` request assertions therefore rely on Playwright
// surfacing dedicated-worker requests on page.on('request') / page.route —
// which it does for dedicated workers owned by the page. Every request listener
// is registered BEFORE boot so nothing loaded during boot is missed.
//
// AVIF is the largest codec (~3.3 MB) and the slowest to encode, so its tests
// use a small fixture and generous timeouts.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

async function boot(page) {
  await page.goto('/convert-image/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Deterministic block-noise canvases → high-entropy PNGs. A lossy re-encode of
// noise is reliably smaller at a low quality than a high one, and each PNG
// decodes back to its exact source dimensions.
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
    // A minimal valid 1×1 transparent GIF89a — canvas can't encode image/gif,
    // so use a known-good literal. It decodes to a single frame, which is the
    // point: the card must flag GIF first-frame conversion.
    const gif = Array.from(
      atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
      (ch) => ch.charCodeAt(0),
    );
    return {
      // 800×600 PNG — the base fixture (decode check + quality-delta test).
      png: await bytes(noiseCanvas(800, 600, 4), 'image/png'),
      // 120×90 PNG — small, so AVIF encode stays quick.
      smallPng: await bytes(noiseCanvas(120, 90, 3), 'image/png'),
      gif,
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

// Range inputs can't be Playwright-filled; set + dispatch input instead.
async function setQuality(page, value) {
  await page.locator('#quality').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function downloadBytes(page, triggerLocator) {
  const dlPromise = page.waitForEvent('download');
  await triggerLocator.click();
  const dl = await dlPromise;
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

// Decode bytes back in-page → confirms the output is a real, readable image.
async function decodeDims(page, bytes, type) {
  return page.evaluate(async ({ bytes, type }) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
    const d = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return d;
  }, { bytes: [...bytes], type });
}

const isWebp = (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 // "RIFF"
  && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;               // "WEBP"

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
  await page.goto('/convert-image/');
  await expect(page).toHaveTitle('Convert Image — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/convert-image/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. PNG → WebP: real WebP out, decodes at the source dimensions, .webp name', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#out-format').selectOption('webp'); // the landing default, made explicit
  await dropFiles(page, [{ name: 'photo.png', bytes: fx.png, type: 'image/png' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-format')).toContainText('WebP', { timeout: 30000 });
  await expect(card.locator('.card-format')).toContainText('PNG'); // SRC → TGT label

  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('photo.webp');           // extension swapped
  expect(isWebp(bytes)).toBe(true);          // genuine WebP magic bytes
  const dims = await decodeDims(page, bytes, 'image/webp');
  expect(dims).toEqual({ width: 800, height: 600 }); // decodes at source size
});

test('2. codec laziness: converting to WebP fetches the webp codec and none of jpeg/avif', async ({ page }) => {
  const req = { webp: [], jpeg: [], avif: [] };
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/vendor/jsquash/webp/')) req.webp.push(u);
    if (u.includes('/vendor/jsquash/jpeg/')) req.jpeg.push(u);
    if (u.includes('/vendor/jsquash/avif/')) req.avif.push(u);
  });
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#out-format').selectOption('webp');
  await dropFiles(page, [{ name: 'photo.png', bytes: fx.png, type: 'image/png' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });

  expect(req.webp.length).toBeGreaterThan(0);
  expect(req.jpeg.length).toBe(0);
  expect(req.avif.length).toBe(0);
});

test('3. AVIF codec is fetched only after switching to AVIF, never before', async ({ page }) => {
  test.setTimeout(120000); // the AVIF encoder is large + slow
  const req = { avif: [], jpeg: [] };
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/vendor/jsquash/avif/')) req.avif.push(u);
    if (u.includes('/vendor/jsquash/jpeg/')) req.jpeg.push(u);
  });
  await boot(page);
  const fx = await makeFixtures(page);

  // Default WebP conversion first — AVIF codec must NOT be fetched yet.
  await page.locator('#out-format').selectOption('webp');
  await dropFiles(page, [{ name: 'small.png', bytes: fx.smallPng, type: 'image/png' }]);
  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-format')).toContainText('WebP', { timeout: 30000 });
  expect(req.avif.length).toBe(0);

  // Switch to AVIF → NOW the avif codec loads and a real AVIF is produced.
  await page.locator('#out-format').selectOption('avif');
  await expect(card.locator('.card-format')).toContainText('AVIF', { timeout: 90000 });
  expect(req.avif.length).toBeGreaterThan(0);
  expect(req.jpeg.length).toBe(0); // only the chosen targets' codecs, ever
});

test('4. quality slider changes a lossy output size', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#out-format').selectOption('webp');
  await setQuality(page, 92);
  await dropFiles(page, [{ name: 'photo.png', bytes: fx.png, type: 'image/png' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-meta')).toContainText('quality 92', { timeout: 30000 });
  const hi = await downloadBytes(page, card.locator('.card-download'));

  await setQuality(page, 15); // debounced re-convert
  await expect(card.locator('.card-meta')).toContainText('quality 15', { timeout: 30000 });
  const lo = await downloadBytes(page, card.locator('.card-download'));

  expect(isWebp(hi.bytes)).toBe(true);
  expect(isWebp(lo.bytes)).toBe(true);
  expect(lo.bytes.length).toBeLessThan(hi.bytes.length); // lower quality = smaller
});

test('5. AVIF encoder load failure disables AVIF, offers WebP, still produces a real WebP', async ({ page }) => {
  test.setTimeout(90000);
  // Force every AVIF codec fetch (glue + wasm) to fail.
  await page.route('**/vendor/jsquash/avif/**', (r) => r.abort());
  await boot(page);
  const fx = await makeFixtures(page);

  await page.locator('#out-format').selectOption('avif');
  await dropFiles(page, [{ name: 'small.png', bytes: fx.smallPng, type: 'image/png' }]);

  // AVIF option is disabled + relabeled; the select auto-switches to WebP.
  await expect(page.locator('#out-format option[value="avif"]')).toBeDisabled({ timeout: 60000 });
  await expect(page.locator('#out-format option[value="avif"]')).toHaveText(/unavailable/);
  await expect(page.locator('#out-format')).toHaveValue('webp');
  await expect(page.locator('#status-line')).toContainText('AVIF');
  await expect(page.locator('#status-line')).toContainText('WebP');

  // A real WebP output is produced — no hang.
  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-format')).toContainText('WebP', { timeout: 60000 });
  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('small.webp');
  expect(isWebp(bytes)).toBe(true);
});

test('6. ZIP is lazy: no /vendor/jszip/ until Download all is clicked; entry has the swapped extension', async ({ page }) => {
  const zipReq = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipReq.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#out-format').selectOption('webp');
  await dropFiles(page, [{ name: 'photo.png', bytes: fx.png, type: 'image/png' }]);

  const zipBtn = page.locator('#download-zip');
  await expect(zipBtn).toBeEnabled({ timeout: 30000 });
  expect(zipReq.length).toBe(0); // nothing loaded until the click

  const { name, bytes } = await downloadBytes(page, zipBtn);
  expect(name).toBe('converted-images.zip');
  expect(zipReq.length).toBeGreaterThan(0);
  // STORE zips write entry names as plain ASCII in the local file header — so a
  // swapped-extension entry (photo.png → photo.webp) is directly observable.
  expect(bytes.includes(Buffer.from('photo.webp'))).toBe(true);
});

test('7. GIF input flags first-frame-only conversion', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#out-format').selectOption('webp');
  await dropFiles(page, [{ name: 'anim.gif', bytes: fx.gif, type: 'image/gif' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-format')).toContainText('GIF'); // SRC label
  await expect(card.locator('.card-note.is-firstframe')).toBeVisible();
  await expect(card.locator('.card-note.is-firstframe')).toContainText('First frame only');
});

test('8. XSS filename is rendered inert in the card', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const fx = await makeFixtures(page);
  const xss = '<img src=x onerror=alert(1)>.png';
  await page.locator('#out-format').selectOption('webp');
  await dropFiles(page, [{ name: xss, bytes: fx.png, type: 'image/png' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-name')).toHaveText(xss); // escaped → literal text, not markup
  await expect(page.locator('#cards .card-name img')).toHaveCount(0);
  await expect(page.locator('#cards img[src="x"]')).toHaveCount(0);
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  expect(dialogFired).toBe(false);
});

test('9. a11y: no serious/critical axe violations (initial + results); keyboard reaches format + slider', async ({ page }) => {
  await boot(page);

  // Initial state.
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  // Keyboard reaches the format select (a real tab stop).
  const fmt = page.locator('#out-format');
  await fmt.focus();
  await expect(fmt).toBeFocused();
  expect(await fmt.evaluate((el) => el.tabIndex >= 0)).toBe(true);

  // Keyboard reaches the slider and arrows change it + its readout.
  const slider = page.locator('#quality');
  await slider.focus();
  await expect(slider).toBeFocused();
  expect(await slider.evaluate((el) => el.tabIndex >= 0)).toBe(true);
  const before = await slider.inputValue();
  await page.keyboard.press('ArrowLeft');
  const after = await slider.inputValue();
  expect(Number(after)).toBe(Number(before) - 1);
  await expect(page.locator('#quality-value')).toHaveText(after);

  // With-results state.
  const fx = await makeFixtures(page);
  await dropFiles(page, [{ name: 'photo.png', bytes: fx.png, type: 'image/png' }]);
  await expect(page.locator('#cards .card .card-download')).toBeVisible({ timeout: 30000 });
  const withResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(withResults);
  if (blockers.length) {
    console.error('[a11y convert-image] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);
});

test('10. no horizontal overflow at 375px (initial + with results)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);

  const overflows = () => page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(await overflows()).toBeLessThanOrEqual(1);

  // A long filename + a result card must still not push the page wide.
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'a-fairly-long-filename-that-should-wrap-not-scroll.png', bytes: fx.png, type: 'image/png' },
  ]);
  await expect(page.locator('#cards .card .card-download')).toBeVisible({ timeout: 30000 });
  expect(await overflows()).toBeLessThanOrEqual(1);
});
