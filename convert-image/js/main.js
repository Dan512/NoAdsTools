// convert-image/js/main.js — boot + tool wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Pipeline: intake (files / drop / paste) → convert.js coordinator
// drives one Web Worker that decodes natively and encodes with the vendored
// @jsquash codecs to the USER-CHOSEN output format at a chosen quality → result
// cards → per-item download / ZIP / clear.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { escapeHtml } from '/shared/escape.js';
import { CODEC_META } from '/shared/jsquash-loader.js';
import {
  createSession, addFiles, convertAll, convertPending, clearSession,
} from './convert.js';
import { outName } from './out-name.js';
import { loadJSZip } from './zip.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  ciPrivacyTitle: 'Privacy',
  ciPrivacyLead: 'This tool converts images entirely in your browser. Your images never leave your device — no upload, no account, no tracking. Converting also strips EXIF/GPS metadata.',
  ciPrivacyFetchHeading: 'What this page loads',
  ciPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The JPEG encoder (mozjpeg, ~246 KB WebAssembly, from this origin) — only when you convert to JPEG.</li>'
    + '<li>The WebP encoder (~338 KB, from this origin) — only when you convert to WebP.</li>'
    + '<li>The AVIF encoder (~3.3 MB, from this origin) — only when you convert to AVIF. It is the largest download and the slowest to run.</li>'
    + '<li>The PNG optimizer (oxipng, ~160 KB, from this origin) — only when you convert to PNG.</li>'
    + '<li>The JSZip library (~97 KB, from this origin) — only if you click "Download all (ZIP)". Used to package your images locally.</li>',
  ciPrivacyStorageHeading: 'Local storage',
  ciPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:convert-image</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'convert-image', lang: false, settings: false });
injectFooter({ toolId: 'convert-image' });
initI18n();
initSettings({ toolId: 'convert-image' });
registerPrivacyRows([
  { headingKey: 'ciPrivacyFetchHeading', bodyKey: 'ciPrivacyFetchList', kind: 'list' },
  { headingKey: 'ciPrivacyStorageHeading', bodyKey: 'ciPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'ciPrivacyTitle', leadKey: 'ciPrivacyLead' });

// --- State + DOM -----------------------------------------------------------

const session = createSession();
const cardEls = new Map();     // itemId -> card element (built once, updated in place)
let busy = 0;                  // >0 while a convert run is in flight (gates ZIP)
let avifDisabled = false;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const qualityControl = document.getElementById('quality-control');
const qualityInput = document.getElementById('quality');
const qualityValue = document.getElementById('quality-value');
const outFormat = document.getElementById('out-format');
const avifCaution = document.getElementById('avif-caution');
const statusLine = document.getElementById('status-line');
const results = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const cardsEl = document.getElementById('cards');
const zipBtn = document.getElementById('download-zip');
const clearBtn = document.getElementById('clear-all');
const issues = document.getElementById('issues');
const issuesSummary = document.getElementById('issues-summary');
const issuesList = document.getElementById('issues-list');

const plural = (n, word) => (n === 1 ? word : `${word}s`);

function prettyBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  const s = v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[u]}`;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// --- Control reads ---------------------------------------------------------

/** The chosen output codec key; falls back off AVIF if its encoder was disabled. */
function currentOutFormat() {
  const v = outFormat.value;
  if (v === 'avif' && avifDisabled) return 'webp';
  return CODEC_META[v] ? v : 'webp';
}

function currentParams() {
  return {
    outFormat: currentOutFormat(),
    quality: clampInt(qualityInput.value, 1, 100, 80),
    onItemStart: (it) => { renderCard(it); },
    onProgress: (it) => { renderCard(it); },
    onItemDone: (it) => { handleItemDone(it); },
  };
}

function handleItemDone(item) {
  renderCard(item);
  if (item.error === 'avif_unavailable' && !avifDisabled) disableAvif();
  renderSummary();
  updateZipButton();
}

// --- Intake ----------------------------------------------------------------

fileInput.addEventListener('change', () => { onAdd([...fileInput.files]); fileInput.value = ''; });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); dropzone.classList.remove('is-drag');
  onAdd([...(e.dataTransfer?.files ?? [])]);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) onAdd(files);
});
// A drop that misses the dropzone must not navigate the tab away (which would
// destroy every result). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function onAdd(files) {
  if (!files || !files.length) return;
  const beforeReadded = session.counts.readded;
  const added = addFiles(session, files);
  renderIssues();
  if (!added.length) {
    statusLine.hidden = false;
    statusLine.textContent = (session.counts.readded > beforeReadded)
      ? 'Those images are already in the list.'
      : 'No supported images found — this tool reads JPEG, PNG, WebP, AVIF, GIF, and BMP.';
    return;
  }
  statusLine.hidden = true;
  results.hidden = false;
  for (const it of added) renderCard(it);
  busy++; updateZipButton();
  try { await convertPending(session, currentParams()); }
  finally { busy--; renderSummary(); updateZipButton(); }
}

// --- Controls wiring -------------------------------------------------------

function updateQualityVisibility() {
  // PNG is lossless — the quality knob does not apply.
  qualityControl.hidden = currentOutFormat() === 'png';
}

outFormat.addEventListener('change', () => {
  updateQualityVisibility();
  avifCaution.hidden = !(outFormat.value === 'avif' && !avifDisabled);
  runAll();
});

qualityInput.addEventListener('input', () => {
  qualityValue.textContent = qualityInput.value;
  if (currentOutFormat() !== 'png') debouncedRun();
});

let runTimer = 0;
function debouncedRun() {
  clearTimeout(runTimer);
  runTimer = setTimeout(runAll, 250);
}

async function runAll() {
  if (!session.items.length) return;
  results.hidden = false;
  busy++; updateZipButton();
  try { await convertAll(session, currentParams()); }
  finally { busy--; renderSummary(); updateZipButton(); }
}

function disableAvif() {
  avifDisabled = true;
  const opt = outFormat.querySelector('option[value="avif"]');
  if (opt) { opt.disabled = true; opt.textContent = 'AVIF (encoder unavailable)'; }
  avifCaution.hidden = true;
  if (outFormat.value === 'avif') {
    outFormat.value = 'webp';
    updateQualityVisibility();
    statusLine.hidden = false;
    statusLine.textContent = 'The AVIF encoder could not load — switched to WebP and re-converted.';
    runAll();
  }
}

// --- Rendering -------------------------------------------------------------

function phaseLabel(item) {
  const isAvif = item.outFormat === 'avif';
  if (item.phase === 'loading-codec') {
    return isAvif ? 'Downloading the AVIF encoder (3.3 MB)…' : 'Loading the encoder…';
  }
  if (item.phase === 'encoding') {
    return isAvif ? 'Encoding AVIF — this can take a few seconds…' : 'Converting…';
  }
  return 'Reading the image…';
}

function renderCard(item) {
  let card = cardEls.get(item.id);
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;
    cardsEl.appendChild(card);
    cardEls.set(item.id, card);
  }

  const thumb = item.thumbUrl
    ? `<img class="card-thumb" src="${item.thumbUrl}" alt="" width="64" height="64">`
    : '<span class="card-thumb-empty">…</span>';
  const name = `<div class="card-name">${escapeHtml(item.name)}</div>`;
  const fmtLabel = CODEC_META[item.outFormat]?.label || item.outFormat || '';

  let body = '';
  if (item.status === 'processing') {
    body = `<div class="card-status">${escapeHtml(phaseLabel(item))}</div>`;
  } else if (item.status === 'failed') {
    body = `<div class="card-error">${escapeHtml(errorText(item))}</div>`;
  } else if (item.status === 'done') {
    body = `<div class="card-format">${escapeHtml(item.sourceFormat)} <span class="card-arrow">→</span> ${escapeHtml(fmtLabel)}</div>`
      + `<div class="card-sizes">${prettyBytes(item.size)} <span class="card-arrow">→</span> ${prettyBytes(item.outSize)}</div>`
      + `<div class="card-meta">${item.quality != null ? `quality ${item.quality}` : 'lossless'}</div>`;
    if (item.firstFrame) {
      body += `<div class="card-note is-firstframe">First frame only — a GIF converts a single frame.</div>`;
    }
    if (item.fallback && item.note) {
      body += `<div class="card-note is-fallback">${escapeHtml(item.note)}</div>`;
    }
  }

  const canDownload = item.status === 'done' && item.outBlob;
  const dl = canDownload
    ? `<button type="button" class="card-download">Download</button>`
    : '';

  card.innerHTML = thumb + name + body + dl;
  if (canDownload) {
    // Capture THIS item — never read a "last item" closure (the playbook bug).
    card.querySelector('.card-download').addEventListener('click', () => downloadItem(item));
  }
}

function errorText(item) {
  if (item.error === 'avif_unavailable') {
    return 'The AVIF encoder could not load — AVIF output is disabled. WebP gives similarly small files.';
  }
  if (item.error === 'decode_failed') {
    return 'This image could not be decoded — it may be damaged, or an AVIF this browser cannot read.';
  }
  if (item.error === 'the browser ran out of memory for this image') return item.error;
  return 'This image could not be converted.';
}

function renderSummary() {
  const done = session.items.filter((it) => it.status === 'done');
  const failed = session.items.filter((it) => it.status === 'failed');
  if (!done.length && !failed.length) { summaryEl.textContent = ''; return; }
  const target = (CODEC_META[currentOutFormat()]?.label || currentOutFormat()).toUpperCase();
  let line = done.length
    ? `Converted ${done.length} ${plural(done.length, 'image')} to ${target}.`
    : '';
  if (failed.length) line += `${line ? ' ' : ''}${failed.length} ${plural(failed.length, 'image')} could not be converted.`;
  summaryEl.textContent = line;
}

function renderIssues() {
  const { nonImage } = session.counts;
  if (!nonImage) { issues.hidden = true; issuesList.textContent = ''; return; }
  issuesSummary.textContent = `Skipped ${nonImage} non-image ${plural(nonImage, 'file')}`;
  issuesList.innerHTML = '<li>This tool reads JPEG, PNG, WebP, AVIF, GIF, and BMP images. For iPhone HEIC photos, use the HEIC to JPG tool.</li>';
  issues.hidden = false;
}

function keepers() {
  return session.items.filter((it) => it.status === 'done' && it.outBlob);
}

function updateZipButton() {
  zipBtn.disabled = busy > 0 || keepers().length === 0;
}

// --- Download + ZIP --------------------------------------------------------

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadItem(item) {
  if (!item.outBlob) return;
  downloadBlob(item.outBlob, outName(item.name, item.outFormat));
}

zipBtn.addEventListener('click', async () => {
  if (busy > 0) return;
  const items = keepers();
  if (!items.length) return;
  clearActionError();
  zipBtn.disabled = true;
  const original = zipBtn.textContent;
  zipBtn.textContent = 'Building ZIP…';
  try {
    let JSZip;
    try { JSZip = await loadJSZip(); }
    catch {
      // zip.js resets its cache on rejection, so clicking again retries.
      showActionError('The ZIP library could not load. Check your connection and try again.');
      return;
    }
    const zip = new JSZip();
    const used = new Set();
    for (const item of items) {
      let name = outName(item.name, item.outFormat);
      if (used.has(name)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 2;
        while (used.has(`${stem} (${i})${ext}`)) i++;
        name = `${stem} (${i})${ext}`;
      }
      used.add(name);
      // STORE: the bytes are already codec-compressed — deflating again wastes time.
      zip.file(name, item.outBlob, { compression: 'STORE' });
    }
    let blob;
    try { blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); }
    catch {
      showActionError("Building the ZIP failed — this set may be too large for this device's memory.");
      return;
    }
    downloadBlob(blob, 'converted-images.zip');
  } finally {
    zipBtn.textContent = original;
    updateZipButton();
  }
});

function showActionError(message) {
  let el = results.querySelector('.action-error');
  if (!el) {
    el = document.createElement('p');
    el.className = 'card-error action-error';
    results.insertBefore(el, cardsEl);
  }
  el.textContent = message;
}
function clearActionError() { results.querySelector('.action-error')?.remove(); }

clearBtn.addEventListener('click', () => {
  clearSession(session); // aborts any in-flight run, revokes thumbnails
  cardEls.clear();
  cardsEl.textContent = '';
  summaryEl.textContent = '';
  issues.hidden = true; issuesList.textContent = '';
  results.hidden = true;
  statusLine.hidden = true; statusLine.textContent = '';
  clearActionError();
  updateZipButton();
});

updateQualityVisibility();
updateZipButton();
document.documentElement.dataset.bootReady = '1';
