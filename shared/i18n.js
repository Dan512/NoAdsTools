// shared/i18n.js — i18n core: t()/setLanguage() machinery + a
// registerTranslations() registry. Tool dictionaries are registered into the
// merged TRANSLATIONS store (the editor's dict lives in
// photo-editor/js/i18n-strings.js and is registered by its i18n.js shim).
//
// Pattern:
//   - One canonical EN dictionary per tool, other languages fall back to EN.
//   - `t(key, vars?)` does the lookup; variable interpolation is HTML-escaped
//     so the result is safe to assign to innerHTML.
//   - `setLanguage(code)` writes localStorage, sets <html lang>/dir, and walks
//     [data-i18n] / [data-i18n-attr] nodes to re-translate them.
//   - The language code is allowlist-sanitized — only the 15 codes in `LANGS`
//     are honored. Anything else (including XSS attempts via localStorage)
//     falls back to 'en'.
import { escapeHtml, pickFromAllowlist } from './escape.js';

export const LANGS = Object.freeze([
  'en', 'es', 'de', 'fr', 'it', 'pt', 'nl', 'pl',
  'ja', 'zh-CN', 'ko', 'ru', 'ar', 'hi', 'tr',
]);

// Per-language native display names for the picker (rendered next to the flag).
export const LANG_NAMES = Object.freeze({
  en: 'English',     es: 'Español',     de: 'Deutsch',     fr: 'Français',
  it: 'Italiano',    pt: 'Português',   nl: 'Nederlands',  pl: 'Polski',
  ja: '日本語',       'zh-CN': '中文',     ko: '한국어',       ru: 'Русский',
  ar: 'العربية',      hi: 'हिन्दी',         tr: 'Türkçe',
});

// Languages that need RTL layout. Used to flip `dir` on <html>.
export const RTL_LANGS = new Set(['ar']);

// TRANSLATIONS: merged store, { [langCode]: { [key]: 'translated string' } }.
// EN is the canonical source; other languages fall back to EN at lookup time.
// Starts empty (one bucket per LANG); tools fill it via registerTranslations().
export const TRANSLATIONS = Object.fromEntries(LANGS.map(code => [code, {}]));

/**
 * Merge a tool/shell dictionary into the store. Shape: { en: {...}, es: {...} }.
 * Call before initI18n()/t(). Later registrations override earlier keys.
 */
export function registerTranslations(dict) {
  if (!dict || typeof dict !== 'object') return;
  for (const code of Object.keys(dict)) {
    if (!TRANSLATIONS[code]) TRANSLATIONS[code] = {};
    Object.assign(TRANSLATIONS[code], dict[code]);
  }
}

let active = 'en';

// Map navigator.language to one of our LANGS. Handles common 2-letter
// prefixes (en-US → en, fr-CA → fr) and routes any zh-* (zh-CN, zh-TW,
// zh-Hant, …) to the v1 'zh-CN' bucket.
export function detectLanguage() {
  const raw = (typeof navigator !== 'undefined' && navigator.language
    ? navigator.language
    : 'en'
  ).toLowerCase();
  if (raw.startsWith('zh')) return 'zh-CN';
  const short = raw.split('-')[0];
  return LANGS.find(l => l === short) || 'en';
}

export function setLanguage(code) {
  active = pickFromAllowlist(code, LANGS, 'en');
  try {
    localStorage.setItem('noadstools_lang', active);
  } catch { /* ignore — Safari private mode etc. */ }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = active;
    document.documentElement.dir = RTL_LANGS.has(active) ? 'rtl' : 'ltr';
  }
  applyDomTranslations();
}

export function getLanguage() {
  return active;
}

// Look up a key in the active dict, falling back to EN, falling back to
// `[?]key`. Variable substitution uses {name} placeholders; values are
// HTML-escaped so the result stays safe to assign to innerHTML.
export function t(key, vars) {
  const dict = TRANSLATIONS[active] || TRANSLATIONS.en;
  const raw = dict[key] ?? TRANSLATIONS.en[key];
  if (raw === undefined) {
    // Dev hint: prefix missing keys with [?] so they're visually obvious
    // during development. Production: same — better than crashing.
    return `[?]${key}`;
  }
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : escapeHtml(v);
  });
}

// Walk the static DOM and apply translations. Elements with [data-i18n]
// have their textContent replaced; elements with [data-i18n-attr] have
// that attribute set instead.
export function applyDomTranslations() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (!key) continue;
    const attr = el.dataset.i18nAttr;
    if (attr) {
      el.setAttribute(attr, t(key));
    } else {
      el.textContent = t(key);
    }
  }
}

// Boot helper: read stored preference, fall back to navigator detection,
// then apply.
export function initI18n() {
  let stored = null;
  try {
    stored = localStorage.getItem('noadstools_lang');
  } catch { /* ignore */ }
  const initial = pickFromAllowlist(stored, LANGS, null) ?? detectLanguage();
  setLanguage(initial);
}
