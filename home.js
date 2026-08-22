// home.js — homepage boot. English-first: registers its own EN chrome dict,
// injects the shared chrome WITHOUT the language picker or settings gear, boots
// theme, and wires client-side category-pill filtering over the static tool
// cards. Imports shared modules only.
//
// Privacy is a plain link to the single /privacy — no in-app panel. The
// homepage passes no toolId to the chrome, so the link carries no #anchor and
// lands the reader at the top of that page (there is no "home" row).
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';

// EN dictionary for the chrome the homepage actually renders (no lang/settings
// controls → no settings/language keys needed).
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

// Inject chrome with the language picker + settings gear omitted (English-first).
injectTopbar({ lang: false, settings: false });
injectFooter();
initI18n();
// Theme handling (applies stored theme + binds #theme-toggle). The absent gear
// makes settings' bindGear a no-op; the absent #lang-toggle makes the
// language-visibility appliers no-ops.
initSettings({ toolId: 'home' });

// Category-pill filtering over the static cards (progressive enhancement — the
// cards are real links in the HTML; this only shows/hides them).
(function wirePillFiltering() {
  const pills = document.querySelectorAll('.category-pills .pill');
  const cards = document.querySelectorAll('.tool-grid .tool-card');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const filter = pill.dataset.filter;
      pills.forEach((p) => {
        const on = p === pill;
        p.classList.toggle('is-active', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      cards.forEach((card) => {
        card.style.display = (filter === 'all' || card.dataset.cat === filter) ? '' : 'none';
      });
    });
  });
})();

document.documentElement.dataset.bootReady = '1';
