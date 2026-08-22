// tests/browser/category-pages.spec.js — the category landing pages.
//
// These pages list their tools as hand-written static <a> links, on purpose:
// crawlable markup is the entire reason they exist, and hand-written blurbs
// read better than the manifest's. The cost of hand-writing is drift, so this
// file is the guard — each page's links must match liveTools() exactly.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveTools, CATEGORIES } from '../../shared/tools.js';

// Category id -> the page that covers it. Categories deliberately WITHOUT a
// page: 'generator' (1 live tool, so the page would duplicate the tool) and
// 'dev' (0 live tools). The last test below flags when that stops being true.
const PAGES = {
  image: '/image-tools/',
  pdf: '/pdf-tools/',
  documents: '/document-tools/',
};

for (const [category, url] of Object.entries(PAGES)) {
  test(`${url} lists exactly the live ${category} tools`, async ({ page }) => {
    await page.goto(url);

    const linked = await page.locator('.tool-list a').evaluateAll(
      (as) => as.map((a) => a.getAttribute('href')),
    );
    const expected = liveTools()
      .filter((t) => t.category === category)
      .map((t) => `/${t.slug}/`);

    expect(linked.slice().sort()).toEqual(expected.slice().sort());
  });

  test(`${url} has sound SEO head and one h1`, async ({ page }) => {
    await page.goto(url);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]'))
      .toHaveAttribute('href', `https://noadstools.com${url}`);

    // These pages carry two JSON-LD blocks now (CollectionPage + BreadcrumbList),
    // so pick the one under test rather than assuming there is only one.
    const blocks = await page.locator('script[type="application/ld+json"]')
      .evaluateAll((els) => els.map((e) => JSON.parse(e.textContent)));
    const ld = blocks.find((b) => b['@type'] === 'CollectionPage');
    expect(ld, 'CollectionPage JSON-LD missing').toBeTruthy();
    // The structured data must not disagree with the visible links.
    const ldUrls = ld.mainEntity.itemListElement.map((i) => new URL(i.url).pathname);
    const expected = liveTools()
      .filter((t) => t.category === category)
      .map((t) => `/${t.slug}/`);
    expect(ldUrls.slice().sort()).toEqual(expected.slice().sort());
  });

  test(`${url} states a tool count that matches reality`, async ({ page }) => {
    // The intro says "Ten tools…" / "Seven tools…". Hand-written prose does not
    // update itself, so a new tool would turn that sentence into a lie.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
      'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
      'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
    const n = liveTools().filter((t) => t.category === category).length;

    await page.goto(url);
    const lead = (await page.locator('.lead').innerText()).toLowerCase();
    expect(lead, `lead should say "${WORDS[n]}" (${n} live ${category} tools)`)
      .toContain(WORDS[n]);
  });

  test(`${url} links back to the homepage and its sibling categories`, async ({ page }) => {
    await page.goto(url);
    await expect(page.locator('.crumbs a[href="/"]')).toBeVisible();
    for (const sibling of Object.values(PAGES).filter((u) => u !== url)) {
      await expect(page.locator(`.sibling-cats a[href="${sibling}"]`)).toHaveCount(1);
    }
  });
}

test('the homepage links to every category page (crawlable, not just pills)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  for (const url of Object.values(PAGES)) {
    await expect(page.locator(`.home-categories a[href="${url}"]`)).toBeVisible();
  }
});

test('every homepage filter pill matches at least one real tool card', async ({ page }) => {
  // The "Developer" pill shipped with zero dev-category tools, so clicking it
  // emptied the grid. Guard against a filter that can only ever show nothing.
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

  const filters = await page.locator('.category-pills .pill').evaluateAll(
    (els) => els.map((e) => e.dataset.filter).filter((f) => f !== 'all'),
  );
  const liveCategories = new Set(liveTools().map((t) => t.category));
  for (const f of filters) {
    expect(liveCategories.has(f), `pill "${f}" filters to zero tools`).toBe(true);
  }
});

test('any category big enough to deserve a page has one', async ({ page }) => {
  // Threshold call, not a law: a 1-tool category page duplicates the tool it
  // links to. When a second tool lands in such a category, build the page.
  const counts = new Map();
  for (const t of liveTools()) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);

  const missing = CATEGORIES
    .filter((c) => (counts.get(c.id) ?? 0) >= 2 && !PAGES[c.id])
    .map((c) => `${c.id} (${counts.get(c.id)} tools)`);

  expect(missing, `these categories now warrant a landing page: ${missing.join(', ')}`)
    .toEqual([]);
});

// The Tools dropdown is grouped by category. Grouping inside role="menu" is
// the part that can go wrong: role="menu" permits only certain children, so a
// heading element or a stray wrapper would be an aria-required-children
// violation. This opens the menu and runs axe against it.
test('the grouped Tools menu is accessible with the dropdown open', async ({ page }) => {
  await page.goto('/merge-pdf/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

  await page.locator('#tools-menu-toggle').click();
  await expect(page.locator('#tools-menu-list')).toBeVisible();

  const headings = await page.locator('#tools-menu-list .tools-menu-heading').allTextContents();
  expect(headings).toEqual(['Image tools', 'PDF tools', 'Document tools', 'Other tools']);

  // Every live tool is reachable from the menu, exactly once.
  // :not(.tools-menu-all) — the trailing "All tools" link shares the item class.
  const hrefs = await page.locator('#tools-menu-list .tools-menu-item:not(.tools-menu-all)')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(hrefs.slice().sort()).toEqual(liveTools().map((t) => `/${t.slug}/`).sort());

  // AxeBuilder, not addScriptTag: the CSP blocks injected inline scripts, which
  // is itself a nice confirmation the policy is live in the test run.
  const results = await new AxeBuilder({ page })
    .include('#tools-menu-list')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const blockers = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`);
  expect(blockers).toEqual([]);
});
