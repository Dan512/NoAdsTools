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
import { privacyHref } from './footer.js';

// The dropdown lists every live tool, which is 20 and climbing, so it is
// grouped rather than one flat column. Categories not named here fall into
// "Other tools" — today that is just the QR generator, and 'dev' has no live
// tools at all. Empty groups are omitted.
// `href` points at the category landing page where one exists. Linking the
// caption gives those pages an inbound link from every page on the site
// instead of the single one on the homepage, which is most of what gets a
// category page crawled at all. "Other tools" has no page, so it stays a
// plain caption.
const MENU_GROUPS = Object.freeze([
  { id: 'image', label: 'Image tools', href: '/image-tools/' },
  { id: 'pdf', label: 'PDF tools', href: '/pdf-tools/' },
  { id: 'video', label: 'Video tools', href: null },
  { id: 'documents', label: 'Document tools', href: '/document-tools/' },
]);
const OTHER_LABEL = 'Other tools';

// ARIA: role="group" is a valid child of role="menu"; a bare heading element
// would violate aria-required-children. The group carries the name via
// aria-label, and the visible caption is aria-hidden so it is not announced
// twice.
export function buildToolsMenuGroups(toolId) {
  const tools = liveTools();
  const named = new Set(MENU_GROUPS.map(g => g.id));
  const groups = [
    ...MENU_GROUPS.map(g => ({
      label: g.label, href: g.href, items: tools.filter(t => t.category === g.id),
    })),
    { label: OTHER_LABEL, href: null, items: tools.filter(t => !named.has(t.category)) },
  ].filter(g => g.items.length > 0);

  return groups.map(g => {
    const items = g.items.map(tl => {
      const here = tl.slug === toolId ? ' aria-current="page"' : '';
      return `<a role="menuitem" class="tools-menu-item" href="/${escapeHtml(tl.slug)}/"${here}>${escapeHtml(tl.title)}</a>`;
    }).join('');
    // A linked caption is a real menuitem, so it must NOT be aria-hidden or
    // keyboard users could not reach it. An unlinked caption stays hidden from
    // AT because the group's aria-label already announces the same words.
    const caption = g.href
      ? `<a role="menuitem" class="tools-menu-heading tools-menu-heading-link" href="${escapeHtml(g.href)}">${escapeHtml(g.label)}</a>`
      : `<span class="tools-menu-heading" aria-hidden="true">${escapeHtml(g.label)}</span>`;
    return `<div role="group" class="tools-menu-group" aria-label="${escapeHtml(g.label)}">`
      + `${caption}${items}</div>`;
  }).join('');
}

export function buildTopbarHtml({ toolId, lang = true, settings = true } = {}) {
  const current = toolBySlug(toolId);
  const toolName = current ? current.title : '';
  const toolSpan = toolName
    ? ` <span class="wordmark-tool">${escapeHtml(toolName)}</span>`
    : '';

  const menuItems = buildToolsMenuGroups(toolId);

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
      <a id="privacy-toggle-header" class="header-link header-only-desktop" href="${privacyHref(toolId)}" data-i18n="privacy">Privacy</a>
    </div>`;
}

// Module scripts are deferred, so this runs AFTER first paint. Inserting a
// 56px-tall header at that point shoves the whole page down by 56px, which is
// a visible jump on a cold load and a real CLS hit. Pages therefore ship an
// empty <header class="topbar"> in their static HTML to reserve the space, and
// we fill that in place instead of inserting. The insert path stays for any
// page that has no placeholder.
export function injectTopbar(opts = {}) {
  if (typeof document === 'undefined') return;
  const placeholder = document.querySelector('body > header.topbar');
  const header = placeholder || document.createElement('header');
  header.className = 'topbar';
  header.removeAttribute('aria-hidden');   // reserved-space markup is inert until filled
  header.innerHTML = buildTopbarHtml(opts);
  if (!placeholder) document.body.insertBefore(header, document.body.firstChild);
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
