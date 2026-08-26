// compress-video/tests/browser/compress-video.spec.js
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function boot(page) {
  await page.goto('/compress-video/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

const FAKE_SRC = {
  durationSec: 60, width: 1920, height: 1080, fps: 30,
  audioBytes: 1_000_000, hasAudio: true, sourceBytes: 80_000_000,
};

// Drive the UI without WebCodecs: fake the probe (and optionally compress)
// through the same module instances main.js imported.
async function installFakeProbe(page, src = FAKE_SRC) {
  await page.evaluate(async (fake) => {
    const { _setProbeForTest } = await import('/compress-video/js/probe.js');
    _setProbeForTest(async () => fake);
  }, src);
}

const dummyVideo = { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not-really-a-video') };

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/compress-video/');
  await expect(page).toHaveTitle('Compress Video to a Target File Size — Free, No Upload · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]'))
    .toHaveAttribute('href', 'https://noadstools.com/compress-video/');
  await expect(page.locator('h1')).toHaveCount(1);
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const app = blocks.map(t => JSON.parse(t)).find(j => j['@type'] === 'SoftwareApplication');
  expect(app).toBeTruthy();
  expect(app.offers.price).toBe('0');
  expect(app.url).toBe('https://noadstools.com/compress-video/');
});

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('lazy engine: zero /vendor/mediabunny/ requests before a file lands', async ({ page }) => {
  const engineRequests = [];
  page.on('request', (r) => {
    if (r.url().includes('/vendor/mediabunny/')) engineRequests.push(r.url());
  });
  await boot(page);
  await page.waitForTimeout(400);
  expect(engineRequests).toEqual([]);
});

test('engine 404 says engine, never corrupt file, and is retryable', async ({ page }) => {
  const engineRequests = [];
  page.on('request', (r) => {
    if (r.url().includes('/vendor/mediabunny/')) engineRequests.push(r.url());
  });
  await page.route('**/vendor/mediabunny/**', (r) => r.abort());
  await boot(page);
  await page.setInputFiles('#file-input', dummyVideo);
  const err = page.locator('#tool-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText(/video engine/i);
  await expect(err).not.toContainText(/corrupt|damaged|read as a video/i);

  // Retry: lift the block and the same page must recover without a reload
  // (the loader's cache must reset on rejection, not stay poisoned). Do NOT
  // install the fake probe here — that would bypass the engine loader
  // entirely and prove nothing about the retry. With the block lifted the
  // engine fetch now succeeds, so probing gets further and fails on a
  // later, different error (the dummy fixture still isn't a real video).
  await page.unroute('**/vendor/mediabunny/**');
  engineRequests.length = 0; // isolate the count to the retry attempt
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(err).toContainText(/read as a video|No video track/i);
  await expect(err).not.toContainText(/video engine/i);
  expect(engineRequests.length).toBeGreaterThanOrEqual(1);
});

test('capability wall renders when WebCodecs is absent', async ({ page }) => {
  await page.addInitScript(() => {
    // Simulate Firefox-Android / old Safari before any page script runs.
    delete window.VideoEncoder;
    delete window.VideoDecoder;
  });
  await boot(page);
  await expect(page.locator('#wall')).toBeVisible();
  await expect(page.locator('#wall')).toContainText(/WebCodecs/);
  await expect(page.locator('#file-input')).toBeDisabled();
  // The SEO copy still renders fully behind the wall.
  await expect(page.locator('.tool-copy h2').first()).toBeVisible();
});

test('configure: summary, live band, presets, and the 720p suggestion', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);

  await expect(page.locator('#summary')).toContainText('clip.mp4');
  await expect(page.locator('#summary')).toContainText('1920×1080');
  await expect(page.locator('#configure')).toBeVisible();

  // 25 MB on 60s of 1080p30 = the spec's worked example: soft, suggest 720p.
  await page.locator('.preset[data-mb="25"]').click();
  await expect(page.locator('#band-label')).toHaveText('Noticeably soft');
  await expect(page.locator('#band-meter .band-step.is-filled')).toHaveCount(2);
  const suggest = page.locator('#suggest-btn');
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('720p');
  await suggest.click();
  await expect(page.locator('#resolution')).toHaveValue('720');
  await expect(page.locator('#band-label')).toHaveText('Good quality');
  await expect(suggest).toBeHidden();
});

test('configure: unreachable target disables encode and names the minimum', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#target-mb').fill('1'); // < 1 MB audio + floor video
  await expect(page.locator('#band-label')).toContainText('too small');
  await expect(page.locator('#band-note')).toContainText(/smallest target/i);
  await expect(page.locator('#encode-btn')).toBeDisabled();
  await expect(page.locator('#preview-btn')).toBeDisabled();
});

test('cancel mid-encode returns to configure without an error', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.evaluate(async () => {
    const { _setCompressForTest } = await import('/compress-video/js/engine.js');
    _setCompressForTest((file, plan, cb) => {
      let reject;
      const done = new Promise((_res, rej) => { reject = rej; });
      // Feed some progress so the bar visibly moves before the cancel.
      setTimeout(() => cb.onProgress?.(0.3), 50);
      return { done, cancel: async () => reject(new Error('compress_cancelled')) };
    });
  });
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#encode-btn').click();
  await expect(page.locator('#progress')).toBeVisible();
  // Intake is dead while an encode runs (mid-encode drop of a second file
  // must be impossible).
  await expect(page.locator('#file-input')).toBeDisabled();
  await expect(page.locator('#progress-track')).toHaveAttribute('aria-valuenow', '30');
  await page.locator('#cancel-btn').click();
  await expect(page.locator('#configure')).toBeVisible();
  await expect(page.locator('#file-input')).toBeEnabled();
  await expect(page.locator('#tool-error')).toBeHidden();
});

test('no horizontal overflow at 375px with content loaded', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#configure')).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('axe: configure state has no serious violations', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#configure')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(v => ['serious', 'critical'].includes(v.impact));
  expect(serious).toEqual([]);
});

// ---------- real-engine e2e (chromium only) ---------------------------------
// Generates a real MP4 IN-PAGE with mediabunny's CanvasSource (no committed
// binary fixture, no ffmpeg dependency), feeds it back through the tool, and
// asserts the output lands at or under the target.
test('e2e: real encode lands at or under the target size', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebCodecs e2e is gated on chromium');
  test.slow();
  await boot(page);

  const fixtureBytes = await page.evaluate(async () => {
    const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const source = new mb.CanvasSource(canvas, {
      codec: 'avc', quality: new mb.Quality({ bitrate: 4_000_000 }),
    });
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget(),
    });
    output.addVideoTrack(source);
    await output.start();
    // 3 s at 15 fps of deterministic block-noise: a seeded LCG repaints a
    // grid of 16px blocks with pseudo-random colors every frame. High
    // entropy (unlike a flat fill + rectangle) so the bitrate target is
    // actually exercised rather than undershot. FIXTURE RULE (see
    // compress-images/tests/browser/compress-images.spec.js's noiseCanvas):
    // strengthen the fixture, never loosen an assertion.
    const block = 16;
    let seed = 0x2f6e2b1 >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 45; i++) {
      for (let y = 0; y < 360; y += block) {
        for (let x = 0; x < 640; x += block) {
          ctx.fillStyle = `rgb(${(rnd() * 256) | 0},${(rnd() * 256) | 0},${(rnd() * 256) | 0})`;
          ctx.fillRect(x, y, block, block);
        }
      }
      await source.add(i / 15, 1 / 15);
    }
    source.close();
    await output.finalize();
    return Array.from(new Uint8Array(output.target.buffer));
  });
  expect(fixtureBytes.length).toBeGreaterThan(10_000);

  await page.setInputFiles('#file-input', {
    name: 'fixture.mp4', mimeType: 'video/mp4', buffer: Buffer.from(fixtureBytes),
  });
  await expect(page.locator('#configure')).toBeVisible({ timeout: 15_000 });
  await page.locator('#target-mb').fill('1');
  await expect(page.locator('#encode-btn')).toBeEnabled();
  await page.locator('#encode-btn').click();

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });
  await page.locator('#download-btn').click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('fixture-compressed.mp4');
  const fs = await import('node:fs');
  const outSize = fs.statSync(await dl.path()).size;
  expect(outSize).toBeGreaterThan(0);
  expect(outSize).toBeLessThanOrEqual(1_048_576);
  // Log for the Task 10 calibration pass.
  console.log(`[calibration] target=1048576 actual=${outSize}`);
});
