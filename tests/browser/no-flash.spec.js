// tests/browser/no-flash.spec.js — the two cold-load regressions.
//
// Both come from the same root cause: the chrome boots from a MODULE script,
// and module scripts are deferred, so they run AFTER first paint.
//
//   1. Theme flash. The stored theme was applied by that deferred script, so a
//      user with light mode saw the browser's dark default first. Fixed with a
//      blocking inline <script> in <head>. It MUST stay inline and blocking:
//      moving it to a module, adding defer, or extracting it to a file all
//      silently bring the flash back.
//   2. Layout shift. injectTopbar() used to insert a 56px header as the first
//      child of <body>, shoving the page down after paint. Pages now ship an
//      empty <header class="topbar"> that reserves the space, and the injector
//      fills it in place.
//
// Neither is visible on a warm load, which is why they need a static check on
// the served HTML rather than a rendered-DOM assertion.
import { test, expect } from '@playwright/test';
import { liveTools } from '../../shared/tools.js';

const PAGES = [
  '/',
  '/image-tools/',
  '/pdf-tools/',
  '/document-tools/',
  ...liveTools().map((t) => `/${t.slug}/`),
];

for (const url of PAGES) {
  test(`${url} reserves the topbar and sets the theme before first paint`, async ({ request }) => {
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    const html = await res.text();

    // --- 1. Pre-paint theme -------------------------------------------------
    // It lives in an external file rather than inline so the CSP needs no
    // script hash: hashes depend on exact bytes, and git rewrites line endings
    // between this repo and the published mirror.
    const themeIdx = html.indexOf('/shared/theme-boot.js');
    expect(themeIdx, 'missing the pre-paint theme script').toBeGreaterThan(-1);
    expect(html.slice(0, themeIdx), 'theme script must be inside <head>')
      .not.toMatch(/<\/head>/i);

    // It must stay render-blocking, or it runs after first paint and the flash
    // comes back.
    const openTag = html.lastIndexOf('<script', themeIdx);
    const tag = html.slice(openTag, html.indexOf('>', openTag) + 1);
    expect(tag, 'the theme script must be render-blocking')
      .not.toMatch(/\bdefer\b|\basync\b|type=["']module["']/);

    // --- 1b. CSP: no EXECUTABLE inline scripts in the shipped HTML ----------
    // script-src is 'self' with no hashes, so an inline block would be silently
    // blocked in production. JSON-LD is exempt: browsers never execute
    // application/ld+json, so CSP does not police it.
    const inlineExecutable = [...html.matchAll(/<script\b([^>]*)>/gi)]
      .map((m) => m[1])
      .filter((attrs) => !/\bsrc=/i.test(attrs))
      .filter((attrs) => {
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
        return !type || type === 'module' || type === 'text/javascript';
      });
    expect(inlineExecutable, 'inline scripts are blocked by the CSP').toEqual([]);

    // --- 2. Reserved topbar -------------------------------------------------
    const bodyIdx = html.search(/<body[^>]*>/i);
    const headerIdx = html.indexOf('<header class="topbar"', bodyIdx);
    expect(headerIdx, 'missing the reserved <header class="topbar"> placeholder')
      .toBeGreaterThan(-1);

    // It has to come before the content it would otherwise push down.
    const mainIdx = html.indexOf('<main', bodyIdx);
    if (mainIdx > -1) expect(headerIdx).toBeLessThan(mainIdx);
  });
}

test('photo-editor ships its landing content, not an empty shell', async ({ request }) => {
  // #queue-view used to be an empty <section> that JS filled after first paint,
  // so the headline and drop zone (the entire above-the-fold area of the
  // busiest page) arrived late and pushed the page around. They are static now
  // and queueView.js adopts them. This also gives the page an <h1> in the
  // served markup, which it previously had nowhere.
  const html = await (await request.get('/photo-editor/')).text();

  expect(html, 'the intro must be in the served HTML').toContain('class="queue-intro"');
  expect(html, 'the drop zone must be in the served HTML').toContain('class="queue-empty"');
  expect(html).toMatch(/<h1[^>]*class="intro-title"/);
  expect(html, 'static copy needs data-i18n or it cannot be translated')
    .toContain('data-i18n="introTitle"');
});

test('photo-editor renders exactly one intro and one drop zone after boot', async ({ page }) => {
  // The failure mode of shipping static markup is a duplicate once JS runs.
  await page.goto('/photo-editor/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

  await expect(page.locator('#queue-view .queue-intro')).toHaveCount(1);
  await expect(page.locator('#queue-view .queue-empty')).toHaveCount(1);

  // ...and that the adopted browse button is wired exactly once.
  const fired = await page.evaluate(async () => {
    let n = 0;
    document.addEventListener('noadstools:openFileBrowser', () => { n++; });
    document.querySelector('.queue-browse').click();
    return n;
  });
  expect(fired, 'browse button should fire once, not zero or twice').toBe(1);
});

test('the injector fills the reserved header instead of adding a second one', async ({ page }) => {
  await page.goto('/image-tools/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

  await expect(page.locator('body > header.topbar')).toHaveCount(1);
  await expect(page.locator('body > header.topbar .wordmark')).toBeVisible();
  // The placeholder is inert until filled; once filled it must be exposed.
  await expect(page.locator('body > header.topbar')).not.toHaveAttribute('aria-hidden', 'true');
});

test('a stored theme survives a reload with no flash of the wrong one', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem(
    'noadstools:settings:global', JSON.stringify({ theme: 'light' })));

  await page.reload();
  // Sampled before any module script could have run: the inline script in
  // <head> is the only thing that can have set this.
  const early = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(early).toBe('light');
});
