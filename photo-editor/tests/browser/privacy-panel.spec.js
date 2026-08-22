// tests/browser/privacy-panel.spec.js — the Privacy control is a link now.
//
// The in-app privacy dialog is gone. All 20 tools share one page at
// /privacy.html, and each tool's control deep-links to its own row — for this
// tool, /privacy.html#photo-editor. Three things can break silently, so each
// gets a test: the control stops being an anchor or loses its href; the
// breakpoint swap hides both copies at some width (the shell hides
// `body > footer` at 768px and shows the `.header-only-desktop` topbar links
// instead, so exactly one of the two is reachable at any width); or the old
// /photo-editor/privacy.html URL stops pointing people at the new page.
import { test, expect } from '@playwright/test';

const HREF = '/privacy.html#photo-editor';

async function boot(page) {
  await page.goto('/photo-editor/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

test.describe('mobile width — the footer link is the visible one', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('footer Privacy is an <a> pointing at the shared page', async ({ page }) => {
    await boot(page);
    const link = page.locator('#privacy-toggle');
    await expect(link).toBeVisible();
    expect(await link.evaluate(el => el.tagName)).toBe('A');
    await expect(link).toHaveAttribute('href', HREF);
    // Below 768px the topbar copy is the one CSS hides.
    await expect(page.locator('#privacy-toggle-header')).toBeHidden();
  });

  test('following the footer link reaches the privacy page', async ({ page }) => {
    await boot(page);
    await page.locator('#privacy-toggle').click();
    await expect(page).toHaveURL(/\/privacy\.html#photo-editor$/);
    await expect(page.locator('h1')).toHaveText('Privacy');
  });
});

test.describe('desktop width — the topbar link is the visible one', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('topbar Privacy is an <a> pointing at the shared page', async ({ page }) => {
    await boot(page);
    const link = page.locator('#privacy-toggle-header');
    await expect(link).toBeVisible();
    expect(await link.evaluate(el => el.tagName)).toBe('A');
    await expect(link).toHaveAttribute('href', HREF);
    // At and above 768px the whole footer is hidden.
    await expect(page.locator('#privacy-toggle')).toBeHidden();
  });

  test('following the topbar link reaches the privacy page', async ({ page }) => {
    await boot(page);
    await page.locator('#privacy-toggle-header').click();
    await expect(page).toHaveURL(/\/privacy\.html#photo-editor$/);
    await expect(page.locator('h1')).toHaveText('Privacy');
  });
});

test('the shared privacy page carries a #photo-editor anchor to land on', async ({ page }) => {
  // The href is only useful if the target exists. If the row id is ever
  // renamed, the link still resolves but drops the reader at the top of a
  // long page with no sign of which tool they came from.
  await page.goto(HREF);
  await expect(page.locator('h1')).toHaveText('Privacy');
  await expect(page.locator('#photo-editor')).toHaveCount(1);
});

test('the old /photo-editor/privacy.html URL still serves the redirect stub', async ({ request }) => {
  // Fetched rather than navigated: the stub redirects itself with a meta
  // refresh, so a real navigation races the assertion. What matters here is
  // the bytes a crawler or a stale bookmark sees.
  const res = await request.get('/photo-editor/privacy.html');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<link rel="canonical" href="https://noadstools.com/privacy.html">');
  expect(html).toMatch(/http-equiv="refresh"[^>]*url=\/privacy\.html#photo-editor/);
  // Belt and braces for anyone whose browser ignores the refresh.
  expect(html).toContain('href="/privacy.html#photo-editor"');
});
