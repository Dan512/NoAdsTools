// tests/unit/settings.test.js — editor settings glue: registration of the 6
// tool settings + seedExportDefaults. The micro-store's own behavior
// (sanitize, scoped persistence, subscribe, hasExplicitValue) is covered by
// shared/tests/unit/settings.test.js.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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
} catch { /* already defined */ }
Object.defineProperty(globalThis, 'document', {
  configurable: true, writable: true,
  value: { documentElement: { lang: '', dir: '' }, getElementById() { return null; } },
});

const settingsGlue = await import('../../js/settings.js');
const sharedStore = await import('../../../shared/settings.js');
const stateModule = await import('../../js/state.js');
const { registerEditorSettings, seedExportDefaults, getSetting, setSetting } = settingsGlue;
const { _resetForTests } = sharedStore;
const { getState } = stateModule;

// Register the 6 editor settings once.
registerEditorSettings();

beforeEach(() => {
  storage.clear();
  _resetForTests({ toolId: 'photo-editor' });
  const s = getState();
  s.export.format = 'png';
  s.export.quality = 0.92;
  delete s.export._userFormatLocked;
});

test('registerEditorSettings registers the 6 tool settings with defaults', () => {
  assert.equal(getSetting('defaultExportFormat'), 'png');
  assert.equal(getSetting('defaultQuality'), 0.92);
  assert.equal(getSetting('confirmBeforeRemove'), false);
  assert.equal(getSetting('showOverlayOutlines'), false);
  assert.equal(getSetting('smoothBrushStrokes'), true);
  assert.equal(getSetting('autoRefreshThumbnails'), true);
});

test('setSetting re-export round-trips through the shared store', () => {
  setSetting('defaultExportFormat', 'webp');
  assert.equal(getSetting('defaultExportFormat'), 'webp');
  const tool = JSON.parse(storage.get('noadstools:settings:photo-editor'));
  assert.equal(tool.defaultExportFormat, 'webp');
});

test('seedExportDefaults copies format + quality into state.export', () => {
  setSetting('defaultExportFormat', 'jpeg');
  setSetting('defaultQuality', 0.7);
  seedExportDefaults();
  assert.equal(getState().export.format, 'jpeg');
  assert.equal(getState().export.quality, 0.7);
});

test('seedExportDefaults sets _userFormatLocked only when format is explicit', () => {
  // No explicit format → not locked.
  seedExportDefaults();
  assert.notEqual(getState().export._userFormatLocked, true);
  // Explicit format → locked.
  _resetForTests({ toolId: 'photo-editor' });
  getState().export._userFormatLocked = undefined;
  setSetting('defaultExportFormat', 'webp');
  seedExportDefaults();
  assert.equal(getState().export._userFormatLocked, true);
});
