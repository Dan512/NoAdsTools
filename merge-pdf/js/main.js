// merge-pdf/js/main.js — boot + tool wiring. English-first; minimal chrome (no
// language picker / settings gear); shared privacy panel with this tool's
// disclosure. Flow: intake (picker / drop / paste, PDF allowlist) → each file
// through merge.js's addPdf (reads page count via lazy pdf-lib, classifies
// locked/error) → ordered rows (ordinal + drag handle + ▲/▼ + Remove) → Merge &
// download (copyPages into a fresh doc) → merged.pdf. Reorder works two ways:
// PointerEvents drag (mouse + touch + pen) and the ▲/▼ buttons (keyboard/a11y
// path). pdf-lib is 0 bytes until the first PDF is added.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { escapeHtml } from '/shared/escape.js';
import { isPdf } from './intake.js';
import { moveUp, moveDown, moveTo, removeAt } from './reorder.js';
import { addPdf, mergeItems, PdfEngineError } from './merge.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  mpPrivacyTitle: 'Privacy',
  mpPrivacyLead: 'This tool merges your PDFs into one entirely in your browser. Your PDFs never leave your device — no upload, no account, no tracking — and the metadata inside the source files is not carried into the merged file.',
  mpPrivacyFetchHeading: 'What this page loads',
  mpPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The pdf-lib library (~511 KB, from this origin) — ONLY when you add a PDF. Used to read page counts and combine the PDFs locally.</li>',
  mpPrivacyStorageHeading: 'Local storage',
  mpPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:merge-pdf</code>. No PDF data is ever stored.',
} });

injectTopbar({ toolId: 'merge-pdf', lang: false, settings: false });
injectFooter({ toolId: 'merge-pdf' });
initI18n();
initSettings({ toolId: 'merge-pdf' });
registerPrivacyRows([
  { headingKey: 'mpPrivacyFetchHeading', bodyKey: 'mpPrivacyFetchList', kind: 'list' },
  { headingKey: 'mpPrivacyStorageHeading', bodyKey: 'mpPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'mpPrivacyTitle', leadKey: 'mpPrivacyLead' });

// --- State -------------------------------------------------------------------
// items: ordered list of { id, file, name, size, pageCount, status, error, bytes }.
let items = [];
let nextId = 1;
let merging = false;

const dropzone = document.getElementById('dropzone');
const input = document.getElementById('file-input');
const intakeNote = document.getElementById('intake-note');
const workspace = document.getElementById('workspace');
const summary = document.getElementById('summary');
const list = document.getElementById('list');
const mergeBtn = document.getElementById('merge');
const clearBtn = document.getElementById('clear');
const mergeHint = document.getElementById('merge-hint');
const mergeError = document.getElementById('merge-error');

const plural = (n, word) => (n === 1 ? word : `${word}s`);

function prettyBytes(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// --- Intake ------------------------------------------------------------------

input.addEventListener('change', () => { intake([...input.files]); input.value = ''; });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); dropzone.classList.remove('is-drag');
  intake([...(e.dataTransfer?.files ?? [])]);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) intake(files);
});
// A drop that misses the dropzone must not navigate the tab away (which would
// destroy the assembled list). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function intake(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdfs = files.filter((f) => isPdf(f.name, f.type));
  const skipped = files.length - pdfs.length;
  let engineFailed = false;

  for (const file of pdfs) {
    try {
      items.push(await addPdf(file, nextId++));
    } catch (e) {
      if (e instanceof PdfEngineError) { engineFailed = true; break; }
      // Any other unexpected throw becomes an honest error row, not a silent drop.
      items.push({ id: nextId++, file, name: file.name, size: file.size, pageCount: 0, status: 'error', error: 'unreadable', bytes: null });
    }
    render(); // progressive: each row appears as its page count resolves
  }
  render();
  showIntakeNote({ skipped, added: pdfs.length, engineFailed });
}

function showIntakeNote({ skipped, added, engineFailed }) {
  if (engineFailed) {
    // Engine failure is not the file's fault — say so, and don't blame the PDF.
    intakeNote.textContent = 'Couldn’t load the PDF engine — check your connection and add the files again.';
    intakeNote.hidden = false;
    return;
  }
  if (skipped > 0 && added === 0) {
    intakeNote.textContent = `Skipped ${skipped} non-PDF ${plural(skipped, 'file')} — this tool merges PDFs only.`;
    intakeNote.hidden = false;
  } else if (skipped > 0) {
    intakeNote.textContent = `Added ${added} ${plural(added, 'PDF')} · skipped ${skipped} non-PDF ${plural(skipped, 'file')}.`;
    intakeNote.hidden = false;
  } else {
    intakeNote.hidden = true;
  }
}

// --- Render ------------------------------------------------------------------

// focusSpec {id, act} restores keyboard focus after a Move re-render so keyboard
// users don't lose their place.
function render(focusSpec) {
  workspace.hidden = items.length === 0;

  let ord = 0;
  const okItems = items.filter((it) => it.status === 'ok');
  list.innerHTML = items.map((it, i) => {
    const name = escapeHtml(it.name);
    const sizeText = prettyBytes(it.size);
    let ordLabel;
    let rowClass = '';
    let meta;
    if (it.status === 'ok') {
      ord += 1;
      ordLabel = String(ord);
      meta = `${it.pageCount} ${plural(it.pageCount, 'page')} · ${sizeText}`;
    } else if (it.status === 'locked') {
      ordLabel = '—';
      rowClass = ' is-locked';
      meta = `🔒 Password-protected — unlock it first · excluded · ${sizeText}`;
    } else {
      ordLabel = '—';
      rowClass = ' is-error';
      meta = `⚠ Couldn’t read this PDF · excluded · ${sizeText}`;
    }
    const isFirst = i === 0;
    const isLast = i === items.length - 1;
    return `<li class="pdf-row${rowClass}" data-id="${it.id}">
      <span class="ord" aria-hidden="true">${ordLabel}</span>
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⠇</span>
      <div class="row-body">
        <div class="row-name">${name}</div>
        <div class="row-meta">${meta}</div>
      </div>
      <div class="row-controls">
        <button type="button" data-act="up" aria-label="Move ${name} up"${isFirst ? ' disabled' : ''}>▲ Up</button>
        <button type="button" data-act="down" aria-label="Move ${name} down"${isLast ? ' disabled' : ''}>▼ Down</button>
        <button type="button" data-act="remove" aria-label="Remove ${name}">✕ Remove</button>
      </div>
    </li>`;
  }).join('');

  const totalPages = okItems.reduce((s, it) => s + it.pageCount, 0);
  if (okItems.length >= 2) {
    summary.textContent = `Merging ${okItems.length} files → ${totalPages} ${plural(totalPages, 'page')}`;
    mergeHint.hidden = true;
  } else if (okItems.length === 1) {
    summary.textContent = `1 PDF ready → ${totalPages} ${plural(totalPages, 'page')}`;
    mergeHint.textContent = 'Add at least one more PDF to merge.';
    mergeHint.hidden = false;
  } else {
    summary.textContent = 'No readable PDFs to merge yet.';
    mergeHint.textContent = items.length ? 'The files above could not be read — add a readable PDF.' : '';
    mergeHint.hidden = !items.length;
  }
  if (!merging) mergeBtn.disabled = okItems.length < 2;

  if (focusSpec) {
    const row = list.querySelector(`li[data-id="${focusSpec.id}"]`);
    const btn = row?.querySelector(`button[data-act="${focusSpec.act}"]`);
    if (btn && !btn.disabled) btn.focus();
    else row?.querySelector('button:not([disabled])')?.focus();
  }
}

// --- Reorder: ▲/▼ buttons + Remove (keyboard/a11y path) ----------------------

list.addEventListener('click', (e) => {
  if (merging) return;
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('li[data-id]');
  if (!li) return;
  const id = Number(li.dataset.id);
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return;
  const act = btn.dataset.act;
  if (act === 'up') { items = moveUp(items, idx); render({ id, act: 'up' }); }
  else if (act === 'down') { items = moveDown(items, idx); render({ id, act: 'down' }); }
  else if (act === 'remove') { items = removeAt(items, idx); render(); }
});

// --- Reorder: PointerEvents drag (mouse + touch + pen) -----------------------
// The row is not re-rendered mid-drag — only a marker class moves — so the
// pointer capture on the handle stays valid until pointerup commits the move.
let drag = null; // { id, fromIndex, pointerId, insertAt }

function clearDragMarkers() {
  for (const r of list.querySelectorAll('.insert-before, .insert-after, .dragging')) {
    r.classList.remove('insert-before', 'insert-after', 'dragging');
  }
}

list.addEventListener('pointerdown', (e) => {
  if (merging) return;
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  const li = handle.closest('li[data-id]');
  if (!li) return;
  const id = Number(li.dataset.id);
  const fromIndex = items.findIndex((it) => it.id === id);
  if (fromIndex < 0) return;
  e.preventDefault();
  drag = { id, fromIndex, pointerId: e.pointerId, insertAt: fromIndex };
  try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  li.classList.add('dragging');
});

list.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  const rows = [...list.querySelectorAll('li[data-id]')];
  const y = e.clientY;
  // insertAt = index (in the current, dragged-row-included array) BEFORE which
  // the dragged row would land; rows.length means "at the end".
  let insertAt = rows.length;
  for (let i = 0; i < rows.length; i += 1) {
    const rect = rows[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) { insertAt = i; break; }
  }
  drag.insertAt = insertAt;
  rows.forEach((r, i) => {
    r.classList.toggle('insert-before', i === insertAt);
    r.classList.toggle('insert-after', insertAt === rows.length && i === rows.length - 1);
  });
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { fromIndex, insertAt } = drag;
  drag = null;
  clearDragMarkers();
  // Removing the dragged item shifts every target after it left by one.
  let to = insertAt;
  if (to > fromIndex) to -= 1;
  if (to !== fromIndex) items = moveTo(items, fromIndex, to);
  render();
}
list.addEventListener('pointerup', endDrag);
list.addEventListener('pointercancel', endDrag);

// --- Merge & download --------------------------------------------------------

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

mergeBtn.addEventListener('click', async () => {
  const ok = items.filter((it) => it.status === 'ok');
  if (ok.length < 2) return;
  merging = true;
  mergeBtn.disabled = true;
  mergeBtn.textContent = 'Working…';
  mergeError.hidden = true;
  try {
    let bytes;
    try {
      bytes = await mergeItems(ok, ({ done, total }) => {
        mergeBtn.textContent = total > 1 ? `Working… ${done}/${total}` : 'Working…';
      });
    } catch (err) {
      // Split the two honest failure modes: engine-load vs. the merge itself.
      mergeError.textContent = (err instanceof PdfEngineError)
        ? 'Couldn’t load the PDF engine — check your connection and try again.'
        : 'Couldn’t merge these PDFs — this set may be too large for this device’s memory.';
      mergeError.hidden = false;
      return;
    }
    downloadBytes(bytes, 'merged.pdf');
  } finally {
    merging = false;
    mergeBtn.textContent = 'Merge & download';
    render();
  }
});

clearBtn.addEventListener('click', () => {
  items = [];
  mergeError.hidden = true;
  intakeNote.hidden = true;
  render();
});

document.documentElement.dataset.bootReady = '1';
