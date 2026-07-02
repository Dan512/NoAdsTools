// shared/tests/unit/privacy.test.js — shared privacy panel: the registry +
// the pure HTML builder. The dialog mechanism (showModal/backdrop/Escape) is
// DOM-bound and covered by the editor's browser spec; here we test the parts
// that run without a DOM.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// shared/privacy.js imports shared/i18n.js, whose setLanguage() touches
// localStorage. Stub the minimum so the module loads under plain node --test.
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  },
});
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, get() { return { language: 'en' }; },
  });
} catch { /* already defined by an earlier test */ }

const { registerTranslations } = await import('../../i18n.js');
const { registerPrivacyRows, initPrivacy, buildPrivacyHtml, _resetForTest } =
  await import('../../privacy.js');

// A throwaway dict. node --test runs each file in its own process, so these
// test-only keys never pollute the real dead-key coverage check.
registerTranslations({ en: {
  tpTitle: 'Privacy', tpLead: 'Runs locally.',
  tpFetchH: 'Fetches', tpFetchL: '<li>A</li><li>B</li>',
  tpStoreH: 'Storage', tpStoreB: 'keys: x',
  tpStatic: 'Open standalone', close: 'Close',
} });

beforeEach(() => { _resetForTest(); });

test('buildPrivacyHtml renders title, lead, rows in order, and the static link', () => {
  registerPrivacyRows([
    { headingKey: 'tpFetchH', bodyKey: 'tpFetchL', kind: 'list' },
    { headingKey: 'tpStoreH', bodyKey: 'tpStoreB', kind: 'text' },
  ]);
  initPrivacy({ titleKey: 'tpTitle', leadKey: 'tpLead',
    staticHref: '/photo-editor/privacy.html', staticLinkKey: 'tpStatic' });
  const html = buildPrivacyHtml();
  assert.ok(html.includes('<h1>Privacy</h1>'));
  assert.ok(html.includes('<p class="lead">Runs locally.</p>'));
  const fetchIdx = html.indexOf('<h2>Fetches</h2><ul><li>A</li><li>B</li></ul>');
  const storeIdx = html.indexOf('<h2>Storage</h2><p>keys: x</p>');
  assert.ok(fetchIdx !== -1, 'list section wraps in <ul>');
  assert.ok(storeIdx !== -1, 'text section wraps in <p>');
  assert.ok(fetchIdx < storeIdx, 'sections render in registration order');
  assert.ok(html.includes(
    '<p class="privacy-static-link"><a href="/photo-editor/privacy.html" target="_blank" rel="noopener">Open standalone</a></p>'));
});

test('registerPrivacyRows is additive; _resetForTest clears rows + chrome', () => {
  registerPrivacyRows([{ headingKey: 'tpFetchH', bodyKey: 'tpFetchL', kind: 'list' }]);
  registerPrivacyRows([{ headingKey: 'tpStoreH', bodyKey: 'tpStoreB', kind: 'text' }]);
  initPrivacy({ titleKey: 'tpTitle', leadKey: 'tpLead' });
  assert.equal((buildPrivacyHtml().match(/<h2>/g) || []).length, 2);
  _resetForTest();
  initPrivacy({ titleKey: 'tpTitle', leadKey: 'tpLead' });
  assert.equal((buildPrivacyHtml().match(/<h2>/g) || []).length, 0);
});

test('omitting staticHref omits the static link', () => {
  registerPrivacyRows([{ headingKey: 'tpFetchH', bodyKey: 'tpFetchL', kind: 'list' }]);
  initPrivacy({ titleKey: 'tpTitle', leadKey: 'tpLead' });
  assert.ok(!buildPrivacyHtml().includes('privacy-static-link'));
});
