// favicon-generator/tests/unit/manifest.test.js — the two text artifacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, buildHtmlSnippet } from '../../js/manifest.js';

test('buildManifest returns valid JSON with the expected shape', () => {
  const json = buildManifest({ name: 'Acme', shortName: 'Acme', themeColor: '#112233', bgColor: '#eeddcc' });
  const m = JSON.parse(json);
  assert.equal(m.name, 'Acme');
  assert.equal(m.short_name, 'Acme');
  assert.equal(m.theme_color, '#112233');
  assert.equal(m.background_color, '#eeddcc');
  assert.equal(m.display, 'standalone');
  assert.equal(m.icons.length, 2);
  assert.deepEqual(m.icons[0], { src: 'favicon-192x192.png', sizes: '192x192', type: 'image/png' });
  assert.deepEqual(m.icons[1], { src: 'favicon-512x512.png', sizes: '512x512', type: 'image/png' });
});

test('buildManifest short_name falls back to name when omitted', () => {
  const m = JSON.parse(buildManifest({ name: 'Just A Name' }));
  assert.equal(m.short_name, 'Just A Name');
});

test('buildManifest falls back to defaults for missing fields', () => {
  const m = JSON.parse(buildManifest({}));
  assert.equal(m.name, 'My Site');
  assert.equal(m.short_name, 'My Site');
  assert.equal(m.theme_color, '#0f1410');
  assert.equal(m.background_color, '#ffffff');
});

test('buildManifest rejects a non-hex (hostile) color and falls back to the default', () => {
  const evil = '#fff" onload=x';
  const m = JSON.parse(buildManifest({ name: 'Acme', themeColor: evil, bgColor: 'javascript:alert(1)' }));
  assert.equal(m.theme_color, '#0f1410'); // rejected → default
  assert.equal(m.background_color, '#ffffff'); // rejected → default
  assert.ok(!JSON.stringify(m).includes('onload')); // no injection substring survives
});

test('buildManifest makes a hostile site name inert (stays a JSON string)', () => {
  const evil = '</script><img src=x onerror=alert(1)>';
  const json = buildManifest({ name: evil });
  const m = JSON.parse(json); // must still parse — JSON.stringify escaped it
  assert.equal(m.name, evil); // preserved as data, never markup
});

test('buildHtmlSnippet contains every required tag', () => {
  const s = buildHtmlSnippet({ themeColor: '#abcdef' });
  assert.match(s, /<link rel="icon" href="\/favicon\.ico" sizes="any">/);
  assert.match(s, /<link rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32x32\.png">/);
  assert.match(s, /<link rel="icon" type="image\/png" sizes="16x16" href="\/favicon-16x16\.png">/);
  assert.match(s, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(s, /<link rel="manifest" href="\/site\.webmanifest">/);
  assert.match(s, /<meta name="theme-color" content="#abcdef">/);
});

test('buildHtmlSnippet uses a default theme color when omitted', () => {
  const s = buildHtmlSnippet({});
  assert.match(s, /<meta name="theme-color" content="#0f1410">/);
});

test('buildHtmlSnippet makes a hostile theme color inert (falls back, no raw injection)', () => {
  const evil = '#fff" onload=x';
  const s = buildHtmlSnippet({ themeColor: evil });
  assert.match(s, /<meta name="theme-color" content="#0f1410">/); // fell back to default
  assert.ok(!s.includes('onload=x')); // the injection substring never lands raw
  assert.ok(!s.includes('#fff"'));
});
