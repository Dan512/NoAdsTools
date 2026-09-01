// tests/browser/tally.spec.js — the anonymous page-view counter, end to end.
//
// Three things can go wrong here and none of them are visible by looking at
// the site:
//   1. A page ships without the script and quietly stops being counted.
//   2. The beacon fires somewhere it should not — a local checkout, a preview
//      deploy, a fork — and poisons the numbers with traffic that is not real.
//   3. The payload changes and /privacy keeps describing the old one, which
//      turns the most load-bearing page on the site into a false statement.
// The last test is the drift guard for (3): it reads the fields the module
// actually sends and requires the privacy page to name every one.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveTools } from '../../shared/tools.js';
import { planBeacon, KEYS, TALLY_URL, SITE } from '../../shared/tally.js';

const COUNTED = ['/', '/privacy', '/404.html',
  '/image-tools/', '/pdf-tools/', '/document-tools/',
  ...liveTools().map((t) => `/${t.slug}/`)];

test('every page a visitor can land on loads the counter', async ({ request }) => {
  const missing = [];
  for (const url of COUNTED) {
    const res = await request.get(url);
    expect(res.status(), `${url} should be served`).toBe(200);
    if (!(await res.text()).includes('/shared/tally.js')) missing.push(url);
  }
  expect(missing, 'these pages would never be counted').toEqual([]);
});

test('the retired redirect stub is deliberately not counted', async ({ request }) => {
  // It exists only to bounce an indexed URL to /privacy. Counting it would
  // record a page nobody reads as one of the site's busiest.
  const html = await (await request.get('/photo-editor/privacy.html')).text();
  expect(html).not.toContain('/shared/tally.js');
});

test('nothing is sent from a host that is not the live site', async ({ page }) => {
  // The suite runs on localhost, so this asserts the host guard on every page
  // load a developer or a fork ever does.
  const beacons = [];
  page.on('request', (r) => {
    if (r.url().includes(new URL(TALLY_URL).hostname)) beacons.push(r.url());
  });
  await page.goto('/merge-pdf/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.goto('/');
  await page.waitForTimeout(500);
  expect(beacons, 'a local checkout must never count itself').toEqual([]);
});

test('on the live host it sends the documented payload, once per half hour', async ({ page }) => {
  await page.goto('/merge-pdf/');

  // The module is imported under the page's real CSP, then driven with a
  // stand-in window so the host guard can be exercised without a live domain.
  // sendBeacon is stubbed: this asserts the message, not the network.
  const out = await page.evaluate(async ([site]) => {
    const m = await import('/shared/tally.js');
    let sent = null;
    const win = {
      location: { hostname: site, pathname: '/merge-pdf/' },
      document: { referrer: 'https://www.google.com/search?q=merge+pdf+without+uploading' },
      localStorage: window.localStorage,
      matchMedia: window.matchMedia.bind(window),
      navigator: { sendBeacon: (url, body) => { sent = { url, body }; return true; } },
    };
    const first = m.sendTally(win);
    const second = m.sendTally(win); // same page, seconds later
    return { first, second, sent, stored: Object.keys(window.localStorage) };
  }, [SITE]);

  expect(out.first, 'the first load counts').toBe(true);
  expect(out.second, 'a reload inside the window does not').toBe(false);
  expect(out.sent.url).toBe(TALLY_URL);
  expect(JSON.parse(out.sent.body)).toEqual({
    site: SITE,
    path: '/merge-pdf/',
    ref: 'www.google.com', // the domain only: never the words searched for
    pwa: false,
    unique: true,
  });
  // The tool's own settings keys share the origin, so this checks presence,
  // not the whole list.
  expect(out.stored, 'the dampening record').toContain(KEYS.recent);
  expect(out.stored, "the local day behind \"unique\"").toContain(KEYS.day);
});

test('/privacy describes exactly what the counter sends', async ({ page }) => {
  // The rule this enforces: change the payload and you change this page in the
  // same commit. A counter documented as something it no longer is would be
  // worse than no disclosure at all.
  await page.goto('/privacy');
  const text = await page.locator('article.prose').innerText();

  const plan = planBeacon({
    hostname: SITE, path: '/', now: 0, today: '2026-01-01', referrer: '',
    pwa: false, skip: false, storageOk: true, recentRaw: null, lastDay: null,
  });

  for (const field of Object.keys(plan.payload)) {
    expect(text, `the privacy page must print the "${field}" field`).toContain(`"${field}"`);
  }
  for (const key of Object.values(KEYS)) {
    expect(text, `the privacy page must name the ${key} storage key`).toContain(key);
  }
  expect(text, 'the endpoint a reader will see in DevTools must be named')
    .toContain(new URL(TALLY_URL).hostname);

  // The opt-out has to be a control on this page, not an instruction to go
  // and edit storage by hand in a developer console.
  await expect(page.locator('#tally-optout-input')).toBeVisible();
});

test('the counter section is where the tool pages point', async ({ page }) => {
  await page.goto('/privacy#visit-counter');
  await expect(page.locator('#visit-counter')).toHaveCount(1);

  for (const slug of ['resume-builder', 'cover-letter-generator', 'qr-code-generator',
    'color-palette-from-image']) {
    await page.goto(`/${slug}/`);
    expect(await page.locator('a[href="/privacy#visit-counter"]').count(),
      `${slug} should link to the counter disclosure`).toBeGreaterThan(0);
  }
});

// --- the opt-out control ---------------------------------------------------

test('the opt-out checkbox turns counting off and on, and survives a reload', async ({ page }) => {
  await page.goto('/privacy');
  const box = page.locator('#tally-optout-input');
  const status = page.locator('#tally-optout-status');

  await expect(box, 'the control is revealed once its script runs').toBeVisible();
  await expect(box).toBeChecked();
  await expect(status).toContainText('on');

  await box.uncheck();
  await expect(status).toContainText('off');
  expect(await page.evaluate((k) => localStorage.getItem(k), KEYS.skip)).toBe('1');

  await page.reload();
  await expect(page.locator('#tally-optout-input'), 'the choice is remembered')
    .not.toBeChecked();

  await page.locator('#tally-optout-input').check();
  expect(await page.evaluate((k) => localStorage.getItem(k), KEYS.skip),
    'opting back in removes the flag rather than storing a falsey value').toBeNull();
});

test('opting out silences the beacon and clears what the counter stored', async ({ page }) => {
  await page.goto('/privacy');

  // Seed the two keys the counter would have written, then opt out.
  await page.evaluate(([recent, day]) => {
    localStorage.setItem(recent, JSON.stringify({ '/': Date.now() }));
    localStorage.setItem(day, '2026-09-01');
  }, [KEYS.recent, KEYS.day]);
  await page.locator('#tally-optout-input').uncheck();

  const after = await page.evaluate(async ([site, keys]) => {
    const m = await import('/shared/tally.js');
    let sent = null;
    const fired = m.sendTally({
      location: { hostname: site, pathname: '/privacy' },
      document: { referrer: '' },
      localStorage: window.localStorage,
      matchMedia: window.matchMedia.bind(window),
      navigator: { sendBeacon: (url, body) => { sent = { url, body }; return true; } },
    });
    return { fired, sent, left: keys.map((k) => localStorage.getItem(k)) };
  }, [SITE, [KEYS.recent, KEYS.day]]);

  expect(after.fired, 'an opted-out browser sends nothing').toBe(false);
  expect(after.sent).toBeNull();
  expect(after.left, 'the dates it had stored are gone too').toEqual([null, null]);
});

test('the control is honest when the browser blocks storage', async ({ browser }) => {
  // Safari in private mode and storage-blocked contexts throw on getItem. The
  // control must say "cannot be saved", which is not the same as "off".
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage disabled'); },
    });
  });
  const page = await context.newPage();
  await page.goto('/privacy');

  await expect(page.locator('#tally-optout-input')).toBeDisabled();
  await expect(page.locator('#tally-optout-status')).toContainText('blocking site storage');
  await expect(page.locator('#tally-optout')).toHaveClass(/is-unavailable/);
  await context.close();
});

test('the control is reachable by keyboard and clean under axe', async ({ page }) => {
  // It is the first interactive control on /privacy, so this is also the
  // page's first accessibility check.
  await page.goto('/privacy');
  const box = page.locator('#tally-optout-input');

  await box.focus();
  await expect(box).toBeFocused();
  await page.keyboard.press('Space');
  await expect(box).not.toBeChecked();
  await expect(page.locator('#tally-optout-status')).toContainText('off');

  const results = await new AxeBuilder({ page }).analyze();
  const blockers = results.violations.filter((v) => ['critical', 'serious'].includes(v.impact || ''));
  expect(blockers.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test('with JavaScript off, no checkbox is shown and nothing is counted', async ({ browser }) => {
  // The counter IS JavaScript, so a reader with it disabled is already not
  // being counted. Showing them a checkbox that could not save anything would
  // be worse than showing none.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/privacy');

  await expect(page.locator('#tally-optout')).toBeHidden();
  // With scripting off the parser builds real elements inside <noscript>, so
  // this selector resolving at all is the proof that the fallback is showing.
  await expect(page.locator('noscript p.optout')).toBeVisible();
  await expect(page.locator('noscript p.optout'))
    .toContainText('nothing here is being counted at all');
  await context.close();
});
