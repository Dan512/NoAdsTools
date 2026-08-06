// cover-letter-generator/js/template.js — PURE (letter) → HTML string renderer.
// Same idiom as resume-builder's templates and the shared chrome builders: no
// DOM, no form knowledge, every user-derived string through escapeHtml.
//
// The import is RELATIVE, not '/shared/…': this module is imported by Node unit
// tests, and Node cannot resolve a root-absolute specifier. A relative path
// works in both Node and the browser.
import { escapeHtml } from '../../shared/escape.js';
import { paragraphsOf } from './model.js';

const e = escapeHtml;
const clean = (s) => (s || '').trim();

export function render(letter) {
  const s = letter.sender || {};
  const r = letter.recipient || {};
  const contact = [s.email, s.phone, s.location].map(clean).filter(Boolean);
  const recipientLines = [r.name, r.title, r.company, r.address].map(clean).filter(Boolean);
  const paras = paragraphsOf(letter.body);
  const signature = clean(letter.signature) || clean(s.fullName);
  const date = clean(letter.dateLine);

  return `<div class="tpl-letter">
    <header class="cl-sender">
      ${clean(s.fullName) ? `<h1>${e(clean(s.fullName))}</h1>` : ''}
      ${contact.length ? `<p class="cl-contact">${contact.map(e).join(' · ')}</p>` : ''}
    </header>
    ${date ? `<p class="cl-date">${e(date)}</p>` : ''}
    ${recipientLines.length
      ? `<address class="cl-recipient">${recipientLines.map(e).join('<br>')}</address>` : ''}
    ${clean(letter.salutation) ? `<p class="cl-salutation">${e(clean(letter.salutation))}</p>` : ''}
    ${paras.map(p => `<p class="cl-para">${e(p)}</p>`).join('')}
    ${clean(letter.closing) ? `<p class="cl-closing">${e(clean(letter.closing))}</p>` : ''}
    ${signature ? `<p class="cl-signature">${e(signature)}</p>` : ''}
  </div>`;
}
