// home.js — homepage boot. English-first: registers its own EN chrome dict,
// injects the shared chrome WITHOUT the language picker or settings gear, boots
// theme + the in-app privacy panel, and wires client-side category-pill
// filtering over the static tool cards. Imports shared modules only.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';

// EN dictionary for the chrome the homepage actually renders (no lang/settings
// controls → no settings/language keys needed) + the homepage's privacy panel.
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
  close: 'Close',
  homePrivacyTitle: 'Privacy',
  homePrivacyLead: 'NoAdsTools runs entirely in your browser. This page loads only its own scripts and styles — nothing you do is uploaded, tracked, or stored off your device.',
  homePrivacyFetchHeading: 'What this page loads',
  homePrivacyFetchList: '<li>HTML, CSS, JavaScript, and self-hosted fonts — all from this site. No third-party CDN.</li>',
  homePrivacyNotHeading: 'What it never does',
  homePrivacyNotList: '<li>No analytics, no cookies, no tracking. No upload. No account.</li>',
} });

// Inject chrome with the language picker + settings gear omitted (English-first).
injectTopbar({ toolId: 'home', lang: false, settings: false });
injectFooter({ toolId: 'home' });
initI18n();
// Theme handling (applies stored theme + binds #theme-toggle). The absent gear
// makes settings' bindGear a no-op; the absent #lang-toggle makes the
// language-visibility appliers no-ops.
initSettings({ toolId: 'home' });

// The homepage's own privacy disclosure.
registerPrivacyRows([
  { headingKey: 'homePrivacyFetchHeading', bodyKey: 'homePrivacyFetchList', kind: 'list' },
  { headingKey: 'homePrivacyNotHeading', bodyKey: 'homePrivacyNotList', kind: 'list' },
]);
initPrivacy({ titleKey: 'homePrivacyTitle', leadKey: 'homePrivacyLead' });

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
