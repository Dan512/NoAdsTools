// compress-video/tests/browser/compress-video.spec.js
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function boot(page) {
  await page.goto('/compress-video/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// A realistic probeFile() result, not a sparse one: audioBitrate and
// audioCopyable are what probeFile actually returns, and without them
// resolveAudio falls back to its Infinity source-bitrate sentinel, so every
// fake-driven test would exercise a source no real file can be.
// Self-consistent by construction, the way probeFile builds it
// (audioBytes = ceil(audioBitrate * durationSec / 8)):
// 133_333 x 60 / 8 = 999_997.5, which rounds to the 1_000_000 below (the
// exactly-consistent bitrate is 133_333.33, not an integer).
// (audioCodec and audioChannels are deliberately absent — probeFile computes
// the codec name to answer audioCopyable and returns neither, because
// nothing downstream reads them.)
const FAKE_SRC = {
  durationSec: 60, width: 1920, height: 1080, fps: 30,
  audioBytes: 1_000_000, hasAudio: true, sourceBytes: 80_000_000,
  audioBitrate: 133_333, audioCopyable: true,
};

// The real field case behind the 60fps tests: 150 s of 1080p60 with a fat
// audio track. 128_000 x 150 / 8 = 2_400_000 exactly, so this one IS a
// fixture probeFile could produce. (audioChannels is deliberately absent —
// Task 5 dropped it from probeFile and nothing reads it.)
const FAKE_60FPS_SRC = {
  durationSec: 150, width: 1920, height: 1080, fps: 60,
  audioBytes: 2_400_000, hasAudio: true, sourceBytes: 178_000_000,
  audioBitrate: 128_000, audioCopyable: true,
};

// A fat 320 kbps track over a short clip: 320_000 x 30 / 8 = 1_200_000
// exactly. Long enough to clear PROBE_MIN_DURATION_SEC, so the calibration
// probe runs, and loud enough that a probe-driven re-plan has a real audio
// move available to make.
const FAKE_320K_SRC = {
  durationSec: 30, width: 1920, height: 1080, fps: 30,
  audioBytes: 1_200_000, hasAudio: true, sourceBytes: 60_000_000,
  audioBitrate: 320_000, audioCopyable: true,
};

// Drive the UI without WebCodecs: fake the probe (and optionally compress)
// through the same module instances main.js imported. Also pins the audio
// floor so these UI tests assert against a fixed value (Chromium's real
// measured 96 kbps) instead of whatever this machine's browser happens to
// support — main.js calls the real, unmocked probeAudioFloorBps() whenever
// hasAudio is true, which would otherwise load the real engine and make
// these "fake probe" tests depend on live AAC encoder capability.
async function installFakeProbe(page, src = FAKE_SRC, floorBps = 96_000) {
  await page.evaluate(async ({ fake, floorBps }) => {
    const { _setProbeForTest } = await import('/compress-video/js/probe.js');
    _setProbeForTest(async () => fake);
    const { _setAudioFloorForTest } = await import('/compress-video/js/engine.js');
    _setAudioFloorForTest(floorBps);
  }, { fake: src, floorBps });
}

const dummyVideo = { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not-really-a-video') };

// A compress fake whose done-promises are resolved/rejected from the test
// side (via window.__pending), not on a timer — so assertions between the
// first and second pass are deterministic. window.__calls records the whole
// decision each call was handed — the bitrate for "second pass is actually
// lower", and the resolved audio step, which the second pass has to carry
// forward unchanged.
async function installTwoPassFake(page) {
  await page.evaluate(async () => {
    const { _setCompressForTest } = await import('/compress-video/js/engine.js');
    window.__calls = [];
    window.__pending = [];
    _setCompressForTest((file, plan) => {
      window.__calls.push({ videoBitrate: plan.videoBitrate, audio: plan.audio ?? null });
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
      window.__compressCalls.push({
        videoBitrate: plan.videoBitrate, out: plan.out, outFps: plan.outFps,
        audio: plan.audio ?? null,
      });
      return {
        done: Promise.resolve(new Blob([new Uint8Array(blobBytes)], { type: 'video/mp4' })),
        cancel: async () => {},
      };
    });
  }, blobBytes);
}

// A compress fake that fails with one of engine.js's NAMED errors, so the
// spec can pin the message main.js maps that name to.
async function installRejectingCompressFake(page, message) {
  await page.evaluate(async (message) => {
    const { _setCompressForTest } = await import('/compress-video/js/engine.js');
    _setCompressForTest(() => {
      const done = Promise.reject(new Error(message));
      done.catch(() => {});
      return { done, cancel: async () => {} };
    });
  }, message);
}

// main.js hides AND disables an audio rung it can't deliver at its label.
// Read both properties off the DOM rather than asking Playwright whether an
// <option> is "visible": options inside a closed <select> have no box, so
// toBeHidden() would pass for every rung and prove nothing.
function audioOptionState(page, value) {
  return page.locator(`#audio option[value="${value}"]`)
    .evaluate(o => ({ hidden: o.hidden, disabled: o.disabled }));
}

// The Mbps figure the band note is currently promising, as a number.
async function bandNoteMbps(page) {
  const text = await page.locator('#band-note').textContent();
  const m = /About ([\d.]+) Mbps/.exec(text);
  expect(m, `no "About N Mbps" in band note: ${text}`).not.toBeNull();
  return parseFloat(m[1]);
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
  await installFakeProbe(page, FAKE_60FPS_SRC);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#resolution')).toHaveValue('auto');
  // 60 fps clears the 40fps gate, so the frame-rate control appears,
  // defaulted to auto alongside the resolution control.
  await expect(page.locator('#framerate-label')).toBeVisible();
  await expect(page.locator('#framerate')).toHaveValue('auto');
  // This test is about the RESOLUTION and FRAME RATE ladders, so audio is
  // pinned out of the search rather than left on auto. On auto the 96k rung
  // frees 600 KB, which lifts 360p30 from bpp 0.05912 (soft) to 0.06375 —
  // over the 0.06 Acceptable line — and tier 1 then prefers that short
  // Acceptable pair to the taller soft 480p30 one. That is the pre-existing
  // tier policy working correctly on a bigger budget, not a fps/resolution
  // fact, and it is asserted directly in 'auto trades audio down...' below.
  await page.selectOption('#audio', 'copy');
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
  await installFakeProbe(page, FAKE_60FPS_SRC);
  await page.setInputFiles('#file-input', dummyVideo);
  // Audio pinned for the same reason as the 480p30 test, and more sharply
  // here: the invariant under test is "a manually pinned dimension is never
  // credited to Auto", which reads cleanest when the only auto dimensions
  // left are the one Auto really chose (resolution) and the one the user
  // pinned (fps).
  await page.selectOption('#audio', 'copy');
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

// ---------- audio -----------------------------------------------------------

test('the Audio control appears only when the source has an audio track', async ({ page }) => {
  await boot(page);
  // probeFile's exact no-audio shape, not just hasAudio: false.
  await installFakeProbe(page, {
    ...FAKE_SRC, hasAudio: false, audioBytes: 0,
    audioBitrate: 0, audioCopyable: false,
  });
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#configure')).toBeVisible();
  await expect(page.locator('#audio-label')).toBeHidden();
  await expect(page.locator('#summary')).toContainText('no audio track');

  await installFakeProbe(page); // FAKE_SRC has a track
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#audio-label')).toBeVisible();
  await expect(page.locator('#audio')).toHaveValue('auto');
});

test('audio rungs at or above the source, or under the measured floor, are not offered', async ({ page }) => {
  await boot(page);
  // A quiet 100 kbps track: 100_000 x 60 / 8 = 750_000 bytes, self-consistent
  // the way probeFile builds it.
  const quietSrc = { ...FAKE_SRC, audioBitrate: 100_000, audioBytes: 750_000 };
  await installFakeProbe(page, quietSrc, 64_000);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#audio-label')).toBeVisible();
  // 128k sits ABOVE the source rate, so resolveAudio collapses it to copy —
  // offering it would put a label on the control that the encoder is never
  // asked for. The two rungs below the source survive.
  expect(await audioOptionState(page, '128k')).toEqual({ hidden: true, disabled: true });
  expect(await audioOptionState(page, '96k')).toEqual({ hidden: false, disabled: false });
  expect(await audioOptionState(page, '64k-mono')).toEqual({ hidden: false, disabled: false });

  // The same source on Chromium's real MEASURED floor (96 kbps — it refuses
  // any lower AAC bitrate, mono or stereo). 64k-mono can no longer be
  // delivered at its label, so it drops out too. This half is the regression
  // guard for the measured-floor mechanism: a build that reverted to a
  // hardcoded floor would keep offering a rung this browser cannot encode.
  await installFakeProbe(page, quietSrc); // default floorBps: 96_000
  await page.setInputFiles('#file-input', dummyVideo);
  expect(await audioOptionState(page, '128k')).toEqual({ hidden: true, disabled: true });
  expect(await audioOptionState(page, '96k')).toEqual({ hidden: false, disabled: false });
  expect(await audioOptionState(page, '64k-mono')).toEqual({ hidden: true, disabled: true });
});

test('no AAC encoder: every bitrate rung is gone and the track is copied whole', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page, FAKE_SRC, null); // Firefox / WebKit
  await installFailingProbe(page);
  await installCompressFake(page, 4_000_000);
  await page.setInputFiles('#file-input', dummyVideo);
  for (const id of ['128k', '96k', '64k-mono']) {
    expect(await audioOptionState(page, id), id).toEqual({ hidden: true, disabled: true });
  }
  await expect(page.locator('#audio-note')).toBeVisible();
  await expect(page.locator('#audio-note')).toContainText("can't re-encode audio");

  // And the planner agrees with the control: even at a target tight enough
  // that Auto drops to 360p, there is no rung to spend, so the track rides
  // through as a stream copy rather than a bitrate the browser can't deliver.
  await page.locator('#target-mb').fill('5');
  await expect(page.locator('#encode-btn')).toBeEnabled();
  await page.locator('#encode-btn').click();
  await expect(page.locator('#result')).toBeVisible();
  const calls = await page.evaluate(() => window.__compressCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].out.height).toBe(360); // the target really was that tight
  expect(calls[0].audio.mode).toBe('copy');
});

test('no AAC encoder and a codec MP4 cannot carry: the control goes, the track goes', async ({ page }) => {
  await boot(page);
  // The compound corner: nothing to transcode TO, and nothing to copy.
  // (audioCopyable false is probeFile's whole answer about the codec — e.g.
  // FLAC, which MP4 won't carry; the codec name itself is not returned.)
  await installFakeProbe(page, { ...FAKE_SRC, audioCopyable: false }, null);
  await installFailingProbe(page);
  await installCompressFake(page, 20_000_000);
  await page.setInputFiles('#file-input', dummyVideo);
  // No choice left to offer, so the control is withdrawn rather than left
  // showing options none of which can happen.
  await expect(page.locator('#audio-label')).toBeHidden();
  await expect(page.locator('#audio-note')).toBeVisible();
  await expect(page.locator('#audio-note')).toContainText('will have no audio');
  // resolveAudio reports id 'copy' here, so `forced` is what stops the band
  // note under-reporting what actually happens to the track.
  await expect(page.locator('#band-note')).toContainText("audio can't be kept here");

  await page.locator('#encode-btn').click();
  await expect(page.locator('#result')).toBeVisible();
  const calls = await page.evaluate(() => window.__compressCalls);
  expect(calls[0].audio.mode).toBe('remove');
  expect(calls[0].audio.forced).toBe(true);
});

test('a codec MP4 cannot carry, WITH an AAC encoder, is converted and says so', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page, { ...FAKE_SRC, audioCopyable: false });
  await installFailingProbe(page);
  await installCompressFake(page, 20_000_000);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#audio-label')).toBeVisible();
  // "Keep original" would be a lie: there is no stream copy available, so
  // the option renames itself to what will really happen.
  await expect(page.locator('#audio option[value="copy"]')).toHaveText('Keep (converted to AAC)');
  await expect(page.locator('#band-note')).toContainText('converted to AAC');

  await page.locator('#encode-btn').click();
  await expect(page.locator('#result')).toBeVisible();
  const calls = await page.evaluate(() => window.__compressCalls);
  expect(calls[0].audio.mode).toBe('encode');
});

test('Remove audio hands the freed bytes to the picture and reaches the engine', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installFailingProbe(page);
  await installCompressFake(page, 20_000_000);
  await page.setInputFiles('#file-input', dummyVideo);
  // Derived from the app's own note, not a memorized number: whatever the
  // planner is promising with the track kept, dropping it must beat.
  const before = await bandNoteMbps(page);
  await page.selectOption('#audio', 'none');
  await expect.poll(() => bandNoteMbps(page)).toBeGreaterThan(before);

  await page.locator('#encode-btn').click();
  await expect(page.locator('#result')).toBeVisible();
  const calls = await page.evaluate(() => window.__compressCalls);
  expect(calls[0].audio.mode).toBe('remove');
});

test('an unreachable target names the audio lever, and stops once it is used', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#target-mb').fill('1'); // < 1 MB audio + floor video
  await expect(page.locator('#band-label')).toContainText('too small');
  await expect(page.locator('#band-note')).toContainText('Removing the audio track under Audio lowers it');
  await expect(page.locator('#encode-btn')).toBeDisabled();

  // Taking that advice is enough on its own here: the freed bytes clear
  // 360p's floor, so the target stops being unreachable and the sentence
  // that offered the lever is gone with it.
  await page.selectOption('#audio', 'none');
  await expect(page.locator('#band-note')).not.toContainText('Removing the audio track under Audio');
  await expect(page.locator('#encode-btn')).toBeEnabled();
});

test('auto trades audio down when the picture visibly gains, and names the rung', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page, FAKE_60FPS_SRC);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#target-mb').fill('10');
  // Per-rung oracle for this fixture (150 s, 1080p60, 2.4 MB audio, 10 MB
  // target, measured floor 96 kbps), evaluated through planEncode:
  //   copy      2_400_000 B  copy    480p30 step 2 / bpp 0.03323   360p30 step 2 / 0.05912
  //   128k      2_400_000 B  encode  (same bytes as copy, so the ladder drops it)
  //   96k       1_800_000 B  encode  480p30 step 2 / bpp 0.03583   360p30 step 3 / 0.06375  <- wins
  //   64k-mono  below the 96 kbps floor, collapses back to copy
  // The 96k rung frees 600 KB, which lifts 360p30 over the 0.06 Acceptable
  // line; the back-off spends the audio only because it buys that band.
  const note = page.locator('#band-note');
  await expect(page.locator('#band-label')).toHaveText('Acceptable quality');
  await expect(page.locator('#band-meter .band-step.is-filled')).toHaveCount(3);
  await expect(note).toContainText(
    'Auto picked 360p at 30 fps with 96 kbps audio for this target. About 0.4 Mbps of video at 640×360.');
  await expect(note).toContainText(/\d+ kbps( mono)? audio/);
});

test('below Acceptable, the note stops claiming a best that Remove audio beats', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page, FAKE_60FPS_SRC);
  await page.setInputFiles('#file-input', dummyVideo);

  // 8 MB on this fixture: Auto lands 360p30 with 96 kbps audio at "Noticeably
  // soft" (step 2) — and Remove audio, which Auto structurally refuses to
  // pick, reaches Acceptable. The old sentence called that state "the best
  // any setting does at this size" while the better setting sat in the very
  // control the sentence is next to.
  await page.locator('#target-mb').fill('8');
  const note = page.locator('#band-note');
  await expect(page.locator('#band-label')).toHaveText('Noticeably soft');
  await expect(note).toContainText(
    'Auto picked 360p at 30 fps with 96 kbps audio, the best it does without dropping the sound; Remove audio does better.');
  await expect(note).not.toContainText('the best any setting does');

  // Not a claim taken on trust: the control the note points at really does
  // reach a higher band.
  await page.selectOption('#audio', 'none');
  await expect(page.locator('#band-label')).toHaveText('Acceptable quality');

  // And the original sentence survives where it is still true: at 6 MB every
  // setting including removal is stuck on the same band, so there is nothing
  // better to point at.
  await page.selectOption('#audio', 'auto');
  await page.locator('#target-mb').fill('6');
  await expect(page.locator('#band-label')).toHaveText('Noticeably soft');
  await expect(note).toContainText('the best any setting does at this size');
  await expect(note).not.toContainText('Remove audio does better');
});

test('it stops claiming it even when no rung was admitted and the note names no audio', async ({ page }) => {
  await boot(page);
  // A 96 kbps track at Chromium's measured 96 kbps floor: 128k and 96k sit at
  // or above the source and 64k-mono sits under the floor, so EVERY rung
  // collapses to copy and the ladder is empty. Auto has no audio move to
  // report, so the note carries no audio clause at all — the variant where
  // the false claim was easiest to miss, because nothing in the sentence
  // mentions sound.
  // 96_000 x 60 / 8 = 720_000, self-consistent the way probeFile builds it.
  await installFakeProbe(page, { ...FAKE_SRC, audioBitrate: 96_000, audioBytes: 720_000 });
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#target-mb').fill('2');

  for (const id of ['128k', '96k', '64k-mono']) {
    expect(await audioOptionState(page, id), id).toEqual({ hidden: true, disabled: true });
  }
  const note = page.locator('#band-note');
  await expect(page.locator('#band-label')).toHaveText('Blocky, poor quality');
  await expect(note).toContainText(
    'Auto picked 360p, the best it does without dropping the sound; Remove audio does better.');
  await expect(note).not.toContainText('kbps');
  await page.selectOption('#audio', 'none');
  await expect(page.locator('#band-label')).toHaveText('Noticeably soft');
});

test("the corrected second pass carries the first pass's audio decision", async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installFailingProbe(page);
  await installTwoPassFake(page);
  await page.setInputFiles('#file-input', dummyVideo);
  // An explicit rung rather than the default copy, so the carried decision
  // is something distinctive rather than the empty-ish copy record.
  await page.selectOption('#audio', '96k');
  await page.locator('.preset[data-mb="25"]').click();
  await page.locator('#encode-btn').click();

  await waitForCalls(page, 1);
  await resolvePass(page, 0, 30_000_000);
  await waitForCalls(page, 2);
  await resolvePass(page, 1, 20_000_000);
  await expect(page.locator('#result-line')).toContainText(/under your 25 MB target/);

  const calls = await page.evaluate(() => window.__calls);
  expect(calls[0].audio).toMatchObject({ id: '96k', mode: 'encode', bps: 96_000 });
  // The second pass re-plans the VIDEO bitrate only. Re-resolving audio there
  // would move the byte budget the correction was computed against, so the
  // corrected pass would aim at a target it no longer describes.
  expect(calls[1].audio).toEqual(calls[0].audio);
});

test('an audio track the muxer refuses names Remove audio as the way out', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page);
  await installFailingProbe(page);
  await installRejectingCompressFake(page, 'audio_unsupported');
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#encode-btn').click();

  const err = page.locator('#tool-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText('Remove audio');
  // And the user lands back on the panel that actually has that control.
  await expect(page.locator('#configure')).toBeVisible();
  await expect(page.locator('#audio-label')).toBeVisible();
});

test("the audio note does not leak into the next file's accessible description", async ({ page }) => {
  await boot(page);
  // A file that HAS a disclosure: no AAC encoder, so the note is shown.
  await installFakeProbe(page, FAKE_SRC, null);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#audio-note')).toContainText("can't re-encode audio");
  // Why the text below has to be empty and not merely hidden.
  await expect(page.locator('#audio')).toHaveAttribute('aria-describedby', 'audio-note');

  // A second file with nothing to disclose. Hiding the note is NOT enough:
  // #audio-note is #audio's aria-describedby target, and the
  // accessible-description algorithm ignores a referenced node's hidden
  // state — stale text here would be read out as THIS file's disclosure, and
  // only screen-reader users would ever hear the wrong one.
  await installFakeProbe(page);
  await page.setInputFiles('#file-input', dummyVideo);
  await expect(page.locator('#audio-label')).toBeVisible();
  await expect(page.locator('#audio-note')).toBeHidden();
  await expect(page.locator('#audio-note')).toHaveText('');
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
  expect(calls[1].videoBitrate).toBeLessThan(calls[0].videoBitrate);
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

test('a re-plan that also re-encodes the audio says so, instead of naming only the picture', async ({ page }) => {
  await boot(page);
  await installFakeProbe(page, FAKE_320K_SRC);
  await page.setInputFiles('#file-input', dummyVideo);
  await page.locator('#target-mb').fill('8');
  // What the user was last shown: 720p with the fat 320 kbps track copied
  // through untouched. Read off the DOM, not remembered — the note must not
  // be crediting Auto with an audio move it hasn't made yet.
  await expect(page.locator('#band-note')).toContainText('Auto picked 720p');
  await expect(page.locator('#band-note')).not.toContainText('kbps audio');

  await installCalibrateFake(page);
  await installCompressFake(page, 7_000_000); // under the 8 MB target
  await page.locator('#encode-btn').click();

  // Both probes measure the same 0.08 bpp floor at the planned 1280×720
  // (0.08 x 1280 x 720 x 30 = 2_211_840 bps = 276_480 B/s), so the encoder is
  // genuinely floor-bound and derivePlan re-plans against that measurement.
  await waitForProbeCalls(page, 1);
  await resolveProbe(page, 0, 1_105_920, 4);
  await waitForProbeCalls(page, 2);
  await resolveProbe(page, 1, 552_960, 2);

  await expect(page.locator('#result')).toBeVisible();
  const calls = await page.evaluate(() => window.__compressCalls);
  // The re-plan really did both things: fewer pixels AND a re-encoded track.
  expect(calls).toHaveLength(1);
  expect(calls[0].out.height).toBe(480);
  expect(calls[0].audio).toMatchObject({ id: '128k', mode: 'encode', bps: 128_000 });
  // The whole point: a note that reported only the resolution would leave
  // the user believing their 320 kbps track rode through untouched.
  await expect(page.locator('#result-line'))
    .toContainText('The sample check moved this to 854×480 with 128 kbps audio to fit.');
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
  // overAdvice() for this exact state: out.height is 360, so not >360, and
  // the fps is already below the 40fps gate — which used to fall through to
  // the "shorter clip or larger target" last resort. It no longer does,
  // because the audio lever is now a real way out and sits ahead of that
  // last resort: FAKE_SRC's copied track is 1_000_000 bytes and the 128k
  // rung would return 40 KB of it, so audioAdvice() reports the whole
  // 977 KB the track could free.
  await expect(line).toContainText('reducing or removing the audio under Audio frees up to 977 KB');
  await expect(line).not.toContainText(/Re-compressing/i);
  await expect(line).not.toContainText(/after a second pass/i);
});

test('with no rung left to reduce to, the advice offers removal rather than reduction', async ({ page }) => {
  await boot(page);
  // Firefox / WebKit: AAC cannot be encoded at all, so every rung collapses
  // to copy and there is nothing to REDUCE to — only the whole track to
  // drop. This is the branch those users actually see, and Chromium never
  // reaches it on its own.
  await installFakeProbe(page, FAKE_SRC, null);
  await installFailingProbe(page);
  await installTwoPassFake(page);
  await page.setInputFiles('#file-input', dummyVideo);
  // 360p pinned so overAdvice() falls past its resolution branch, and
  // FAKE_SRC's 30 fps is under the 40fps gate so the frame-rate branch is
  // unreachable too — the audio advice is what is left.
  await page.selectOption('#resolution', '360');
  await page.locator('#target-mb').fill('5');
  await expect(page.locator('#encode-btn')).toBeEnabled();
  await page.locator('#encode-btn').click();

  // Both passes land over the 5 MB target, so the flow reaches its last
  // resort and spends overAdvice().
  await waitForCalls(page, 1);
  await resolvePass(page, 0, 8_000_000);
  await waitForCalls(page, 2);
  await resolvePass(page, 1, 7_000_000);

  const line = page.locator('#result-line');
  await expect(line).toContainText(/still over your 5 MB target after a second pass/);
  // "frees", not "frees up to": the reduce-or-remove wording would be a
  // false offer here, because no reduction exists in this browser.
  await expect(line).toContainText('removing the audio under Audio frees 977 KB');
  await expect(line).not.toContainText('reducing or removing');
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

// 3 s at 15 fps of deterministic block-noise: a seeded LCG repaints a grid of
// 16px blocks with pseudo-random colors every frame. High entropy (unlike a
// flat fill + rectangle) so the bitrate target is actually exercised rather
// than undershot. FIXTURE RULE (see compress-images/tests/browser/
// compress-images.spec.js's noiseCanvas): strengthen the fixture, never
// loosen an assertion.
//
// withAudio adds a real 440 Hz mono tone as an OPUS track: Chromium always
// has an Opus encoder (its AAC encoder refuses bitrates under 96 kbps, which
// this fixture has no reason to fight) and Opus fits MP4. Both tracks are
// added BEFORE start() and fed after it, which is mediabunny's contract.
async function makeFixtureMp4(page, { withAudio = false } = {}) {
  const bytes = await page.evaluate(async (withAudio) => {
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
    let audioSource = null;
    let audioBuf = null;
    if (withAudio) {
      const rate = 48_000;
      audioBuf = new AudioBuffer({ numberOfChannels: 1, length: rate * 3, sampleRate: rate });
      const ch = audioBuf.getChannelData(0);
      for (let s = 0; s < ch.length; s++) ch[s] = Math.sin(2 * Math.PI * 440 * (s / rate)) * 0.3;
      audioSource = new mb.AudioBufferSource({ codec: 'opus', bitrate: 64_000 });
      output.addAudioTrack(audioSource);
    }
    await output.start();
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
    if (audioSource) {
      await audioSource.add(audioBuf);
      audioSource.close();
    }
    source.close();
    await output.finalize();
    return Array.from(new Uint8Array(output.target.buffer));
  }, withAudio);
  expect(bytes.length).toBeGreaterThan(10_000);
  return Buffer.from(bytes);
}

// Re-open finished bytes through mediabunny in-page: the only honest way to
// say what is or isn't in the file the user actually got.
async function tracksInFile(page, buffer) {
  return page.evaluate(async (b64) => {
    const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source: new mb.BlobSource(new Blob([bytes], { type: 'video/mp4' })),
    });
    return {
      hasAudio: (await input.getPrimaryAudioTrack()) != null,
      hasVideo: (await input.getPrimaryVideoTrack()) != null,
    };
  }, buffer.toString('base64'));
}

test('e2e: real encode lands at or under the target size', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebCodecs e2e is gated on chromium');
  test.slow();
  await boot(page);

  await page.setInputFiles('#file-input', {
    name: 'fixture.mp4', mimeType: 'video/mp4', buffer: await makeFixtureMp4(page),
  });
  await expect(page.locator('#configure')).toBeVisible({ timeout: 15_000 });
  // This fixture is silent, so the real probe must reach the same conclusion
  // the fake-driven visibility test reaches — free coverage of that branch
  // against the actual probeFile.
  await expect(page.locator('#audio-label')).toBeHidden();
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

test('e2e: Remove audio really removes the track from the downloaded file', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebCodecs e2e is gated on chromium');
  test.slow();
  await boot(page);

  await page.setInputFiles('#file-input', {
    name: 'withsound.mp4', mimeType: 'video/mp4',
    buffer: await makeFixtureMp4(page, { withAudio: true }),
  });
  await expect(page.locator('#configure')).toBeVisible({ timeout: 15_000 });
  // The REAL probe found the track and the REAL floor probe ran — no fake in
  // this path, so this is the control's only end-to-end proof.
  await expect(page.locator('#audio-label')).toBeVisible();
  await page.selectOption('#audio', 'none');
  await page.locator('#target-mb').fill('1');
  await expect(page.locator('#encode-btn')).toBeEnabled();
  await page.locator('#encode-btn').click();

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });
  await page.locator('#download-btn').click();
  const dl = await download;
  const fs = await import('node:fs');
  const outPath = await dl.path();
  const outSize = fs.statSync(outPath).size;
  expect(outSize).toBeGreaterThan(0);
  expect(outSize).toBeLessThanOrEqual(1_048_576);

  const tracks = await tracksInFile(page, fs.readFileSync(outPath));
  expect(tracks.hasAudio).toBe(false);
  expect(tracks.hasVideo).toBe(true);
});
