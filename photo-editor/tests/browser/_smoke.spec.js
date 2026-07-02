import { test, expect } from '@playwright/test';
test('home page loads', async ({ page }) => {
  await page.goto('/photo-editor/');
  await expect(page).toHaveTitle(/NoAds/);
});
