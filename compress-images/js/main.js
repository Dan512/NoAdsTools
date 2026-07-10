// compress-images/js/main.js — boot + tool wiring. English-first; minimal
// chrome (no language picker / settings gear); shared privacy panel with this
// tool's disclosure. Pipeline: intake (files / drop / paste) → compress.js
// coordinator drives one Web Worker that decodes natively and encodes with the
// vendored @jsquash codecs (quality slider OR target-size search) → result
// cards → per-item download / ZIP / clear.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { escapeHtml } from '/shared/escape.js';
import { CODEC_META } from '/shared/jsquash-loader.js';
import {
  createSession, addFiles, compressAll, compressPending, clearSession,
} from './compress.js';
import { savings } from './plan-quality.js';
import { loadJSZip } from './zip.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  cmPrivacyTitle: 'Privacy',
  cmPrivacyLead: 'This tool compresses images entirely in your browser. Your images never leave your device — no upload, no account, no tracking. Compressing also strips EXIF/GPS metadata.',
  cmPrivacyFetchHeading: 'What this page loads',
  cmPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The JPEG encoder (mozjpeg, ~246 KB WebAssembly, from this origin) — only when you compress to JPEG.</li>'
    + '<li>The WebP encoder (~338 KB, from this origin) — only when you compress to WebP.</li>'
    + '<li>The AVIF encoder (~3.3 MB, from this origin) — only when you compress to AVIF. It is the largest download and the slowest to run.</li>'
    + '<li>The PNG optimizer (oxipng, ~160 KB, from this origin) — only when you compress a PNG.</li>'
    + '<li>The JSZip library (~97 KB, from this origin) — only if you click "Download all (ZIP)". Used to package your images locally.</li>',
  cmPrivacyStorageHeading: 'Local storage',
  cmPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:compress-images</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'compress-images', lang: false, settings: false });
injectFooter({ toolId: 'compress-images' });
initI18n();
initSettings({ toolId: 'compress-images' });
registerPrivacyRows([
  { headingKey: 'cmPrivacyFetchHeading', bodyKey: 'cmPrivacyFetchList', kind: 'list' },
  { headingKey: 'cmPrivacyStorageHeading', bodyKey: 'cmPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'cmPrivacyTitle', leadKey: 'cmPrivacyLead' });

// --- State + DOM -----------------------------------------------------------

const session = createSession();
const cardEls = new Map();     // itemId -> card element (built once, updated in place)
let busy = 0;                  // >0 while a compress run is in flight (gates ZIP)
let avifDisabled = false;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const modeFieldset = document.getElementById('mode');
const qualityControl = document.getElementById('quality-control');
const qualityInput = document.getElementById('quality');
const qualityValue = document.getElementById('quality-value');
const targetControl = document.getElementById('target-control');
const targetSize = document.getElementById('target-size');
const targetUnit = document.getElementById('target-unit');
const outFormat = document.getElementById('out-format');
const avifCaution = document.getElementById('avif-caution');
const statusLine = document.getElementById('status-line');
const results = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const cardsEl = document.getElementById('cards');
const zipBtn = document.getElementById('download-zip');
const clearBtn = document.getElementById('clear-all');
const skipped = document.getElementById('skipped');
const skippedSummary = document.getElementById('skipped-summary');
const skippedList = document.getElementById('skipped-list');

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

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === 'target' ? 'target' : 'quality';
}

function currentParams() {
  const unit = Number(targetUnit.value) || 1024;
  const targetBytes = Math.max(1, Math.round((Number(targetSize.value) || 0) * unit));
  return {
    mode: currentMode(),
    quality: clampInt(qualityInput.value, 1, 100, 75),
    targetBytes,
    outFormatChoice: outFormat.value,
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
  renderSkipped();
  if (!added.length) {
    statusLine.hidden = false;
    statusLine.textContent = (session.counts.readded > beforeReadded)
      ? 'Those images are already in the list.'
      : 'No supported images found — this tool reads JPEG, PNG, WebP, and AVIF.';
    return;
  }
  statusLine.hidden = true;
  results.hidden = false;
  for (const it of added) renderCard(it);
  busy++; updateZipButton();
  try { await compressPending(session, currentParams()); }
  finally { busy--; renderSummary(); updateZipButton(); }
}

// --- Controls wiring -------------------------------------------------------

modeFieldset.addEventListener('change', (e) => {
  if (e.target?.name !== 'mode') return;
  const target = currentMode() === 'target';
  qualityControl.hidden = target;
  targetControl.hidden = !target;
  runAll();
});

qualityInput.addEventListener('input', () => {
  qualityValue.textContent = qualityInput.value;
  if (currentMode() === 'quality') debouncedRun();
});

let targetTimer = 0;
const onTargetEdit = () => {
  if (currentMode() !== 'target') return;
  clearTimeout(targetTimer);
  targetTimer = setTimeout(runAll, 300);
};
targetSize.addEventListener('input', onTargetEdit);
targetUnit.addEventListener('change', () => { if (currentMode() === 'target') runAll(); });

outFormat.addEventListener('change', () => {
  avifCaution.hidden = !(outFormat.value === 'avif' && !avifDisabled);
  runAll();
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
  try { await compressAll(session, currentParams()); }
  finally { busy--; renderSummary(); updateZipButton(); }
}

function disableAvif() {
  avifDisabled = true;
  const opt = outFormat.querySelector('option[value="avif"]');
  if (opt) { opt.disabled = true; opt.textContent = 'AVIF (encoder unavailable)'; }
  avifCaution.hidden = true;
  if (outFormat.value === 'avif') {
    outFormat.value = 'webp';
    statusLine.hidden = false;
    statusLine.textContent = 'The AVIF encoder could not load — switched to WebP and re-compressed.';
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
    return isAvif ? 'Encoding AVIF — this can take a few seconds…' : 'Compressing…';
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
  const fmtLabel = CODEC_META[item.outFormat]?.label || item.outFormat;

  let body = '';
  if (item.status === 'processing') {
    body = `<div class="card-status">${escapeHtml(phaseLabel(item))}</div>`;
  } else if (item.status === 'failed') {
    body = `<div class="card-error">${escapeHtml(errorText(item))}</div>`;
  } else if (item.status === 'kept-original') {
    body = `<div class="card-sizes">${prettyBytes(item.size)}</div>`
      + `<div class="card-note is-kept">Already optimized — kept the original file.</div>`
      + `<div class="card-meta">${escapeHtml(fmtLabel)}</div>`;
  } else if (item.status === 'done') {
    const s = savings(item.size, item.outSize);
    body = `<div class="card-sizes">${prettyBytes(item.size)} <span class="card-arrow">→</span> ${prettyBytes(item.outSize)}</div>`
      + `<div class="card-saved">${s.percent}% smaller · saved ${prettyBytes(s.savedBytes)}</div>`
      + `<div class="card-meta">${escapeHtml(fmtLabel)}${item.quality != null ? ` · quality ${item.quality}` : ' · lossless'}</div>`;
    if (item.fallback && item.note) {
      body += `<div class="card-note is-fallback">${escapeHtml(item.note)}</div>`;
    }
    if (item.targetOk === false) {
      body += `<div class="card-note is-warn">${escapeHtml(item.note
        || 'Could not reach the target size at any quality. Try reducing the image dimensions first in the Photo Editor.')}</div>`;
    }
  }

  const canDownload = (item.status === 'done' || item.status === 'kept-original') && item.outBlob;
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
    return 'This image could not be decoded — it may be damaged or use an unsupported variant.';
  }
  if (item.error === 'the browser ran out of memory for this image') return item.error;
  return 'This image could not be compressed.';
}

function renderSummary() {
  const done = session.items.filter((it) => it.status === 'done' || it.status === 'kept-original');
  const failed = session.items.filter((it) => it.status === 'failed');
  if (!done.length && !failed.length) { summaryEl.textContent = ''; return; }
  let origTotal = 0, outTotal = 0;
  for (const it of done) { origTotal += it.size; outTotal += it.outSize || it.size; }
  const s = savings(origTotal, outTotal);
  let line = done.length
    ? `Compressed ${done.length} ${plural(done.length, 'image')} — saved ${prettyBytes(s.savedBytes)} (${s.percent}%).`
    : '';
  if (failed.length) line += `${line ? ' ' : ''}${failed.length} ${plural(failed.length, 'image')} could not be compressed.`;
  summaryEl.textContent = line;
}

function renderSkipped() {
  const { nonImage } = session.counts;
  if (!nonImage) { skipped.hidden = true; skippedList.textContent = ''; return; }
  skippedSummary.textContent = `Skipped ${nonImage} non-image ${plural(nonImage, 'file')}`;
  skippedList.innerHTML = `<li>This tool compresses JPEG, PNG, WebP, and AVIF images only.</li>`;
  skipped.hidden = false;
}

function keepers() {
  return session.items.filter((it) => (it.status === 'done' || it.status === 'kept-original') && it.outBlob);
}

function updateZipButton() {
  zipBtn.disabled = busy > 0 || keepers().length === 0;
}

// --- Download + ZIP --------------------------------------------------------

function outName(item) {
  const stem = item.name.replace(/\.[^.]+$/, '') || item.name;
  const ext = CODEC_META[item.outFormat]?.ext || 'img';
  return `${stem}.${ext}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadItem(item) {
  if (!item.outBlob) return;
  downloadBlob(item.outBlob, outName(item));
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
      let name = outName(item);
      if (used.has(name)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 2;
        while (used.has(`${stem} (${i})${ext}`)) i++;
        name = `${stem} (${i})${ext}`;
      }
      used.add(name);
      // STORE: the bytes are already compressed — deflating again wastes time.
      zip.file(name, item.outBlob, { compression: 'STORE' });
    }
    let blob;
    try { blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); }
    catch {
      showActionError("Building the ZIP failed — this set may be too large for this device's memory.");
      return;
    }
    downloadBlob(blob, 'compressed-images.zip');
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
  skipped.hidden = true; skippedList.textContent = '';
  results.hidden = true;
  statusLine.hidden = true; statusLine.textContent = '';
  clearActionError();
  updateZipButton();
});

updateZipButton();
document.documentElement.dataset.bootReady = '1';
