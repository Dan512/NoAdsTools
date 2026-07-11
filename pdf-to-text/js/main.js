// pdf-to-text/js/main.js — boot + tool wiring. English-first; minimal chrome (no
// language picker / settings gear); shared privacy panel with this tool's
// disclosure. Flow: intake ONE PDF (picker / drop / paste, PDF allowlist) →
// loadPdf opens it via the shared pdfjs loader (classifies locked/corrupt) →
// choose a mode (Auto / Text layer only / OCR all pages) and pages (All / a
// range) → Extract reads each page's text layer and, when a page needs it,
// renders that page to an on-DOM canvas and runs Tesseract OCR (lazy — the
// ~22 MB engine loads only on first real OCR) → the assembled text lands in a
// read-only textarea, page-separated, with an OCR badge on each OCR'd page →
// Copy / Download .txt.
//
// rAF-safe rendering (playbook §4): the OCR render canvas lives in the on-DOM
// (clipped) #ocr-stage — a detached/hidden canvas stalls pdfjs' render promise.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { isPdf } from './intake.js';
import { parseRanges } from './ranges.js';
import { assembleText, outName } from './extract-opts.js';
import { loadPdf, extractPages } from './extract.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  ptPrivacyTitle: 'Privacy',
  ptPrivacyLead: 'This tool extracts and OCRs text from your PDF entirely in your browser. Your PDF never leaves your device — no upload, no account, no tracking.',
  ptPrivacyFetchHeading: 'What this page loads',
  ptPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The pdf.js library (~1.73 MB main + worker, from this origin) — ONLY when you open a PDF. Used to read and render the pages locally; its character maps and fonts are fetched from this origin only for PDFs that need them.</li>'
    + '<li>The Tesseract OCR engine (~22 MB, from this origin) — ONLY when a page needs OCR (a scanned or image-only page, or OCR-all mode). A normal digital PDF never fetches it. The English language data is part of that download.</li>',
  ptPrivacyStorageHeading: 'Local storage',
  ptPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:pdf-to-text</code>. No PDF or text data is ever stored.',
} });

injectTopbar({ toolId: 'pdf-to-text', lang: false, settings: false });
injectFooter({ toolId: 'pdf-to-text' });
initI18n();
initSettings({ toolId: 'pdf-to-text' });
registerPrivacyRows([
  { headingKey: 'ptPrivacyFetchHeading', bodyKey: 'ptPrivacyFetchList', kind: 'list' },
  { headingKey: 'ptPrivacyStorageHeading', bodyKey: 'ptPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'ptPrivacyTitle', leadKey: 'ptPrivacyLead' });

// --- State -------------------------------------------------------------------
const state = {
  doc: null,          // pdfjs document proxy
  numPages: 0,
  fileName: '',
  mode: 'auto',       // 'auto' | 'text' | 'ocr-all'
  pagesMode: 'all',   // 'all' | 'range'
  working: false,
  text: '',           // last assembled output (for copy/download)
};

const MODE_HINTS = {
  auto: 'Auto reads the text layer and runs OCR only on pages that have little or no text.',
  text: 'Text layer only is instant and never runs OCR — scanned pages come back empty.',
  'ocr-all': 'OCR all pages recognises every page from its image — slower, for garbled or scanned PDFs. English only for now.',
};

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const input = $('file-input');
const intakeNote = $('intake-note');
const workspace = $('workspace');
const docName = $('doc-name');
const docPages = $('doc-pages');
const controls = $('controls');
const modeHint = $('mode-hint');
const rangeField = $('range-field');
const rangeInput = $('range-input');
const rangeError = $('range-error');
const extractBtn = $('extract');
const clearBtn = $('clear');
const runStatus = $('run-status');
const runError = $('run-error');
const output = $('output');
const pageBadges = $('page-badges');
const ocrNote = $('ocr-note');
const outArea = $('out');
const copyBtn = $('copy');
const downloadBtn = $('download');
const ocrStage = $('ocr-stage');

// One reused on-DOM canvas for OCR rasterisation (rAF-safe — see file header).
let ocrCanvas = null;
function getOcrCanvas() {
  if (!ocrCanvas) {
    ocrCanvas = document.createElement('canvas');
    ocrStage.appendChild(ocrCanvas);
  }
  return ocrCanvas;
}

const plural = (n, w) => (n === 1 ? w : `${w}s`);

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
// discard the loaded PDF). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

function setIntakeNote(text) {
  intakeNote.textContent = text;   // textContent → any XSS in the name is inert
  intakeNote.hidden = false;
}

async function intake(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdfs = files.filter((f) => isPdf(f.name, f.type));
  if (!pdfs.length) { setIntakeNote('This tool reads one PDF — drop a PDF file.'); return; }
  const file = pdfs[0];             // one PDF at a time; a new drop replaces it
  const extras = files.length - 1;  // everything else in the drop is ignored

  resetWorkspace();
  runError.hidden = true;
  docName.textContent = file.name;  // textContent → XSS inert
  docPages.textContent = 'Opening…';
  workspace.hidden = false;
  state.fileName = file.name;

  let result;
  try {
    result = await loadPdf(file);
  } catch {
    resetWorkspace(); workspace.hidden = true;
    setIntakeNote('Could not open this PDF — it may be corrupt.');
    return;
  }

  if (result.status === 'locked') {
    resetWorkspace(); workspace.hidden = true;
    setIntakeNote('This PDF is password-protected — unlock it first, then add it again.');
    return;
  }
  if (result.status !== 'ok') {
    resetWorkspace(); workspace.hidden = true;
    setIntakeNote('Could not open this PDF — it may be corrupt or not a real PDF.');
    return;
  }

  state.doc = result.doc;
  state.numPages = result.numPages;
  docName.textContent = state.fileName;
  docPages.textContent = `${state.numPages} ${plural(state.numPages, 'page')}`;
  if (extras > 0) {
    setIntakeNote(`Loaded this PDF · ignored ${extras} other ${plural(extras, 'file')} (this tool reads one PDF at a time).`);
  } else {
    intakeNote.hidden = true;
  }
  extractBtn.disabled = false;
}

// --- Controls ----------------------------------------------------------------
controls.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || state.working) return;
  if (btn.dataset.mode) return onMode(btn);
  if (btn.dataset.pages) return onPagesMode(btn);
});

function pressOne(group, btn) {
  for (const b of group.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b === btn));
}

function onMode(btn) {
  if (btn.dataset.mode === state.mode) return;
  state.mode = btn.dataset.mode;
  pressOne(btn.parentElement, btn);
  modeHint.textContent = MODE_HINTS[state.mode] || '';
}

function onPagesMode(btn) {
  if (btn.dataset.pages === state.pagesMode) return;
  state.pagesMode = btn.dataset.pages;
  pressOne(btn.parentElement, btn);
  rangeField.hidden = state.pagesMode !== 'range';
  if (state.pagesMode === 'all') rangeError.hidden = true;
}

// Resolve the page numbers the current mode targets. Returns null on a range
// error (message already shown), [] when a valid-but-empty range.
function resolvePageSet() {
  if (state.pagesMode === 'range') {
    const r = parseRanges(rangeInput.value, state.numPages);
    if (r.errors.length) { rangeError.textContent = r.errors.join(' · '); rangeError.hidden = false; return null; }
    rangeError.hidden = true;
    return r.flat;
  }
  rangeError.hidden = true;
  return Array.from({ length: state.numPages }, (_, i) => i + 1);
}

// --- Extract -----------------------------------------------------------------
extractBtn.addEventListener('click', async () => {
  if (state.working || !state.doc) return;
  const pageSet = resolvePageSet();
  if (pageSet === null) return;   // range error is shown
  if (!pageSet.length) {
    if (state.pagesMode === 'range' && !rangeInput.value.trim()) {
      showRunError('Enter the pages you want, such as 1-3, 5, 8-10.');
    } else {
      showRunError('No pages match — check the range.');
    }
    return;
  }

  output.hidden = true;
  setWorking(true, `Reading page 1 / ${pageSet.length}…`);

  let res;
  try {
    res = await extractPages(state.doc, pageSet, {
      mode: state.mode,
      ocrCanvas: getOcrCanvas(),
      onProgress: ({ page, total, phase }) => {
        runStatus.textContent = phase === 'ocr'
          ? `OCR page ${page}… (this is slower — a few seconds per page)`
          : `Reading page ${page} / ${total}…`;
      },
    });
  } catch {
    setWorking(false);
    showRunError('Could not read this PDF — it may be corrupt, or too large for this device’s memory.');
    return;
  }

  setWorking(false);
  renderOutput(res);
});

function renderOutput(res) {
  const { pages, ocrError } = res;
  state.text = assembleText(pages);
  outArea.value = state.text;

  // Per-page badges: one chip per output section, OCR'd sections carry the OCR
  // badge. Numbered by the page's SOURCE page number to match `assembleText`'s
  // `--- Page N ---` headings (both use `p.page`), so the chip and the heading
  // never disagree on the same screen — even when a page range is extracted.
  pageBadges.textContent = '';
  pages.forEach((p) => {
    const chip = document.createElement('span');
    chip.className = 'page-chip';
    const label = document.createElement('span');
    label.textContent = `Page ${p.page}`;
    chip.appendChild(label);
    if (p.ocr) {
      const badge = document.createElement('span');
      badge.className = 'ocr-badge';
      badge.textContent = 'OCR';
      chip.appendChild(badge);
    }
    pageBadges.appendChild(chip);
  });

  // Honest notes, in priority order.
  const anyOcr = pages.some((p) => p.ocr);
  const stripped = state.text.replace(/--- Page \d+ ---/g, '').replace(/\s+/g, '');
  if (ocrError) {
    ocrNote.textContent = 'The OCR engine could not load, so scanned pages are not recognised — the text layer is shown. Check your connection and try Extract again.';
    ocrNote.hidden = false;
  } else if (state.mode === 'text' && !stripped.length) {
    ocrNote.textContent = 'No text layer found on these pages — they may be scanned. Try Auto or OCR all pages.';
    ocrNote.hidden = false;
  } else if (!stripped.length) {
    ocrNote.textContent = 'No text was found on these pages.';
    ocrNote.hidden = false;
  } else if (anyOcr) {
    ocrNote.textContent = 'Pages marked OCR were recognised from the page image — OCR is approximate, so proofread those.';
    ocrNote.hidden = false;
  } else {
    ocrNote.hidden = true;
  }

  copyBtn.textContent = 'Copy text';
  copyBtn.disabled = false;
  downloadBtn.disabled = false;
  output.hidden = false;
}

// --- Copy / Download ---------------------------------------------------------
copyBtn.addEventListener('click', async () => {
  if (!state.text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(state.text);
    ok = true;
  } catch {
    // Fallback: select the textarea and use execCommand.
    try {
      outArea.focus();
      outArea.select();
      ok = document.execCommand('copy');
      outArea.setSelectionRange(0, 0);
      outArea.blur();
    } catch { ok = false; }
  }
  copyBtn.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
  setTimeout(() => { copyBtn.textContent = 'Copy text'; }, 2000);
});

function stem() {
  const base = String(state.fileName || 'document').replace(/\.pdf$/i, '').trim();
  return base || 'document';
}

downloadBtn.addEventListener('click', () => {
  if (!state.text) return;
  const blob = new Blob([state.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = outName(stem());
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

// --- Working / status --------------------------------------------------------
function setWorking(on, statusText) {
  state.working = on;
  extractBtn.disabled = on || !state.doc;
  clearBtn.disabled = on;
  copyBtn.disabled = on || !state.text;
  downloadBtn.disabled = on || !state.text;
  if (on) {
    runError.hidden = true;
    runStatus.textContent = statusText || 'Working…';
    runStatus.hidden = false;
  } else {
    runStatus.hidden = true;
  }
}

function showRunError(text) { runError.textContent = text; runError.hidden = false; }

// --- Clear / reset -----------------------------------------------------------
function resetWorkspace() {
  state.doc = null;
  state.numPages = 0;
  state.text = '';
  output.hidden = true;
  pageBadges.textContent = '';
  outArea.value = '';
  ocrNote.hidden = true;
  runStatus.hidden = true;
  runError.hidden = true;
  extractBtn.disabled = true;
}

clearBtn.addEventListener('click', () => {
  if (state.working) return;
  resetWorkspace();
  workspace.hidden = true;
  intakeNote.hidden = true;
  rangeError.hidden = true;
  rangeInput.value = '';
  state.fileName = '';
  // Reset pages mode back to All (mode keeps its choice).
  state.pagesMode = 'all';
  rangeField.hidden = true;
  for (const b of controls.querySelectorAll('.seg-btn[data-pages]')) {
    b.setAttribute('aria-pressed', String(b.dataset.pages === 'all'));
  }
});

extractBtn.disabled = true;
document.documentElement.dataset.bootReady = '1';
