// split-audio/tests/browser/split-audio.spec.js
// Real fixtures through the real engine. Downloads are reopened in Node:
// the ZIP with the vendored JSZip (run through a CommonJS shim so it
// evaluates in this realm; see split-pdf.spec.js for why not vm), each chunk
// with mediabunny, which imports fine in Node.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => resolve(__dir, '../fixtures', name);
const mb = await import('../../../vendor/mediabunny/mediabunny.min.mjs');

const JSZip = (() => {
  const code = readFileSync(resolve(__dir, '../../../vendor/jszip/jszip.min.js'), 'utf8');
  const factory = new Function('module', 'exports', `${code}\nreturn module.exports;`);
  const mod = { exports: {} };
  return factory(mod, mod.exports);
})();

async function boot(page) {
  await page.goto('/split-audio/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

async function open(page, name) {
  await page.setInputFiles('#file-input', fixture(name));
  await expect(page.locator('#editor')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#summary')).toContainText(name);
}

async function describeChunk(bytes, ext) {
  const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  return { duration: await input.computeDuration(), codec: track?.codec, tags: await input.getMetadataTags(), ext };
}

// name, summary text, codec, snap tolerance (half a frame plus slack), and the
// lead-in a chunk after the first may carry: MP3 up to five 26 ms frames on
// this 64 kbps fixture, AAC and Vorbis one frame, Opus none because its
// rewritten pre-skip hides the pre-roll, WAV and FLAC none.
const FORMATS = [
  ['tone-3s.mp3', 'MP3, 44.1 kHz stereo', 'mp3', 0.03, 0.14],
  ['tone-3s.wav', 'WAV, 44.1 kHz stereo', 'pcm-s16', 0.0001, 0],
  ['tone-3s.m4a', 'M4A, 44.1 kHz stereo', 'aac', 0.03, 0.03],
  ['tone-3s.ogg', 'OGG, 48 kHz stereo', 'opus', 0.03, 0],
  ['tone-3s-vorbis.ogg', 'OGG, 44.1 kHz stereo', 'vorbis', 0.05, 0.05],
  ['tone-3s.flac', 'FLAC, 44.1 kHz stereo', 'flac', 0.1, 0],
];

test('lazy engine: zero /vendor/mediabunny/ requests before a file lands, one after', async ({ page }) => {
  const hits = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/mediabunny/')) hits.push(r.url()); });
  await boot(page);
  expect(hits).toEqual([]);
  await open(page, 'tone-3s.mp3');
  expect(hits.length).toBe(1);
});

for (const [name, summaryText] of FORMATS) {
  test(`opens ${name}: summary, one chunk, no Download all`, async ({ page }) => {
    await boot(page);
    await open(page, name);
    await expect(page.locator('#summary')).toContainText(summaryText);
    await expect(page.locator('#summary')).toContainText('0:03.0');
    await expect(page.locator('#segments-body tr')).toHaveCount(1);
    await expect(page.locator('#download-all-btn')).toBeHidden();
    await expect(page.locator('#tool-error')).toBeHidden();
    // Peaks need a decoder: WebCodecs' AudioDecoder, or an OfflineAudioContext for the
    // fallback. Playwright's headless WebKit build ships neither, so there every
    // compressed fixture honestly takes the "Couldn't decode" path; WAV is PCM and
    // mediabunny decodes it without any of them, so that one must always draw.
    const canPeaks = await page.evaluate(() => typeof AudioDecoder !== 'undefined' || typeof OfflineAudioContext !== 'undefined' || typeof webkitOfflineAudioContext !== 'undefined');
    if (name === 'tone-3s.wav' || canPeaks) {
      await expect(page.locator('#silence-apply')).toBeEnabled({ timeout: 10000 });
      await expect(page.locator('#peaks-note')).toBeHidden();
    } else {
      await expect(page.locator('#peaks-note')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#peaks-note')).toContainText("Couldn't decode");
      await expect(page.locator('#silence-apply')).toBeDisabled();
    }
  });
}

test('a video file gets the honest message, not "corrupt"', async ({ page }) => {
  await boot(page);
  await page.setInputFiles('#file-input', fixture('tiny.mp4'));
  await expect(page.locator('#tool-error')).toContainText('This is a video file');
  await expect(page.locator('#editor')).toBeHidden();
});

test('a non-audio file is named as unreadable, with the format list', async ({ page }) => {
  await boot(page);
  await page.setInputFiles('#file-input', fixture('not-audio.txt'));
  await expect(page.locator('#tool-error')).toContainText("doesn't look like an audio file");
  await expect(page.locator('#tool-error')).not.toContainText('corrupt');
});

test('engine load failure is reported as OUR failure and retry works', async ({ page }) => {
  await boot(page);
  await page.route('**/vendor/mediabunny/**', (r) => r.abort());
  await page.setInputFiles('#file-input', fixture('tone-3s.mp3'));
  await expect(page.locator('#tool-error')).toContainText('audio engine');
  await expect(page.locator('#tool-error')).not.toContainText('corrupt');
  await page.unroute('**/vendor/mediabunny/**');
  await open(page, 'tone-3s.mp3');
  await expect(page.locator('#tool-error')).toBeHidden();
});

for (const [name, , codec, tol, leadIn] of FORMATS) {
  test(`${name}: equal parts 3 → Download all → three valid ${codec} chunks with tags`, async ({ page }) => {
    await boot(page);
    await open(page, name);
    const zipHits = [];
    page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipHits.push(r.url()); });
    await page.locator('.mode-btn[data-mode="equal"]').click();
    await page.fill('#equal-n', '3');
    await page.locator('#equal-apply').click();
    await expect(page.locator('#segments-body tr')).toHaveCount(3);
    expect(zipHits).toEqual([]);
    const dl = page.waitForEvent('download');
    await page.locator('#download-all-btn').click();
    const file = await dl;
    const base = name.replace(/\.[^.]+$/, '');
    expect(file.suggestedFilename()).toBe(`${base}-split.zip`);
    const zip = await JSZip.loadAsync(readFileSync(await file.path()));
    const ext = name.split('.').pop();
    const entries = Object.keys(zip.files).sort();
    expect(entries).toEqual([`${base}-01.${ext}`, `${base}-02.${ext}`, `${base}-03.${ext}`]);
    for (let i = 0; i < 3; i++) {
      const bytes = await zip.file(entries[i]).async('uint8array');
      const c = await describeChunk(bytes, ext);
      expect(c.codec).toBe(codec);
      expect(c.duration).toBeGreaterThan(1.0 - tol - 0.03);
      expect(c.duration).toBeLessThan(1.0 + leadIn + tol + 0.03);
      expect(c.tags?.title).toMatch(new RegExp(`\\(part ${i + 1}\\)$`));
      expect(c.tags?.trackNumber).toBe(i + 1);
      expect(c.tags?.tracksTotal).toBe(3);
    }
    expect(zipHits.length).toBe(1);
    await expect(page.locator('#status')).toContainText('Downloaded 3 chunks');
  });
}

test('per-row Download names the chunk and captures its own row', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.mp3');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '3');
  await page.locator('#equal-apply').click();
  const dl = page.waitForEvent('download');
  await page.locator('#segments-body tr:nth-child(2) .dl-seg').click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe('tone-3s-02.mp3');
  const c = await describeChunk(readFileSync(await file.path()), 'mp3');
  expect(c.tags?.trackNumber).toBe(2);
});

test('Every: 1 second on a 3 s file gives three parts, and an exact multiple leaves no empty tail', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="every"]').click();
  await page.selectOption('#every-unit', '1');
  await page.fill('#every-value', '1');
  await page.locator('#every-apply').click();
  await expect(page.locator('#segments-body tr')).toHaveCount(3);
  await expect(page.locator('#segments-body tr:nth-child(3) .t-start')).toHaveValue('0:02.0');
});

test('editing an End time moves the cut; an impossible value is flagged and restored on blur', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '2');
  await page.locator('#equal-apply').click();
  const end1 = page.locator('#segments-body tr:nth-child(1) .t-end');
  await end1.fill('0:02.0');
  await end1.press('Enter');
  await expect(page.locator('#segments-body tr:nth-child(2) .t-start')).toHaveValue('0:02.0');
  await expect(page.locator('.mode-btn[data-mode="manual"]')).toHaveAttribute('aria-pressed', 'true');
  await end1.fill('0:05.0');
  await end1.press('Enter');
  await expect(end1).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#segments-body tr:nth-child(1) .row-error')).toContainText('Must be between');
  await page.locator('#clear-cuts-btn').focus();
  await expect(end1).toHaveValue('0:02.0');
  await expect(end1).not.toHaveAttribute('aria-invalid', 'true');
});

test('Merge with previous removes the cut, and Clear cuts empties the list', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '3');
  await page.locator('#equal-apply').click();
  await page.locator('#segments-body tr:nth-child(2) .merge-seg').click();
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  await expect(page.locator('#segments-body tr:nth-child(1) .t-end')).toHaveValue('0:02.0');
  await page.locator('#clear-cuts-btn').click();
  await expect(page.locator('#segments-body tr')).toHaveCount(1);
  await expect(page.locator('#download-all-btn')).toBeHidden();
});

test('Silence mode finds the one gap in tone-gap-tone.wav', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-gap-tone.wav');
  await expect(page.locator('#silence-apply')).toBeEnabled({ timeout: 10000 });
  await page.locator('.mode-btn[data-mode="silence"]').click();
  await page.locator('#silence-apply').click();
  await expect(page.locator('#silence-result')).toContainText('Found 1 gap');
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  const end1 = await page.locator('#segments-body tr:nth-child(1) .t-end').inputValue();
  const [m, s] = end1.split(':');
  const t = Number(m) * 60 + Number(s);
  expect(t).toBeGreaterThan(1.0);
  expect(t).toBeLessThan(2.5);
});

test('ZIP packer failure is reported as OUR failure and single downloads still work', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.mp3');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '2');
  await page.locator('#equal-apply').click();
  await page.route('**/vendor/jszip/**', (r) => r.abort());
  await page.locator('#download-all-btn').click();
  await expect(page.locator('#status')).toContainText('ZIP packer');
  const dl = page.waitForEvent('download');
  await page.locator('#segments-body tr:nth-child(1) .dl-seg').click();
  expect((await dl).suggestedFilename()).toBe('tone-3s-01.mp3');
});

test('editing a time keeps keyboard focus in the table, and Merge moves focus to the merged row', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '3');
  await page.locator('#equal-apply').click();
  const end1 = page.locator('#segments-body tr:nth-child(1) .t-end');
  await end1.focus();
  await end1.fill('0:00.8');
  await page.keyboard.press('Tab');
  // The rebuild happens inside the Tab's own focus transfer, so the browser's
  // pre-computed next element is detached by the time it gets there and the
  // restore wins: focus stays on the input just edited. One Tab press is
  // consumed; the next one advances normally (Play is the row's next control,
  // not the following row's Start), so this is not a keyboard trap.
  const focusedAfterEdit = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  expect(focusedAfterEdit).toBe('End of part 1');
  await expect(page.locator('#segments-body tr:nth-child(1) .t-end')).toHaveValue('0:00.8');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Play part 1');
  await page.locator('#segments-body tr:nth-child(3) .merge-seg').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  const focusedAfterMerge = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  expect(focusedAfterMerge).toBe('End of part 2');
});

// ---- Part B: the timeline ------------------------------------------------------
async function frameBox(page) {
  // page.mouse takes raw viewport coordinates and never scrolls, so on a short
  // viewport (mobile-safari is 664 px tall and the frame starts at y~840) every
  // click would land outside the page. Scroll it in first, like .click() does.
  await page.locator('#timeline-frame').scrollIntoViewIfNeeded();
  const box = await page.locator('#timeline-frame').boundingBox();
  return { ...box, tabY: box.y + 18 + 7 };   // RULER_H + TAB_H/2
}
const timeOfInput = async (loc) => {
  const v = await loc.inputValue();
  const parts = v.split(':').map(Number);
  return parts.reduce((a, p) => a * 60 + p, 0);
};

test('double-click on the waveform adds a cut there', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  const f = await frameBox(page);
  await page.mouse.dblclick(f.x + f.width / 3, f.y + f.height * 0.6);
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  const t = await timeOfInput(page.locator('#segments-body tr:nth-child(1) .t-end'));
  expect(Math.abs(t - 1.0)).toBeLessThan(0.1);
});

test('click seeks the playhead; Add cut and S cut there', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  const f = await frameBox(page);
  await page.mouse.click(f.x + f.width * 0.25, f.y + f.height * 0.6);
  await expect(page.locator('#time-now')).toHaveText(/0:00\.[78]/);
  await page.locator('#add-cut-btn').click();
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  const t = await timeOfInput(page.locator('#segments-body tr:nth-child(1) .t-end'));
  expect(Math.abs(t - 0.75)).toBeLessThan(0.1);
});

test('dragging a marker with the mouse moves the cut and switches the mode to Manual', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '2');
  await page.locator('#equal-apply').click();
  const f = await frameBox(page);
  const x0 = f.x + f.width / 2;
  await page.mouse.move(x0, f.tabY);
  await page.mouse.down();
  await page.mouse.move(x0 + f.width / 12, f.tabY, { steps: 5 });
  await page.mouse.move(x0 + f.width / 6, f.tabY, { steps: 5 });
  await page.mouse.up();
  const t = await timeOfInput(page.locator('#segments-body tr:nth-child(1) .t-end'));
  expect(Math.abs(t - 2.0)).toBeLessThan(0.1);
  await expect(page.locator('.mode-btn[data-mode="manual"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#segments-body tr:nth-child(1)')).toHaveClass(/is-selected/);
});

test('dragging a marker by touch moves the cut (CDP touch events)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP touch injection is Chromium-only');
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '2');
  await page.locator('#equal-apply').click();
  const f = await frameBox(page);
  const x0 = f.x + f.width / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: f.tabY }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - f.width / 12, y: f.tabY }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - f.width / 6, y: f.tabY }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const t = await timeOfInput(page.locator('#segments-body tr:nth-child(1) .t-end'));
  expect(Math.abs(t - 1.0)).toBeLessThan(0.1);
});

test('zoom in narrows the view and Fit restores the whole file', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  const view = async () => (await page.locator('#timeline-frame').getAttribute('data-view')).split(':').map(Number);
  let [a, b] = await view();
  expect(a).toBe(0); expect(Math.abs(b - 3)).toBeLessThan(0.01);
  await page.locator('#zoom-in-btn').click();
  [a, b] = await view();
  expect(b - a).toBeLessThan(2.1);
  await page.locator('#fit-btn').click();
  [a, b] = await view();
  expect(Math.abs(b - a - 3)).toBeLessThan(0.01);
});

test('the waveform gets drawn: the canvas is not blank after peaks arrive', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.mp3');
  await expect(page.locator('#silence-apply')).toBeEnabled({ timeout: 10000 });
  const nonBg = await page.locator('#timeline').evaluate((c) => {
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, Math.floor(c.height * 0.5), c.width, 1);
    const first = [data[0], data[1], data[2]].join(',');
    let diff = 0;
    for (let i = 0; i < data.length; i += 4) if ([data[i], data[i + 1], data[i + 2]].join(',') !== first) diff += 1;
    return diff;
  });
  expect(nonBg).toBeGreaterThan(50);
});

// ---- Part C: playback and shortcuts ------------------------------------------
test('transport: Play advances the playhead and toggles to Pause', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await expect(page.locator('#play-btn')).toBeEnabled();
  await page.locator('#play-btn').click();
  await expect(page.locator('#play-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#time-now')).not.toHaveText('0:00.0', { timeout: 3000 });
  await page.locator('#play-btn').click();
  await expect(page.locator('#play-btn')).toHaveAttribute('aria-pressed', 'false');
});

test('a row\'s Play plays only that chunk and stops at its end', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '3');
  await page.locator('#equal-apply').click();
  await page.locator('#segments-body tr:nth-child(1) .play-seg').click();
  await expect(page.locator('#play-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-btn')).toHaveAttribute('aria-pressed', 'false', { timeout: 4000 });
  await expect(page.locator('#time-now')).toHaveText('0:01.0');
});

test('keyboard: arrows nudge, S cuts at the playhead, Delete removes the selected cut', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('#summary').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#time-now')).toHaveText('0:01.0');
  await page.keyboard.press('s');
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  await expect(page.locator('#segments-body tr:nth-child(1) .t-end')).toHaveValue('0:01.0');
  await page.keyboard.press('Delete');
  await expect(page.locator('#segments-body tr')).toHaveCount(1);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.locator('#time-now')).toHaveText('0:00.0');
});

test('prev/next jump between cuts', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '3');
  await page.locator('#equal-apply').click();
  await page.locator('#next-btn').click();
  await expect(page.locator('#time-now')).toHaveText('0:01.0');
  await page.locator('#next-btn').click();
  await expect(page.locator('#time-now')).toHaveText('0:02.0');
  await page.locator('#next-btn').click();
  await expect(page.locator('#time-now')).toHaveText('0:03.0');
  await page.locator('#prev-btn').click();
  await expect(page.locator('#time-now')).toHaveText('0:02.0');
});

test('when the browser cannot play the format, the transport is disabled and downloads still work', async ({ page }) => {
  await page.addInitScript(() => { HTMLMediaElement.prototype.canPlayType = () => ''; });
  await boot(page);
  await open(page, 'tone-3s.mp3');
  await expect(page.locator('#play-btn')).toBeDisabled();
  await expect(page.locator('#play-note')).toContainText("can't play MP3");
  const dl = page.waitForEvent('download');
  await page.locator('#segments-body tr:nth-child(1) .dl-seg').click();
  expect((await dl).suggestedFilename()).toBe('tone-3s-01.mp3');
});

test('Space on a focused button activates the button, not the transport; Space in a time input types a space', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '2');
  await page.locator('#equal-apply').click();
  await page.locator('#zoom-in-btn').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#play-btn')).toHaveAttribute('aria-pressed', 'false');
  const end1 = page.locator('#segments-body tr:nth-child(1) .t-end');
  await end1.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await expect(end1).toHaveValue('0:01.5 ');
  await expect(page.locator('#play-btn')).toHaveAttribute('aria-pressed', 'false');
});

test('with the transport disabled, S, arrows and Delete still edit the cut list', async ({ page }) => {
  await page.addInitScript(() => { HTMLMediaElement.prototype.canPlayType = () => ''; });
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('#summary').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#time-now')).toHaveText('0:01.0');
  await page.keyboard.press('s');
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(page.locator('#segments-body tr')).toHaveCount(1);
});

// ---- Part D: a11y, mobile, edge states -------------------------------------------
test('axe: no violations with a file open and three rows', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '3');
  await page.locator('#equal-apply').click();
  await expect(page.locator('#segments-body tr')).toHaveCount(3);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('375 px: no horizontal overflow after content is loaded and cuts exist', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '3');
  await page.locator('#equal-apply').click();
  await expect(page.locator('#segments-body tr')).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // The timeline frame itself must not exceed the viewport either.
  const w = await page.locator('#timeline-frame').evaluate((n) => n.getBoundingClientRect().width);
  expect(w).toBeLessThanOrEqual(375);
  // The silence panel is the widest control row, so re-check with it open.
  await page.locator('.mode-btn[data-mode="silence"]').click();
  await expect(page.locator('#mode-silence')).toBeVisible();
  const overflowSilence = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowSilence).toBeLessThanOrEqual(1);
});

test('keyboard: every row control is reachable with Shift+Tab from Download all', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '2');
  await page.locator('#equal-apply').click();
  await page.locator('#download-all-btn').focus();
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Shift+Tab');
    const id = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName}.${a.className}#${a.getAttribute('aria-label') || a.id}` : '';
    });
    seen.add(id);
  }
  const labels = [...seen].join('\n');
  for (const want of ['Download part 2', 'Play part 2', 'Merge part 2 with previous', 'End of part 1', 'Download part 1']) {
    expect(labels, `${want} reachable by Shift+Tab`).toContain(want);
  }
});

test('Add cut with the playhead at 0 explains why nothing happened', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('#add-cut-btn').click();
  await expect(page.locator('#segments-body tr')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('No room for a cut');
});

test('opening a second file with cuts present asks first, and a dismissed confirm keeps the current file', async ({ page }) => {
  await boot(page);
  await open(page, 'tone-3s.wav');
  await page.locator('.mode-btn[data-mode="equal"]').click();
  await page.fill('#equal-n', '2');
  await page.locator('#equal-apply').click();
  page.once('dialog', (d) => d.dismiss());
  await page.setInputFiles('#file-input', fixture('tone-3s.mp3'));
  await expect(page.locator('#summary')).toContainText('tone-3s.wav');
  await expect(page.locator('#segments-body tr')).toHaveCount(2);
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#file-input', fixture('tone-3s.mp3'));
  await expect(page.locator('#summary')).toContainText('tone-3s.mp3');
  await expect(page.locator('#segments-body tr')).toHaveCount(1);
});
