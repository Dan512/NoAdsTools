// resume-builder/tests/browser/resume-builder.spec.js — the tool end-to-end.
// No vendored libs, no network beyond same-origin page assets — asserted.
//
// Test 13 is the regression test for the print-scaling bug found in review:
// page.pdf() (print media, NO emulateMedia call — emulating 'screen' would
// force screen CSS and invalidate the test) must yield ONE page with the
// resume text at the top-left at full size. A shrink-to-fit regression
// (screen grid leaking into print) shows up as font size ~15pt instead of
// the 22pt name; page-chrome leaking into the text layer shows up as
// 'Download PDF' / 'NoAdsTools' strings in the extracted text.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function boot(page) {
  await page.goto('/resume-builder/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

async function typeName(page, name) {
  await page.fill('#f-fullName', name);
}

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter(v => FAIL.has(v.impact || ''));
}

test('SEO head + single h1 + JSON-LD', async ({ page }) => {
  await page.goto('/resume-builder/');
  await expect(page).toHaveTitle('Resume Builder Online — Free, No Sign-Up · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://noadstools.com/resume-builder/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  expect(ld).toContain('"price": "0"');
  expect(ld).toContain('agpl-3.0');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('1. typing updates the live preview', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await page.fill('#f-email', 'ada@example.com');
  await expect(page.locator('#paper h1')).toHaveText('Ada Lovelace');
  await expect(page.locator('#paper .contact')).toContainText('ada@example.com');
});

test('2. autosave: reload restores the draft; indicator is text not hue', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await expect(page.locator('#save-state')).toContainText('Saved ·', { timeout: 3000 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1');
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');
  await expect(page.locator('#paper h1')).toHaveText('Ada Lovelace');
});

test('3. export → import round-trip preserves content', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  const dl = page.waitForEvent('download');
  await page.click('#export');
  const download = await dl;
  const path = await download.path();
  const fs = await import('node:fs');
  const text = fs.readFileSync(path, 'utf8');

  // wipe, then import the file back through the real input
  await page.click('#clear-data');
  await page.click('#clear-data'); // two-step confirm
  await expect(page.locator('#f-fullName')).toHaveValue('');
  await page.setInputFiles('#import-input', {
    name: 'ada.resume.json', mimeType: 'application/json', buffer: Buffer.from(text),
  });
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');
  await expect(page.locator('#paper h1')).toHaveText('Ada Lovelace');
});

test('4. invalid import shows errors and leaves the current resume untouched', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Keep Me');
  await page.setInputFiles('#import-input', {
    name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"foo":1}'),
  });
  await expect(page.locator('#import-errors')).toBeVisible();
  await expect(page.locator('#f-fullName')).toHaveValue('Keep Me');
});

test('5. Clear my data (two-step) empties noadstools:resume:* storage', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada');
  await expect(page.locator('#save-state')).toContainText('Saved ·');
  await page.click('#clear-data');
  await expect(page.locator('#clear-data')).toContainText('confirm');
  await page.click('#clear-data');
  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => k.startsWith('noadstools:resume:')));
  expect(keys).toEqual([]);
  await expect(page.locator('#f-fullName')).toHaveValue('');
});

test('6. print media: chrome hidden, paper at true size, unscaled', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await page.emulateMedia({ media: 'print' });
  const topbarHidden = await page.evaluate(() => {
    const el = document.querySelector('#topbar-root');
    return !el || getComputedStyle(el).visibility === 'hidden';
  });
  expect(topbarHidden).toBe(true);
  const paperState = await page.evaluate(() => {
    const p = document.getElementById('paper');
    const cs = getComputedStyle(p);
    return { visibility: cs.visibility, transform: cs.transform, width: p.offsetWidth };
  });
  expect(paperState.visibility).toBe('visible');
  expect(paperState.transform).toBe('none');
  expect(Math.abs(paperState.width - 8.5 * 96)).toBeLessThan(2); // 816px letter
  await page.emulateMedia({ media: 'screen' });
});

test('7. A4 toggle changes the paper geometry', async ({ page }) => {
  await boot(page);
  await page.click('#tool .seg-btn[data-paper="a4"]');
  // Under 900px the panes collapse to one column and the edit view sets
  // `.rb-preview { display: none }` — #paper would then measure 0 and this test
  // would assert nothing on the mobile projects. Switch to the Preview view
  // when the view toggle is showing, so the geometry measured is always real.
  const previewBtn = page.locator('#tool .seg-btn[data-view="preview"]');
  if (await previewBtn.isVisible()) await previewBtn.click();
  await expect(page.locator('#paper')).toBeVisible();
  const w = await page.evaluate(() => document.getElementById('paper').offsetWidth);
  expect(Math.abs(w - 210 * 96 / 25.4)).toBeLessThan(2); // ≈794px
  const pageRule = await page.evaluate(() => document.getElementById('page-size-style').textContent);
  expect(pageRule).toContain('A4');
});

test('8. XSS-crafted content is inert in the preview', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  await typeName(page, '<img src=x onerror=alert(1)>');
  await expect(page.locator('#paper h1')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#paper img')).toHaveCount(0);
  expect(dialogFired).toBe(false);
});

test('9. zero vendor/third-party requests — the shortest network story on the site', async ({ page }) => {
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await boot(page);
  await typeName(page, 'Ada');
  await page.waitForTimeout(600); // let autosave fire (it must not fetch)
  expect(requests.filter(u => u.includes('/vendor/'))).toEqual([]);
  expect(requests.filter(u => !u.startsWith('http://localhost:4173'))).toEqual([]);
});

test('10. a11y: no serious/critical axe violations empty, filled, and across the view toggle', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const empty = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(empty)).toEqual([]);
  await typeName(page, 'Ada Lovelace');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.click('#tool .seg-btn[data-view="preview"]');
  const mobile = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(mobile)).toEqual([]);
});

test('11. 375px: no horizontal overflow with a filled resume', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace With A Rather Long Name Indeed');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.click('#tool .seg-btn[data-view="preview"]');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('12. keyboard: tab reaches the primary actions', async ({ page }, testInfo) => {
  await boot(page);

  // Walk focus from #f-fullName with `key` and report how the walk ended:
  //   reached — #download took focus (what we are proving);
  //   cycled  — focus returned to #f-fullName without ever passing #download;
  //   stalled — the SAME element kept focus across three presses, i.e. the
  //             engine refuses to move focus any further (see below);
  //   budget  — ran out of presses.
  // Element identity, not id, drives the stall check: most stops on this page
  // have no id, so comparing ids would read a run of them as a stall.
  async function walk(key, budget) {
    await page.focus('#f-fullName');
    await page.evaluate(() => { window.__rbLastActive = document.activeElement; });
    const trail = [];
    let repeats = 0;
    for (let i = 0; i < budget; i++) {
      await page.keyboard.press(key);
      const step = await page.evaluate(() => {
        const a = document.activeElement;
        const same = a === window.__rbLastActive;
        window.__rbLastActive = a;
        return { id: (a && a.id) || '<no-id>', same };
      });
      trail.push(step.id);
      if (step.id === 'download') return { end: 'reached', trail };
      if (step.id === 'f-fullName') return { end: 'cycled', trail };
      repeats = step.same ? repeats + 1 : 0;
      if (repeats >= 3) return { end: 'stalled', trail };
    }
    return { end: 'budget', trail };
  }

  // #download lives in .rb-actions, ABOVE the form in the DOM (focusable #7 of
  // 56 on desktop; #f-fullName is #11), so from a form field the short keyboard
  // route to it is backwards — four stops. This must hold in every engine.
  const back = await walk('Shift+Tab', 30);
  expect(back.end,
    `Shift+Tab from #f-fullName never reached #download (${back.end}); trail: ${back.trail.join(' → ')}`
  ).toBe('reached');

  // Forwards the only route is the long way round: the rest of the form, the
  // prose links, the footer (mobile only — `body > footer` is display:none
  // above 768px, where the topbar carries those links instead), then a wrap
  // back to the top of the document. Chromium and WebKit perform that wrap;
  // headless Firefox parks focus on the document's last focusable element and
  // never wraps, because there is no browser chrome to hand off to and come
  // back from. That is an engine limitation, not a page one — the page's focus
  // order is byte-identical across engines — so it is recorded, not ignored.
  const fwd = await walk('Tab', 200);
  if (fwd.end === 'stalled') {
    testInfo.annotations.push({
      type: 'engine-limitation',
      description: `${testInfo.project.name}: Tab does not wrap past the last focusable element, so the forward route to #download cannot be exercised here; the backwards route above verifies reachability.`,
    });
  } else {
    expect(fwd.end,
      `Tab from #f-fullName never reached #download (${fwd.end}, ${fwd.trail.length} presses); last stops: ${fwd.trail.slice(-15).join(' → ')}`
    ).toBe('reached');
  }
});

test('13. printed PDF: 1 page, text at top-left, full size (chromium)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'page.pdf is chromium-only');
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await page.fill('#f-email', 'ada@example.com');
  // First text input of the first (Experience) entry = "Job title".
  await page.locator('#form-sections details.entry input[type="text"]').first()
    .fill('Analytical Engine Programmer');
  await expect(page.locator('#save-state')).toContainText('Saved ·', { timeout: 3000 });

  // NO emulateMedia before page.pdf — page.pdf renders with print media by
  // default; emulating 'screen' would force screen CSS and invalidate the test.
  const pdf = await page.pdf({ preferCSSPageSize: true });

  // The review bug: screen grid/sticky leaking into print produced a
  // shrunk-to-fit multi-page PDF. One page, or the fix regressed.
  const doc = await PDFDocument.load(new Uint8Array(pdf));
  expect(doc.getPageCount()).toBe(1);

  // Extract the text layer with the site's own pdfjs loader, in-page.
  const info = await page.evaluate(async (bytes) => {
    const { openPdf } = await import('/shared/pdfjs-loader.js');
    const doc2 = await openPdf(new Uint8Array(bytes));
    const page1 = await doc2.getPage(1);
    const tc = await page1.getTextContent();
    const vp = page1.getViewport({ scale: 1 });
    const first = tc.items.find(i => i.str.trim());
    return {
      str: first.str,
      x: first.transform[4],
      yFromTop: vp.height - first.transform[5],
      size: Math.hypot(first.transform[0], first.transform[1]),
      pageW: vp.width,
      pageH: vp.height,
      all: tc.items.map(i => i.str).join(' '),
    };
  }, Array.from(pdf));

  const allText = info.all.replace(/\s+/g, ' ');
  expect(info.str.trim()).toMatch(/^Ada/);          // the name renders first…
  expect(allText).toContain('Ada Lovelace');        // …and in full
  expect(info.x).toBeLessThan(info.pageW * 0.25);   // top-LEFT, not offset mid-sheet
  expect(info.yFromTop).toBeLessThan(info.pageH * 0.25);
  expect(info.size).toBeGreaterThan(20);            // 22pt name — proves no shrink-to-fit
  expect(allText).toContain('Analytical Engine Programmer');
  expect(allText).not.toContain('Download PDF');    // page chrome must not leak
  expect(allText).not.toContain('NoAdsTools');
});

// --- Phase 2: reordering -----------------------------------------------------
// As-built DOM notes (the selectors below are pinned to these):
//   • the drag handle is <span class="drag-handle" aria-hidden="true"> — NOT a
//     button and with no tabindex (a nested interactive inside <summary> is an
//     axe `nested-interactive` serious violation);
//   • each entry's <summary> holds <span class="entry-title"> plus that handle;
//   • the move controls are <button class="move-btn"> carrying
//     data-focus-key="up|down:i:<itemId>" for entries and ":s:<sectionId>" for
//     sections — the same key the tool uses to restore focus after a re-render.

const firstCard = (page) => page.locator('#form-sections section.card').first();

// Fill the first section (Experience) with N distinguishable entries.
// Stride of 5: an Experience entry renders exactly five text inputs — Job
// title, Company, Location, Start, End. (The "I currently work here" checkbox
// and the bullets textarea are not input[type=text]; the section-title input
// lives in .sec-head, outside details.entry.) Index i*5 is therefore the Job
// title of entry i, which is what the preview's .entry-head shows.
async function seedEntries(page, titles) {
  const card = firstCard(page);
  for (let i = 1; i < titles.length; i++) {
    await card.getByRole('button', { name: 'Add entry' }).click();
    await expect(card.locator('details.entry')).toHaveCount(i + 1);
  }
  const inputs = card.locator('details.entry input[type="text"]');
  await expect(inputs).toHaveCount(titles.length * 5);
  for (let i = 0; i < titles.length; i++) await inputs.nth(i * 5).fill(titles[i]);
}

// Entry headings of the first rendered preview section. With only Experience
// filled, the blank Education/Skills sections render nothing and the empty
// summary emits no <section>, so .rsec:first IS Experience. Returned as a
// locator so assertions retry over the rAF-throttled preview re-render.
const previewHeads = (page) => page.locator('#paper .rsec').first().locator('.entry-head');

test('14. keyboard: the down button reorders an entry AND keeps focus (repeatable)', async ({ page }) => {
  await boot(page);
  await seedEntries(page, ['Alpha', 'Bravo', 'Charlie']);
  await expect(previewHeads(page)).toHaveText(['Alpha', 'Bravo', 'Charlie']);

  const firstDown = firstCard(page).locator('.move-btn[data-focus-key^="down:i:"]').first();
  await firstDown.focus();
  await page.keyboard.press('Enter');
  await expect(previewHeads(page)).toHaveText(['Bravo', 'Alpha', 'Charlie']);

  // Focus must survive the re-render, or a keyboard user can only move once.
  const stillFocused = await page.evaluate(() =>
    document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.focusKey || '' : '');
  expect(stillFocused).toMatch(/^down:i:/);

  await page.keyboard.press('Enter');          // second press with no re-tabbing
  await expect(previewHeads(page)).toHaveText(['Bravo', 'Charlie', 'Alpha']);
});

test('15. move buttons are disabled at the ends of the list', async ({ page }) => {
  await boot(page);
  await seedEntries(page, ['Alpha', 'Bravo']);
  const card = firstCard(page);
  const ups = card.locator('.move-btn[data-focus-key^="up:i:"]');
  const downs = card.locator('.move-btn[data-focus-key^="down:i:"]');
  await expect(ups).toHaveCount(2);
  await expect(ups.first()).toBeDisabled();    // nothing above the first entry
  await expect(ups.last()).toBeEnabled();
  await expect(downs.first()).toBeEnabled();
  await expect(downs.last()).toBeDisabled();   // nothing below the last entry
});

test('16. sections reorder and the preview order follows', async ({ page }) => {
  await boot(page);
  const headings = page.locator('#paper .rsec h2');
  const titles = () => headings.allTextContents();
  await firstCard(page).locator('details.entry input[type="text"]').first().fill('Alpha');
  await page.locator('#form-sections section.card').nth(1)
    .locator('details.entry input[type="text"]').first().fill('A degree');
  await expect(headings).toHaveCount(2);       // Experience, Education (Skills blank)
  const before = await titles();
  await page.locator('#form-sections .move-btn[data-focus-key^="down:s:"]').first().click();
  await expect(headings).toHaveText([before[1], before[0]]);
  const after = await titles();
  expect(after[0]).toBe(before[1]);
  expect(after[1]).toBe(before[0]);
});

test('17. pointer drag reorders an entry', async ({ page }) => {
  await boot(page);
  await seedEntries(page, ['Alpha', 'Bravo', 'Charlie']);
  const card = firstCard(page);
  // Collapse the entries first. Expanded, three Experience entries are taller
  // than a phone viewport, so the drop row's box would sit off-screen and the
  // synthesised pointer coordinates would be meaningless. Collapsed rows are
  // a real user state and keep the whole list on one screen everywhere.
  await card.evaluate((el) => el.querySelectorAll('details.entry').forEach(d => { d.open = false; }));
  const handle = card.locator('details.entry .drag-handle').first();
  const last = card.locator('details.entry').last();
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await last.boundingBox();
  const vh = page.viewportSize().height;
  expect(from.y, 'drag source must be on-screen').toBeGreaterThanOrEqual(0);
  expect(to.y + to.height, 'drop row must be on-screen').toBeLessThanOrEqual(vh);

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 4, { steps: 12 });
  await page.mouse.up();
  await expect(previewHeads(page)).toHaveText(['Bravo', 'Charlie', 'Alpha']);
});

test('18. a11y + 375px hold with reorder controls present', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedEntries(page, ['Alpha', 'Bravo']);
  const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(res)).toEqual([]);
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

// --- Phase 3: multiple resumes -----------------------------------------------
// As-built DOM notes (the selectors below are pinned to these):
//   • `#resume-switcher` is a <select>; one <option> per stored resume, value =
//     the resume id, textContent = its name (set with textContent, never HTML);
//   • `#resume-name` renames the CURRENT resume as you type;
//   • `#resume-new` / `#resume-duplicate` swap the loaded resume immediately;
//   • `#resume-delete` is two-step — the first click re-labels it to text
//     containing "again", the second click deletes;
//   • saveResume() UNSHIFTS the index, so the most recently saved resume is the
//     FIRST option. Never assume a fixed option order — ask which is selected.

const switcherOptions = (page) => page.locator('#resume-switcher option');

// The UI never shows resume ids, so tests find "the other resume" the way a
// person does: the one option that is not the selected one.
async function switcherState(page) {
  const ids = await switcherOptions(page).evaluateAll(os => os.map(o => o.value));
  const current = await page.inputValue('#resume-switcher');
  return { ids, current, other: ids.find(id => id !== current) };
}

test('19. New creates a second resume; the two are isolated', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await expect(page.locator('#save-state')).toContainText('Saved ·');
  await page.click('#resume-new');
  await expect(page.locator('#f-fullName')).toHaveValue('');      // fresh resume
  await expect(switcherOptions(page)).toHaveCount(2);

  await typeName(page, 'Grace Hopper');
  const { ids, current, other } = await switcherState(page);
  expect(other, `no second option to switch to; selected ${current} of [${ids}]`).toBeTruthy();
  await page.selectOption('#resume-switcher', other);
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');
});

test('20. Duplicate copies the content and the copy edits independently', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await page.fill('#resume-name', 'Backend role');
  await expect(page.locator('#save-state')).toContainText('Saved ·');

  await page.click('#resume-duplicate');
  await expect(page.locator('#resume-name')).toHaveValue('Backend role (copy)');
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');   // content copied

  await typeName(page, 'Ada L. (tailored)');
  // Back to the original — the option that is NOT the one now selected.
  const { ids, current, other } = await switcherState(page);
  expect(other, `no original left to switch back to; selected ${current} of [${ids}]`).toBeTruthy();
  await page.selectOption('#resume-switcher', other);
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');   // original untouched
  await expect(page.locator('#resume-name')).toHaveValue('Backend role');

  await page.selectOption('#resume-switcher', current);                    // …and back again
  await expect(page.locator('#f-fullName')).toHaveValue('Ada L. (tailored)');
  await expect(page.locator('#resume-name')).toHaveValue('Backend role (copy)');
});

test('21. switching flushes a pending edit instead of losing it', async ({ page }, testInfo) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await expect(page.locator('#save-state')).toContainText('Saved ·');
  await page.click('#resume-new');
  await expect(page.locator('#f-fullName')).toHaveValue('');
  const { ids, current, other } = await switcherState(page);
  expect(other, `no second option to switch to; selected ${current} of [${ids}]`).toBeTruthy();

  // Instrument the SECOND resume's storage key so this run can prove the race
  // window was real rather than assume it. The 'change' marker is a
  // capture-phase listener on `document`, which fires before the select's own
  // listener — so the flush write the tool does inside that listener always
  // lands AFTER the marker, while a debounced autosave would land before it.
  await page.evaluate((key) => {
    window.__rbLog = [];
    const mark = (kind, extra) =>
      window.__rbLog.push({ kind, at: Math.round(performance.now()), ...extra });
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === key) mark('write', { pending: String(v).includes('Grace Hopper') });
      return orig.call(this, k, v);
    };
    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'f-fullName') mark('edit');
    }, true);
    document.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'resume-switcher') mark('switch');
    }, true);
  }, `noadstools:resume:${current}`);

  // Type and switch IMMEDIATELY — inside the ~400 ms autosave debounce window.
  await page.fill('#f-fullName', 'Grace Hopper');
  await page.selectOption('#resume-switcher', other);
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');

  const log = await page.evaluate(() => window.__rbLog);
  const seen = JSON.stringify(log);
  const kinds = log.map(e => e.kind);
  // edit → switch → write, with NO write in between: the debounce never fired,
  // so the only thing that can have carried "Grace Hopper" to storage is the
  // flush inside the switch handler. (A write before 'switch' would mean this
  // run landed outside the debounce window and proved nothing.)
  expect(kinds.slice(0, 2),
    `expected the edit and the switch back-to-back with no autosave between; log: ${seen}`)
    .toEqual(['edit', 'switch']);
  const margin = log[1].at - log[0].at;
  testInfo.annotations.push({
    type: 'debounce-margin',
    description: `${margin}ms elapsed between the keystroke and the switch (autosave debounce is ~400ms).`,
  });
  expect(margin,
    `the switch landed ${margin}ms after the edit — outside the ~400ms debounce, so the race was not exercised`)
    .toBeLessThan(400);
  expect(log.slice(2).some(e => e.kind === 'write' && e.pending),
    `no post-switch write carried the pending edit; log: ${seen}`).toBe(true);

  await page.selectOption('#resume-switcher', current);
  await expect(page.locator('#f-fullName')).toHaveValue('Grace Hopper');   // not lost
});

test('22. Delete (two-step) removes the resume and loads another', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await page.click('#resume-new');
  await typeName(page, 'Grace Hopper');
  await expect(switcherOptions(page)).toHaveCount(2);

  await page.click('#resume-delete');
  await expect(page.locator('#resume-delete')).toContainText('again');
  await page.click('#resume-delete');
  await expect(switcherOptions(page)).toHaveCount(1);
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');   // fell back
});

test('23. deleting the last resume leaves a usable blank one', async ({ page }) => {
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await expect(page.locator('#save-state')).toContainText('Saved ·');
  await page.click('#resume-delete');
  await page.click('#resume-delete');
  await expect(page.locator('#f-fullName')).toHaveValue('');
  await expect(switcherOptions(page)).toHaveCount(1);
  await typeName(page, 'Still works');                    // tool remains usable
  await expect(page.locator('#paper h1')).toHaveText('Still works');
});

test('24. a resume name containing markup stays inert in the switcher', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  await page.fill('#resume-name', '<img src=x onerror=alert(1)>');
  await expect(switcherOptions(page).first())
    .toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#resume-switcher img')).toHaveCount(0);
  expect(dialogFired).toBe(false);
});

test('26. a primed Delete does not carry across a resume switch', async ({ page }) => {
  // Arming Delete on resume A and then switching must NOT leave the button
  // primed: a single click on B would otherwise destroy B with no confirm of
  // its own. Every destructive action confirms for what it actually destroys.
  await boot(page);
  await typeName(page, 'Ada Lovelace');
  await page.click('#resume-new');
  await typeName(page, 'Grace Hopper');
  await expect(switcherOptions(page)).toHaveCount(2);

  await page.click('#resume-delete');                       // arm on the NEW resume
  await expect(page.locator('#resume-delete')).toContainText('again');

  const { other } = await switcherState(page);
  await page.selectOption('#resume-switcher', other);        // switch away
  await expect(page.locator('#resume-delete')).toHaveText('Delete');   // disarmed
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');

  await page.click('#resume-delete');                        // first click re-arms only
  await expect(switcherOptions(page)).toHaveCount(2);         // nothing deleted yet
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');
});

test('25. a11y + 375px hold with the switcher present', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await typeName(page, 'Ada Lovelace');
  await page.click('#resume-duplicate');
  const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(res)).toEqual([]);
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
