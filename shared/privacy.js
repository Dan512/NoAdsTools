// shared/privacy.js — tool-agnostic in-app privacy panel.
//
// Owns the <dialog> mechanism (open/close/backdrop/Escape) lifted from the
// editor's privacy.js, plus a registry: a tool calls registerPrivacyRows() to
// contribute its disclosure sections (what it fetches, the localStorage keys it
// sets, the platform-wide "what we don't do"/AI/open-source/tip sections, …)
// and initPrivacy() with the panel chrome (title/lead + a link to the tool's
// static privacy page). buildPrivacyHtml() (pure) assembles them; openPanel()
// shows the dialog.
//
// SAFETY: section bodies are author-controlled i18n HTML inserted via innerHTML
// (so <li>/<a> tags render). Same trust model as before — translations must
// NEVER interpolate user data and must be reviewed for unescaped tags.
import { t } from './i18n.js';

let dialogEl = null;
let rows = [];     // ordered { headingKey, bodyKey, kind: 'list' | 'text' }
let chrome = {};   // { titleKey, leadKey, staticHref?, staticLinkKey? }

// Register disclosure sections (additive — supports multiple registrants).
export function registerPrivacyRows(sections) {
  if (Array.isArray(sections)) rows.push(...sections);
}

// Boot. Stores the panel chrome (done BEFORE the document guard so the pure
// builder works under Node), then — in a browser — binds the privacy triggers.
export function initPrivacy(opts = {}) {
  chrome = {
    titleKey: opts.titleKey,
    leadKey: opts.leadKey,
    staticHref: opts.staticHref,
    staticLinkKey: opts.staticLinkKey,
  };
  if (typeof document === 'undefined') return;
  for (const id of ['privacy-toggle', 'privacy-toggle-header']) {
    const link = document.getElementById(id);
    if (!link) continue;
    link.addEventListener('click', (e) => { e.preventDefault(); openPanel(); });
  }
}

// Pure: assemble the panel inner HTML from the registered chrome + rows.
export function buildPrivacyHtml() {
  const sections = rows.map((s) => {
    const body = s.kind === 'list' ? `<ul>${t(s.bodyKey)}</ul>` : `<p>${t(s.bodyKey)}</p>`;
    return `<h2>${t(s.headingKey)}</h2>${body}`;
  }).join('');
  // Both keys required together — gating on staticHref alone would render a
  // "[?]undefined" link label if a future tool supplies the href without a
  // staticLinkKey (t() returns "[?]"+key for an undefined key).
  const staticLink = chrome.staticHref && chrome.staticLinkKey
    ? `<p class="privacy-static-link"><a href="${chrome.staticHref}" target="_blank" rel="noopener">${t(chrome.staticLinkKey)}</a></p>`
    : '';
  return `
    <h1>${t(chrome.titleKey)}</h1>
    <p class="lead">${t(chrome.leadKey)}</p>
    ${sections}
    ${staticLink}
  `;
}

function openPanel() {
  // Re-use the dialog if it's still in the DOM so we don't pile up instances.
  if (dialogEl && dialogEl.isConnected) {
    try { dialogEl.showModal(); } catch { dialogEl.setAttribute('open', ''); }
    return;
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'privacy-panel';
  dialog.className = 'privacy-panel-dialog';
  dialog.setAttribute('aria-label', t(chrome.titleKey));
  dialog.innerHTML = `
    <button type="button" class="dialog-close" data-close aria-label="${escapeAttr(t('close'))}">×</button>
    <article class="prose">
      ${buildPrivacyHtml()}
    </article>
  `;
  document.body.appendChild(dialog);

  dialog.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) { dialog.close(); return; }
    if (e.target === dialog) {
      // Backdrop click: hit-test so a click on the dialog padding doesn't dismiss.
      const rect = dialog.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right
                  && e.clientY >= rect.top  && e.clientY <= rect.bottom;
      if (!inside) dialog.close();
    }
  });
  dialog.addEventListener('close', () => {
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    if (dialogEl === dialog) dialogEl = null;
  });

  dialogEl = dialog;
  try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

// Local attribute escaper for the close-button aria-label (the body keys are
// trusted HTML inserted verbatim; only this attribute needs escaping).
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Test-only reset: clears the dialog, registered rows, and chrome.
export function _resetForTest() {
  if (dialogEl) {
    try { if (dialogEl.open) dialogEl.close(); } catch { /* ignore */ }
    if (dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    dialogEl = null;
  }
  rows = [];
  chrome = {};
}
