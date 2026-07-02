// tests/browser/home.spec.js — the platform homepage: shared chrome mounts
// (minus lang/settings), the static tool grid + "Soon" tiles, pill filtering,
// theme, the in-app privacy panel, and the SEO head. English-first (Direction B).
import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

test('chrome injects without the language picker or settings gear', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#theme-toggle')).toHaveCount(1);
  await expect(page.locator('#tools-menu-toggle')).toHaveCount(1);
  await expect(page.locator('#lang-toggle')).toHaveCount(0);
  await expect(page.locator('#settings-toggle')).toHaveCount(0);
  await expect(page.locator('.topbar .wordmark a')).toHaveAttribute('href', '/');
});

test('Tools dropdown lists the live editor', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#tools-menu-list a[href="/photo-editor/"]')).toHaveCount(1);
});

test('grid shows the live editor card and non-clickable Soon tiles', async ({ page }) => {
  await boot(page);
  await expect(page.locator('a.tool-card[href="/photo-editor/"]')).toHaveCount(1);
  const soon = page.locator('.tool-card.is-soon');
  expect(await soon.count()).toBeGreaterThan(0);
  // Soon tiles are not links.
  await expect(page.locator('a.tool-card.is-soon')).toHaveCount(0);
  await expect(soon.first().locator('.tool-soon')).toHaveText('Soon');
});

test('live grid cards match liveTools() (drift guard)', async ({ page }) => {
  await boot(page);
  const liveSlugs = await page.evaluate(async () => {
    const m = await import('/shared/tools.js');
    return m.liveTools().map(t => t.slug).sort();
  });
  const cardHrefs = await page.locator('a.tool-card').evaluateAll(
    els => els.map(e => e.getAttribute('href')).sort());
  expect(cardHrefs).toEqual(liveSlugs.map(s => `/${s}/`));
});

test('category pills filter the grid', async ({ page }) => {
  await boot(page);
  await page.locator('.category-pills .pill[data-filter="pdf"]').click();
  // The image editor card is hidden; a pdf-category tile is visible.
  await expect(page.locator('a.tool-card[href="/photo-editor/"]')).toBeHidden();
  await expect(page.locator('.tool-card[data-cat="pdf"]').first()).toBeVisible();
  // Back to All shows the editor again.
  await page.locator('.category-pills .pill[data-filter="all"]').click();
  await expect(page.locator('a.tool-card[href="/photo-editor/"]')).toBeVisible();
});

test('theme toggle flips html[data-theme]', async ({ page }) => {
  await boot(page);
  await page.locator('#theme-toggle').click();
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(['light', 'dark']).toContain(theme);
});

test('privacy panel opens with the homepage rows', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle-header').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h1')).toHaveText('Privacy');
  await expect(dialog.locator('h2').first()).toHaveText('What this page loads');
});

test('SEO head has the title, canonical, and WebSite JSON-LD', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/NoAdsTools/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"WebSite"');
});
