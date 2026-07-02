// shared/tests/unit/settings.test.js — settings micro-store: registry,
// sanitize, scoped persistence, subscribe, hasExplicitValue.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal globals so shared/settings.js (which imports shared/i18n.js) loads
// under plain `node --test`. Same pattern as i18n.test.js.
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
    clear() { storage.clear(); },
  },
});
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, get() { return { language: 'en' }; },
  });
} catch { /* already defined by an earlier test */ }
Object.defineProperty(globalThis, 'document', {
  configurable: true, writable: true,
  value: { documentElement: { lang: '', dir: '' }, getElementById() { return null; } },
});

const {
  registerSetting, getSetting, setSetting, restoreDefaults,
  hasExplicitValue, subscribeSettings, _resetForTests, _loadForTests,
} = await import('../../settings.js');

// Register a known fixture schema once. _resetForTests() clears values +
// listeners but KEEPS the schema, so registration survives beforeEach.
registerSetting('theme', {
  kind: 'enum', scope: 'global', default: 'auto',
  options: [{ value: 'auto', labelKey: 'a' }, { value: 'light', labelKey: 'l' }, { value: 'dark', labelKey: 'd' }],
  labelKey: 'settingsTheme', ariaKey: 'settingsThemeAria',
});
registerSetting('showThemeButton', { kind: 'bool', scope: 'global', default: true, labelKey: 'st', ariaKey: 'sta' });
registerSetting('defaultQuality', { kind: 'number', scope: 'tool', min: 0.5, max: 1.0, step: 0.01, default: 0.92, labelKey: 'q', ariaKey: 'qa' });
registerSetting('confirmBeforeRemove', { kind: 'bool', scope: 'tool', default: false, labelKey: 'c', ariaKey: 'ca' });

beforeEach(() => {
  storage.clear();
  _resetForTests({ toolId: 'photo-editor' });
});

test('getSetting returns schema defaults before any set', () => {
  assert.equal(getSetting('theme'), 'auto');
  assert.equal(getSetting('showThemeButton'), true);
  assert.equal(getSetting('defaultQuality'), 0.92);
  assert.equal(getSetting('confirmBeforeRemove'), false);
});

test('setSetting sanitizes enum and clamps number', () => {
  setSetting('theme', 'javascript:hack');
  assert.equal(getSetting('theme'), 'auto');
  setSetting('theme', 'dark');
  assert.equal(getSetting('theme'), 'dark');
  setSetting('defaultQuality', 5);
  assert.equal(getSetting('defaultQuality'), 1);
  setSetting('defaultQuality', 0);
  assert.equal(getSetting('defaultQuality'), 0.5);
  setSetting('defaultQuality', 'nope');
  assert.equal(getSetting('defaultQuality'), 0.92);
});

test('setSetting coerces bools and ignores unknown keys', () => {
  setSetting('confirmBeforeRemove', 'truthy');
  assert.equal(getSetting('confirmBeforeRemove'), true);
  setSetting('confirmBeforeRemove', '');
  assert.equal(getSetting('confirmBeforeRemove'), false);
  setSetting('nope', 1); // no throw, no key
  assert.equal(getSetting('nope'), undefined);
});

test('scoped persistence: globals to global key, tool to tool key', () => {
  setSetting('theme', 'dark');             // global
  setSetting('defaultQuality', 0.7);       // tool
  const global = JSON.parse(storage.get('noadstools:settings:global'));
  const tool = JSON.parse(storage.get('noadstools:settings:photo-editor'));
  assert.equal(global.theme, 'dark');
  assert.equal(Object.prototype.hasOwnProperty.call(global, 'defaultQuality'), false);
  assert.equal(tool.defaultQuality, 0.7);
  assert.equal(Object.prototype.hasOwnProperty.call(tool, 'theme'), false);
});

test('loadFromStorage reads scoped blobs and marks loaded keys explicit', () => {
  storage.set('noadstools:settings:global', JSON.stringify({ theme: 'dark' }));
  storage.set('noadstools:settings:photo-editor', JSON.stringify({ defaultQuality: 0.7 }));
  _loadForTests({ toolId: 'photo-editor' });
  assert.equal(getSetting('theme'), 'dark');            // from the global blob
  assert.equal(getSetting('defaultQuality'), 0.7);      // from the tool blob
  assert.equal(hasExplicitValue('theme'), true);
  assert.equal(hasExplicitValue('defaultQuality'), true);
  // A key absent from storage stays default and is NOT explicit — this is
  // exactly the distinction _userFormatLocked relies on after the cutover.
  assert.equal(getSetting('confirmBeforeRemove'), false);
  assert.equal(hasExplicitValue('confirmBeforeRemove'), false);
});

test('hasExplicitValue is false for defaults, true after set', () => {
  assert.equal(hasExplicitValue('theme'), false);
  setSetting('theme', 'light');
  assert.equal(hasExplicitValue('theme'), true);
});

test('subscribeSettings fires on every change and unsubscribes', () => {
  let n = 0;
  const off = subscribeSettings(() => { n++; });
  setSetting('theme', 'dark');
  setSetting('confirmBeforeRemove', true);
  assert.equal(n, 2);
  off();
  setSetting('theme', 'light');
  assert.equal(n, 2);
});

test('restoreDefaults resets values and clears explicit flags', () => {
  setSetting('theme', 'dark');
  setSetting('defaultQuality', 0.7);
  restoreDefaults();
  assert.equal(getSetting('theme'), 'auto');
  assert.equal(getSetting('defaultQuality'), 0.92);
  assert.equal(hasExplicitValue('theme'), false);
});
