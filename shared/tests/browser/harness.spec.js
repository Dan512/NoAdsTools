// shared/tests/browser/harness.spec.js — proves the shared chrome mounts with
// NO editor code. This is the platform's "second consumer": if any shared module
// secretly depended on the editor, the harness would break here.
import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.goto('/shared/tests/harness/index.html');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
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
  await expect(page.locator('#privacy-toggle')).toHaveCount(1);
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

test('privacy panel opens with the registered demo section (no editor)', async ({ page }) => {
  await boot(page);
  // Use the header privacy button (#privacy-toggle-header) — the footer's
  // #privacy-toggle is hidden at desktop width by shell.css's ≥768px rule
  // (same rule that existed in style.css; both buttons wire to the same handler).
  await page.locator('#privacy-toggle-header').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h1')).toHaveText('Privacy');
  await expect(dialog.locator('h2')).toHaveText('What this demo fetches');
});
