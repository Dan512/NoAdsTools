// shared/links.js — platform-wide outbound links (single source of truth).
//
// There is no Ko-fi *widget* — the brand uses a plain link to the Ko-fi page.
// These two URLs are referenced by the shared topbar + footer; centralizing
// them here means any future URL change touches one place for the chrome.
// (The same URLs also appear inside the privacy panel's localized i18n
// HTML strings, which stay in the i18n dict — not imported from here.)
export const KOFI_URL = 'https://ko-fi.com/noadsdude';
export const REPO_URL = 'https://github.com/Dan512/NoAdsTools';
