// tests/browser/privacy.spec.js — the single site-wide privacy page.
//
// This spec exists to replace coverage that was LOST when the 20 per-tool
// in-app privacy panels were retired. Each tool's spec used to assert its own
// disclosure text ("libheif", "1.1 MB", the localStorage keys). Those panels
// are gone, so without this file nothing would notice if /privacy.html quietly
// stopped listing a tool, or if a tool linked to an anchor that does not exist.
//
// The drift guard is the first test: it walks liveTools() against the table.
// Add a tool to the manifest without adding its row here and it fails.
import { test, expect } from '@playwright/test';
import { liveTools } from '../../shared/tools.js';

test('every live tool has its own row on the privacy page', async ({ page }) => {
  await page.goto('/privacy.html');

  const rowIds = await page.locator('.fetch-table tbody tr[id]').evaluateAll(
    (rows) => rows.map((r) => r.id),
  );
  const slugs = liveTools().map((t) => t.slug);

  // Sorted compare so the failure message names the missing/extra tool.
  expect(rowIds.slice().sort()).toEqual(slugs.slice().sort());
});

test('each row links to the tool it describes', async ({ page }) => {
  await page.goto('/privacy.html');

  for (const slug of liveTools().map((t) => t.slug)) {
    const link = page.locator(`.fetch-table tr#${slug} td:first-child a`);
    await expect(link, `row #${slug} should link to /${slug}/`)
      .toHaveAttribute('href', `/${slug}/`);
  }
});

// The disclosure facts the per-tool panels used to assert. These are the
// numbers a reader can check in DevTools, so a silent edit that drops one
// should break the build.
test('the page still states the load-bearing disclosure facts', async ({ page }) => {
  await page.goto('/privacy.html');
  const text = await page.locator('article.prose').innerText();

  for (const fact of [
    'libheif',        // heic-to-jpg + find-duplicate-photos decoder
    '1.1',            // ...its size in MB
    'JSZip',          // the ZIP packer, six tools
    'pdf-lib',        // the four pdf-lib tools
    'pdf.js',         // the three viewer tools
    'Tesseract',      // pdf-to-text OCR
    '22',             // ...its size in MB
    '3.3',            // the AVIF encoder, the biggest image-side download
    '118',            // photo-editor background removal
    'noadstools:resume:',   // cross-tool read by the cover letter generator
    'noadstools:letter:',
    'kept native size',     // the resize pass-through that PRESERVES EXIF/GPS
  ]) {
    expect(text, `privacy page should still mention "${fact}"`).toContain(fact);
  }
});

test('the in-app privacy dialog is gone site-wide', async ({ page }) => {
  await page.goto('/privacy.html');
  await expect(page.locator('#privacy-panel')).toHaveCount(0);
});

test('the retired photo-editor privacy page redirects to the canonical one', async ({ page }) => {
  // Static hosting cannot issue a 301, so the stub carries a canonical + a
  // meta refresh. Assert the tags rather than the navigation, which would be
  // racy across engines.
  const res = await page.request.get('/photo-editor/privacy.html');
  expect(res.status()).toBe(200);
  const html = await res.text();

  expect(html).toContain('<link rel="canonical" href="https://noadstools.com/privacy.html">');
  expect(html).toContain('name="robots" content="noindex, follow"');
  expect(html).toMatch(/http-equiv="refresh"[^>]*url=\/privacy\.html#photo-editor/);
});

// One representative tool per engine family, proving the link a real page
// renders points at an anchor that actually exists. The full slug-to-row
// mapping is covered by the drift guard above; this checks the wiring.
for (const slug of ['remove-exif', 'merge-pdf', 'pdf-to-text', 'resume-builder']) {
  test(`${slug} links to a privacy anchor that exists`, async ({ page }) => {
    await page.goto(`/${slug}/`);
    await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

    // shell.css shows exactly one of the two controls per viewport.
    const wide = (page.viewportSize()?.width ?? 0) >= 768;
    const shown = page.locator(wide ? '#privacy-toggle-header' : 'footer #privacy-toggle');
    await expect(shown).toBeVisible();
    await expect(shown).toHaveAttribute('href', `/privacy.html#${slug}`);

    await page.goto(`/privacy.html#${slug}`);
    await expect(page.locator(`tr#${slug}`)).toHaveCount(1);
  });
}
