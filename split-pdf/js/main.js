// split-pdf/js/main.js — boot + tool wiring. English-first; minimal chrome (no
// language picker / settings gear); shared privacy panel with this tool's
// disclosure. Flow: intake ONE PDF (picker / drop / paste, PDF allowlist) →
// loadPdf reads the page count via lazy pdf-lib (classifies locked/error) →
// pick a mode (Extract / Ranges / Every-N / Burst) → a live preview line states
// the outcome → Split & download builds the output(s) via copyPages into fresh
// docs and downloads a single PDF or a ZIP (JSZip lazy, only when >1 output).
// pdf-lib is 0 bytes until the first PDF is added; JSZip is 0 bytes until a
// multi-output split runs.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { isPdf } from './intake.js';
import { parseRanges, everyN, burst } from './ranges.js';
import { loadPdf, buildOutputs, buildExtract, zipOutputs, PdfEngineError } from './split.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  spPrivacyTitle: 'Privacy',
  spPrivacyLead: 'This tool splits your PDF into pieces entirely in your browser. Your PDF never leaves your device — no upload, no account, no tracking — and the metadata inside the source file is not carried into the split files.',
  spPrivacyFetchHeading: 'What this page loads',
  spPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The pdf-lib library (~511 KB, from this origin) — ONLY when you add a PDF. Used to read the page count and build the split files locally.</li><li>The JSZip library (~97 KB, from this origin) — ONLY when a split produces more than one file, to bundle them into a ZIP.</li>',
  spPrivacyStorageHeading: 'Local storage',
  spPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:split-pdf</code>. No PDF data is ever stored.',
} });

injectTopbar({ toolId: 'split-pdf', lang: false, settings: false });
injectFooter({ toolId: 'split-pdf' });
initI18n();
initSettings({ toolId: 'split-pdf' });
registerPrivacyRows([
  { headingKey: 'spPrivacyFetchHeading', bodyKey: 'spPrivacyFetchList', kind: 'list' },
  { headingKey: 'spPrivacyStorageHeading', bodyKey: 'spPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'spPrivacyTitle', leadKey: 'spPrivacyLead' });

// --- State -------------------------------------------------------------------
// src: the loaded source descriptor { name, size, pageCount, status, bytes, ... }
// or null. mode: which split strategy. working: true while a split is running.
let src = null;
let mode = 'extract';
let working = false;

const dropzone = document.getElementById('dropzone');
const input = document.getElementById('file-input');
const intakeNote = document.getElementById('intake-note');
const workspace = document.getElementById('workspace');
const docName = document.getElementById('doc-name');
const docPages = document.getElementById('doc-pages');
const modeGroup = document.querySelector('.mode-group');
const modeBtns = [...document.querySelectorAll('.mode-btn')];
const rangeField = document.getElementById('range-field');
const rangeLabel = document.getElementById('range-label');
const rangeInput = document.getElementById('range-input');
const nField = document.getElementById('n-field');
const nInput = document.getElementById('n-input');
const rangeError = document.getElementById('range-error');
const preview = document.getElementById('preview');
const runBtn = document.getElementById('run');
const clearBtn = document.getElementById('clear');
const runError = document.getElementById('run-error');

const plural = (n, word) => (n === 1 ? word : `${word}s`);

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
    setIntakeNote('This tool splits one PDF — drop a PDF file.');
    return;
  }
  const file = pdfs[0];              // one PDF at a time; a new drop replaces it
  const extras = files.length - 1;   // everything else in the drop is ignored

  // Reading state (loadPdf is fast, but big files take a beat).
  runError.hidden = true;
  docName.textContent = file.name;   // textContent → any XSS in the name is inert
  docPages.textContent = 'Reading…';
  workspace.hidden = false;

  let loaded;
  try {
    loaded = await loadPdf(file);
  } catch (e) {
    if (e instanceof PdfEngineError) {
      src = null;
      workspace.hidden = true;
      setIntakeNote('Couldn’t load the PDF engine — check your connection and add the file again.');
      return;
    }
    src = null;
    workspace.hidden = true;
    setIntakeNote('Couldn’t read this PDF — it may be corrupt.');
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
    setIntakeNote(`Loaded this PDF · ignored ${extras} other ${plural(extras, 'file')} (this tool splits one PDF at a time).`);
  } else {
    intakeNote.hidden = true;
  }
  recompute();
}

function setIntakeNote(text) {
  intakeNote.textContent = text;    // textContent → no HTML injection from names
  intakeNote.hidden = false;
}

// --- Mode selection ----------------------------------------------------------

modeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  const next = btn.dataset.mode;
  if (next === mode) return;
  mode = next;
  for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));

  const isRangeMode = mode === 'extract' || mode === 'ranges';
  rangeField.hidden = !isRangeMode;
  nField.hidden = mode !== 'everyn';
  if (mode === 'extract') {
    rangeLabel.textContent = 'Pages to extract';
    rangeInput.placeholder = 'e.g. 1-3, 5, 8-10';
  } else if (mode === 'ranges') {
    rangeLabel.textContent = 'Ranges (each becomes its own file)';
    rangeInput.placeholder = 'e.g. 1-5, 6-10';
  }
  recompute();
});

rangeInput.addEventListener('input', recompute);
nInput.addEventListener('input', recompute);

// --- Preview / validation ----------------------------------------------------
// Compute the current split plan and reflect it in the preview line + errors +
// Run enabled state. Returns the plan so run() can reuse it.
function currentPlan() {
  if (!src || src.status !== 'ok') return { valid: false };
  const pageCount = src.pageCount;

  if (mode === 'extract') {
    const r = parseRanges(rangeInput.value, pageCount);
    return {
      mode, valid: r.flat.length > 0, errors: r.errors, flat: r.flat,
      preview: r.flat.length
        ? `Extract ${r.flat.length} ${plural(r.flat.length, 'page')} → 1 PDF`
        : '',
    };
  }
  if (mode === 'ranges') {
    const r = parseRanges(rangeInput.value, pageCount);
    const n = r.groups.length;
    return {
      mode, valid: n > 0, errors: r.errors, groups: r.groups, naming: 'range',
      preview: n ? `Split into ${n} ${plural(n, 'PDF')}` : '',
    };
  }
  if (mode === 'everyn') {
    const raw = parseInt(nInput.value, 10);
    if (!Number.isFinite(raw) || raw < 1) {
      return { mode, valid: false, errors: ['enter how many pages each file should hold (1 or more)'], preview: '' };
    }
    const groups = everyN(pageCount, raw);
    const n = groups.length;
    const whole = n === 1 ? ' — the whole document' : '';
    return {
      mode, valid: true, errors: [], groups, naming: 'part',
      preview: `Every ${raw} ${plural(raw, 'page')} → ${n} ${plural(n, 'PDF')}${whole}`,
    };
  }
  // burst
  const groups = burst(pageCount);
  const n = groups.length;
  return {
    mode, valid: n > 0, errors: [], groups, naming: 'range',
    preview: `Burst ${pageCount} ${plural(pageCount, 'page')} → ${n} ${plural(n, 'PDF')}`,
  };
}

function recompute() {
  const plan = currentPlan();
  // Range errors: list the bad tokens (valid tokens still work alongside them).
  const errs = plan.errors || [];
  if (errs.length) {
    rangeError.textContent = errs.join(' · ');   // textContent → tokens inert
    rangeError.hidden = false;
  } else {
    rangeError.hidden = true;
  }
  preview.textContent = plan.preview || (src ? 'Enter pages to split.' : '');
  if (!working) runBtn.disabled = !plan.valid;
  return plan;
}

// --- Run ---------------------------------------------------------------------

function stem() {
  const base = String(src?.name || 'document').replace(/\.pdf$/i, '').trim();
  return base || 'document';
}

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

runBtn.addEventListener('click', async () => {
  const plan = currentPlan();
  if (!plan.valid || !src) return;
  working = true;
  runBtn.disabled = true;
  runBtn.textContent = 'Working…';
  runError.hidden = true;
  const s = stem();
  try {
    if (plan.mode === 'extract') {
      const out = await buildExtract(src.bytes, plan.flat, s);
      downloadBytes(out.bytes, out.name);
    } else {
      const outputs = await buildOutputs(src.bytes, plan.groups, s, { naming: plan.naming });
      if (outputs.length === 1) {
        downloadBytes(outputs[0].bytes, outputs[0].name);
      } else {
        const zip = await zipOutputs(outputs, s);
        downloadBlob(zip.blob, zip.name);
      }
    }
  } catch (err) {
    runError.textContent = (err instanceof PdfEngineError)
      ? 'Couldn’t load the PDF engine — check your connection and try again.'
      : 'Couldn’t split this PDF — it may be too large for this device’s memory.';
    runError.hidden = false;
  } finally {
    working = false;
    runBtn.textContent = 'Split & download';
    recompute();
  }
});

clearBtn.addEventListener('click', () => {
  src = null;
  workspace.hidden = true;
  intakeNote.hidden = true;
  runError.hidden = true;
  rangeError.hidden = true;
  rangeInput.value = '';
  nInput.value = '1';
  preview.textContent = '';
});

document.documentElement.dataset.bootReady = '1';
