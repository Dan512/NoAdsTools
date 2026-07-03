// find-duplicate-photos/tests/browser/find-duplicate-photos.spec.js — the
// tool end-to-end. Fixtures are drawn in-page (canvas → PNG bytes) so the
// perceptual hashes are deterministic without committing binary fixtures.
//
// FIXTURE RULE (Wave 2a finding): the "similar" pair must NOT reuse the
// exact pair's pattern at a new size — exact-group members are excluded
// from the perceptual pass, so such a file would end up partnerless.
// Fixture shape: identical checker pair (exact group), diag at 400×300 +
// 200×150 (similar group), stripes (distinct, in no group).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function boot(page) {
  await page.goto('/find-duplicate-photos/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Draw strongly-structured patterns so perceptual hashes are stable across
// resizes: 'diag' (half dark/half light + heavy diagonal), 'checker', and
// 'stripes' (horizontal bars — matches neither of the others).
async function makeFixtures(page) {
  return page.evaluate(async () => {
    const draw = (w, h, variant) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      if (variant === 'diag') {
        x.fillStyle = '#111'; x.fillRect(0, 0, w / 2, h);
        x.fillStyle = '#eee'; x.fillRect(w / 2, 0, w / 2, h);
        x.strokeStyle = '#888'; x.lineWidth = w / 8;
        x.beginPath(); x.moveTo(0, 0); x.lineTo(w, h); x.stroke();
      } else if (variant === 'checker') {
        for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
          x.fillStyle = (i + j) % 2 ? '#000' : '#fff';
          x.fillRect(i * w / 8, j * h / 8, w / 8, h / 8);
        }
      } else {
        // stripes: horizontal bars — distinct from both diag and checker.
        for (let j = 0; j < 8; j++) {
          x.fillStyle = j % 2 ? '#000' : '#fff';
          x.fillRect(0, j * h / 8, w, h / 8);
        }
      }
      return new Promise(res => c.toBlob(res, 'image/png'));
    };
    const big = await draw(400, 300, 'diag');
    const small = await draw(200, 150, 'diag');
    const other = await draw(400, 300, 'checker');
    const stripes = await draw(400, 300, 'stripes');
    const toArr = async b => [...new Uint8Array(await b.arrayBuffer())];
    return {
      identicalBytes: await toArr(other),  // checker — used twice under two names (exact group)
      diagBigBytes: await toArr(big),       // diag 400x300 (similar group)
      diagSmallBytes: await toArr(small),   // diag 200x150 (similar group)
      stripesBytes: await toArr(stripes),   // distinct — no group
    };
  });
}

async function dropFiles(page, files /* [{name, bytes, type}] */) {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) {
      // Fixed lastModified so re-dropping the SAME named file twice produces
      // the SAME re-add key (relPath+size+lastModified) — a fresh File()
      // without this defaults lastModified to Date.now(), which would defeat
      // the tool's re-add guard on every repeat drop.
      dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type, lastModified: 1700000000000 }));
    }
    document.getElementById('dropzone')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, files);
}

// Reproduces the diag pattern at 400x300 as raw pixel data, for the fake
// HEIC decoder (assertion 6) — must cluster with the diag PNG fixture.
async function makeDiagImageData(page) {
  return page.evaluate(async () => {
    const w = 400, h = 300;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#111'; x.fillRect(0, 0, w / 2, h);
    x.fillStyle = '#eee'; x.fillRect(w / 2, 0, w / 2, h);
    x.strokeStyle = '#888'; x.lineWidth = w / 8;
    x.beginPath(); x.moveTo(0, 0); x.lineTo(w, h); x.stroke();
    const data = x.getImageData(0, 0, w, h).data;
    return { data: [...data], width: w, height: h };
  });
}

async function waitForGroups(page, count, timeout = 15000) {
  await expect(page.locator('.group-card')).toHaveCount(count, { timeout });
}

test('boots with minimal chrome (no lang picker, no settings gear)', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
});

test('SEO head: title, canonical, SoftwareApplication JSON-LD, single h1', async ({ page }) => {
  await page.goto('/find-duplicate-photos/');
  await expect(page).toHaveTitle('Find Duplicate Photos — Free, No Upload, No Install · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/find-duplicate-photos/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. exact + similar grouping, with thumb + dims coverage', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'C1.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'C2.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'D-big.png', bytes: fx.diagBigBytes, type: 'image/png' },
    { name: 'D-small.png', bytes: fx.diagSmallBytes, type: 'image/png' },
    { name: 'other.png', bytes: fx.stripesBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 2);

  await expect(page.locator('#summary')).toContainText('Found 2 duplicate groups');

  const identicalCard = page.locator('.group-card').filter({ has: page.locator('.group-match', { hasText: 'Identical files' }) });
  await expect(identicalCard).toHaveCount(1);
  const similarCard = page.locator('.group-card').filter({ has: page.locator('.group-match', { hasText: 'Visually similar' }) });
  await expect(similarCard).toHaveCount(1);

  // C1.png (exact-group member) must appear inside the "Identical files" card.
  await expect(identicalCard.locator('.photo-name', { hasText: 'C1.png' })).toHaveCount(1);

  // other.png (stripes) must appear in neither group.
  await expect(page.locator('.photo-name', { hasText: 'other.png' })).toHaveCount(0);

  // The "Visually similar" card must contain a thumbnail <img> with a blob:
  // src, and the 400x300 member's meta text must show "400×300" — the only
  // browser coverage of the worker's `thumb` extension (dims + display thumb).
  const bigPhoto = similarCard.locator('.photo').filter({ has: page.locator('.photo-name', { hasText: 'D-big.png' }) });
  await expect(bigPhoto.locator('.photo-meta')).toContainText('400×300');
  const bigThumbSrc = await bigPhoto.locator('.photo-thumb img').getAttribute('src');
  expect(bigThumbSrc).toMatch(/^blob:/);
});

test('2. keeper auto-pick + toggle', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'D-big.png', bytes: fx.diagBigBytes, type: 'image/png' },
    { name: 'D-small.png', bytes: fx.diagSmallBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 1);

  const card = page.locator('.group-card').first();
  const bigPhoto = card.locator('.photo').filter({ has: page.locator('.photo-name', { hasText: 'D-big.png' }) });
  const smallPhoto = card.locator('.photo').filter({ has: page.locator('.photo-name', { hasText: 'D-small.png' }) });

  // 400x300 (most pixels) auto-wins the keeper slot.
  await expect(bigPhoto).toHaveAttribute('aria-pressed', 'true');
  await expect(bigPhoto.locator('.photo-state')).toContainText('Keep');
  await expect(smallPhoto).toHaveAttribute('aria-pressed', 'false');
  await expect(smallPhoto.locator('.photo-state')).toContainText('Duplicate');

  const summaryBefore = await page.locator('#summary').textContent();
  expect(summaryBefore).toMatch(/Found 1 duplicate group/);

  // Toggle the small one to Keep — reclaimable count should drop to 0 (both kept).
  await smallPhoto.click();
  await expect(smallPhoto).toHaveAttribute('aria-pressed', 'true');
  await expect(smallPhoto.locator('.photo-state')).toContainText('Keep');
  await expect(page.locator('#summary')).toContainText('No duplicates found');

  // Toggle again — back to duplicate.
  await smallPhoto.click();
  await expect(smallPhoto).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#summary')).toContainText('Found 1 duplicate group');
});

test('3. sensitivity change resets overrides', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'D-big.png', bytes: fx.diagBigBytes, type: 'image/png' },
    { name: 'D-small.png', bytes: fx.diagSmallBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 1);

  const card = page.locator('.group-card').first();
  const smallPhoto = card.locator('.photo').filter({ has: page.locator('.photo-name', { hasText: 'D-small.png' }) });
  await smallPhoto.click();
  await expect(smallPhoto).toHaveAttribute('aria-pressed', 'true');

  // Switch to Strict — groups rebuild, override discarded (auto keeper restored).
  await page.locator('#sensitivity input[value="strict"]').check();
  await waitForGroups(page, 1);
  const smallAfter = page.locator('.group-card').first().locator('.photo')
    .filter({ has: page.locator('.photo-name', { hasText: 'D-small.png' }) });
  await expect(smallAfter).toHaveAttribute('aria-pressed', 'false');
});

test('4. JSZip loads lazily — only after Download unique set is clicked', async ({ page }) => {
  const zipRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/jszip/')) zipRequests.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'C1.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'C2.png', bytes: fx.identicalBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 1);
  expect(zipRequests.length).toBe(0);

  const dl = page.waitForEvent('download');
  await page.locator('#download-zip').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('photos-unique-set.zip');
  expect(zipRequests.length).toBeGreaterThan(0);
});

test('5. libheif never loads for a PNG-only flow', async ({ page }) => {
  const libheifRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/libheif/')) libheifRequests.push(r.url()); });
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'C1.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'C2.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'D-big.png', bytes: fx.diagBigBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 1);
  expect(libheifRequests.length).toBe(0);
});

test('6. HEIC path with fake decoder clusters into the similar group', async ({ page }) => {
  const libheifRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/libheif/')) libheifRequests.push(r.url()); });
  await boot(page);

  const diag = await makeDiagImageData(page);
  await page.evaluate(async (fakeImageData) => {
    const { _setHeicDecoderForTest } = await import('/shared/heic-loader.js');
    _setHeicDecoderForTest({
      decode: async () => ({
        data: new Uint8ClampedArray(fakeImageData.data),
        width: fakeImageData.width,
        height: fakeImageData.height,
      }),
    });
  }, diag);

  const fx = await makeFixtures(page);
  // .heic extension routes the file to the HEIC path regardless of its
  // actual bytes — the HEIC file's on-disk bytes must NOT equal the PNG's
  // bytes (that would collide on SHA-256 and land them in the EXACT group
  // instead of similar). The fake decoder supplies the matching pixels
  // regardless of what bytes were "on disk".
  const heicBytes = [...fx.diagBigBytes].reverse();
  await dropFiles(page, [
    { name: 'photo.heic', bytes: heicBytes, type: 'image/heic' },
    { name: 'A.png', bytes: fx.diagBigBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 1, 20000);

  await expect(page.locator('.group-match')).toContainText('Visually similar');
  await expect(page.locator('.photo-name', { hasText: 'photo.heic' })).toHaveCount(1);
  await expect(page.locator('.photo-name', { hasText: 'A.png' })).toHaveCount(1);
  expect(libheifRequests.length).toBe(0);
});

test('7. re-add guard: dropping the same files twice skips them, no self-duplicates', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  const files = [
    { name: 'C1.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'C2.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'D-big.png', bytes: fx.diagBigBytes, type: 'image/png' },
    { name: 'D-small.png', bytes: fx.diagSmallBytes, type: 'image/png' },
  ];
  await dropFiles(page, files);
  await waitForGroups(page, 2);

  await dropFiles(page, files);
  // No new pending items are added, so no re-scan happens — but the issues
  // section must show the skip note immediately, and grouping stays at 2.
  await expect(page.locator('#issues-summary')).toContainText('Skipped 4 already-added files');
  await waitForGroups(page, 2);
});

test('8. non-image file is skipped with an honest note, no crash', async ({ page }) => {
  await boot(page);
  await dropFiles(page, [{ name: 'notes.txt', bytes: [...Buffer.from('hello')], type: 'text/plain' }]);
  await expect(page.locator('#issues-summary')).toContainText('Skipped 1 non-image file');
});

test('9. zero-duplicate positive state disables ZIP + list buttons', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'A.png', bytes: fx.diagBigBytes, type: 'image/png' },
    { name: 'other.png', bytes: fx.stripesBytes, type: 'image/png' },
  ]);
  await expect(page.locator('#summary')).toContainText('No duplicates found among 2 photos', { timeout: 15000 });
  await expect(page.locator('#download-zip')).toBeDisabled();
  await expect(page.locator('#copy-list')).toBeDisabled();
  await expect(page.locator('#download-list')).toBeDisabled();
});

test('10. copy list writes the delete list to the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'C1.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'C2.png', bytes: fx.identicalBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 1);

  await page.locator('#copy-list').click();
  await expect(page.locator('#copy-list')).toContainText('Copied');
  const clipText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipText).toMatch(/Group 1 — identical files:/);
  expect(clipText).toMatch(/DELETE/);
});

test('11. keyboard toggles a photo and axe reports no serious/critical violations', async ({ page }) => {
  await boot(page);
  const fx = await makeFixtures(page);
  await dropFiles(page, [
    { name: 'C1.png', bytes: fx.identicalBytes, type: 'image/png' },
    { name: 'C2.png', bytes: fx.identicalBytes, type: 'image/png' },
  ]);
  await waitForGroups(page, 1);

  // Capture the target by its stable data-id, NOT by the aria-pressed="false"
  // selector — that selector stops matching the instant the toggle succeeds,
  // which would make a passing toggle look like "element not found".
  const dupId = await page.locator('.photo[aria-pressed="false"]').first().getAttribute('data-id');
  const dupPhoto = page.locator(`.photo[data-id="${dupId}"]`);
  await dupPhoto.focus();
  await expect(dupPhoto).toBeFocused();
  // Programmatic .focus() succeeds even on non-tabbable elements — confirm
  // the element is a real tab stop (native <button>, non-negative tabIndex).
  expect(await dupPhoto.evaluate(el => el.tagName === 'BUTTON' && el.tabIndex >= 0)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(dupPhoto).toHaveAttribute('aria-pressed', 'true');
  // main.js captures/restores focus by data-id across the toggle re-render —
  // deleting that code must fail this assertion.
  await expect(dupPhoto).toBeFocused();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const FAIL_IMPACTS = new Set(['critical', 'serious']);
  const blockers = results.violations.filter(v => FAIL_IMPACTS.has(v.impact || ''));
  if (blockers.length) {
    console.error('[a11y find-duplicate-photos] blocking violations:');
    for (const v of blockers) {
      console.error(`  ${v.id} (${v.impact}): ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) console.error(`    ${n.target.join(' ')}`);
    }
  }
  expect(blockers).toEqual([]);
});
