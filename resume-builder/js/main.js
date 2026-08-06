// resume-builder/js/main.js — boot + wiring. Flow: load (or create) the resume
// from localStorage → render form + preview → every input mutates the model,
// debounce-saves (~400 ms), and rAF-throttles a preview re-render. The form is
// REBUILT only on structural changes (add/remove section/item/link); field
// listeners mutate their captured item directly (per-row capture — playbook).
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { createResume, addItem, removeItem, addSection, removeSection,
  moveItem, moveSection, moveItemTo, moveSectionTo, genResumeId } from './model.js';
import { toJson, fromJson } from './serialize.js';
import { TEMPLATES } from './templates/registry.js';
import { loadIndex, loadResume, saveResume, clearAll, removeResume } from './storage.js';
import { applyPaper, printDocument } from '/shared/paper-print.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  rbPrivacyTitle: 'Privacy',
  rbPrivacyLead: 'This tool builds your resume entirely in your browser. Nothing you type — name, address, phone, work history — is ever uploaded. There is no server, no account, no tracking.',
  rbPrivacyFetchHeading: 'What this page loads',
  rbPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party requests at all, ever. This is the shortest list on the site.</li>',
  rbPrivacyStorageHeading: 'Local storage',
  rbPrivacyStorageBody: 'Every resume you create is saved in THIS browser’s local storage under <code>noadstools:resume:*</code> keys so a refresh never loses work — they stay on this device until you delete them or press “Clear my data”. Also stored: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:resume-builder</code> (theme and chrome preferences). On a shared computer, export a .json copy and clear your data when done.',
} });

injectTopbar({ toolId: 'resume-builder', lang: false, settings: false });
injectFooter({ toolId: 'resume-builder' });
initI18n();
initSettings({ toolId: 'resume-builder' });
registerPrivacyRows([
  { headingKey: 'rbPrivacyFetchHeading', bodyKey: 'rbPrivacyFetchList', kind: 'list' },
  { headingKey: 'rbPrivacyStorageHeading', bodyKey: 'rbPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'rbPrivacyTitle', leadKey: 'rbPrivacyLead' });

// --- Storage (guarded access: private-browsing can throw on the getter) -----
let store = null;
try { store = window.localStorage; store.getItem('noadstools:resume:index'); } catch { store = null; }

const $ = (id) => document.getElementById(id);
const tool = $('tool');
const panes = document.querySelector('.rb-panes');
const formSections = $('form-sections');
const paper = $('paper');
const saveState = $('save-state');
const storageBanner = $('storage-banner');
const importErrors = $('import-errors');

// --- State -------------------------------------------------------------------
let state = null;
if (store) {
  const idx = loadIndex(store);
  if (idx.length) state = loadResume(store, idx[0].id);
}
if (!state) state = createResume();

if (!store) {
  storageBanner.textContent = 'This browser is blocking local saves — your work only lives on this screen. Export a .json to keep it.';
  storageBanner.hidden = false;
  saveState.textContent = 'Not saving';
}

// --- Save / preview scheduling ------------------------------------------------
let saveTimer = 0;
function scheduleSave() {
  if (!store) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = saveResume(store, state);
    if (out.ok) {
      const t = new Date();
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      saveState.textContent = `Saved · ${hh}:${mm}`;
    } else {
      saveState.textContent = 'Not saving';
      storageBanner.textContent = 'Saving failed (storage may be full or blocked) — export a .json to keep your work.';
      storageBanner.hidden = false;
    }
  }, 400);
}

// Write any pending debounced edit NOW. Every path that replaces `state`
// (switch / new / duplicate / import) must call this first, or the timer fires
// after the swap and writes the wrong resume — losing the user's last
// keystrokes. Delete is the deliberate exception: it CANCELS the timer instead,
// because the resume is being destroyed on purpose (same reasoning as Clear).
function flushSave() {
  clearTimeout(saveTimer);
  if (!store || !state) return;
  saveResume(store, state);
}

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    renderPreview();
  });
}

const PAGE_PX = { letter: 11 * 96, a4: 297 * 96 / 25.4 }; // CSS px per page height
function renderPreview() {
  // Fallback guard: migrate() keeps any non-empty template string, so an
  // imported file naming an unknown template must not crash the preview.
  const template = TEMPLATES[state.template] || TEMPLATES.classic;
  paper.innerHTML = template.render(state);
  fitPreview();
  const pages = Math.max(1, Math.ceil(paper.offsetHeight / PAGE_PX[state.options.paper]));
  $('page-count').textContent = pages === 1 ? '1 page' : `${pages} pages`;
}

function fitPreview() {
  const wrap = $('paper-wrap');
  const scale = Math.min(1, wrap.clientWidth / paper.offsetWidth);
  paper.style.transform = `scale(${scale})`;
  wrap.style.height = `${paper.offsetHeight * scale}px`;
}
window.addEventListener('resize', fitPreview);

function touched() { scheduleSave(); schedulePreview(); }

// --- Form builders (DOM API — no HTML strings, so no escaping needed here) ----
function textField(labelText, value, onInput, attrs = {}) {
  const label = document.createElement('label');
  label.append(labelText);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
  input.addEventListener('input', () => { onInput(input.value); touched(); });
  label.appendChild(input);
  return label;
}

function areaField(labelText, value, onInput, attrs = {}) {
  const label = document.createElement('label');
  label.append(labelText);
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.value = value || '';
  for (const [k, v] of Object.entries(attrs)) ta.setAttribute(k, v);
  ta.addEventListener('input', () => { onInput(ta.value); touched(); });
  label.appendChild(ta);
  return label;
}

function button(text, onClick, aria) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (aria) b.setAttribute('aria-label', aria);
  b.addEventListener('click', onClick);
  return b;
}

// Basics are static inputs in index.html — bind once.
function bindBasics() {
  const map = [['f-fullName', 'fullName'], ['f-headline', 'headline'], ['f-email', 'email'],
    ['f-phone', 'phone'], ['f-location', 'location']];
  for (const [id, key] of map) {
    const el = $(id);
    el.value = state.basics[key] || '';
    el.addEventListener('input', () => { state.basics[key] = el.value; touched(); });
  }
  const sum = $('f-summary');
  sum.value = state.summary || '';
  sum.addEventListener('input', () => { state.summary = sum.value; touched(); });
  renderLinks();
  $('add-link').addEventListener('click', () => {
    state.basics.links.push({ id: `l_${Date.now().toString(36)}`, label: '', url: '' });
    renderLinks(); touched();
  });
}

function renderLinks() {
  const list = $('links-list');
  list.textContent = '';
  state.basics.links.forEach((link) => {          // capture PER LINK (playbook)
    const row = document.createElement('div');
    row.className = 'link-row';
    row.appendChild(textField('Label', link.label, (v) => { link.label = v; }, { placeholder: 'Portfolio' }));
    row.appendChild(textField('URL', link.url, (v) => { link.url = v; }, { placeholder: 'https://…' }));
    row.appendChild(button('Remove', () => {
      state.basics.links = state.basics.links.filter(l => l !== link);
      renderLinks(); touched();
    }, 'Remove link'));
    list.appendChild(row);
  });
}

// Per-type entry field definitions: [label, key, kind]
const FIELDS = {
  experience: [['Job title', 'role'], ['Company', 'org'], ['Location', 'location'],
    ['Start', 'start'], ['End', 'end']],
  education: [['Degree / program', 'degree'], ['School', 'school'], ['Location', 'location'],
    ['Start', 'start'], ['End', 'end'], ['Note', 'note']],
  skills: [['Skill', 'text']],
  custom: [['Heading', 'heading'], ['Subheading', 'sub'], ['When / where', 'meta']],
};

function entrySummaryText(sec, item) {
  const head = sec.type === 'experience' ? [item.role, item.org]
    : sec.type === 'education' ? [item.degree, item.school]
    : sec.type === 'custom' ? [item.heading]
    : [item.text];
  return head.map(s => (s || '').trim()).filter(Boolean).join(' · ') || 'New entry';
}

function renderEntry(sec, item) {                  // capture PER ITEM (playbook)
  const det = document.createElement('details');
  det.className = 'entry';
  det.open = true;
  const summary = document.createElement('summary');
  // The live title gets its OWN span: field listeners rewrite it on every
  // keystroke, and `summary.textContent = …` would wipe the drag handle with it.
  const summaryText = document.createElement('span');
  summaryText.className = 'entry-title';
  summaryText.textContent = entrySummaryText(sec, item);
  summary.appendChild(summaryText);
  det.appendChild(summary);
  summary.prepend(makeDragHandle(
    det,
    () => [...det.parentElement.querySelectorAll(':scope > details.entry')],
    (index) => moveItemTo(state, sec.id, item.id, index),
  ));

  for (const [labelText, key] of FIELDS[sec.type]) {
    det.appendChild(textField(labelText, item[key], (v) => {
      item[key] = v;
      summaryText.textContent = entrySummaryText(sec, item);
    }));
  }
  if (sec.type === 'experience') {
    const cur = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.current;
    cb.addEventListener('change', () => { item.current = cb.checked; touched(); });
    cur.appendChild(cb);
    cur.append(' I currently work here');
    det.appendChild(cur);
  }
  if (sec.type === 'experience' || sec.type === 'custom') {
    det.appendChild(areaField('Bullet points (one per line)', (item.bullets || []).join('\n'), (v) => {
      item.bullets = v.split('\n');
    }));
  }
  const actions = document.createElement('div');
  actions.className = 'entry-actions';
  const idx = sec.items.findIndex(i => i.id === item.id);
  const label = entrySummaryText(sec, item);
  actions.appendChild(moveButton(-1, `up:i:${item.id}`, `Move entry up: ${label}`,
    idx === 0, () => moveItem(state, sec.id, item.id, -1)));
  actions.appendChild(moveButton(+1, `down:i:${item.id}`, `Move entry down: ${label}`,
    idx === sec.items.length - 1, () => moveItem(state, sec.id, item.id, +1)));
  actions.appendChild(button('Remove entry', () => {
    removeItem(state, sec.id, item.id);
    renderFormSections(); touched();
  }, `Remove entry: ${label}`));
  det.appendChild(actions);
  return det;
}

// Reordering rebuilds the form, which destroys focus. Each move-button carries
// a stable data-focus-key; we record the focused key before the rebuild and
// restore it after, so a keyboard user can press ▲ repeatedly. If the button
// became disabled (the row reached an end), fall back to its sibling so focus
// never lands on nothing.
function focusKeyOf(el) { return el && el.dataset ? el.dataset.focusKey || '' : ''; }

function rerenderFormPreservingFocus() {
  const key = focusKeyOf(document.activeElement);
  renderFormSections();
  if (!key) return;
  let target = formSections.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  if (target && target.disabled) {
    const sibKey = key.startsWith('up:') ? key.replace(/^up:/, 'down:') : key.replace(/^down:/, 'up:');
    const sib = formSections.querySelector(`[data-focus-key="${CSS.escape(sibKey)}"]`);
    if (sib && !sib.disabled) target = sib;
  }
  if (target) target.focus();
}

// A ▲/▼ move control. Colorblind-safe by construction: the glyph and the
// aria-label carry the meaning, never colour. Disabled at the ends of the list
// so the control honestly reflects that there is nowhere further to go.
function moveButton(dir, focusKey, ariaLabel, atBound, onMove) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'move-btn';
  b.textContent = dir < 0 ? '▲' : '▼';
  b.dataset.focusKey = focusKey;
  b.setAttribute('aria-label', ariaLabel);
  b.disabled = atBound;
  b.addEventListener('click', () => { onMove(); touched(); rerenderFormPreservingFocus(); });
  return b;
}

// Generic vertical drag-to-reorder over a row's siblings. PointerEvents only —
// one path for mouse, touch and pen. The ▲▼ buttons remain the accessible
// path; this is the convenience layer, so it never becomes the only way.
function makeDragHandle(row, getSiblings, commit) {
  // A SPAN, not a button, and with no tabindex at all: the entry handle lives
  // inside <summary>, which is itself an interactive control — a nested button
  // (even aria-hidden + tabindex="-1") is an axe `nested-interactive` serious
  // violation. The ▲▼ buttons are the a11y path, so this needs no role.
  const h = document.createElement('span');
  h.className = 'drag-handle';
  h.textContent = '⠿';
  h.setAttribute('aria-hidden', 'true');   // ▲▼ buttons are the a11y path
  let dragging = false;
  let targetIndex = -1;

  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    targetIndex = -1;
    row.classList.add('is-dragging');
    try { h.setPointerCapture(e.pointerId); } catch { /* older engines */ }
  });

  h.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const sibs = getSiblings();
    let idx = sibs.length - 1;
    for (let i = 0; i < sibs.length; i++) {
      const r = sibs[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = i; break; }
    }
    if (idx !== targetIndex) {
      targetIndex = idx;
      sibs.forEach((s, i) => s.classList.toggle('is-drop-target', i === idx && s !== row));
    }
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    row.classList.remove('is-dragging');
    getSiblings().forEach(s => s.classList.remove('is-drop-target'));
    try { h.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (targetIndex >= 0) { commit(targetIndex); touched(); renderFormSections(); }
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  // The handle lives inside <summary>; a bubbling click would toggle the
  // <details> open/closed after every drag (and on a plain tap). The handle is
  // aria-hidden + tabIndex -1, so suppressing its click costs nothing.
  h.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  return h;
}

function renderFormSections() {
  formSections.textContent = '';
  state.sections.forEach((sec) => {                // capture PER SECTION
    const card = document.createElement('section');
    card.className = 'card';
    const head = document.createElement('div');
    head.className = 'sec-head';
    head.prepend(makeDragHandle(
      card,
      () => [...formSections.querySelectorAll(':scope > section.card')],
      (index) => moveSectionTo(state, sec.id, index),
    ));
    const title = document.createElement('input');
    title.type = 'text';
    title.value = sec.title;
    title.setAttribute('aria-label', 'Section title');
    title.addEventListener('input', () => { sec.title = title.value; touched(); });
    head.appendChild(title);
    const sIdx = state.sections.findIndex(s => s.id === sec.id);
    head.appendChild(moveButton(-1, `up:s:${sec.id}`, `Move section up: ${sec.title}`,
      sIdx === 0, () => moveSection(state, sec.id, -1)));
    head.appendChild(moveButton(+1, `down:s:${sec.id}`, `Move section down: ${sec.title}`,
      sIdx === state.sections.length - 1, () => moveSection(state, sec.id, +1)));
    head.appendChild(button('Remove section', () => {
      removeSection(state, sec.id);
      renderFormSections(); touched();
    }, `Remove section: ${sec.title}`));
    card.appendChild(head);
    sec.items.forEach((item) => card.appendChild(renderEntry(sec, item)));
    card.appendChild(button(sec.type === 'skills' ? 'Add skill' : 'Add entry', () => {
      addItem(state, sec.id);
      renderFormSections(); touched();
    }));
    formSections.appendChild(card);
  });
}

// --- Multiple resumes ---------------------------------------------------------
const switcher = $('resume-switcher');
const nameInput = $('resume-name');

// Rebuild the dropdown from the storage index, keeping the current resume
// selected. The current resume is always present even if the store is blocked.
function renderSwitcher() {
  const entries = store ? loadIndex(store) : [];
  const seen = new Set(entries.map(e => e.id));
  const list = seen.has(state.id)
    ? entries
    : [{ id: state.id, name: state.name }, ...entries];
  switcher.textContent = '';
  for (const entry of list) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.name || 'Untitled resume';   // textContent → XSS inert
    switcher.appendChild(opt);
  }
  switcher.value = state.id;
  switcher.disabled = list.length < 2;
  nameInput.value = state.name || '';
}

// Swap to a different resume object. Callers MUST have flushed (or, when the
// old resume is being destroyed, cancelled) the pending save already.
function adoptResume(next) {
  state = next;
  // A primed Delete must NOT carry across a resume swap: otherwise arming it on
  // resume A, switching, then clicking again would delete resume B with no
  // confirm step of its own. Every destructive action confirms for the resume
  // it actually destroys.
  disarmDelete();
  tool.dataset.paper = state.options.paper;
  applyPaper(state.options.paper);
  syncPaperButtons();
  rebindAll();
  renderSwitcher();
  schedulePreview();
}

switcher.addEventListener('change', () => {
  const id = switcher.value;
  if (!store || id === state.id) return;
  flushSave();                                   // keep the edit we just made
  const next = loadResume(store, id);
  if (!next) { renderSwitcher(); return; }       // vanished: re-sync, keep current
  adoptResume(next);
  saveState.textContent = 'Switched';
});

nameInput.addEventListener('input', () => {
  state.name = nameInput.value;
  const opt = switcher.querySelector(`option[value="${CSS.escape(state.id)}"]`);
  if (opt) opt.textContent = state.name || 'Untitled resume';
  touched();
});

$('resume-new').addEventListener('click', () => {
  flushSave();
  const next = createResume();
  if (store) saveResume(store, next);
  adoptResume(next);
  saveState.textContent = 'New resume';
});

$('resume-duplicate').addEventListener('click', () => {
  flushSave();
  // Plain-JSON model → a JSON round-trip is a safe deep clone. Only the RESUME
  // id must change; section/item ids are scoped to one resume, and only one
  // resume is ever rendered at a time.
  const copy = JSON.parse(JSON.stringify(state));
  copy.id = genResumeId();
  copy.name = `${state.name || 'Untitled resume'} (copy)`;
  if (store) saveResume(store, copy);
  adoptResume(copy);
  saveState.textContent = 'Duplicated';
});

let deleteArmed = false;
function disarmDelete() {
  deleteArmed = false;
  $('resume-delete').textContent = 'Delete';
}
$('resume-delete').addEventListener('click', () => {
  if (!deleteArmed) {
    deleteArmed = true;
    $('resume-delete').textContent = 'Click again to delete';
    setTimeout(disarmDelete, 4000);
    return;
  }
  disarmDelete();
  clearTimeout(saveTimer);                       // deleting: do NOT flush it back
  const goneId = state.id;
  if (store) removeResume(store, goneId);
  // Fall back to the next stored resume, or a fresh blank one — the tool must
  // never be left with nothing loaded.
  const rest = store ? loadIndex(store).filter(e => e.id !== goneId) : [];
  let next = rest.length && store ? loadResume(store, rest[0].id) : null;
  if (!next) {
    next = createResume();
    if (store) saveResume(store, next);
  }
  adoptResume(next);
  saveState.textContent = 'Deleted';
});

// --- Actions -------------------------------------------------------------------
function syncPaperButtons() {
  document.querySelectorAll('#tool .seg-btn[data-paper]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.paper === state.options.paper)));
}

document.querySelectorAll('#tool .seg-btn[data-paper]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.options.paper = btn.dataset.paper;
    tool.dataset.paper = state.options.paper;
    applyPaper(state.options.paper);
    syncPaperButtons();
    touched();
  });
});

document.querySelectorAll('#tool .seg-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    panes.dataset.view = btn.dataset.view;
    document.querySelectorAll('#tool .seg-btn[data-view]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));
    if (btn.dataset.view === 'preview') fitPreview();
  });
});

$('download').addEventListener('click', () => printDocument(state.basics.fullName, 'Resume'));

$('export').addEventListener('click', () => {
  const blob = new Blob([toJson(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stem = (state.name || 'resume').replace(/[^\w\- ]+/g, '').trim() || 'resume';
  a.href = url; a.download = `${stem}.resume.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

$('import-input').addEventListener('change', async () => {
  const file = $('import-input').files[0];
  $('import-input').value = '';
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    importErrors.textContent = 'Could not read this file — try again.';
    importErrors.hidden = false;
    return;
  }
  const out = fromJson(text);
  if (!out.ok) {
    importErrors.textContent = `Could not import: ${out.errors.join(' ')}`;
    importErrors.hidden = false;
    return;                                        // current resume untouched
  }
  importErrors.hidden = true;
  flushSave();                                     // the OUTGOING resume's last edit
  state = out.resume;
  tool.dataset.paper = state.options.paper;
  applyPaper(state.options.paper);
  syncPaperButtons();
  rebindAll();
  renderSwitcher();                                // the imported resume is now current
  touched();
});

let clearArmed = false;
$('clear-data').addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true;
    $('clear-data').textContent = 'Click again to confirm clearing';
    setTimeout(() => { clearArmed = false; $('clear-data').textContent = 'Clear my data'; }, 4000);
    return;
  }
  clearArmed = false;
  $('clear-data').textContent = 'Clear my data';
  clearTimeout(saveTimer); // a pending debounced save must not resurrect the cleared keys
  if (store) clearAll(store);
  state = createResume();
  tool.dataset.paper = state.options.paper;
  applyPaper(state.options.paper);
  syncPaperButtons();
  rebindAll();
  renderSwitcher();          // every stored resume is gone — the list must say so
  saveState.textContent = 'Cleared';
  schedulePreview();
});

$('add-section').addEventListener('click', () => {
  addSection(state, $('add-section-type').value);
  renderFormSections(); touched();
});

// A drop that misses any target must not navigate the tab away.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

function rebindAll() {
  // Static basics inputs keep their old listeners; reset values and let the
  // shared listeners read the NEW state via closure — simplest correct way is
  // to re-run bindBasics against fresh nodes: clone-and-replace basics card.
  const card = $('basics-card');
  const fresh = card.cloneNode(true);
  card.replaceWith(fresh);
  bindBasics();
  renderFormSections();
}

// --- Boot ----------------------------------------------------------------------
tool.dataset.paper = state.options.paper;
applyPaper(state.options.paper);
syncPaperButtons();
bindBasics();
renderFormSections();
renderPreview();
renderSwitcher();
document.documentElement.dataset.bootReady = '1';
