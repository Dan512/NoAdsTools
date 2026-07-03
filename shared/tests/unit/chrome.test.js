// shared/tests/unit/chrome.test.js — the injected chrome must reproduce every
// control ID the editor's modules bind to, plus the new wordmark brand-link and
// Tools dropdown. Builders are pure (no DOM), so we assert on the HTML string.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildTopbarHtml } = await import('../../topbar.js');
const { buildFooterHtml } = await import('../../footer.js');

test('topbar reproduces every control ID the editor binds to', () => {
  const html = buildTopbarHtml({ toolId: 'photo-editor' });
  for (const id of [
    'id="lang-toggle"', 'id="theme-toggle"', 'id="settings-toggle"',
    'id="privacy-toggle-header"',
  ]) assert.ok(html.includes(id), `missing ${id}`);
  assert.ok(html.includes('class="lang-flag"'), 'missing lang-flag img');
  assert.ok(html.includes('class="btn-tip"'), 'missing tip button');
});

test('topbar wordmark is the NoAdsTools brand-link plus the tool name', () => {
  const html = buildTopbarHtml({ toolId: 'photo-editor' });
  assert.ok(html.includes('data-i18n="brandName"'), 'wordmark must carry brandName');
  assert.ok(html.includes('href="/"'), 'wordmark must link home');
  assert.ok(html.includes('Photo Editor'), 'wordmark must show the current tool name');
  assert.ok(html.includes('NoAdsTools'), 'wordmark fallback text must read NoAdsTools');
});

test('topbar Tools dropdown lists live tools and an All tools link', () => {
  const html = buildTopbarHtml({ toolId: 'photo-editor' });
  assert.ok(html.includes('id="tools-menu-toggle"'), 'missing tools menu toggle');
  assert.ok(html.includes('data-i18n="toolsMenu"'), 'tools toggle needs toolsMenu key');
  assert.ok(html.includes('href="/photo-editor/"'), 'dropdown must link the live editor');
  assert.ok(html.includes('data-i18n="allTools"'), 'dropdown must have an All tools link');
  // A planned tool must NOT appear as a live dropdown link. (Uses a tool that
  // is still status:'planned' in the manifest — update the slug when it ships.)
  assert.ok(!html.includes('href="/compress-images/"'), 'planned tools must not be linked');
});

test('topbar marks the current tool with aria-current', () => {
  const html = buildTopbarHtml({ toolId: 'photo-editor' });
  assert.ok(/href="\/photo-editor\/"[^>]*aria-current="page"/.test(html));
});

test('footer has privacy, source, and tip links', () => {
  const html = buildFooterHtml({ toolId: 'photo-editor' });
  assert.ok(html.includes('id="privacy-toggle"'), 'missing footer privacy button');
  assert.ok(html.includes('data-i18n="source"'), 'missing source link');
  assert.ok(html.includes('data-i18n="tipFooter"'), 'missing footer tip link');
});

test('footer omits "other tools" when the current tool is the only live one', () => {
  const html = buildFooterHtml({ toolId: 'photo-editor' });
  // photo-editor is the only live tool today → no other-tool link to itself.
  assert.ok(!html.includes('href="/photo-editor/"'), 'footer must not link the current tool');
});

test('topbar omits the language toggle when lang:false', () => {
  const html = buildTopbarHtml({ toolId: 'photo-editor', lang: false });
  assert.ok(!html.includes('id="lang-toggle"'), 'lang toggle must be omitted');
  assert.ok(!html.includes('class="lang-flag"'), 'lang flag must be omitted');
  assert.ok(html.includes('id="theme-toggle"'), 'theme toggle still present');
});

test('topbar omits the settings gear when settings:false', () => {
  const html = buildTopbarHtml({ toolId: 'photo-editor', settings: false });
  assert.ok(!html.includes('id="settings-toggle"'), 'settings gear must be omitted');
  assert.ok(html.includes('id="theme-toggle"'), 'theme toggle still present');
});

test('topbar defaults include both language and settings controls', () => {
  const html = buildTopbarHtml({ toolId: 'photo-editor' });
  assert.ok(html.includes('id="lang-toggle"'), 'default includes lang toggle');
  assert.ok(html.includes('id="settings-toggle"'), 'default includes settings gear');
});
