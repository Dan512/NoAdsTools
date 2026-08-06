// cover-letter-generator/tests/browser/cover-letter-generator.spec.js — the tool
// end-to-end. No vendored libs, no network beyond same-origin page assets —
// asserted (test 10). Modelled on resume-builder's spec; the two tools share
// /shared/paper-doc.css, /shared/paper-print.js and /shared/doc-storage.js, so
// the print/geometry and storage assertions deliberately mirror each other.
//
// Test 8 is the printed-PDF geometry test: page.pdf() renders with PRINT media
// by default and there is NO emulateMedia call — emulating 'screen' would force
// screen CSS and invalidate the test. A shrink-to-fit regression (the screen
// grid/sticky leaking into print) shows up as a multi-page PDF and a shrunken
// name; page chrome leaking into the text layer shows up as 'Download PDF' /
// 'NoAdsTools' strings in the extracted text.
//
// As-built DOM notes (the selectors below are pinned to these):
//   • sender ids `#f-fullName #f-email #f-phone #f-location`; recipient ids
//     `#f-rname #f-rtitle #f-rcompany #f-raddress`; letter ids
//     `#f-date #f-salutation #f-body #f-closing #f-signature`;
//   • `#use-resume-wrap` carries the `hidden` attribute when this browser has no
//     saved resume; `#use-resume` is the <select>, `#use-resume-apply` the
//     button, `#use-resume-note` the role=status line;
//   • the preview renders body paragraphs as `p.cl-para`, the contact line as
//     `p.cl-contact`, and `#f-date` is intentionally NOT prefilled — a fresh
//     letter therefore renders no `.cl-date` at all.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from '../../../vendor/pdf-lib/pdf-lib.esm.min.js';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function boot(page) {
  await page.goto('/cover-letter-generator/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

function axeBlockers(results) {
  const FAIL = new Set(['critical', 'serious']);
  return results.violations.filter(v => FAIL.has(v.impact || ''));
}

// Seed a REAL resume through the resume builder's own UI (same origin, same
// browser profile), so the "use my details" feature is exercised against data
// the other tool actually wrote rather than a hand-forged localStorage blob.
async function seedResume(page, { fullName, email }) {
  await page.goto('/resume-builder/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.fill('#f-fullName', fullName);
  await page.fill('#f-email', email);
  await expect(page.locator('#save-state')).toContainText('Saved ·', { timeout: 3000 });
}

const keysWithPrefix = (page, prefix) =>
  page.evaluate(p => Object.keys(localStorage).filter(k => k.startsWith(p)).sort(), prefix);

test('1. SEO head: title, canonical, JSON-LD, single h1', async ({ page }) => {
  await page.goto('/cover-letter-generator/');
  await expect(page).toHaveTitle('Cover Letter Generator — Free, No Sign-Up, No Upload · NoAdsTools');
  await expect(page.locator('link[rel="canonical"]'))
    .toHaveAttribute('href', 'https://noadstools.com/cover-letter-generator/');
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(ld).toContain('"SoftwareApplication"');
  expect(ld).toContain('"price": "0"');
  expect(ld).toContain('agpl-3.0');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('2. typing sender, recipient and body updates the live preview', async ({ page }) => {
  await boot(page);
  await page.fill('#f-fullName', 'Ada Lovelace');
  await page.fill('#f-email', 'ada@example.com');
  await page.fill('#f-rname', 'Charles Babbage');
  await page.fill('#f-rcompany', 'Babbage & Co');
  await page.fill('#f-body', 'I am writing about the Analyst role.\n\nI wrote the first program.');

  await expect(page.locator('#paper h1')).toHaveText('Ada Lovelace');
  await expect(page.locator('#paper .cl-contact')).toContainText('ada@example.com');
  await expect(page.locator('#paper .cl-recipient')).toContainText('Charles Babbage');
  // The ampersand must survive escaping as a literal character, not '&amp;'.
  await expect(page.locator('#paper .cl-recipient')).toContainText('Babbage & Co');
  // A blank line is a paragraph break; a single newline is a soft wrap.
  await expect(page.locator('#paper p.cl-para')).toHaveCount(2);
  await expect(page.locator('#paper p.cl-para').first()).toHaveText('I am writing about the Analyst role.');

  await page.fill('#f-body', 'One\nparagraph\nonly');
  await expect(page.locator('#paper p.cl-para')).toHaveCount(1);
});

test('3. autosave: reload restores the draft; the indicator is text, not hue', async ({ page }) => {
  await boot(page);
  await page.fill('#f-fullName', 'Ada Lovelace');
  await page.fill('#f-body', 'I am writing about the Analyst role.');
  // Colourblind-safe: the save state is readable words, not a coloured dot.
  await expect(page.locator('#save-state')).toContainText('Saved ·', { timeout: 3000 });

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1');
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');
  await expect(page.locator('#f-body')).toHaveValue('I am writing about the Analyst role.');
  await expect(page.locator('#paper h1')).toHaveText('Ada Lovelace');
});

test('4. export → import round-trip preserves content', async ({ page }) => {
  await boot(page);
  await page.fill('#f-fullName', 'Ada Lovelace');
  await page.fill('#f-rcompany', 'Babbage & Co');
  await page.fill('#f-body', 'First paragraph.\n\nSecond paragraph.');
  await expect(page.locator('#paper p.cl-para')).toHaveCount(2);

  const dl = page.waitForEvent('download');
  await page.click('#export');
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.cover-letter\.json$/);
  const fs = await import('node:fs');
  const text = fs.readFileSync(await download.path(), 'utf8');

  // wipe, then import the file back through the real <input type=file>
  await page.click('#clear-data');
  await page.click('#clear-data');            // two-step confirm
  await expect(page.locator('#f-fullName')).toHaveValue('');
  await page.setInputFiles('#import-input', {
    name: 'ada.cover-letter.json', mimeType: 'application/json', buffer: Buffer.from(text),
  });
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');
  await expect(page.locator('#f-rcompany')).toHaveValue('Babbage & Co');
  await expect(page.locator('#f-body')).toHaveValue('First paragraph.\n\nSecond paragraph.');
  await expect(page.locator('#paper h1')).toHaveText('Ada Lovelace');
  await expect(page.locator('#paper p.cl-para')).toHaveCount(2);
});

test('5. invalid import shows errors and leaves the current letter untouched', async ({ page }) => {
  await boot(page);
  await page.fill('#f-fullName', 'Keep Me');
  await page.fill('#f-body', 'Keep this body too.');
  await page.setInputFiles('#import-input', {
    name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"foo":1}'),
  });
  await expect(page.locator('#import-errors')).toBeVisible();
  await expect(page.locator('#f-fullName')).toHaveValue('Keep Me');
  await expect(page.locator('#f-body')).toHaveValue('Keep this body too.');
  await expect(page.locator('#paper h1')).toHaveText('Keep Me');

  // Not-JSON-at-all takes the other error branch and is equally non-destructive.
  await page.setInputFiles('#import-input', {
    name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json'),
  });
  await expect(page.locator('#import-errors')).toBeVisible();
  await expect(page.locator('#f-fullName')).toHaveValue('Keep Me');
});

test('6. Clear my data (two-step) empties letters and LEAVES RESUMES ALONE', async ({ page }) => {
  // Cross-tool isolation: someone clearing their cover letters must not silently
  // lose the resume they built in the sibling tool. Both live in the same
  // localStorage; only the key prefix separates them.
  await seedResume(page, { fullName: 'Ada Lovelace', email: 'ada@example.com' });
  const resumeBefore = await keysWithPrefix(page, 'noadstools:resume:');
  expect(resumeBefore.length).toBeGreaterThan(0);

  await boot(page);
  await page.fill('#f-fullName', 'Ada');
  await expect(page.locator('#save-state')).toContainText('Saved ·', { timeout: 3000 });
  expect((await keysWithPrefix(page, 'noadstools:letter:')).length).toBeGreaterThan(0);

  await page.click('#clear-data');
  await expect(page.locator('#clear-data')).toContainText('confirm');
  await page.click('#clear-data');

  expect(await keysWithPrefix(page, 'noadstools:letter:')).toEqual([]);
  expect(await keysWithPrefix(page, 'noadstools:resume:')).toEqual(resumeBefore);
  await expect(page.locator('#f-fullName')).toHaveValue('');
  await expect(page.locator('#save-state')).toHaveText('Cleared');

  // …and the resume is still really loadable, not just key-shaped debris.
  await page.goto('/resume-builder/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1');
  await expect(page.locator('#f-fullName')).toHaveValue('Ada Lovelace');
});

test('7. "use my details": hidden with no resumes, copies the contact block with one', async ({ page }) => {
  // Fresh profile: no saved resume, so the control must not appear at all — a
  // dead dropdown would imply we found data we did not.
  await boot(page);
  await expect(page.locator('#use-resume-wrap')).toBeHidden();

  await seedResume(page, { fullName: 'Grace Hopper', email: 'grace@example.com' });
  await boot(page);
  await expect(page.locator('#use-resume-wrap')).toBeVisible();
  await expect(page.locator('#use-resume option')).toHaveCount(1);

  await page.click('#use-resume-apply');
  await expect(page.locator('#f-fullName')).toHaveValue('Grace Hopper');
  await expect(page.locator('#f-email')).toHaveValue('grace@example.com');
  await expect(page.locator('#paper h1')).toHaveText('Grace Hopper');
  await expect(page.locator('#paper .cl-contact')).toContainText('grace@example.com');
  await expect(page.locator('#use-resume-note')).toContainText('copied');

  // Read-only: copying must not have written to (or pruned) the resume's keys.
  await page.goto('/resume-builder/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1');
  await expect(page.locator('#f-fullName')).toHaveValue('Grace Hopper');
});

test('8. print media: chrome hidden, paper at true size, unscaled', async ({ page }) => {
  await boot(page);
  await page.fill('#f-fullName', 'Ada Lovelace');
  await page.fill('#f-body', 'I am writing about the Analyst role.');
  await page.emulateMedia({ media: 'print' });

  const topbarHidden = await page.evaluate(() => {
    const el = document.querySelector('#topbar-root');
    return !el || getComputedStyle(el).visibility === 'hidden';
  });
  expect(topbarHidden).toBe(true);
  const actionsHidden = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#tool .cl-actions')).display === 'none');
  expect(actionsHidden).toBe(true);

  const paperState = await page.evaluate(() => {
    const p = document.getElementById('paper');
    const cs = getComputedStyle(p);
    return { visibility: cs.visibility, transform: cs.transform, width: p.offsetWidth };
  });
  expect(paperState.visibility).toBe('visible');
  expect(paperState.transform).toBe('none');
  expect(Math.abs(paperState.width - 8.5 * 96)).toBeLessThan(2);   // 816px letter
  await page.emulateMedia({ media: 'screen' });
});

test('9. A4 toggle changes the paper geometry and the @page rule', async ({ page }) => {
  await boot(page);
  await page.click('#tool .seg-btn[data-paper="a4"]');
  // Under 900px the panes collapse to one column and the edit view sets
  // `.rb-preview { display: none }` — #paper would then measure 0 and this test
  // would assert nothing on the mobile projects. Switch to the Preview view
  // when the toggle is showing, so the geometry measured is always real.
  const previewBtn = page.locator('#tool .seg-btn[data-view="preview"]');
  if (await previewBtn.isVisible()) await previewBtn.click();
  await expect(page.locator('#paper')).toBeVisible();
  const w = await page.evaluate(() => document.getElementById('paper').offsetWidth);
  expect(Math.abs(w - 210 * 96 / 25.4)).toBeLessThan(2);           // ≈794px
  const pageRule = await page.evaluate(() => document.getElementById('page-size-style').textContent);
  expect(pageRule).toContain('A4');
});

test('10. XSS-crafted content is inert in the preview', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
  await boot(page);
  const payload = '<img src=x onerror=alert(1)>';
  await page.fill('#f-fullName', payload);
  await page.fill('#f-body', payload);
  await page.fill('#f-rcompany', payload);
  await expect(page.locator('#paper h1')).toHaveText(payload);
  await expect(page.locator('#paper p.cl-para').first()).toHaveText(payload);
  await expect(page.locator('#paper .cl-recipient')).toContainText(payload);
  await expect(page.locator('#paper img')).toHaveCount(0);
  expect(dialogFired).toBe(false);
});

test('11. zero vendor/third-party requests across a full editing session', async ({ page }) => {
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await boot(page);
  await page.fill('#f-fullName', 'Ada Lovelace');
  await page.fill('#f-rcompany', 'Babbage & Co');
  await page.fill('#f-body', 'First paragraph.\n\nSecond paragraph.');
  await page.click('#tool .seg-btn[data-paper="a4"]');
  await page.click('#tool .seg-btn[data-paper="letter"]');
  await page.waitForTimeout(600);                 // let autosave fire (it must not fetch)
  expect(requests.filter(u => u.includes('/vendor/'))).toEqual([]);
  expect(requests.filter(u => !u.startsWith('http://localhost:4173'))).toEqual([]);
});

test('12. a11y: no serious/critical axe violations empty, filled, and across the view toggle', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const empty = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(empty)).toEqual([]);

  await page.fill('#f-fullName', 'Ada Lovelace');
  await page.fill('#f-rname', 'Charles Babbage');
  await page.fill('#f-body', 'First paragraph.\n\nSecond paragraph.');
  const filled = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(filled)).toEqual([]);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.click('#tool .seg-btn[data-view="preview"]');
  const preview = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(preview)).toEqual([]);
  await page.click('#tool .seg-btn[data-view="edit"]');
  const edit = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeBlockers(edit)).toEqual([]);
});

test('13. 375px: no horizontal overflow with a filled letter', async ({ page }) => {
  await boot(page);
  await page.fill('#f-fullName', 'Ada Lovelace With A Rather Long Name Indeed');
  await page.fill('#f-raddress', '120 Analytical Way, Somewhere Rather Distant, OR 97000');
  await page.fill('#f-body',
    'A paragraph long enough to test wrapping inside the sheet at a narrow width.\n\nAnd a second one.');
  await page.setViewportSize({ width: 375, height: 800 });
  // Mobile hides the preview pane in the edit view, so the sheet must be shown
  // before its width can overflow anything — measure the state that can fail.
  await page.click('#tool .seg-btn[data-view="preview"]');
  await expect(page.locator('#paper')).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('14. keyboard: Shift+Tab from the first field reaches Download', async ({ page }) => {
  await boot(page);

  // #download lives in .cl-actions, ABOVE the form in the DOM, so from a form
  // field the short keyboard route to it is backwards. Forward Tab would have to
  // traverse the whole form, the prose links and the footer and then WRAP — and
  // headless Firefox never wraps (it parks focus on the last focusable element,
  // there being no browser chrome to hand off to). The backwards walk is the
  // engine-agnostic assertion; see the playbook §4 gotcha.
  //
  // Walk outcomes: reached — #download took focus; cycled — focus came back to
  // #f-fullName without passing it; stalled — the SAME element kept focus for
  // three presses; budget — ran out of presses. Element identity (not id) drives
  // the stall check, because most stops on this page have no id.
  async function walk(key, budget) {
    await page.focus('#f-fullName');
    await page.evaluate(() => { window.__clLastActive = document.activeElement; });
    const trail = [];
    let repeats = 0;
    for (let i = 0; i < budget; i++) {
      await page.keyboard.press(key);
      const step = await page.evaluate(() => {
        const a = document.activeElement;
        const same = a === window.__clLastActive;
        window.__clLastActive = a;
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

  const back = await walk('Shift+Tab', 30);
  expect(back.end,
    `Shift+Tab from #f-fullName never reached #download (${back.end}); trail: ${back.trail.join(' → ')}`
  ).toBe('reached');
});

test('15. printed PDF: 1 page, letter text at top-left, no chrome (chromium)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'page.pdf is chromium-only');
  await boot(page);
  await page.fill('#f-fullName', 'Ada Lovelace');
  await page.fill('#f-email', 'ada@example.com');
  await page.fill('#f-rname', 'Charles Babbage');
  await page.fill('#f-rcompany', 'Babbage and Co');
  await page.fill('#f-body', 'I am writing about the Analytical Engine Programmer role.\n\nI wrote the first program.');
  await expect(page.locator('#paper p.cl-para')).toHaveCount(2);
  await expect(page.locator('#save-state')).toContainText('Saved ·', { timeout: 3000 });

  // NO emulateMedia before page.pdf — page.pdf renders with print media by
  // default; emulating 'screen' would force screen CSS and invalidate the test.
  const pdf = await page.pdf({ preferCSSPageSize: true });

  // A short letter is one page. Screen grid/sticky leaking into print produces a
  // shrunk-to-fit, multi-page PDF instead.
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
  expect(info.str.trim()).toMatch(/^Ada/);            // the sender name renders first…
  expect(allText).toContain('Ada Lovelace');          // …and in full
  expect(info.x).toBeLessThan(info.pageW * 0.25);     // top-LEFT, not offset mid-sheet
  expect(info.yFromTop).toBeLessThan(info.pageH * 0.25);
  expect(info.size).toBeGreaterThan(17);              // 20pt name — proves no shrink-to-fit
  expect(allText).toContain('Charles Babbage');
  expect(allText).toContain('I wrote the first program.');
  expect(allText).not.toContain('Download PDF');      // page chrome must not leak
  expect(allText).not.toContain('NoAdsTools');
});
