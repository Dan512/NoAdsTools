// watermark-pdf/js/main.js — boot + tool wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Flow: intake ONE PDF (picker / drop / paste, PDF allowlist) →
// loadPdf reads the page count via lazy pdf-lib (classifies locked/error) →
// choose a Text or Image watermark, set position / opacity / rotation / tiling
// and which pages → a live preview line states the outcome → Apply & download
// stamps the watermark in a fresh copy and downloads one PDF. pdf-lib is 0 bytes
// until the first PDF is added.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { isPdf, isRasterLogo } from './intake.js';
import { parseRanges } from './ranges.js';
import { loadPdf, applyWatermark, PdfEngineError } from './watermark.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  wmPrivacyTitle: 'Privacy',
  wmPrivacyLead: 'This tool adds watermarks in your browser. Your PDF and any logo image never leave your device — no upload, no account, no tracking — and the document properties inside the source file are not carried into the watermarked copy.',
  wmPrivacyFetchHeading: 'What this page loads',
  wmPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The pdf-lib library (~511 KB, from this origin) — ONLY when you add a PDF. Used to read the page count and stamp the watermark locally.</li>',
  wmPrivacyStorageHeading: 'Local storage',
  wmPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:watermark-pdf</code>. No PDF or logo data is ever stored.',
} });

injectTopbar({ toolId: 'watermark-pdf', lang: false, settings: false });
injectFooter({ toolId: 'watermark-pdf' });
initI18n();
initSettings({ toolId: 'watermark-pdf' });
registerPrivacyRows([
  { headingKey: 'wmPrivacyFetchHeading', bodyKey: 'wmPrivacyFetchList', kind: 'list' },
  { headingKey: 'wmPrivacyStorageHeading', bodyKey: 'wmPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'wmPrivacyTitle', leadKey: 'wmPrivacyLead' });

// --- State -------------------------------------------------------------------
let src = null;                 // loaded source descriptor or null
let type = 'text';              // 'text' | 'image'
let position = 'center';        // 'center' | 'tile' | 'tl' | 'tr' | 'bl' | 'br'
let applyTo = 'all';            // 'all' | 'range'
let logo = null;                // { bytes, mime, name } or null
let working = false;

const $ = (id) => document.getElementById(id);

const dropzone = $('dropzone');
const input = $('file-input');
const intakeNote = $('intake-note');
const workspace = $('workspace');
const docName = $('doc-name');
const docPages = $('doc-pages');

const typeGroup = document.querySelector('[aria-labelledby="type-label"]');
const posGroup = document.querySelector('[aria-labelledby="pos-label"]');
const applyGroup = document.querySelector('[aria-labelledby="apply-label"]');

const textControls = $('text-controls');
const imageControls = $('image-controls');
const wmText = $('wm-text');
const wmFont = $('wm-font');
const wmSize = $('wm-size');
const wmColor = $('wm-color');
const wmColorHex = $('wm-color-hex');
const logoInput = $('logo-input');
const logoName = $('logo-name');
const wmScale = $('wm-scale');
const wmScaleVal = $('wm-scale-val');
const wmOpacity = $('wm-opacity');
const wmOpacityVal = $('wm-opacity-val');
const wmRotation = $('wm-rotation');
const wmRotationVal = $('wm-rotation-val');
const tileGapField = $('tile-gap-field');
const wmTileGap = $('wm-tilegap');
const rangeField = $('range-field');
const rangeInput = $('range-input');
const rangeError = $('range-error');
const preview = $('preview');
const applyBtn = $('apply');
const applyHint = $('apply-hint');
const clearBtn = $('clear');
const runError = $('run-error');

const plural = (n, word) => (n === 1 ? word : `${word}s`);
const POS_WORD = { center: 'centered', tile: 'tiled', tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };

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

async function intake(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdfs = files.filter((f) => isPdf(f.name, f.type));
  if (!pdfs.length) {
    setIntakeNote('This tool watermarks one PDF — drop a PDF file.');
    return;
  }
  const file = pdfs[0];              // one PDF at a time; a new drop replaces it
  const extras = files.length - 1;   // everything else in the drop is ignored

  runError.hidden = true;
  docName.textContent = file.name;   // textContent → any XSS in the name is inert
  docPages.textContent = 'Reading…';
  workspace.hidden = false;

  let loaded;
  try {
    loaded = await loadPdf(file);
  } catch (e) {
    src = null;
    workspace.hidden = true;
    setIntakeNote(e instanceof PdfEngineError
      ? 'Couldn’t load the PDF engine — check your connection and add the file again.'
      : 'Couldn’t read this PDF — it may be corrupt.');
    return;
  }

  if (loaded.status === 'locked') {
    src = null;
    workspace.hidden = true;
    setIntakeNote('This PDF is password-protected — unlock it first, then add it again.');
    return;
  }
  if (loaded.status !== 'ok') {
    src = null;
    workspace.hidden = true;
    setIntakeNote('Couldn’t read this PDF — it may be corrupt or not a real PDF.');
    return;
  }

  src = loaded;
  docName.textContent = src.name;
  docPages.textContent = `${src.pageCount} ${plural(src.pageCount, 'page')}`;
  if (extras > 0) {
    setIntakeNote(`Loaded this PDF · ignored ${extras} other ${plural(extras, 'file')} (this tool watermarks one PDF at a time).`);
  } else {
    intakeNote.hidden = true;
  }
  recompute();
}

function setIntakeNote(text) {
  intakeNote.textContent = text;     // textContent → no HTML injection from names
  intakeNote.hidden = false;
}

// --- Segmented controls ------------------------------------------------------

typeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const next = btn.dataset.type;
  if (next === type) return;
  type = next;
  for (const b of typeGroup.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.type === type));
  textControls.hidden = type !== 'text';
  imageControls.hidden = type !== 'image';
  recompute();
});

posGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  position = btn.dataset.pos;
  for (const b of posGroup.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.pos === position));
  tileGapField.hidden = position !== 'tile';
  recompute();
});

applyGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  applyTo = btn.dataset.apply;
  for (const b of applyGroup.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.apply === applyTo));
  rangeField.hidden = applyTo !== 'range';
  recompute();
});

// --- Logo picker -------------------------------------------------------------

logoInput.addEventListener('change', async () => {
  const file = [...logoInput.files][0];
  logoInput.value = '';
  if (!file) return;
  if (!isRasterLogo(file.name, file.type)) {
    logo = null;
    logoName.textContent = 'Use a PNG or JPEG logo.';
    recompute();
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = /\.png$/i.test(file.name) || file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    logo = { bytes, mime, name: file.name };
    logoName.textContent = file.name;    // textContent → inert
  } catch {
    logo = null;
    logoName.textContent = 'Couldn’t read that image.';
  }
  recompute();
});

// --- Live sliders / labels ---------------------------------------------------

wmColor.addEventListener('input', () => { wmColorHex.textContent = wmColor.value.toUpperCase(); });
wmScale.addEventListener('input', () => { wmScaleVal.textContent = `${wmScale.value}%`; recompute(); });
wmOpacity.addEventListener('input', () => { wmOpacityVal.textContent = `${wmOpacity.value}%`; recompute(); });
wmRotation.addEventListener('input', () => { wmRotationVal.textContent = `${wmRotation.value}°`; recompute(); });
for (const el of [wmText, wmFont, wmSize, wmTileGap, rangeInput]) el.addEventListener('input', recompute);

// --- Preview / validation ----------------------------------------------------
// Compute the current plan → reflect it in the preview line, the range error,
// the Apply-enabled state, and the disabled hint. Returns the plan for apply().
function currentPlan() {
  if (!src || src.status !== 'ok') return { valid: false };
  const pageCount = src.pageCount;

  let pageSet = null;
  let pagesN = pageCount;
  let errors = [];
  if (applyTo === 'range') {
    const r = parseRanges(rangeInput.value, pageCount);
    errors = r.errors;
    pageSet = r.flat;
    pagesN = r.flat.length;
  }

  // Content validity first (empty text / missing logo), then page selection.
  let contentValid = true;
  let hint = '';
  if (type === 'text') {
    if (!wmText.value.trim()) { contentValid = false; hint = 'Enter watermark text.'; }
  } else if (!logo) {
    contentValid = false; hint = 'Choose a PNG or JPEG logo.';
  }

  let pagesValid = true;
  if (applyTo === 'range' && pagesN === 0) {
    pagesValid = false;
    if (!hint) hint = 'Enter which pages to watermark.';
  }

  const opacityPct = parseInt(wmOpacity.value, 10);
  const rot = parseInt(wmRotation.value, 10);
  const what = type === 'text' ? `“${wmText.value.trim() || '…'}”` : 'your logo';
  const previewText = (contentValid && pagesValid)
    ? `Stamp ${what} on ${pagesN} ${plural(pagesN, 'page')}, ${POS_WORD[position]}, ${rot}°, ${opacityPct}% opacity`
    : '';

  return {
    valid: contentValid && pagesValid,
    errors, pageSet: applyTo === 'range' ? pageSet : null,
    hint, preview: previewText,
  };
}

function recompute() {
  const plan = currentPlan();
  const errs = plan.errors || [];
  if (errs.length) {
    rangeError.textContent = errs.join(' · ');   // textContent → tokens inert
    rangeError.hidden = false;
  } else {
    rangeError.hidden = true;
  }
  preview.textContent = plan.preview || (src ? 'Set up your watermark.' : '');
  if (plan.hint) { applyHint.textContent = plan.hint; applyHint.hidden = false; }
  else { applyHint.hidden = true; }
  if (!working) applyBtn.disabled = !plan.valid;
  return plan;
}

// --- Apply -------------------------------------------------------------------

function stem() {
  const base = String(src?.name || 'document').replace(/\.pdf$/i, '').trim();
  return base || 'document';
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function buildOpts(plan) {
  const common = {
    opacity: parseInt(wmOpacity.value, 10) / 100,
    rotationDeg: parseInt(wmRotation.value, 10),
    position,
    tileGap: parseInt(wmTileGap.value, 10) || 0,
    pageSet: plan.pageSet,
  };
  if (type === 'image') {
    return { ...common, type: 'image', logoBytes: logo.bytes, logoMime: logo.mime, scalePct: parseInt(wmScale.value, 10) };
  }
  return {
    ...common, type: 'text',
    text: wmText.value, font: wmFont.value,
    size: parseInt(wmSize.value, 10) || 48, colorHex: wmColor.value,
  };
}

applyBtn.addEventListener('click', async () => {
  const plan = currentPlan();
  if (!plan.valid || !src) return;
  working = true;
  applyBtn.disabled = true;
  applyBtn.textContent = 'Working…';
  runError.hidden = true;
  try {
    const bytes = await applyWatermark(src.bytes, buildOpts(plan));
    download(bytes, `${stem()}-watermarked.pdf`);
  } catch (err) {
    runError.textContent = (err instanceof PdfEngineError)
      ? 'Couldn’t load the PDF engine — check your connection and try again.'
      : 'Couldn’t watermark this PDF — it may be too large for this device’s memory.';
    runError.hidden = false;
  } finally {
    working = false;
    applyBtn.textContent = 'Apply & download';
    recompute();
  }
});

clearBtn.addEventListener('click', () => {
  src = null;
  logo = null;
  workspace.hidden = true;
  intakeNote.hidden = true;
  runError.hidden = true;
  rangeError.hidden = true;
  applyHint.hidden = true;
  rangeInput.value = '';
  logoName.textContent = '';
  preview.textContent = '';
});

document.documentElement.dataset.bootReady = '1';
