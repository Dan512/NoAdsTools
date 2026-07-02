// tests/unit/i18n-coverage.test.js — drift detector.
//
// Walks the live source tree, finds every i18n key referenced by either
//   `data-i18n="key"` markup or `t('key', …)` JS call, and verifies that
// the EN dict in js/i18n.js contains every one of them. Also reports any
// keys that exist in EN but aren't referenced anywhere (likely dead).
//
// This catches three classes of bug at test time:
//   1) Markup or JS references a key the dict doesn't have (production: shows
//      `[?]key`; in dev that's only seen if the path actually renders).
//   2) EN string was renamed in code but not removed from the dict.
//   3) A new translation key was added to the dict without being wired up
//      anywhere — likely a copy-paste typo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// Minimal globals so importing js/i18n.js works under Node. Node 24 has
// a built-in `navigator` getter, so use defineProperty (configurable) to
// override.
if (!globalThis.localStorage) {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
    },
  });
}
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    get() { return { language: 'en' }; },
  });
} catch { /* already overridden by another test that ran first */ }
if (!globalThis.document) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { documentElement: { lang: '', dir: '' } },
  });
}

const { TRANSLATIONS } = await import('../../js/i18n.js');

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

// Files / directories to scan and skip.
const SCAN_DIRS = ['js', 'css'];
const SCAN_FILES_AT_ROOT = ['index.html', 'privacy.html'];
// 404.html lives at the repository root — the platform/site root GitHub Pages
// serves site-wide 404s from — one level above this tool's photo-editor/ dir.
// It still references editor i18n keys (notFound*), so scan it there.
const SCAN_FILES_AT_REPO_ROOT = ['404.html'];
// shared/ modules (settings.js, etc.) now reference editor i18n keys via
// t()/labelKey/ariaKey — scan them too. SKIP_PATH_PARTS already excludes
// shared/tests, and walk() skips i18n.js by name.
const SCAN_DIRS_AT_REPO_ROOT = ['shared'];
const SKIP_PATH_PARTS = ['node_modules', 'vendor', '.tmp-vendor', 'test-results', 'tests', 'docs', 'scripts'];

// Regexes:
//   - data-i18n="key" / data-i18n='key' / element.dataset.i18n = 'key'
//   - t('key') / t("key") — used in source. We ignore template-literal forms
//     (rare and produce key collisions when computed).
//   - i18n: 'key' — property in TOOLS/SLIDERS/etc. constant arrays.
// We explicitly DON'T match data-i18n-attr (whose value is the html attr,
// not an i18n key) by anchoring with a non-hyphen lookahead.
const DATA_I18N_RE   = /\bdata-i18n(?!-)\s*=\s*["']([a-zA-Z][a-zA-Z0-9_-]*)["']/g;
const DATASET_I18N_RE = /\.dataset\.i18n\s*=\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;
const T_CALL_RE      = /\bt\(\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;
const I18N_PROP_RE   = /\bi18n\s*:\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;
// `tipKey: 'editorToolFooTip'` — used in editor.js TOOLS descriptors for
// longer tooltips that explain what the tool does. The loop reads
// `tool.tipKey` dynamically, so without this pattern the dead-key detector
// would flag editorToolPanTip / editorToolEyedropperTip / etc. as orphans.
const TIPKEY_PROP_RE = /\btipKey\s*:\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;
// `labelKey: 'targetSizePresetFoo'` — used in targetSizePresets.js (and
// potentially future catalogs) where UI code reads `entry.labelKey`
// dynamically and passes it to t(). Same shape as tipKey.
const LABELKEY_PROP_RE = /\blabelKey\s*:\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;
// `ariaKey: 'settingsThemeAria'` — registerSetting() definitions (shared +
// glue) carry an ariaKey the popover passes to t(). Same shape as labelKey.
const ARIAKEY_PROP_RE = /\bariaKey\s*:\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;
// `headingKey: 'privacyFetchesHeading'` / `bodyKey:` / `titleKey:` / `leadKey:`
// / `staticLinkKey:` — registerPrivacyRows()/initPrivacy() (shared privacy panel
// + editor glue) pass i18n keys as props the renderer feeds to t(). Same shape
// as labelKey/ariaKey.
const PRIVACY_KEY_PROP_RE = /\b(?:headingKey|bodyKey|titleKey|leadKey|staticLinkKey)\s*:\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;

function collectFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    walk(path.join(ROOT, dir), out);
  }
  for (const f of SCAN_FILES_AT_ROOT) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) out.push(p);
  }
  for (const f of SCAN_FILES_AT_REPO_ROOT) {
    const p = path.resolve(ROOT, '..', f);
    if (fs.existsSync(p)) out.push(p);
  }
  for (const dir of SCAN_DIRS_AT_REPO_ROOT) {
    walk(path.resolve(ROOT, '..', dir), out);
  }
  return out;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (SKIP_PATH_PARTS.some(part => full.split(path.sep).includes(part))) continue;
    if (ent.isDirectory()) {
      walk(full, out);
      continue;
    }
    // Skip the i18n modules — the shim (i18n.js) and the strings data file
    // (i18n-strings.js) define/register the dict but don't reference keys.
    if (ent.name === 'i18n.js' || ent.name === 'i18n-strings.js') continue;
    if (/\.(html|js|css)$/i.test(ent.name)) out.push(full);
  }
}

function extractKeys(content) {
  const keys = new Set();
  for (const m of content.matchAll(DATA_I18N_RE))    keys.add(m[1]);
  for (const m of content.matchAll(DATASET_I18N_RE)) keys.add(m[1]);
  for (const m of content.matchAll(T_CALL_RE))       keys.add(m[1]);
  for (const m of content.matchAll(I18N_PROP_RE))    keys.add(m[1]);
  for (const m of content.matchAll(TIPKEY_PROP_RE))  keys.add(m[1]);
  for (const m of content.matchAll(LABELKEY_PROP_RE)) keys.add(m[1]);
  for (const m of content.matchAll(ARIAKEY_PROP_RE)) keys.add(m[1]);
  for (const m of content.matchAll(PRIVACY_KEY_PROP_RE)) keys.add(m[1]);
  return keys;
}

// Some keys are referenced indirectly via template literals or computed
// strings (e.g. `t(`adjust${capitalize(key)}`)` or a ternary like
// `key === 1 ? 'singular' : 'plural'`). We allowlist those so the
// coverage test doesn't flag them as unreferenced dead keys.
const KNOWN_DYNAMIC_KEYS = new Set([
  // queueView.js batch panel composes the per-slider label from the per-image
  // adjust keys via `adjust${capitalize(key)}`:
  'adjustBrightness',
  'adjustContrast',
  'adjustSaturation',
  'adjustBlur',
  // editor.js builds the side-panel title list as inner arrays:
  // `[['panelToolOptions', 'panel-tool'], ...]` — the regex looks for keys
  // as direct args to `t()` so it misses these.
  'panelToolOptions',
  'panelResize',
  'panelAdjust',
  'panelOverlays',
  'panelExport',
  // Singular/plural variants picked via ternary in queueView.js and
  // exporter.js batch dialogs:
  'batchReadoutSingular',
  'batchReadoutPlural',
  'batchProgressBgTitleSingular',
  'batchProgressBgTitlePlural',
  'batchProgressExportTitleSingular',
  'batchProgressExportTitlePlural',
  // queueView.js builds dedupe sensitivity option labels via
  // `t('dedupeSensitivity' + lvl[0].toUpperCase() + lvl.slice(1))`:
  'dedupeSensitivityStrict',
  'dedupeSensitivityNormal',
  'dedupeSensitivityLoose',
  // queueView.js will reference dedupeBadge when rendering the dark
  // overlay on marked thumbnails (Task #37 / v1.2 Feature 7).
  'dedupeBadge',
  // redactTool.js builds the AI-detect sensitivity preset labels via
  // `t('redactDetectSensitivity' + level[0].toUpperCase() + level.slice(1))`:
  'redactDetectSensitivityStrict',
  'redactDetectSensitivityNormal',
  'redactDetectSensitivityLoose',
  // watermarkTool.js (v1.3 Feature 12): type-chip labels picked via ternary
  // (`t2 === 'text' ? 'watermarkTypeText' : 'watermarkTypeImage'`) and the
  // 9-grid position chip labels resolved through the POSITION_LABEL_KEYS map
  // — the regex sees `t(labelKey)` and can't follow the lookup. The Custom
  // label is set programmatically when the user drags the watermark.
  'watermarkTypeText',
  'watermarkTypeImage',
  'watermarkPositionTopLeft',
  'watermarkPositionTop',
  'watermarkPositionTopRight',
  'watermarkPositionLeft',
  'watermarkPositionCenter',
  'watermarkPositionRight',
  'watermarkPositionBottomLeft',
  'watermarkPositionBottom',
  'watermarkPositionBottomRight',
  'watermarkPositionCustom',
]);

test('every referenced i18n key exists in TRANSLATIONS.en', () => {
  const files = collectFiles();
  const referenced = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const keys = extractKeys(text);
    for (const k of keys) referenced.add(k);
  }
  // The EN dict lives in i18n-strings.js (registered via the i18n.js shim);
  // both are skipped by walk() so their property keys aren't miscounted as
  // references. The regexes match `t('foo')`/`data-i18n` patterns anyway.
  const missing = [];
  for (const key of referenced) {
    if (!Object.prototype.hasOwnProperty.call(TRANSLATIONS.en, key)) {
      missing.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Referenced keys missing from TRANSLATIONS.en: ${missing.join(', ')}`,
  );
});

test('every key in TRANSLATIONS.en is referenced somewhere (dead-key detector)', () => {
  const files = collectFiles();
  const referenced = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const k of extractKeys(text)) referenced.add(k);
  }
  const orphans = [];
  for (const key of Object.keys(TRANSLATIONS.en)) {
    if (referenced.has(key)) continue;
    if (KNOWN_DYNAMIC_KEYS.has(key)) continue;
    orphans.push(key);
  }
  assert.deepEqual(
    orphans,
    [],
    `EN keys with no reference (likely dead): ${orphans.join(', ')}`,
  );
});
