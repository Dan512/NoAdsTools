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

// A compress fake whose done-promises are resolved/rejected from the test
// side (via window.__pending), not on a timer — so assertions between the
// first and second pass are deterministic. window.__calls records each
// call's plan.videoBitrate for the "second pass is actually lower" check.
async function installTwoPassFake(page) {
  await page.evaluate(async () => {
    const { _setCompressForTest } = await import('/compress-video/js/engine.js');
    window.__calls = [];
    window.__pending = [];
    _setCompressForTest((file, plan) => {
      window.__calls.push(plan.videoBitrate);
      let resolve, reject;
      const done = new Promise((res, rej) => { resolve = res; reject = rej; });
      window.__pending.push({ resolve, reject });
      return { done, cancel: async () => reject(new Error('compress_cancelled')) };
    });
  });
}

async function waitForCalls(page, n) {
  await page.waitForFunction((n) => window.__calls && window.__calls.length >= n, n);
}

async function resolvePass(page, index, bytes) {
  await page.evaluate(({ index, bytes }) => {
    window.__pending[index].resolve(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
  }, { index, bytes });
}

// A calibration-probe fake (calibrate.js's startProbe), same house style as
// installTwoPassFake: done-promises are resolved/rejected from the test
// side via window.__probePending, and window.__probeCalls records each
// call's plan so tests can assert what the encoder was asked to try before
// any probe-driven re-plan.
async function installCalibrateFake(page) {
  await page.evaluate(async () => {
    const { _setProbeEncodeForTest } = await import('/compress-video/js/calibrate.js');
    window.__probeCalls = [];
    window.__probePending = [];
    _setProbeEncodeForTest((file, plan, durationSec, cb) => {
      window.__probeCalls.push({
        videoBitrate: plan.videoBitrate, out: plan.out, outFps: plan.outFps, segments: cb?.segments,
      });
      let resolve, reject;
      const done = new Promise((res, rej) => { resolve = res; reject = rej; });
      window.__probePending.push({ resolve, reject });
      return { done, cancel: async () => reject(new Error('probe_cancelled')) };
    });
  });
}

async function waitForProbeCalls(page, n) {
  await page.waitForFunction((n) => window.__probeCalls && window.__probeCalls.length >= n, n);
}

async function resolveProbe(page, index, probeBytes, probeSecs) {
  await page.evaluate(({ index, probeBytes, probeSecs }) => {
    window.__probePending[index].resolve({ probeBytes, probeSecs });
  }, { index, probeBytes, probeSecs });
}

// A probe that fails immediately without being cancelled — the real
// startProbe does exactly this today when handed the dummy (non-video)
// fixture the other encode tests use. Faking that failure keeps those
// tests fast and deterministic instead of depending on mediabunny's actual
// parse-failure timing against garbage bytes; main.js's fall-through
// behavior on a non-cancelled probe failure is identical either way.
async function installFailingProbe(page) {
  await page.evaluate(async () => {
    const { _setProbeEncodeForTest } = await import('/compress-video/js/calibrate.js');
    _setProbeEncodeForTest(() => {
      const done = Promise.reject(new Error('probe_failed'));
      done.catch(() => {});
      return { done, cancel: async () => {} };
    });
  });
}

// A one-shot compress fake for tests that don't need the two-pass
// machinery: resolves immediately with a Blob of the given size and
// records every call's plan (so a probe-driven re-plan can be inspected).
async function installCompressFake(page, blobBytes) {
  await page.evaluate(async (blobBytes) => {
    const { _setCompressForTest } = await import('/compress-video/js/engine.js');
    window.__compressCalls = [];
    _setCompressForTest((file, plan) => {
      window.__compressCalls.push({ videoBitrate: plan.videoBitrate, out: plan.out, outFps: plan.outFps });
      return {
        done: Promise.resolve(new Blob([new Uint8Array(blobBytes)], { type: 'video/mp4' })),
        cancel: async () => {},
      };
    });
  }, blobBytes);
}

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

test('configure: auto picks 720p; source override shows the soft band and suggestion', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);

  await expect(page.locator('#summary')).toContainText('clip.mp4');
  await expect(page.locator('#summary')).toContainText('1920×1080');
  await expect(page.locator('#configure')).toBeVisible();
  await expect(page.locator('#resolution')).toHaveValue('auto');
  // FAKE_SRC is 30 fps: below the 40fps gate, so the frame-rate control
  // must not appear at all — there is no meaningful fps to drop.
  await expect(page.locator('#framerate-label')).toBeHidden();

  // 25 MB on 60s of 1080p30, auto default: 720p is the tallest candidate
  // that clears "acceptable", so auto picks it and says so in the note.
  await page.locator('.preset[data-mb="25"]').click();
  await expect(page.locator('#band-label')).toHaveText('Good quality');
  await expect(page.locator('#band-meter .band-step.is-filled')).toHaveCount(4);
  await expect(page.locator('#band-note'))
    .toContainText('Auto picked 720p for this target. About 3.3 Mbps of video at 1280×720.');
  await expect(page.locator('#suggest-btn')).toBeHidden();

  // Overriding to the explicit source resolution re-anchors the original
  // worked example: full 1080p is soft at this bitrate, so it suggests 720p.
  await page.selectOption('#resolution', 'source');
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

test('auto rescues an impossible source-res target at 480p30; full source pin shows unreachable with a fix', async ({ page }) => {
  await boot(page);
  // The real field case: 60fps raises the fps-aware bpp floor enough that a
  // 10 MB target on 1080p60 is unreachable. Auto tries a fps drop to 30
  // before the next resolution step down, and 480p30 is the first (height,
  // fps) pair that clears "soft".
  await installFakeProbe(page, {
    durationSec: 150, width: 1920, height: 1080, fps: 60,
    audioBytes: 2_400_000, hasAudio: true, sourceBytes: 178_000_000,
  });
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#resolution')).toHaveValue('auto');
  // 60 fps clears the 40fps gate, so the frame-rate control appears,
  // defaulted to auto alongside the resolution control.
  await expect(page.locator('#framerate-label')).toBeVisible();
  await expect(page.locator('#framerate')).toHaveValue('auto');
  await page.locator('#target-mb').fill('10');

  await expect(page.locator('#band-label')).toHaveText('Noticeably soft');
  await expect(page.locator('#band-meter .band-step.is-filled')).toHaveCount(2);
  await expect(page.locator('#band-note')).toContainText(
    'Auto picked 480p at 30 fps, the best any setting does at this size. About 0.4 Mbps of video at 854×480.');
  await expect(page.locator('#encode-btn')).toBeEnabled();
  await expect(page.locator('#suggest-btn')).toBeHidden();

  // Pinning resolution to source alone (fps still auto) pins the independence
  // of the two controls: auto now only has fps left to drop, and 1080p30 is
  // the best it can do at this size.
  await page.selectOption('#resolution', 'source');
  await expect(page.locator('#band-label')).toHaveText('Blocky, poor quality');
  await expect(page.locator('#band-note')).toContainText(
    'Auto picked 30 fps, the best any setting does at this size. About 0.4 Mbps of video at 1920×1080.');
  await expect(page.locator('#encode-btn')).toBeEnabled();

  // Pinning frame rate to source too re-anchors the original, pre-auto-fps
  // unreachable coverage: 1080p60 at this target names the minimum and
  // offers the 720p fix instead of silently dropping anything.
  await page.selectOption('#framerate', 'source');
  await expect(page.locator('#band-label')).toContainText('too small');
  await expect(page.locator('#band-note')).toContainText('1920×1080');
  const suggest = page.locator('#suggest-btn');
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText('720p');
  await expect(page.locator('#encode-btn')).toBeDisabled();

  await suggest.click();
  await expect(page.locator('#resolution')).toHaveValue('720');
  // 10 MB at 720p60 clears the fps-aware floor — the unit tests pin the
  // math; here we only assert the UI actually flips on it (fps still
  // pinned to source).
  await expect(page.locator('#encode-btn')).toBeEnabled();
});

test('auto is the default and generous targets keep the source resolution', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#resolution')).toHaveValue('auto');
  // FAKE_SRC is 30 fps: below the 40fps gate, so the frame-rate control
  // must not appear.
  await expect(page.locator('#framerate-label')).toBeHidden();
  await page.locator('#target-mb').fill('200');
  await expect(page.locator('#band-label')).toHaveText('Near-original quality');
  await expect(page.locator('#band-note')).not.toContainText('Auto picked');
  await expect(page.locator('#band-note')).toContainText('1920×1080');
});

test('manual 30 fps is honored and not credited to Auto', async ({ page }) => {
  await boot(page);
  // Same field fixture as the 480p30 test: 60 fps clears the 40fps gate,
  // so the frame-rate control is present, and 10 MB is tight enough that
  // dropping to 30 fps actually changes the outcome.
  await installFakeProbe(page, {
    durationSec: 150, width: 1920, height: 1080, fps: 60,
    audioBytes: 2_400_000, hasAudio: true, sourceBytes: 178_000_000,
  });
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#target-mb').fill('10');
  await expect(page.locator('#resolution')).toHaveValue('auto');

  // The user picks 30 fps themselves; resolution is left on auto.
  await page.selectOption('#framerate', '30');
  await expect(page.locator('#resolution')).toHaveValue('auto');
  const note = page.locator('#band-note');
  await expect(note).toContainText('Auto picked 480p');
  // The fps was the user's own choice, not Auto's — the note must credit
  // only the resolution it actually picked, never the pinned fps.
  await expect(note).not.toContainText('Auto picked 480p at 30 fps');
  await expect(note).toContainText('Auto picked 480p, the best any setting does at this size.');
});

test('cancel mid-encode returns to configure without an error', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installFailingProbe(page);
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

test('overshoot triggers one corrected second pass with the download live', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installFailingProbe(page);
  await installTwoPassFake(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('.preset[data-mb="25"]').click();
  await page.locator('#encode-btn').click();

  // First pass lands over target (~30 MB vs a 25 MB target).
  await waitForCalls(page, 1);
  await resolvePass(page, 0, 30_000_000);

  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#result-line'))
    .toContainText(/over your 25 MB target\. Re-compressing to get under your 25 MB target/);
  // The first attempt's output stays downloadable while the second pass
  // runs; only "compress again" is blocked mid-correction.
  await expect(page.locator('#download-btn')).toBeEnabled();
  await expect(page.locator('#again-btn')).toBeDisabled();
  await expect(page.locator('#progress')).toBeVisible();
  await expect(page.locator('#file-input')).toBeDisabled();

  // Second pass lands under target (~20 MB).
  await waitForCalls(page, 2);
  await resolvePass(page, 1, 20_000_000);

  await expect(page.locator('#result-line')).toContainText(/under your 25 MB target/);
  await expect(page.locator('#again-btn')).toBeEnabled();
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#file-input')).toBeEnabled();

  const calls = await page.evaluate(() => window.__calls);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBeLessThan(calls[0]);
});

test('cancel during the second pass keeps the first result', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installFailingProbe(page);
  await installTwoPassFake(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('.preset[data-mb="25"]').click();
  await page.locator('#encode-btn').click();

  await waitForCalls(page, 1);
  await resolvePass(page, 0, 30_000_000);
  await expect(page.locator('#result-line')).toContainText(/Re-compressing/);
  await waitForCalls(page, 2);

  await page.locator('#cancel-btn').click();

  // A cancelled (or failed) second pass falls back to the first result —
  // it must never bounce all the way back to #configure.
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#configure')).toBeHidden();
  await expect(page.locator('#result-line')).toContainText(/over your 25 MB target/);
  // Pin the real overAdvice() string for this fixture (FAKE_SRC's auto pick
  // is 720p > 360, so the resolution branch fires) rather than an OR that
  // partially matched stale copy — "slightly smaller target" doesn't exist
  // in main.js anymore.
  await expect(page.locator('#result-line')).toContainText(/lower resolution will land it/i);
  await expect(page.locator('#download-btn')).toBeEnabled();
  await expect(page.locator('#file-input')).toBeEnabled();
});

test('the probe runs before the encode and shows its own progress line', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installCalibrateFake(page);
  await installCompressFake(page, 20_000_000); // well under the 25 MB target
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('.preset[data-mb="25"]').click();
  await page.locator('#encode-btn').click();

  await waitForProbeCalls(page, 1);
  await expect(page.locator('#progress')).toBeVisible();
  await expect(page.locator('#progress-line')).toContainText(/Checking a sample/i);

  // 1.2 MB over 4 probed seconds extrapolates to ~19 MB for the full 60 s
  // clip — comfortably under the 25 MB target, so no re-plan fires.
  await resolveProbe(page, 0, 1_200_000, 4);

  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#progress-line')).toContainText(/Encoding happens on your device/i);

  const compressCalls = await page.evaluate(() => window.__compressCalls);
  expect(compressCalls).toHaveLength(1);
  await expect(page.locator('#result-line')).toContainText(/under your 25 MB target/);
  await expect(page.locator('#result-line')).not.toContainText(/sample check|moved this to/i);
});

test('a probe that predicts an overshoot re-plans before encoding', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('.preset[data-mb="25"]').click();
  // Capture the pre-probe pick from the DOM itself (not asserted from
  // memory): FAKE_SRC's auto pick at 25 MB is 720p, same as the already
  // -verified 'configure: auto picks 720p...' test.
  await expect(page.locator('#band-note')).toContainText('720p');

  await installCalibrateFake(page);
  await installCompressFake(page, 20_000_000); // lands under target in one pass
  await page.locator('#encode-btn').click();

  // First probe: implies an overshoot (~38.5 MB predicted for the full
  // 60 s clip vs. a 25 MB target), so main.js computes a corrected (lower)
  // bitrate and re-probes ONCE at that bitrate (segments: 1) to check
  // whether the encoder actually honors it.
  await waitForProbeCalls(page, 1);
  await resolveProbe(page, 0, 2_500_000, 4);

  // Second (confirmation) probe: the encoder is genuinely floor-bound for
  // this footage — even at the lower requested bitrate it still produces
  // ~5 Mbps (the same measured rate as the first probe), so the
  // prediction still misses the target and main.js concludes a
  // resolution/fps drop is the only lever left, using THIS probe's
  // measured floor (not the first probe's) to re-plan.
  await waitForProbeCalls(page, 2);
  await resolveProbe(page, 1, 1_250_000, 2);

  await expect(page.locator('#result')).toBeVisible();
  const calls = await page.evaluate(() => window.__compressCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].out.height).toBeLessThan(720);
  // Re-derived against the new two-probe design: chooseAuto against the
  // measured floor still lands on 480p, the tallest candidate that clears
  // "acceptable" at that floor.
  expect(calls[0].out.height).toBe(480);
  await expect(page.locator('#result-line')).toContainText(/sample check moved this to/i);

  // Bonus pin: the confirmation probe asked for exactly one segment.
  const probeCalls = await page.evaluate(() => window.__probeCalls);
  expect(probeCalls).toHaveLength(2);
  expect(probeCalls[1].segments).toBe(1);
});

test('a probe that overshoots but responds to a lower bitrate keeps the resolution', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('.preset[data-mb="25"]').click();
  await expect(page.locator('#band-note')).toContainText('720p');

  await installCalibrateFake(page);
  await installCompressFake(page, 20_000_000); // lands under target in one pass
  await page.locator('#encode-btn').click();

  // First probe: same overshoot signal as the floor-bound test, so main.js
  // computes the same corrected (lower) bitrate and re-probes once at it.
  await waitForProbeCalls(page, 1);
  await resolveProbe(page, 0, 2_500_000, 4);

  // Second (confirmation) probe: here the encoder DOES honor the lower
  // requested bitrate — the prediction now lands under target — so
  // main.js keeps the resolution and just uses the lower bitrate instead
  // of needlessly dropping quality. This is exactly the regression the
  // old ratio-based discriminator caused at threshold 1.1.
  await waitForProbeCalls(page, 2);
  await resolveProbe(page, 1, 700_000, 2);

  await expect(page.locator('#result')).toBeVisible();
  const calls = await page.evaluate(() => window.__compressCalls);
  const probeCalls = await page.evaluate(() => window.__probeCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].out.height).toBe(720);
  expect(calls[0].out.width).toBe(1280);
  // Lower than the pre-probe plan's own bitrate (captured from the first
  // probe call, which always runs at the original, un-corrected plan) —
  // no magic number, derived from what the app itself asked for.
  expect(calls[0].videoBitrate).toBeLessThan(probeCalls[0].videoBitrate);
  // Nothing moved: the resolution survived, so no "sample check" note.
  await expect(page.locator('#result-line')).not.toContainText(/sample check moved this to/i);

  expect(probeCalls).toHaveLength(2);
  expect(probeCalls[1].segments).toBe(1);
});

test('cancel during the probe returns to configure without an error', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installCalibrateFake(page);
  await installCompressFake(page, 20_000_000);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#encode-btn').click();

  await waitForProbeCalls(page, 1);
  await expect(page.locator('#progress-line')).toContainText(/Checking a sample/i);

  await page.locator('#cancel-btn').click();

  await expect(page.locator('#configure')).toBeVisible();
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#tool-error')).toBeHidden();
  await expect(page.locator('#file-input')).toBeEnabled();
  // The real bug this pins: a cancelled probe must not fall through into a
  // full encode.
  const compressCalls = await page.evaluate(() => window.__compressCalls);
  expect(compressCalls).toHaveLength(0);
});

test('cancel during the confirmation probe keeps nothing running', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installCalibrateFake(page);
  await installCompressFake(page, 20_000_000);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('.preset[data-mb="25"]').click();
  await page.locator('#encode-btn').click();

  // First probe: implies an overshoot, so the flow starts the confirmation
  // probe (segments: 1) to check whether a lower bitrate is enough.
  await waitForProbeCalls(page, 1);
  await resolveProbe(page, 0, 2_500_000, 4);

  await waitForProbeCalls(page, 2);
  await expect(page.locator('#progress-line')).toContainText(/lower bitrate is enough/i);

  await page.locator('#cancel-btn').click();

  await expect(page.locator('#configure')).toBeVisible();
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#tool-error')).toBeHidden();
  await expect(page.locator('#file-input')).toBeEnabled();
  // Probe 1's cancel path is covered elsewhere; this pins probe 2's: a
  // cancelled confirmation probe must not fall through into a full encode.
  const compressCalls = await page.evaluate(() => window.__compressCalls);
  expect(compressCalls).toHaveLength(0);
});

test('a floor-bound clip with nowhere left to go skips the futile second pass', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  // Pin BOTH controls so derivePlan() can't move anywhere: resolution
  // explicitly at the bottom of the ladder (360p, the lowest option), and
  // FAKE_SRC's fps (30) is under the 40fps gate so #framerate is already
  // hidden/forced to source — confirmed by reading main.js's derivePlan():
  // with autoRes and autoFps both false it takes the outHeight/outFps-pinned
  // branch directly, never calling chooseAuto, so there is no smaller
  // candidate for the probe-driven re-plan to find.
  await page.selectOption('#resolution', '360');
  await page.locator('#target-mb').fill('5');
  await expect(page.locator('#encode-btn')).toBeEnabled();

  await installCalibrateFake(page);
  await installCompressFake(page, 6_000_000); // stays over the 5 MB target
  await page.locator('#encode-btn').click();

  // First probe: a guessed-floor bitrate of ~539 kbps at 360p was never
  // going to survive a real encoder — 1 MB over 4 probed seconds implies
  // ~2 Mbps achieved and a 16 MB prediction against the 5 MB target.
  await waitForProbeCalls(page, 1);
  await resolveProbe(page, 0, 1_000_000, 4);

  // Second (confirmation) probe: the SAME ~2 Mbps floor persists even at
  // the corrected (much lower) requested bitrate — genuinely floor-bound —
  // and derivePlan() at floorBpp≈0.289 makes 360p itself unreachable, so
  // there is nowhere smaller to move to.
  await waitForProbeCalls(page, 2);
  await resolveProbe(page, 1, 500_000, 2);

  await expect(page.locator('#result')).toBeVisible();
  const compressCalls = await page.evaluate(() => window.__compressCalls);
  expect(compressCalls).toHaveLength(1);
  const line = page.locator('#result-line');
  await expect(line).toContainText(/over your .* target/);
  // overAdvice() for this exact state (out.height 360, so not >360; fps
  // already below the 40fps gate) falls through to its last branch.
  await expect(line).toContainText('a shorter clip or a larger target are the ways out');
  await expect(line).not.toContainText(/Re-compressing/i);
  await expect(line).not.toContainText(/after a second pass/i);
});

test('short clips skip the probe entirely', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { _setProbeEncodeForTest } = await import('/compress-video/js/calibrate.js');
    window.__probeWasCalled = false;
    _setProbeEncodeForTest(() => {
      window.__probeWasCalled = true;
      throw new Error('the calibration probe must not run under PROBE_MIN_DURATION_SEC');
    });
  });
  await installFakeProbe(page, { ...FAKE_SRC, durationSec: 5 }); // under PROBE_MIN_DURATION_SEC (15)
  await installCompressFake(page, 20_000_000);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('.preset[data-mb="25"]').click();
  await page.locator('#encode-btn').click();

  await expect(page.locator('#result')).toBeVisible();
  const probeWasCalled = await page.evaluate(() => window.__probeWasCalled);
  expect(probeWasCalled).toBe(false);
  await expect(page.locator('#progress-line')).not.toContainText(/Checking a sample/i);
  await expect(page.locator('#progress-line')).toContainText(/Encoding happens on your device/i);
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
