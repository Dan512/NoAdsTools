// crop-image/tests/browser/crop-image.spec.js — the interactive cropper
// end-to-end. Fixtures are drawn in-page (canvas → JPEG/PNG bytes) so source
// dimensions are deterministic without committing binaries.
//
// HARNESS NOTES (both are load-bearing, do not remove):
//  1. The crop handles sit at the bottom of a tall stage, often below the fold.
//     A raw page.mouse drag needs real viewport coordinates, so every drag
//     scrollIntoViewIfNeeded()s the handle FIRST, then reads its boundingBox.
//  2. The 375px no-overflow test narrows the viewport AFTER loading an image
//     (900 → 375) and also exercises clear + re-add at 375 — a fresh-load-at-375
//     would pass while missing the stale-frame-measurement bug the fix targets.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

async function boot(page) {
  await page.goto('/crop-image/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Draw a valid, non-trivial image (gradient + vertical bars) at a known size.
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
      aJpeg: await bytes(draw(800, 600), 'image/jpeg', 0.9), // 800×600 landscape
      bPng: await bytes(draw(400, 300), 'image/png'),        // 400×300 (PNG, keep-format)
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

// Drop images and wait for the stage to render (readout carries the crop dims).
async function loadImages(page, files) {
  await dropFiles(page, files);
  await expect(page.locator('#readout')).toContainText('px', { timeout: 30000 });
}

// Drive a real pointer drag on a handle by (dx,dy) DISPLAY px. Scrolls the
// handle into view first so the mouse lands on real viewport coordinates.
async function dragHandle(page, handle, dx, dy) {
  const el = page.locator(`.handle-${handle}`);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error(`handle ${handle} has no box`);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await page.mouse.up();
}

const numVal = (page, sel) => page.locator(sel).evaluate((el) => Number(el.value));
const cropDims = async (page) => {
  const t = await page.locator('#readout').textContent();
  const m = t.match(/(\d+)\D+(\d+)/);
  return { w: Number(m[1]), h: Number(m[2]) };
};

async function downloadBytes(page, triggerLocator) {
  const dlPromise = page.waitForEvent('download');
  await triggerLocator.click();
  const dl = await dlPromise;
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

async function decodeDims(page, bytes) {
  return page.evaluate(async (arr) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(arr)]));
    const d = { w: bmp.width, h: bmp.height };
    bmp.close();
    return d;
  }, [...bytes]);
}

const noOverflow = (page) => page.evaluate(() => {
  const el = document.documentElement;
  return el.scrollWidth <= el.clientWidth + 1;
});

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
  await page.goto('/crop-image/');
  await expect(page).toHaveTitle('Crop Image — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/crop-image/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. load an image → stage + crop rectangle render; readout shows initial crop dims', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#crop-box')).toBeVisible();
  // fitInitialRect free = 80% centered on 800×600 → 640×480 at (80,60).
  expect(await numVal(page, '#in-w')).toBe(640);
  expect(await numVal(page, '#in-h')).toBe(480);
  expect(await numVal(page, '#in-x')).toBe(80);
  expect(await numVal(page, '#in-y')).toBe(60);
  expect(await cropDims(page)).toEqual({ w: 640, h: 480 });
  // Single image → no strip.
  await expect(page.locator('#strip')).toBeHidden();
});

test('2. a real pointer drag on the SE handle grows the rectangle, staying in bounds', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  const before = await cropDims(page);
  await dragHandle(page, 'se', 60, 60); // pull outward toward the SE corner
  const after = await cropDims(page);

  expect(after.w).toBeGreaterThan(before.w); // correct direction: grew
  expect(after.h).toBeGreaterThan(before.h);
  expect(after.w).toBeLessThanOrEqual(800);  // never escapes the image
  expect(after.h).toBeLessThanOrEqual(600);
  expect(await numVal(page, '#in-x')).toBeGreaterThanOrEqual(0);
  expect(await numVal(page, '#in-y')).toBeGreaterThanOrEqual(0);
});

test('3. aspect preset 1:1 locks the ratio and a subsequent drag holds it', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  await page.locator('.preset[data-ratio="1:1"]').click();
  await expect(page.locator('.preset[data-ratio="1:1"]')).toHaveAttribute('aria-pressed', 'true');
  let d = await cropDims(page);
  expect(d.w).toBe(d.h); // square

  await dragHandle(page, 'se', 40, 40);
  d = await cropDims(page);
  expect(d.w).toBe(d.h); // still square after resizing
});

test('4. ratio-locked drag INTO a bound stays in-ratio (guards the clamp fix)', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  await page.locator('.preset[data-ratio="1:1"]').click();
  // Drag the SE handle far past the image edge — a naive per-dimension clamp
  // would distort to a non-square rect; the ratio-preserving clamp must not.
  await dragHandle(page, 'se', 4000, 4000);
  const d = await cropDims(page);
  expect(d.w).toBe(d.h);               // still square
  expect(d.w).toBeLessThanOrEqual(800);
  expect(d.h).toBeLessThanOrEqual(600);
});

test('5. exact W/H inputs update + clamp the crop, flooring below the min size', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  await page.locator('#in-w').fill('200');
  await page.locator('#in-h').fill('150');
  expect(await cropDims(page)).toEqual({ w: 200, h: 150 });

  // Below the 16px floor → clamped up to 16 (a 1px crop is impossible).
  await page.locator('#in-w').fill('1');
  expect((await cropDims(page)).w).toBe(16);

  // Larger than the image → clamped down to the source width.
  await page.locator('#in-w').fill('99999');
  expect((await cropDims(page)).w).toBe(800);
});

test('6. Download crops to the exact rectangle dimensions', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  await page.locator('#in-x').fill('10');
  await page.locator('#in-y').fill('10');
  await page.locator('#in-w').fill('200');
  await page.locator('#in-h').fill('150');
  expect(await cropDims(page)).toEqual({ w: 200, h: 150 });

  const { name, bytes } = await downloadBytes(page, page.locator('#download'));
  expect(name).toBe('photo-cropped.jpg');
  expect(bytes[0]).toBe(0xFF); expect(bytes[1]).toBe(0xD8); // JPEG magic — kept format
  expect(await decodeDims(page, bytes)).toEqual({ w: 200, h: 150 });
});

test('7. multi-image strip switch preserves each image\'s own crop', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [
    { name: 'a.jpg', bytes: fx.aJpeg, type: 'image/jpeg' },  // 800×600 → item 0 (active)
    { name: 'b.png', bytes: fx.bPng, type: 'image/png' },    // 400×300 → item 1
  ]);
  await expect(page.locator('#strip')).toBeVisible();
  await expect(page.locator('.strip-thumb')).toHaveCount(2);

  // Give image A a distinctive crop.
  await page.locator('#in-w').fill('200');
  await page.locator('#in-h').fill('200');

  // Switch to B — it keeps its own initial crop (80% of 400×300 = 320×240).
  await page.locator('.strip-thumb').nth(1).click();
  expect(await cropDims(page)).toEqual({ w: 320, h: 240 });
  await page.locator('.preset[data-ratio="1:1"]').click(); // change B

  // Back to A — its 200×200 crop survived the round trip.
  await page.locator('.strip-thumb').nth(0).click();
  expect(await cropDims(page)).toEqual({ w: 200, h: 200 });
});

test('8. JSZip is lazy: 0 requests to /vendor/jszip/ before ZIP, ≥1 after', async ({ page }) => {
  const zipReq = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipReq.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [
    { name: 'a.jpg', bytes: fx.aJpeg, type: 'image/jpeg' },
    { name: 'b.png', bytes: fx.bPng, type: 'image/png' },
  ]);

  const zipBtn = page.locator('#download-zip');
  await expect(zipBtn).toBeVisible();
  expect(zipReq.length).toBe(0);

  const { name } = await downloadBytes(page, zipBtn);
  expect(name).toBe('cropped-images.zip');
  expect(zipReq.length).toBeGreaterThan(0);
});

test('9. XSS filename is rendered inert in the strip', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const fx = await makeFixtures(page);
  const xss = '<img src=x onerror=alert(1)>.png';
  await loadImages(page, [
    { name: 'a.jpg', bytes: fx.aJpeg, type: 'image/jpeg' },
    { name: xss, bytes: fx.bPng, type: 'image/png' },
  ]);

  await expect(page.locator('#strip .strip-name', { hasText: xss })).toHaveCount(1); // literal text
  await expect(page.locator('#strip img[src="x"]')).toHaveCount(0);
  expect(dialogFired).toBe(false);
});

test('10. Clear all resets the editor and restores the full dropzone', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#dropzone')).toHaveClass(/is-compact/); // collapsed while loaded

  await page.locator('#clear-all').click();
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('#dropzone')).not.toHaveClass(/is-compact/);
  await expect(page.locator('#file-label-text')).toHaveText('Choose files');
});

test('11. keyboard: crop rectangle is focusable and arrow keys nudge it', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);

  const box = page.locator('#crop-box');
  await box.focus();
  await expect(box).toBeFocused();

  const x0 = await numVal(page, '#in-x');
  await page.keyboard.press('ArrowRight');
  expect(await numVal(page, '#in-x')).toBe(x0 + 1);       // 1px nudge
  await page.keyboard.press('Shift+ArrowRight');
  expect(await numVal(page, '#in-x')).toBe(x0 + 11);      // Shift = 10px
});

test('12. a11y: no serious/critical axe violations (initial + with an image loaded)', async ({ page }) => {
  await boot(page);
  const initial = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeBlockers(initial)).toEqual([]);

  const fx = await makeFixtures(page);
  await loadImages(page, [{ name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' }]);
  const loaded = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blockers = axeBlockers(loaded);
  if (blockers.length) {
    console.error('[a11y crop-image] blocking violations:');
    for (const v of blockers) console.error(`  ${v.id} (${v.impact}): ${v.help}`);
  }
  expect(blockers).toEqual([]);
});

test('13. no horizontal overflow at 375px after narrowing, and after clear + re-add', async ({ page }) => {
  // Load WIDE, then narrow — the stale-frame-measurement bug only shows when the
  // viewport shrinks after a render (a fresh 375 load would silently pass).
  await page.setViewportSize({ width: 900, height: 800 });
  await boot(page);
  const fx = await makeFixtures(page);
  const file = { name: 'photo.jpg', bytes: fx.aJpeg, type: 'image/jpeg' };
  await loadImages(page, [file]);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(250); // let the debounced resize re-render the stage
  expect(await noOverflow(page)).toBe(true);

  // Clear, then re-add the same image at 375 — the second reproduction path.
  await page.locator('#clear-all').click();
  await loadImages(page, [file]);
  await page.waitForTimeout(250);
  expect(await noOverflow(page)).toBe(true);
});
