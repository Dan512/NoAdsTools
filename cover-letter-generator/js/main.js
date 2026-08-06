// cover-letter-generator/js/main.js — boot + wiring. Flow: load (or create) the
// letter from localStorage → fill the form + preview → every input mutates the
// model, debounce-saves (~400 ms), and rAF-throttles a preview re-render.
//
// The form is entirely static markup (no repeatable rows), so listeners are
// bound ONCE at boot and read the module-level `state` at call time. Paths that
// replace `state` (import, "use my details", clear) therefore only have to push
// the new values back into the inputs — see syncFields().
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { SCHEMA_VERSION, createLetter, migrate } from './model.js';
import { render } from './template.js';
import { loadIndex, loadLetter, saveLetter, clearAll } from './storage.js';
import { makeDocStorage } from '/shared/doc-storage.js';
import { applyPaper, printDocument } from '/shared/paper-print.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  clPrivacyTitle: 'Privacy',
  clPrivacyLead: 'This tool writes your cover letter entirely in your browser. Nothing you type — your name, address, phone, the company you are applying to, or anything you say about yourself — is ever uploaded. There is no server, no account, no tracking.',
  clPrivacyFetchHeading: 'What this page loads',
  clPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party requests at all, ever. This is the shortest list on the site.</li>',
  clPrivacyStorageHeading: 'Local storage',
  clPrivacyStorageBody: 'Your letter is saved in THIS browser’s local storage under <code>noadstools:letter:*</code> keys so a refresh never loses work — it stays on this device until you delete it or press “Clear my data”. Also stored: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:cover-letter-generator</code> (theme and chrome preferences). “Clear my data” removes only the <code>noadstools:letter:*</code> keys — any resume you saved in the resume builder is left alone.',
  clPrivacyResumeHeading: 'Reading your saved resumes',
  clPrivacyResumeBody: '“Use my details from a resume” reads the <code>noadstools:resume:*</code> keys that the resume builder saved in this same browser, so it can copy your contact details across. It only ever reads them — it never writes to or deletes a resume — and the control is hidden when no resume is saved. Nothing is sent anywhere either way.',
} });

injectTopbar({ toolId: 'cover-letter-generator', lang: false, settings: false });
injectFooter({ toolId: 'cover-letter-generator' });
initI18n();
initSettings({ toolId: 'cover-letter-generator' });
registerPrivacyRows([
  { headingKey: 'clPrivacyFetchHeading', bodyKey: 'clPrivacyFetchList', kind: 'list' },
  { headingKey: 'clPrivacyStorageHeading', bodyKey: 'clPrivacyStorageBody', kind: 'text' },
  { headingKey: 'clPrivacyResumeHeading', bodyKey: 'clPrivacyResumeBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'clPrivacyTitle', leadKey: 'clPrivacyLead' });

// --- Storage (guarded access: private-browsing can throw on the getter) -----
let store = null;
try { store = window.localStorage; store.getItem('noadstools:letter:index'); } catch { store = null; }

const $ = (id) => document.getElementById(id);
const tool = $('tool');
const panes = document.querySelector('.rb-panes');
const paper = $('paper');
const saveState = $('save-state');
const storageBanner = $('storage-banner');
const importErrors = $('import-errors');

// --- State -------------------------------------------------------------------
let state = null;
if (store) {
  const idx = loadIndex(store);
  if (idx.length) state = loadLetter(store, idx[0].id);
}
if (!state) state = createLetter();

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
    const out = saveLetter(store, state);
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

// Write any pending debounced edit NOW. Every path that REPLACES `state`
// (import) must call this first, or the timer fires after the swap and writes
// the wrong document — losing the user's last keystrokes. Clear is the
// deliberate exception: it CANCELS the timer instead, because the letter is
// being destroyed on purpose. (Carried over from resume-builder phase 3.)
function flushSave() {
  clearTimeout(saveTimer);
  if (!store || !state) return;
  saveLetter(store, state);
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
  paper.innerHTML = render(state);          // every field escaped inside render()
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

// --- Form binding --------------------------------------------------------------
// [inputId, bucket ('sender' | 'recipient' | null = top level), key]
const FIELDS = [
  ['f-fullName', 'sender', 'fullName'],
  ['f-email', 'sender', 'email'],
  ['f-phone', 'sender', 'phone'],
  ['f-location', 'sender', 'location'],
  ['f-rname', 'recipient', 'name'],
  ['f-rtitle', 'recipient', 'title'],
  ['f-rcompany', 'recipient', 'company'],
  ['f-raddress', 'recipient', 'address'],
  ['f-date', null, 'dateLine'],
  ['f-salutation', null, 'salutation'],
  ['f-body', null, 'body'],
  ['f-closing', null, 'closing'],
  ['f-signature', null, 'signature'],
];

function bindFields() {
  for (const [id, bucket, key] of FIELDS) {
    const el = $(id);
    el.addEventListener('input', () => {
      if (bucket) state[bucket][key] = el.value;
      else state[key] = el.value;
      touched();
    });
  }
}

/** Push model values into the inputs. `only` limits it to one bucket. */
function syncFields(only) {
  for (const [id, bucket, key] of FIELDS) {
    if (only && bucket !== only) continue;
    $(id).value = (bucket ? state[bucket][key] : state[key]) || '';
  }
}
const rebindSender = () => syncFields('sender');

// --- "Use my details from a resume" ---------------------------------------------
// Read the RESUME tool's saved documents (same origin, same browser) and offer
// to copy the contact block across, so the letter matches the resume without
// retyping. Read-only: we never write to the resume's keys, and we pass an
// identity migrate because we only touch a few fields and coerce them ourselves.
const resumeStore = makeDocStorage('noadstools:resume:', (raw) => raw);

function showNote(text) {
  $('use-resume-note').textContent = text;
}

function refreshResumePicker() {
  const wrap = $('use-resume-wrap');
  const sel = $('use-resume');
  const entries = store ? resumeStore.loadIndex(store) : [];
  sel.textContent = '';
  for (const entry of entries) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.name || 'Untitled resume';   // textContent → XSS inert
    sel.appendChild(opt);
  }
  // Hide the whole control when there is nothing to copy from — never show a
  // dead dropdown, and never imply we found data we did not.
  wrap.hidden = entries.length === 0;
}

$('use-resume-apply').addEventListener('click', () => {
  const r = store ? resumeStore.loadDoc(store, $('use-resume').value) : null;
  const b = r && typeof r === 'object' && r.basics && typeof r.basics === 'object' ? r.basics : null;
  if (!b) {
    showNote('Could not read that resume — it may have been deleted in another tab.');
    refreshResumePicker();
    return;
  }
  state.sender = {
    fullName: typeof b.fullName === 'string' ? b.fullName : '',
    email: typeof b.email === 'string' ? b.email : '',
    phone: typeof b.phone === 'string' ? b.phone : '',
    location: typeof b.location === 'string' ? b.location : '',
  };
  rebindSender();      // push the new values into the sender inputs
  touched();
  showNote('Contact details copied from your resume.');
});

// --- Export / import -------------------------------------------------------------
// Same contract as resume-builder's serialize: fromJson NEVER throws, and the
// current letter is replaced only on ok:true — a failed import must not destroy
// what the user has open.
function toJson(letter) {
  return JSON.stringify(letter, null, 2);
}

const NOT_OURS = 'This does not look like a cover letter file from this tool.';

function fromJson(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch {
    return { ok: false, errors: ['This file is not valid JSON.'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: [NOT_OURS] };
  if (typeof raw.schemaVersion !== 'number' || !('body' in raw || 'sender' in raw)) {
    return { ok: false, errors: [NOT_OURS] };
  }
  if (raw.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, errors: ['This file was made with a newer version of this tool — update this page (reload) and try again.'] };
  }
  return { ok: true, letter: migrate(raw) };
}

// --- Actions ----------------------------------------------------------------------
function syncPaperButtons() {
  document.querySelectorAll('#tool .seg-btn[data-paper]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.paper === state.options.paper)));
}

function applyPaperState() {
  tool.dataset.paper = state.options.paper;
  applyPaper(state.options.paper);
  syncPaperButtons();
}

document.querySelectorAll('#tool .seg-btn[data-paper]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.options.paper = btn.dataset.paper;
    applyPaperState();
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

$('download').addEventListener('click', () => printDocument(state.sender.fullName, 'Cover Letter'));

$('export').addEventListener('click', () => {
  const blob = new Blob([toJson(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const raw = state.recipient.company || state.sender.fullName || 'cover-letter';
  const stem = raw.replace(/[^\w\- ]+/g, '').trim() || 'cover-letter';
  a.href = url; a.download = `${stem}.cover-letter.json`;
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
    return;                                        // current letter untouched
  }
  importErrors.hidden = true;
  flushSave();                                     // the OUTGOING letter's last edit
  state = out.letter;
  applyPaperState();
  syncFields();
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
  if (store) clearAll(store);   // only the noadstools:letter:* prefix — resumes are untouched
  state = createLetter();
  applyPaperState();
  syncFields();
  saveState.textContent = 'Cleared';
  schedulePreview();
});

// A drop that misses any target must not navigate the tab away.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// --- Boot ---------------------------------------------------------------------------
applyPaperState();
bindFields();
syncFields();
refreshResumePicker();
renderPreview();
document.documentElement.dataset.bootReady = '1';
