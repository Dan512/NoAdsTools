// pdf-to-jpg/js/main.js — boot + tool wiring. English-first; minimal chrome (no
// language picker / settings gear); shared privacy panel with this tool's
// disclosure. Flow: intake ONE PDF (picker / drop / paste, PDF allowlist) →
// loadPdf opens it via the shared pdfjs loader (classifies locked/corrupt) →
// choose format (JPG/PNG), quality (JPG), resolution (1×/2×/3×), and pages
// (All / a range) → each selected page renders into an on-DOM thumbnail canvas
// in the grid → per-page Download re-renders THAT page at the export scale and
// saves it; Download all renders the set into a reused on-DOM stage canvas and
// bundles the images with JSZip (lazy). pdfjs is 0 bytes until a PDF is opened;
// JSZip is 0 bytes until a multi-page ZIP is built.
//
// rAF-safe rendering (playbook §4): every render targets a canvas already
// attached to the (visible) DOM — thumbnails live in the grid, exports render in
// the on-DOM #render-stage — because a detached/hidden canvas stalls pdfjs.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { isPdf } from './intake.js';
import { parseRanges } from './ranges.js';
import { estPx, clampScaleForCanvas } from './render-opts.js';
import { loadPdf, renderPage, pageToBlob, pageSizePt, exportPages, zipOutputs } from './topdf-render.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  pjPrivacyTitle: 'Privacy',
  pjPrivacyLead: 'This tool converts your PDF to images entirely in your browser. Your PDF never leaves your device — no upload, no account, no tracking.',
  pjPrivacyFetchHeading: 'What this page loads',
  pjPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The pdf.js library (~1.66 MB main + worker, from this origin) — ONLY when you open a PDF. Used to render the pages locally; its character maps and fonts are fetched from this origin only for PDFs that need them.</li>'
    + '<li>The JSZip library (~97 KB, from this origin) — ONLY when you download more than one page together, to bundle the images into a ZIP locally.</li>',
  pjPrivacyStorageHeading: 'Local storage',
  pjPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:pdf-to-jpg</code>. No PDF or image data is ever stored.',
} });

injectTopbar({ toolId: 'pdf-to-jpg', lang: false, settings: false });
injectFooter({ toolId: 'pdf-to-jpg' });
initI18n();
initSettings({ toolId: 'pdf-to-jpg' });
registerPrivacyRows([
  { headingKey: 'pjPrivacyFetchHeading', bodyKey: 'pjPrivacyFetchList', kind: 'list' },
  { headingKey: 'pjPrivacyStorageHeading', bodyKey: 'pjPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'pjPrivacyTitle', leadKey: 'pjPrivacyLead' });

// --- Constants ---------------------------------------------------------------
const THUMB_PX = 300;   // target backing-store width of a preview thumbnail (low memory)
const MAX_DIM = 4096;   // canvas-side clamp (iOS ~4096²); mirrors render-opts default
const MAX_GRID_CARDS = 150; // cap the rendered grid: each card owns a canvas (~0.31 MB),
                            // so a many-page PDF in the default "All" mode could exhaust
                            // mobile memory. Render the first MAX_GRID_CARDS; the page
                            // range control reaches later pages (see the grid note).

// --- State -------------------------------------------------------------------
const state = {
  doc: null,          // pdfjs document proxy
  numPages: 0,
  fileName: '',
  fmt: 'jpg',         // 'jpg' | 'png'
  scale: 2,           // 1 | 2 | 3 (pdfjs viewport scale)
  quality: 90,        // JPG quality, 10..100
  pagesMode: 'all',   // 'all' | 'range'
  fullCount: 0,       // pages the current mode resolves to, BEFORE the grid cap
  pageSet: [],        // 1-based page numbers currently in the grid (≤ MAX_GRID_CARDS)
  dims: new Map(),    // pageNum -> { widthPt, heightPt }
  cards: new Map(),   // pageNum -> { card, thumb, canvas, pxEl, clampEl, dlBtn }
  working: false,
  buildToken: 0,      // supersedes an in-flight grid build when the set changes
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
const qualityControl = $('quality-control');
const qualityInput = $('quality');
const qualityValue = $('quality-value');
const resHint = $('res-hint');
const rangeField = $('range-field');
const rangeInput = $('range-input');
const rangeError = $('range-error');
const zipBtn = $('download-zip');
const clearBtn = $('clear');
const runStatus = $('run-status');
const runError = $('run-error');
const gridNote = $('grid-note');
const grid = $('grid');
const renderStage = $('render-stage');

// One reused on-DOM canvas for full-resolution export renders (rAF-safe).
let stageCanvas = null;
function getStageCanvas() {
  if (!stageCanvas) {
    stageCanvas = document.createElement('canvas');
    renderStage.appendChild(stageCanvas);
  }
  return stageCanvas;
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
  if (!pdfs.length) { setIntakeNote('This tool converts one PDF — drop a PDF file.'); return; }
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
    setIntakeNote(`Loaded this PDF · ignored ${extras} other ${plural(extras, 'file')} (this tool converts one PDF at a time).`);
  } else {
    intakeNote.hidden = true;
  }
  await recomputePageSet();     // builds the grid for the current mode
}

// --- Controls: format --------------------------------------------------------
controls.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || state.working) return;
  if (btn.dataset.format) return onFormat(btn);
  if (btn.dataset.scale) return onScale(btn);
  if (btn.dataset.pages) return onPagesMode(btn);
});

function pressOne(group, btn) {
  for (const b of group.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b === btn));
}

function onFormat(btn) {
  if (btn.dataset.format === state.fmt) return;
  state.fmt = btn.dataset.format;
  pressOne(btn.parentElement, btn);
  qualityControl.hidden = state.fmt !== 'jpg';   // quality applies to JPG only
}

function onScale(btn) {
  const next = Number(btn.dataset.scale);
  if (next === state.scale) return;
  state.scale = next;
  pressOne(btn.parentElement, btn);
  updatePxHints();   // resolution only changes the OUTPUT size, not the preview render
}

function onPagesMode(btn) {
  if (btn.dataset.pages === state.pagesMode) return;
  state.pagesMode = btn.dataset.pages;
  pressOne(btn.parentElement, btn);
  rangeField.hidden = state.pagesMode !== 'range';
  if (state.pagesMode === 'all') rangeError.hidden = true;
  void recomputePageSet();
}

qualityInput.addEventListener('input', () => {
  state.quality = Number(qualityInput.value) || 90;
  qualityValue.textContent = qualityInput.value;
});

let rangeTimer = 0;
rangeInput.addEventListener('input', () => {
  clearTimeout(rangeTimer);
  rangeTimer = setTimeout(() => { void recomputePageSet(); }, 250);
});

// --- Page set + grid ---------------------------------------------------------
// Resolve the current page numbers from the mode, then (re)build the grid.
async function recomputePageSet() {
  if (!state.doc) return;
  let pages;
  if (state.pagesMode === 'range') {
    const r = parseRanges(rangeInput.value, state.numPages);
    if (r.errors.length) { rangeError.textContent = r.errors.join(' · '); rangeError.hidden = false; }
    else rangeError.hidden = true;
    pages = r.flat;
  } else {
    rangeError.hidden = true;
    pages = Array.from({ length: state.numPages }, (_, i) => i + 1);
  }
  state.fullCount = pages.length;
  // Cap the rendered grid so a huge PDF can't allocate N large canvases at once
  // (mobile OOM). The remainder stays reachable via the page-range control; the
  // grid note below says so honestly.
  state.pageSet = pages.length > MAX_GRID_CARDS ? pages.slice(0, MAX_GRID_CARDS) : pages;
  updateZipButton();
  await buildGrid();
}

// Build one card per page in the set, then render each thumbnail sequentially
// into an on-DOM (visible) canvas at a small preview scale — low memory, and
// rAF-safe. A newer build (set changed) supersedes an older in-flight one.
async function buildGrid() {
  const token = ++state.buildToken;
  grid.textContent = '';
  state.cards.clear();

  // Honest cap note: shown only when the resolved set is larger than the grid renders.
  if (state.fullCount > state.pageSet.length) {
    gridNote.textContent = `Showing the first ${state.pageSet.length} of ${state.fullCount} pages — use the page range above to convert the rest.`;
    gridNote.hidden = false;
  } else {
    gridNote.hidden = true;
  }

  if (!state.pageSet.length) {
    if (state.pagesMode === 'range' && !rangeInput.value.trim()) {
      showEmpty('Enter the pages you want, such as 1-3, 5, 8-10.');
    } else if (state.pagesMode === 'range') {
      showEmpty('No pages match — check the range.');
    }
    updateZipButton();
    return;
  }

  for (const pageNum of state.pageSet) buildCard(pageNum);

  for (const pageNum of state.pageSet) {
    if (token !== state.buildToken) return;   // superseded — stop
    await renderThumb(pageNum, token);
  }
}

function showEmpty(text) {
  const p = document.createElement('p');
  p.className = 'run-status';
  p.textContent = text;
  grid.appendChild(p);
}

function buildCard(pageNum) {
  const card = document.createElement('div');
  card.className = 'page-card';

  const thumb = document.createElement('div');
  thumb.className = 'page-thumb is-pending';
  const canvas = document.createElement('canvas');
  thumb.appendChild(canvas);
  card.appendChild(thumb);

  const meta = document.createElement('div');
  meta.className = 'page-meta';
  const num = document.createElement('span');
  num.className = 'page-num';
  num.textContent = `Page ${pageNum}`;
  const px = document.createElement('span');
  px.className = 'page-px';
  meta.appendChild(num); meta.appendChild(px);
  card.appendChild(meta);

  const clampEl = document.createElement('p');
  clampEl.className = 'page-clamp';
  clampEl.hidden = true;
  card.appendChild(clampEl);

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'page-download';
  dlBtn.textContent = 'Download';
  dlBtn.disabled = true;
  // Capture THIS page number — never a shared "last page" closure (playbook bug).
  dlBtn.addEventListener('click', () => downloadOne(pageNum));
  card.appendChild(dlBtn);

  grid.appendChild(card);
  state.cards.set(pageNum, { card, thumb, canvas, pxEl: px, clampEl, dlBtn });
}

async function renderThumb(pageNum, token) {
  const entry = state.cards.get(pageNum);
  if (!entry) return;
  let dims = state.dims.get(pageNum);
  if (!dims) {
    try { dims = await pageSizePt(state.doc, pageNum); state.dims.set(pageNum, dims); }
    catch { markThumbFailed(entry); return; }
  }
  if (token !== state.buildToken) return;
  const previewScale = Math.min(THUMB_PX / (dims.widthPt || THUMB_PX), state.scale);
  try {
    // pdfjs fills white by default; JPG passes white explicitly as
    // belt-and-suspenders (PNG uses that same default white plate).
    await renderPage(state.doc, pageNum, {
      scale: previewScale, canvas: entry.canvas, maxDim: MAX_DIM,
      background: state.fmt === 'png' ? null : '#ffffff',
    });
  } catch {
    markThumbFailed(entry); return;
  }
  if (token !== state.buildToken) return;
  entry.thumb.classList.remove('is-pending');
  entry.dlBtn.disabled = false;
  updatePxHint(pageNum);
  updateResHint();   // fill the global "≈ W×H px" line once the first page's dims exist
}

function markThumbFailed(entry) {
  entry.failed = true;   // a blanket re-enable (setWorking) must skip this button
  entry.thumb.classList.remove('is-pending');
  entry.canvas.remove();
  const fb = document.createElement('div');
  fb.className = 'thumb-fallback';
  fb.textContent = 'This page could not be rendered.';
  entry.thumb.appendChild(fb);
}

// Per-card output-size hint (uses the clamp so it shows the TRUE output size).
function updatePxHint(pageNum) {
  const entry = state.cards.get(pageNum);
  const dims = state.dims.get(pageNum);
  if (!entry || !dims) return;
  const clamp = clampScaleForCanvas(state.scale, dims.widthPt, dims.heightPt, MAX_DIM);
  const { w, h } = estPx(dims.widthPt, dims.heightPt, clamp.scale);
  entry.pxEl.textContent = `${w} × ${h} px`;
  if (clamp.clamped) {
    entry.clampEl.textContent = 'Reduced resolution to fit this browser.';
    entry.clampEl.hidden = false;
  } else {
    entry.clampEl.hidden = true;
  }
}

function updatePxHints() {
  for (const pageNum of state.cards.keys()) updatePxHint(pageNum);
  updateResHint();
}

// Global "≈ W×H px per page" line, from the first page in the set.
function updateResHint() {
  const first = state.pageSet[0];
  const dims = first && state.dims.get(first);
  if (!dims) { resHint.textContent = ''; return; }
  const clamp = clampScaleForCanvas(state.scale, dims.widthPt, dims.heightPt, MAX_DIM);
  const { w, h } = estPx(dims.widthPt, dims.heightPt, clamp.scale);
  const many = state.pageSet.length > 1;
  resHint.textContent = many
    ? `≈ ${w} × ${h} px (page ${first})`
    : `≈ ${w} × ${h} px`;
}

// --- Downloads ---------------------------------------------------------------
function stem() {
  const base = String(state.fileName || 'document').replace(/\.pdf$/i, '').trim();
  return base || 'document';
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadOne(pageNum) {
  if (state.working || !state.doc) return;
  const entry = state.cards.get(pageNum);
  setWorking(true, `Rendering page ${pageNum}…`);
  try {
    const canvas = getStageCanvas();
    const r = await renderPage(state.doc, pageNum, {
      scale: state.scale, canvas, maxDim: MAX_DIM,
      background: state.fmt === 'png' ? null : '#ffffff',
    });
    if (entry) {
      entry.clampEl.hidden = !r.clamped;
      if (r.clamped) entry.clampEl.textContent = 'Reduced resolution to fit this browser.';
    }
    const blob = await pageToBlob(canvas, state.fmt, state.quality / 100);
    downloadBlob(blob, `${stem()}-p${pageNum}.${state.fmt === 'png' ? 'png' : 'jpg'}`);
    setWorking(false);
  } catch {
    setWorking(false);
    showRunError('Could not render this page — it may be too large for this device’s memory.');
  }
}

zipBtn.addEventListener('click', async () => {
  if (state.working || !state.doc || !state.pageSet.length) return;
  const pages = state.pageSet.slice();
  setWorking(true, `Rendering 0 / ${pages.length}…`);
  try {
    const { outputs, anyClamped } = await exportPages(state.doc, pages, {
      scale: state.scale, fmt: state.fmt, quality: state.quality / 100,
      stem: stem(), maxDim: MAX_DIM,
      canvasFactory: getStageCanvas,
      onProgress: (done, total) => { runStatus.textContent = `Rendering ${done} / ${total}…`; },
    });
    if (outputs.length === 1) {
      downloadBlob(outputs[0].blob, outputs[0].name);
    } else {
      runStatus.textContent = 'Building ZIP…';
      const zip = await zipOutputs(outputs, stem());
      downloadBlob(zip.blob, zip.name);
    }
    setWorking(false);
    if (anyClamped) showRunStatus('Some pages were reduced in resolution to fit this browser.');
  } catch (err) {
    setWorking(false);
    const msg = /JSZip|zip/i.test(String(err && err.message))
      ? 'The ZIP library could not load — check your connection and try again.'
      : 'Could not render these pages — the set may be too large for this device’s memory.';
    showRunError(msg);
  }
});

function setWorking(on, statusText) {
  state.working = on;
  zipBtn.disabled = on || state.pageSet.length === 0;
  // Never re-enable a page that failed to render — its button stays disabled.
  for (const entry of state.cards.values()) entry.dlBtn.disabled = on || entry.failed === true;
  if (on) {
    runError.hidden = true;
    runStatus.textContent = statusText || 'Working…';
    runStatus.hidden = false;
  } else {
    runStatus.hidden = true;
  }
}

function showRunStatus(text) { runStatus.textContent = text; runStatus.hidden = false; }
function showRunError(text) { runError.textContent = text; runError.hidden = false; }

function updateZipButton() {
  if (!state.working) zipBtn.disabled = state.pageSet.length === 0;
  zipBtn.textContent = state.pageSet.length > 1 ? 'Download all (ZIP)' : 'Download';
}

// --- Clear / reset -----------------------------------------------------------
function resetWorkspace() {
  state.buildToken++;   // abort any in-flight grid build
  state.doc = null;
  state.numPages = 0;
  state.fullCount = 0;
  state.pageSet = [];
  state.dims.clear();
  state.cards.clear();
  grid.textContent = '';
  gridNote.hidden = true;
  resHint.textContent = '';
  runStatus.hidden = true;
  runError.hidden = true;
}

clearBtn.addEventListener('click', () => {
  resetWorkspace();
  workspace.hidden = true;
  intakeNote.hidden = true;
  rangeError.hidden = true;
  rangeInput.value = '';
  state.fileName = '';
  // Reset pages mode back to All (format/quality/resolution keep their choice).
  state.pagesMode = 'all';
  rangeField.hidden = true;
  for (const b of controls.querySelectorAll('.seg-btn[data-pages]')) {
    b.setAttribute('aria-pressed', String(b.dataset.pages === 'all'));
  }
});

updateZipButton();
document.documentElement.dataset.bootReady = '1';
