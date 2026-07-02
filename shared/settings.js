// shared/settings.js — tool-agnostic settings micro-store.
//
// A module-local store (no state.js dependency): `schema` holds each setting's
// definition, `values` holds the current value, `explicit` tracks which values
// came from localStorage (vs the schema default), `listeners` are notified on
// every change. Tools register their settings via registerSetting(); the shell
// self-registers the 3 global chrome settings in initSettings().
//
// Persistence is SCOPED: scope:'global' settings persist to one shared key
// (so a future second tool inherits theme); scope:'tool' settings persist to a
// per-tool key. Every value is re-sanitized against its registered schema on
// load and on persist, so a tampered blob can't smuggle a `javascript:` theme.
import { t, applyDomTranslations } from './i18n.js';
import { escapeHtml, pickFromAllowlist } from './escape.js';

const GLOBAL_KEY = 'noadstools:settings:global';
const toolKey = (id) => `noadstools:settings:${id}`;
// Legacy single-blob key from the pre-platform editor. We do a one-time
// cleanup in initSettings() so it isn't left as an undisclosed orphan.
const LEGACY_KEY = 'noadsimages_settings';

const schema = new Map();          // key -> definition
const values = Object.create(null); // key -> current value
const explicit = new Set();         // keys whose value came from storage
const listeners = new Set();
let currentToolId = null;

// --- Registry + accessors -------------------------------------------------

/**
 * Register a setting. def = { kind:'enum'|'bool'|'number', scope:'global'|'tool',
 * default, labelKey, ariaKey, options?:[{value,labelKey}], min?, max?, step? }.
 * Idempotent on key; the default seeds values[key] if not already present.
 */
export function registerSetting(key, def) {
  schema.set(key, def);
  if (!(key in values)) values[key] = def.default;
}

export function getSetting(key) {
  if (key in values) return values[key];
  return schema.get(key)?.default;
}

export function hasExplicitValue(key) {
  return explicit.has(key);
}

export function setSetting(key, value) {
  const def = schema.get(key);
  if (!def) return;
  values[key] = sanitize(key, value);
  explicit.add(key);
  persist();
  notify();
}

export function restoreDefaults() {
  for (const [key, def] of schema) values[key] = def.default;
  explicit.clear();
  persist();
  notify();
}

export function subscribeSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* a bad subscriber shouldn't break the rest */ }
  }
}

// --- Validation -----------------------------------------------------------

function enumValues(def) {
  return def.options.map(o => (typeof o === 'string' ? o : o.value));
}

function sanitize(key, value) {
  const def = schema.get(key);
  if (!def) return undefined;
  if (def.kind === 'enum') return pickFromAllowlist(value, enumValues(def), def.default);
  if (def.kind === 'bool') return !!value;
  if (def.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return def.default;
    return Math.max(def.min, Math.min(def.max, n));
  }
  return def.default;
}

// --- Scoped persistence ---------------------------------------------------

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function loadFromStorage() {
  const global = readJson(GLOBAL_KEY);
  const tool = currentToolId ? readJson(toolKey(currentToolId)) : null;
  for (const [key, def] of schema) {
    const blob = def.scope === 'global' ? global : tool;
    if (blob && typeof blob === 'object' && key in blob) {
      values[key] = sanitize(key, blob[key]);
      explicit.add(key);
    } else {
      values[key] = def.default;
    }
  }
}

function persist() {
  const global = {};
  const tool = {};
  for (const [key, def] of schema) {
    const safe = sanitize(key, values[key] ?? def.default);
    (def.scope === 'global' ? global : tool)[key] = safe;
  }
  try { localStorage.setItem(GLOBAL_KEY, JSON.stringify(global)); } catch { /* ignore */ }
  if (currentToolId) {
    try { localStorage.setItem(toolKey(currentToolId), JSON.stringify(tool)); } catch { /* ignore */ }
  }
}

// --- Test seam ------------------------------------------------------------
// Clears live values + listeners + explicit flags (KEEPS the schema) so unit
// tests start fresh without re-importing the module. Not used in production.
export function _resetForTests({ toolId = null } = {}) {
  currentToolId = toolId;
  explicit.clear();
  listeners.clear();
  for (const [key, def] of schema) values[key] = def.default;
}

// Test seam: set the tool, clear explicit flags, and run the real load path
// (loadFromStorage) so unit tests can assert load + hasExplicitValue-after-load
// without the DOM/binding side effects of initSettings(). Not used in prod.
export function _loadForTests({ toolId = null } = {}) {
  currentToolId = toolId;
  explicit.clear();
  loadFromStorage();
}

// --- Built-in global chrome settings --------------------------------------

// Registered by initSettings() before load. Labels live in whichever tool dict
// is registered with i18n (today: the editor's). scope:'global' so they persist
// to GLOBAL_KEY and a future second tool inherits them.
function registerGlobalSettings() {
  registerSetting('theme', {
    kind: 'enum', scope: 'global', default: 'auto',
    options: [
      { value: 'auto',  labelKey: 'settingsThemeAuto' },
      { value: 'light', labelKey: 'settingsThemeLight' },
      { value: 'dark',  labelKey: 'settingsThemeDark' },
    ],
    labelKey: 'settingsTheme', ariaKey: 'settingsThemeAria',
  });
  registerSetting('showThemeButton', {
    kind: 'bool', scope: 'global', default: true,
    labelKey: 'settingsShowTheme', ariaKey: 'settingsShowThemeAria',
  });
  registerSetting('showLanguagePicker', {
    kind: 'bool', scope: 'global', default: true,
    labelKey: 'settingsShowLanguage', ariaKey: 'settingsShowLanguageAria',
  });
}

// --- Theme bridge ---------------------------------------------------------

function applyThemeFromState() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const theme = getSetting('theme');
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function getDisplayedTheme() {
  if (typeof document === 'undefined' || !document.documentElement) return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  if (typeof window !== 'undefined' && window.matchMedia) {
    try { if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'; }
    catch { /* ignore */ }
  }
  return 'light';
}

function bindThemeToggle() {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = getDisplayedTheme() === 'dark' ? 'light' : 'dark';
    setSetting('theme', next);
  });
}

function applyTopbarVisibility() {
  if (typeof document === 'undefined') return;
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.hidden = !getSetting('showThemeButton');
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) langBtn.hidden = !getSetting('showLanguagePicker');
}

function applyThemeButtonIcon() {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.textContent = getDisplayedTheme() === 'dark' ? '🌙' : '☀️';
}

function wireColorSchemeListener() {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  try {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeButtonIcon();
    if (mql.addEventListener) mql.addEventListener('change', handler);
    else if (mql.addListener) mql.addListener(handler);
  } catch { /* ignore — older browsers */ }
}

// --- Generic popover ------------------------------------------------------

function orderedKeys() {
  const keys = [...schema.keys()];
  const globals = keys.filter(k => schema.get(k).scope === 'global');
  const tools = keys.filter(k => schema.get(k).scope !== 'global');
  return [...globals, ...tools];
}

function renderRow(key) {
  const def = schema.get(key);
  const aria = escapeHtml(t(def.ariaKey));
  const label = `<label for="settings-${key}">${escapeHtml(t(def.labelKey))}</label>`;
  let control;
  if (def.kind === 'enum') {
    const opts = def.options.map((o) => {
      const sel = getSetting(key) === o.value ? ' selected' : '';
      return `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(t(o.labelKey))}</option>`;
    }).join('');
    control = `<select id="settings-${key}" aria-label="${aria}">${opts}</select>`;
  } else if (def.kind === 'bool') {
    control = `<input type="checkbox" id="settings-${key}" ${getSetting(key) ? 'checked' : ''} aria-label="${aria}">`;
  } else {
    control = `<input type="range" id="settings-${key}" min="${def.min}" max="${def.max}" step="${def.step ?? 0.01}" value="${escapeHtml(String(getSetting(key)))}" aria-label="${aria}">`;
  }
  return `<div class="settings-row" data-setting="${key}">${label}${control}</div>`;
}

function buildPopoverHtml() {
  const rows = orderedKeys().map(renderRow).join('');
  return `${rows}
    <div class="settings-divider" aria-hidden="true"></div>
    <button type="button" class="settings-revert-btn"
            aria-label="${escapeHtml(t('settingsRestoreDefaultsAria'))}">
      ${escapeHtml(t('settingsRestoreDefaults'))}
    </button>`;
}

function bindRows(popover) {
  for (const row of popover.querySelectorAll('[data-setting]')) {
    const key = row.dataset.setting;
    const control = row.querySelector('select, input');
    if (!control) continue;
    const evt = control.type === 'checkbox' ? 'change' : 'input';
    control.addEventListener(evt, () => {
      const value = control.type === 'checkbox' ? control.checked : control.value;
      setSetting(key, value);
    });
  }
  const revert = popover.querySelector('.settings-revert-btn');
  if (revert) {
    revert.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreDefaults();
      popover.innerHTML = buildPopoverHtml();
      applyDomTranslations();
      bindRows(popover);
    });
  }
}

function positionPopover(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const POP_WIDTH_FALLBACK = 320;
  const margin = 4;
  let right = window.innerWidth - rect.right;
  const top = rect.bottom + margin;
  if (right + POP_WIDTH_FALLBACK > window.innerWidth - 8) right = 8;
  el.style.top = `${Math.max(8, top)}px`;
  el.style.right = `${Math.max(8, right)}px`;
  el.style.left = 'auto';
}

function bindGear() {
  const btn = document.getElementById('settings-toggle');
  if (!btn) return;
  let popover = null;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover) { closePopover(); return; }
    popover = openPopover(btn);
  });
  document.addEventListener('click', (e) => {
    if (popover && !popover.contains(e.target) && e.target !== btn) closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover) closePopover();
  });
  window.addEventListener('resize', () => { if (popover) positionPopover(popover, btn); });

  function openPopover(anchor) {
    const el = document.createElement('div');
    el.className = 'settings-popover';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('settings'));
    el.innerHTML = buildPopoverHtml();
    document.body.appendChild(el);
    positionPopover(el, anchor);
    applyDomTranslations();
    bindRows(el);
    return el;
  }
  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
  }
}

// --- Boot -----------------------------------------------------------------

/**
 * Boot the settings system for a tool. Tool settings must be registered
 * BEFORE this call. Order: register globals → one-time legacy cleanup →
 * load+sanitize from storage → apply theme (before first paint) → bind chrome
 * → subscribe the appliers → wire the OS color-scheme listener.
 */
export function initSettings({ toolId } = {}) {
  currentToolId = toolId || null;
  registerGlobalSettings();
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  loadFromStorage();
  applyThemeFromState();
  bindGear();
  bindThemeToggle();
  applyTopbarVisibility();
  applyThemeButtonIcon();
  subscribeSettings(applyThemeFromState);
  subscribeSettings(applyTopbarVisibility);
  subscribeSettings(applyThemeButtonIcon);
  wireColorSchemeListener();
}
