// shared/tests/browser/harness.spec.js — proves the shared chrome mounts with
// NO editor code. This is the platform's "second consumer": if any shared module
// secretly depended on the editor, the harness would break here.
import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.goto('/shared/tests/harness/index.html');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// shell.css hides body > footer at ≥768px and hides .header-only-desktop
// below it, so exactly ONE of the two Privacy links is on screen per viewport.
// Pick the one this project's device actually shows.
function shownPrivacyLink(page) {
  const wide = (page.viewportSize()?.width ?? 0) >= 768;
  return page.locator(wide ? '#privacy-toggle-header' : 'footer #privacy-toggle');
}

test('shell.css is self-sufficient: tokens resolve + topbar is styled', async ({ page }) => {
  await boot(page);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  expect(accent.length).toBeGreaterThan(0);
  const pos = await page.locator('.topbar').evaluate(el => getComputedStyle(el).position);
  expect(pos).toBe('sticky');
});

test('topbar injects with the wordmark + all chrome controls', async ({ page }) => {
  await boot(page);
  await expect(page.locator('.topbar .wordmark')).toContainText('NoAdsTools');
  for (const id of ['tools-menu-toggle', 'lang-toggle', 'theme-toggle', 'settings-toggle', 'privacy-toggle-header']) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
});

test('footer injects with privacy, source, and tip', async ({ page }) => {
  await boot(page);
  await expect(page.locator('footer #privacy-toggle')).toHaveCount(1);
  await expect(page.locator('footer a[data-i18n="source"]')).toHaveCount(1);
  await expect(page.locator('footer a[data-i18n="tipFooter"]')).toHaveCount(1);
});

test('theme toggle flips html[data-theme]', async ({ page }) => {
  await boot(page);
  await page.locator('#theme-toggle').click();
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(['light', 'dark']).toContain(theme);
});

test('settings popover opens with the 3 global settings rows', async ({ page }) => {
  await boot(page);
  await page.locator('#settings-toggle').click();
  const popover = page.locator('.settings-popover');
  await expect(popover).toBeVisible();
  // theme, showThemeButton, showLanguagePicker — the shared global settings.
  await expect(popover.locator('[data-setting]')).toHaveCount(3);
});

// Privacy is a link to the one static page, not an in-app dialog. The harness
// passes a placeholder toolId, so the #anchor proves the toolId flows all the
// way through the shared chrome into the href.
test('privacy is a link to /privacy, anchored at this tool row', async ({ page }) => {
  await boot(page);
  const href = '/privacy#harness';
  await expect(page.locator('#privacy-toggle-header')).toHaveAttribute('href', href);
  await expect(page.locator('footer #privacy-toggle')).toHaveAttribute('href', href);
  await expect(shownPrivacyLink(page)).toBeVisible();
  // No dialog is created, and nothing is left wired to open one.
  await expect(page.locator('#privacy-panel')).toHaveCount(0);
});
