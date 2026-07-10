// compress-images/tests/browser/compress-images.spec.js — the tool end-to-end.
//
// Fixtures are drawn in-page (canvas → JPEG/PNG bytes) so sizes are
// deterministic without committing binaries. FIXTURE RULE: keep them clearly
// compressible — a deterministic-noise block pattern gives high entropy so a
// high-quality source shrinks meaningfully at a lower quality. Strengthen the
// fixture, never loosen an assertion.
//
// The encode pipeline (decode + @jsquash WASM) runs inside a module Web Worker.
// The `/vendor/jsquash/<codec>/` request assertions therefore rely on Playwright
// surfacing dedicated-worker requests on page.on('request') / page.route — which
// it does for dedicated workers owned by the page.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

async function boot(page) {
  await page.goto('/compress-images/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Deterministic block-noise canvas → high-entropy, reliably compressible.
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
      // Big, high-quality JPEG — shrinks a lot at lower quality / smaller targets.
      jpeg: await bytes(noiseCanvas(800, 600, 4), 'image/jpeg', 0.95),
      // A PNG source for the lossless (oxipng) path.
      png: await bytes(noiseCanvas(400, 300, 4), 'image/png'),
      // A tiny, heavily-compressed JPEG: re-encoding to WebP (esp. at q100)
      // grows it, so the tool keeps the original.
      tinyJpeg: await bytes(noiseCanvas(128, 128, 2), 'image/jpeg', 0.3),
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

const isWebp = (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 // "RIFF"
  && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;               // "WEBP"
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
  await page.goto('/compress-images/');
  await expect(page).toHaveTitle('Compress Images — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/compress-images/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. quality 40 shrinks a JPEG and the card shows a % saved', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await setQuality(page, 40);
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.jpeg, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-saved')).toContainText('% smaller', { timeout: 30000 });
  await expect(card.locator('.card-saved')).toHaveText(/[1-9]\d*% smaller/); // a real, positive saving
  await expect(card.locator('.card-meta')).toContainText('quality 40');

  // The downloaded output is genuinely smaller than the source bytes.
  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('photo.jpg');
  expect(isJpeg(bytes)).toBe(true);
  expect(bytes.length).toBeLessThan(fx.jpeg.length);
});

test('2. target-size mode: reachable target is met with a shown quality; a tiny target reports it honestly', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  const fx = await makeFixtures(page);

  // A target comfortably below the source (forces a real re-encode = "done")
  // but far above the lowest-quality size (so it is reachable).
  const targetKB = Math.max(1, Math.floor((fx.jpeg.length * 0.7) / 1024));
  const targetBytes = targetKB * 1024;

  await page.locator('input[name="mode"][value="target"]').check();
  await page.locator('#target-size').fill(String(targetKB));
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.jpeg, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  // Quality-used is reported in target mode.
  await expect(card.locator('.card-meta')).toContainText(/quality \d+/, { timeout: 30000 });
  await expect(card.locator('.card-note.is-warn')).toHaveCount(0);

  const { bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(bytes.length).toBeLessThanOrEqual(targetBytes); // achieved size ≤ target

  // Unreachable tiny target → honest "couldn't reach" note + the Photo-Editor hint.
  await page.locator('#target-size').fill('1');
  await expect(card.locator('.card-note.is-warn')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-note.is-warn')).toContainText('Could not reach');
  await expect(card.locator('.card-note.is-warn')).toContainText('Photo Editor');
});

test('3. output format WebP: real WebP out, webp codec fetched, avif/jpeg codecs untouched', async ({ page }) => {
  const req = { webp: [], avif: [], jpeg: [] };
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/vendor/jsquash/webp/')) req.webp.push(u);
    if (u.includes('/vendor/jsquash/avif/')) req.avif.push(u);
    if (u.includes('/vendor/jsquash/jpeg/')) req.jpeg.push(u);
  });
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#out-format').selectOption('webp');
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.jpeg, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-meta')).toContainText('WebP', { timeout: 30000 });

  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('photo.webp');
  expect(isWebp(bytes)).toBe(true);

  expect(req.webp.length).toBeGreaterThan(0);
  expect(req.avif.length).toBe(0);
  expect(req.jpeg.length).toBe(0);
});

test('4. codec laziness: a PNG-only flow fetches oxipng and none of jpeg/webp/avif', async ({ page }) => {
  const req = { jpeg: [], webp: [], avif: [], oxipng: [] };
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/vendor/jsquash/jpeg/')) req.jpeg.push(u);
    if (u.includes('/vendor/jsquash/webp/')) req.webp.push(u);
    if (u.includes('/vendor/jsquash/avif/')) req.avif.push(u);
    if (u.includes('/vendor/jsquash/oxipng/')) req.oxipng.push(u);
  });
  await boot(page);
  const fx = await makeFixtures(page);
  // Keep original format → a PNG source stays PNG (lossless, oxipng path).
  await dropFiles(page, [{ name: 'flat.png', bytes: fx.png, type: 'image/png' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-download')).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.card-meta')).toContainText('PNG');

  expect(req.oxipng.length).toBeGreaterThan(0);
  expect(req.jpeg.length).toBe(0);
  expect(req.webp.length).toBe(0);
  expect(req.avif.length).toBe(0);
});

test('5. ZIP is lazy: no /vendor/jszip/ until Download all is clicked', async ({ page }) => {
  const zipReq = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipReq.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await setQuality(page, 40);
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.jpeg, type: 'image/jpeg' }]);

  const zipBtn = page.locator('#download-zip');
  await expect(zipBtn).toBeEnabled({ timeout: 30000 });
  expect(zipReq.length).toBe(0);

  const { name } = await downloadBytes(page, zipBtn);
  expect(name).toBe('compressed-images.zip');
  expect(zipReq.length).toBeGreaterThan(0);
});

test('6. kept-original keeps the SOURCE format: forcing WebP on a tiny JPEG that grows stays a .jpg', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await page.locator('#out-format').selectOption('webp');
  await setQuality(page, 100); // near-lossless WebP is reliably larger than the tiny low-q JPEG
  await dropFiles(page, [{ name: 'tiny.jpg', bytes: fx.tinyJpeg, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-note.is-kept')).toBeVisible({ timeout: 30000 });
  // Labeled with the SOURCE format (JPEG), NOT the forced WebP.
  await expect(card.locator('.card-meta')).toContainText('JPEG');
  await expect(card.locator('.card-meta')).not.toContainText('WebP');

  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('tiny.jpg');       // .jpg, not .webp
  expect(name.endsWith('.webp')).toBe(false);
  expect(isJpeg(bytes)).toBe(true);
  expect(bytes.length).toBe(fx.tinyJpeg.length); // the untouched original was kept
});

test('7. AVIF encoder load failure disables AVIF, auto-switches to WebP, still produces output', async ({ page }) => {
  test.setTimeout(60000);
  // Force every AVIF codec fetch (glue + wasm) to fail.
  await page.route('**/vendor/jsquash/avif/**', (r) => r.abort());
  await boot(page);
  const fx = await makeFixtures(page);

  await page.locator('#out-format').selectOption('avif');
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.jpeg, type: 'image/jpeg' }]);

  // The AVIF option is disabled + relabeled, and the select auto-switches to WebP.
  await expect(page.locator('#out-format option[value="avif"]')).toBeDisabled({ timeout: 40000 });
  await expect(page.locator('#out-format option[value="avif"]')).toHaveText(/unavailable/);
  await expect(page.locator('#out-format')).toHaveValue('webp');
  await expect(page.locator('#status-line')).toContainText('AVIF');
  await expect(page.locator('#status-line')).toContainText('WebP');

  // A real WebP output is produced (no hang).
  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-meta')).toContainText('WebP', { timeout: 40000 });
  const { name, bytes } = await downloadBytes(page, card.locator('.card-download'));
  expect(name).toBe('photo.webp');
  expect(isWebp(bytes)).toBe(true);
});

test('8. XSS filename is rendered inert in the card', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const fx = await makeFixtures(page);
  const xss = '<img src=x onerror=alert(1)>.jpg';
  await setQuality(page, 40);
  await dropFiles(page, [{ name: xss, bytes: fx.jpeg, type: 'image/jpeg' }]);

  const card = page.locator('#cards .card').first();
  await expect(card.locator('.card-name')).toHaveText(xss); // escaped → literal text, not markup
  // No injected element made it into the DOM, and nothing executed.
  await expect(page.locator('#cards .card-name img')).toHaveCount(0);
  await expect(page.locator('#cards img[src="x"]')).toHaveCount(0);
  await expect(card.locator('.card-saved')).toBeVisible({ timeout: 30000 });
  expect(dialogFired).toBe(false);
});

test('9. a11y: no serious/critical axe violations (initial + results); keyboard drives the quality slider', async ({ page }) => {
  await boot(page);

  // Initial state.
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  // Keyboard reaches the slider and arrows change it.
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
  await dropFiles(page, [{ name: 'photo.jpg', bytes: fx.jpeg, type: 'image/jpeg' }]);
  await expect(page.locator('#cards .card .card-saved')).toBeVisible({ timeout: 30000 });
  const withResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(withResults);
  if (blockers.length) {
    console.error('[a11y compress-images] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);
});
