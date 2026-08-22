// shared/category-boot.js — chrome boot for the category landing pages
// (/image-tools/, /pdf-tools/, /document-tools/).
//
// Mirrors home.js's boot: the same English-first chrome dictionary, the topbar
// and footer without the language picker or settings gear, and the theme
// bridge. It deliberately does NOT wire pill filtering — a category page is
// already filtered, and its tool links are plain crawlable <a> elements in the
// HTML rather than anything this file renders.
//
// Privacy is a link to /privacy with no #anchor: these pages are not tools, so
// there is no row for them to land on.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools',
  toolsMenu: 'Tools',
  allTools: 'All tools',
  themeToggle: 'Toggle theme',
  tip: 'Support this site',
  tipShort: 'Support',
  privacy: 'Privacy',
  source: 'Source',
  tipFooter: 'Support this site',
} });

injectTopbar({ lang: false, settings: false });
injectFooter();
initI18n();
initSettings({ toolId: 'category' });

document.documentElement.dataset.bootReady = '1';
