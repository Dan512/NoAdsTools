// shared/footer.js — the platform footer, injected at boot (replacing each
// tool's static <footer>). Carries the Privacy link, Source, tip, and "other
// NoAds tools" crosslinks from the live manifest.
//
// Privacy is a LINK to the single /privacy.html, not an in-app dialog. The
// per-tool panels were retired in favour of one page: 19 of the 20 panels were
// English-only anyway, and keeping 20 copies of the disclosure in sync is what
// let nine pages ship a false offline claim. The link carries a #<slug> anchor
// so a tool lands the reader on its own row of the table.
import { escapeHtml } from './escape.js';
import { liveTools } from './tools.js';
import { KOFI_URL, REPO_URL } from './links.js';

export function privacyHref(toolId) {
  return toolId ? `/privacy.html#${encodeURIComponent(toolId)}` : '/privacy.html';
}

export function buildFooterHtml({ toolId } = {}) {
  const others = liveTools().filter(tl => tl.slug !== toolId);
  const otherLinks = others.length
    ? `<span aria-hidden="true">·</span>` + others.map(tl =>
        `<a href="/${escapeHtml(tl.slug)}/">${escapeHtml(tl.title)}</a>`
      ).join('<span aria-hidden="true">·</span>')
    : '';

  return `
    <a id="privacy-toggle" href="${privacyHref(toolId)}" data-i18n="privacy">Privacy</a>
    <span aria-hidden="true">·</span>
    <a href="${REPO_URL}" target="_blank" rel="noopener" data-i18n="source" title="Source code on GitHub">Source</a>
    <span aria-hidden="true">·</span>
    <a href="${KOFI_URL}" target="_blank" rel="noopener" data-i18n="tipFooter">Support this site</a>${otherLinks}`;
}

export function injectFooter(opts = {}) {
  if (typeof document === 'undefined') return;
  const footer = document.createElement('footer');
  footer.innerHTML = buildFooterHtml(opts);
  document.body.appendChild(footer);
}
