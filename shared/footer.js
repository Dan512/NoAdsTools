// shared/footer.js — the platform footer, injected at boot (replacing each
// tool's static <footer>). Reproduces the editor's existing footer links
// (#privacy-toggle, Source, tip) and appends "other NoAds tools" crosslinks
// from the live manifest (none yet — the editor is the only live tool).
import { escapeHtml } from './escape.js';
import { liveTools } from './tools.js';
import { KOFI_URL, REPO_URL } from './links.js';

export function buildFooterHtml({ toolId } = {}) {
  const others = liveTools().filter(tl => tl.slug !== toolId);
  const otherLinks = others.length
    ? `<span aria-hidden="true">·</span>` + others.map(tl =>
        `<a href="/${escapeHtml(tl.slug)}/">${escapeHtml(tl.title)}</a>`
      ).join('<span aria-hidden="true">·</span>')
    : '';

  return `
    <button id="privacy-toggle" type="button" data-i18n="privacy">Privacy</button>
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
