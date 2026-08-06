// resume-builder/js/templates/classic.js — template A: single-column classic.
// PURE (resume) → HTML string; no DOM, no form knowledge. Single-column with
// real headings in reading order — the ATS-safe layout. Every user-derived
// string goes through escapeHtml. Relative import so this module works in
// Node tests AND the browser (resolves to /shared/escape.js when served).
import { escapeHtml } from '../../../shared/escape.js';

const e = escapeHtml;

function dateRange(start, end, current) {
  const from = (start || '').trim();
  const to = current ? 'present' : (end || '').trim();
  if (!from && !to) return '';
  return [from, to].filter(Boolean).join(' – ');
}

function bulletList(bullets) {
  const items = (bullets || []).map(b => (b || '').trim()).filter(Boolean);
  if (!items.length) return '';
  return `<ul>${items.map(b => `<li>${e(b)}</li>`).join('')}</ul>`;
}

// One entry renderer per section type. Each returns '' for a blank item so
// hasContent/section-omission stays a simple "did anything render" check.
const ENTRY = {
  experience(i) {
    const head = [i.role, i.org].map(s => (s || '').trim()).filter(Boolean);
    const meta = [i.location, dateRange(i.start, i.end, i.current)].map(s => (s || '').trim()).filter(Boolean);
    if (!head.length && !meta.length && !bulletList(i.bullets)) return '';
    return `<div class="entry">
      ${head.length ? `<p class="entry-head">${head.map(e).join(' — ')}</p>` : ''}
      ${meta.length ? `<p class="entry-meta">${meta.map(e).join(' · ')}</p>` : ''}
      ${bulletList(i.bullets)}
    </div>`;
  },
  education(i) {
    const head = [i.degree, i.school].map(s => (s || '').trim()).filter(Boolean);
    const meta = [i.location, dateRange(i.start, i.end, false), (i.note || '').trim()].filter(Boolean);
    if (!head.length && !meta.length) return '';
    return `<div class="entry">
      ${head.length ? `<p class="entry-head">${head.map(e).join(' — ')}</p>` : ''}
      ${meta.length ? `<p class="entry-meta">${meta.map(e).join(' · ')}</p>` : ''}
    </div>`;
  },
  skills(i) {
    return (i.text || '').trim(); // joined below, not one entry per line
  },
  custom(i) {
    const head = [i.heading, i.sub].map(s => (s || '').trim()).filter(Boolean);
    const meta = (i.meta || '').trim();
    if (!head.length && !meta && !bulletList(i.bullets)) return '';
    return `<div class="entry">
      ${head.length ? `<p class="entry-head">${head.map(e).join(' — ')}</p>` : ''}
      ${meta ? `<p class="entry-meta">${e(meta)}</p>` : ''}
      ${bulletList(i.bullets)}
    </div>`;
  },
};

function renderSection(sec) {
  let body = '';
  if (sec.type === 'skills') {
    const parts = sec.items.map(ENTRY.skills).filter(Boolean);
    body = parts.length ? `<p class="skills-line">${parts.map(e).join(' · ')}</p>` : '';
  } else {
    body = sec.items.map(ENTRY[sec.type]).filter(Boolean).join('');
  }
  if (!body) return ''; // omit empty sections entirely
  return `<section class="rsec">
    <h2>${e(sec.title || '')}</h2>
    ${body}
  </section>`;
}

export function render(resume) {
  const b = resume.basics || {};
  const contact = [b.email, b.phone, b.location,
    ...(b.links || []).map(l => (l.label || l.url || '').trim())]
    .map(s => (s || '').trim()).filter(Boolean);
  const summary = (resume.summary || '').trim();
  return `<div class="tpl-classic">
    <header class="rhead">
      ${b.fullName ? `<h1>${e(b.fullName)}</h1>` : ''}
      ${b.headline ? `<p class="headline">${e(b.headline)}</p>` : ''}
      ${contact.length ? `<p class="contact">${contact.map(e).join(' · ')}</p>` : ''}
    </header>
    ${summary ? `<section class="rsec"><h2>Summary</h2><p>${e(summary)}</p></section>` : ''}
    ${(resume.sections || []).map(renderSection).join('')}
  </div>`;
}
