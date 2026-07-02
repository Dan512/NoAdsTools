// shared/topbar.js — the platform topbar, injected at boot (replacing each
// tool's hand-written static <header>). buildTopbarHtml() is a pure string
// builder (unit-tested under Node, no DOM); injectTopbar() mounts it and wires
// the Tools dropdown. The markup reproduces the exact control IDs the editor's
// modules already bind to (#lang-toggle + img.lang-flag, #theme-toggle,
// #settings-toggle, #privacy-toggle-header, .btn-tip) so nothing downstream
// changes — it only adds the wordmark brand-link and the Tools dropdown.
// Pass { lang: false } / { settings: false } to omit the language toggle /
// settings gear (e.g. the English-first homepage); both default true, so the
// editor (which calls injectTopbar({toolId})) is unaffected.
import { escapeHtml } from './escape.js';
import { liveTools, toolBySlug } from './tools.js';
import { KOFI_URL } from './links.js';

export function buildTopbarHtml({ toolId, lang = true, settings = true } = {}) {
  const current = toolBySlug(toolId);
  const toolName = current ? current.title : '';
  const toolSpan = toolName
    ? ` <span class="wordmark-tool">${escapeHtml(toolName)}</span>`
    : '';

  const menuItems = liveTools().map(tl => {
    const here = tl.slug === toolId ? ' aria-current="page"' : '';
    return `<a role="menuitem" class="tools-menu-item" href="/${escapeHtml(tl.slug)}/"${here}>${escapeHtml(tl.title)}</a>`;
  }).join('');

  const langBtn = lang
    ? `
      <button id="lang-toggle" type="button" data-i18n="language" data-i18n-attr="aria-label" aria-label="Language">
        <img class="lang-flag" alt="" width="20" height="14">
      </button>`
    : '';

  const settingsBtn = settings
    ? `
      <button id="settings-toggle" type="button" data-i18n="settings" data-i18n-attr="aria-label" aria-label="Settings">⚙️</button>`
    : '';

  return `
    <p class="wordmark"><a href="/" data-i18n="brandName">NoAdsTools</a>${toolSpan}</p>
    <div class="spacer"></div>
    <div class="controls">
      <div class="tools-menu">
        <button id="tools-menu-toggle" type="button" class="header-link"
                aria-haspopup="true" aria-expanded="false" data-i18n="toolsMenu">Tools</button>
        <div id="tools-menu-list" class="tools-menu-list" role="menu" hidden>
          ${menuItems}
          <a role="menuitem" class="tools-menu-item tools-menu-all" href="/" data-i18n="allTools">All tools</a>
        </div>
      </div>${langBtn}
      <button id="theme-toggle" type="button" data-i18n="themeToggle" data-i18n-attr="aria-label" aria-label="Toggle theme">☀️</button>${settingsBtn}
      <a class="btn-tip" href="${KOFI_URL}" target="_blank" rel="noopener">
        <span class="tip-full" data-i18n="tip">Support this site</span>
        <span class="tip-short" data-i18n="tipShort">Support</span>
      </a>
      <span class="header-divider header-only-desktop" aria-hidden="true">·</span>
      <button id="privacy-toggle-header" class="header-link header-only-desktop" type="button" data-i18n="privacy">Privacy</button>
    </div>`;
}

export function injectTopbar(opts = {}) {
  if (typeof document === 'undefined') return;
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML = buildTopbarHtml(opts);
  document.body.insertBefore(header, document.body.firstChild);
  bindToolsMenu();
}

// Open/close the Tools dropdown: toggle on the button, close on outside-click
// and Escape. Mirrors the language/settings popover pattern already in the app.
function bindToolsMenu() {
  const btn = document.getElementById('tools-menu-toggle');
  const list = document.getElementById('tools-menu-list');
  if (!btn || !list) return;
  const open = () => { list.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
  const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (list.hidden) open(); else close();
  });
  document.addEventListener('click', (e) => {
    if (!list.hidden && !list.contains(e.target) && e.target !== btn) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) close();
  });
}
