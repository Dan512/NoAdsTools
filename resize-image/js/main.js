// resize-image/js/main.js — boot + tool wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Pipeline: intake (files / drop / paste) → resize.js coordinator
// (native decode → pica high-quality resize → native re-encode, keep-format) →
// result cards → per-item download / ZIP / clear. The resize runs automatically
// on add and on any control change (debounced); invalid controls just show an
// inline hint and never run.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { escapeHtml } from '/shared/escape.js';
import {
  createSession, addFiles, resizeAll, resizePending, clearSession,
} from './resize.js';
import { loadJSZip } from './zip.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  riPrivacyTitle: 'Privacy',
  riPrivacyLead: 'This tool resizes images entirely in your browser. Your images never leave your device — no upload, no account, no tracking. Re-encoding a resized image also removes its EXIF/GPS metadata; an image already smaller than your target is passed through unchanged and keeps its metadata.',
  riPrivacyFetchHeading: 'What this page loads',
  riPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The pica image-resizing library (~53 KB, from this origin) — only when you resize an image. It runs entirely on your device; nothing is sent anywhere.</li>'
    + '<li>The JSZip library (~97 KB, from this origin) — only if you click "Download all (ZIP)". Used to package your images locally.</li>',
  riPrivacyStorageHeading: 'Local storage',
  riPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:resize-image</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'resize-image', lang: false, settings: false });
injectFooter({ toolId: 'resize-image' });
initI18n();
initSettings({ toolId: 'resize-image' });
registerPrivacyRows([
  { headingKey: 'riPrivacyFetchHeading', bodyKey: 'riPrivacyFetchList', kind: 'list' },
  { headingKey: 'riPrivacyStorageHeading', bodyKey: 'riPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'riPrivacyTitle', leadKey: 'riPrivacyLead' });

// --- State + DOM -----------------------------------------------------------

const session = createSession();
const cardEls = new Map();     // itemId -> card element (built once, updated in place)
let busy = 0;                  // >0 while a resize run is in flight (gates ZIP)

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const modeFieldset = document.getElementById('mode');
const dimsControl = document.getElementById('dims-control');
const pctControl = document.getElementById('pct-control');
const targetW = document.getElementById('target-w');
const targetH = document.getElementById('target-h');
const aspectLock = document.getElementById('aspect-lock');
const pctInput = document.getElementById('target-pct');
const allowUpscale = document.getElementById('allow-upscale');
const controlMsg = document.getElementById('control-msg');
const statusLine = document.getElementById('status-line');
const results = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const cardsEl = document.getElementById('cards');
const zipBtn = document.getElementById('download-zip');
const clearBtn = document.getElementById('clear-all');
const skipped = document.getElementById('skipped');
const skippedSummary = document.getElementById('skipped-summary');
const skippedList = document.getElementById('skipped-list');

const FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' };
const FORMAT_EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MAX_DIM = 20000;

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

// --- Control reads + validation --------------------------------------------

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === 'percentage'
    ? 'percentage' : 'dimensions';
}

function readNum(el) {
  const raw = String(el.value).trim();
  if (raw === '') return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function currentParams() {
  return {
    mode: currentMode(),
    targetW: readNum(targetW) || 0,
    targetH: readNum(targetH) || 0,
    percent: readNum(pctInput) || 0,
    allowUpscale: allowUpscale.checked,
    aspectLock: aspectLock.checked,
    onItemStart: (it) => renderCard(it),
    onItemDone: (it) => { renderCard(it); renderSummary(); updateZipButton(); },
  };
}

/** Validate the controls; mark invalid fields (ring) and return a hint. */
function validate() {
  targetW.classList.remove('is-invalid');
  targetH.classList.remove('is-invalid');
  pctInput.classList.remove('is-invalid');

  if (currentMode() === 'percentage') {
    const p = readNum(pctInput);
    if (!Number.isFinite(p) || p <= 0) {
      pctInput.classList.add('is-invalid');
      return { ok: false, message: 'Enter a percentage above 0.' };
    }
    if (p > 1000) {
      pctInput.classList.add('is-invalid');
      return { ok: false, message: 'Percentage must be 1000 or less.' };
    }
    return { ok: true };
  }

  const w = readNum(targetW), h = readNum(targetH);
  const wOk = Number.isFinite(w) && w > 0;
  const hOk = Number.isFinite(h) && h > 0;
  if (Number.isFinite(w) && w > MAX_DIM) {
    targetW.classList.add('is-invalid');
    return { ok: false, message: `Width must be ${MAX_DIM} pixels or less.` };
  }
  if (Number.isFinite(h) && h > MAX_DIM) {
    targetH.classList.add('is-invalid');
    return { ok: false, message: `Height must be ${MAX_DIM} pixels or less.` };
  }
  if (aspectLock.checked) {
    if (!wOk && !hOk) {
      targetW.classList.add('is-invalid'); targetH.classList.add('is-invalid');
      return { ok: false, message: 'Enter a width, a height, or both.' };
    }
    return { ok: true };
  }
  // unlocked → an exact size needs both dimensions.
  if (!wOk || !hOk) {
    if (!wOk) targetW.classList.add('is-invalid');
    if (!hOk) targetH.classList.add('is-invalid');
    return { ok: false, message: 'Enter both a width and a height for an exact size, or lock the aspect ratio to use just one.' };
  }
  return { ok: true };
}

function showControlMsg(text) { controlMsg.textContent = text; controlMsg.hidden = false; }
function clearControlMsg() { controlMsg.textContent = ''; controlMsg.hidden = true; }

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
      : 'No supported images found — this tool reads JPEG, PNG, and WebP.';
    return;
  }
  statusLine.hidden = true;
  results.hidden = false;
  for (const it of added) renderCard(it);
  const v = validate();
  if (!v.ok) { showControlMsg(v.message); return; } // cards wait until controls are valid
  clearControlMsg();
  busy++; updateZipButton();
  try { await resizePending(session, currentParams()); }
  finally { busy--; renderSummary(); updateZipButton(); }
}

// --- Controls wiring -------------------------------------------------------

modeFieldset.addEventListener('change', (e) => {
  if (e.target?.name !== 'mode') return;
  const pct = currentMode() === 'percentage';
  dimsControl.hidden = pct;
  pctControl.hidden = !pct;
  runAll();
});

let runTimer = 0;
function debouncedRun() {
  clearTimeout(runTimer);
  runTimer = setTimeout(runAll, 250);
}

// Number-field edits: give immediate validity feedback, but debounce the resize.
function onControlEdit() {
  const v = validate();
  if (!v.ok) { showControlMsg(v.message); clearTimeout(runTimer); return; }
  clearControlMsg();
  debouncedRun();
}
targetW.addEventListener('input', onControlEdit);
targetH.addEventListener('input', onControlEdit);
pctInput.addEventListener('input', onControlEdit);
aspectLock.addEventListener('change', runAll);
allowUpscale.addEventListener('change', runAll);

async function runAll() {
  if (!session.items.length) { validate(); return; }
  const v = validate();
  if (!v.ok) { showControlMsg(v.message); return; }
  clearControlMsg();
  results.hidden = false;
  busy++; updateZipButton();
  try { await resizeAll(session, currentParams()); }
  finally { busy--; renderSummary(); updateZipButton(); }
}

// --- Rendering -------------------------------------------------------------

function stateNote(item) {
  if (item.action === 'kept-native') {
    return `<div class="card-note is-kept">${escapeHtml(item.note || 'kept native size (already smaller than the target)')}</div>`;
  }
  if (item.action === 'enlarged') {
    return `<div class="card-note is-enlarged">enlarged past the original size</div>`;
  }
  if (item.action === 'stretched') {
    return `<div class="card-note is-stretched">stretched to the exact size (aspect ratio not kept)</div>`;
  }
  return '';
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

  let body = '';
  if (item.status === 'pending') {
    body = `<div class="card-status">Waiting for the resize settings…</div>`;
  } else if (item.status === 'processing') {
    body = `<div class="card-status">Resizing…</div>`;
  } else if (item.status === 'failed') {
    body = `<div class="card-error">${escapeHtml(item.error || 'This image could not be resized.')}</div>`;
  } else if (item.status === 'done') {
    body = `<div class="card-dims">${item.nativeW}×${item.nativeH} <span class="card-arrow">→</span> ${item.outW}×${item.outH}</div>`
      + `<div class="card-meta">${escapeHtml(FORMAT_LABEL[item.sourceFormat] || item.sourceFormat)} · ${prettyBytes(item.outSize)}</div>`;
    body += stateNote(item);
    if (item.fallback && item.note) {
      body += `<div class="card-note is-fallback">${escapeHtml(item.note)}</div>`;
    }
  }

  const canDownload = item.status === 'done' && item.outBlob;
  const dl = canDownload
    ? `<button type="button" class="card-download" aria-label="Download ${escapeHtml(item.name)}">Download</button>`
    : '';

  card.innerHTML = thumb + name + body + dl;
  if (canDownload) {
    // Capture THIS item — never read a "last item" closure (the playbook bug).
    card.querySelector('.card-download').addEventListener('click', () => downloadItem(item));
  }
}

function renderSummary() {
  const done = session.items.filter((it) => it.status === 'done');
  const failed = session.items.filter((it) => it.status === 'failed');
  if (!done.length && !failed.length) { summaryEl.textContent = ''; return; }
  let line = done.length ? `Resized ${done.length} ${plural(done.length, 'image')}.` : '';
  const kept = done.filter((it) => it.action === 'kept-native').length;
  const enlarged = done.filter((it) => it.action === 'enlarged').length;
  const notes = [];
  if (kept) notes.push(`${kept} kept at native size`);
  if (enlarged) notes.push(`${enlarged} enlarged`);
  if (notes.length) line += ` (${notes.join(', ')}).`;
  if (failed.length) line += `${line ? ' ' : ''}${failed.length} ${plural(failed.length, 'image')} could not be resized.`;
  summaryEl.textContent = line;
}

function renderSkipped() {
  const { nonImage } = session.counts;
  if (!nonImage) { skipped.hidden = true; skippedList.textContent = ''; return; }
  skippedSummary.textContent = `Skipped ${nonImage} non-image ${plural(nonImage, 'file')}`;
  skippedList.innerHTML = `<li>This tool resizes JPEG, PNG, and WebP images only. AVIF and GIF are not supported yet.</li>`;
  skipped.hidden = false;
}

function keepers() {
  return session.items.filter((it) => it.status === 'done' && it.outBlob);
}

function updateZipButton() {
  zipBtn.disabled = busy > 0 || keepers().length === 0;
}

// --- Download + ZIP --------------------------------------------------------

function outName(item) {
  // Keep the original name + extension (format is unchanged). Extensionless
  // pasted files get the format's extension appended.
  return /\.[^.]+$/.test(item.name) ? item.name : `${item.name}.${FORMAT_EXT[item.sourceFormat] || 'img'}`;
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
      // STORE: the pixels are already re-encoded — deflating again wastes time.
      zip.file(name, item.outBlob, { compression: 'STORE' });
    }
    let blob;
    try { blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); }
    catch {
      showActionError("Building the ZIP failed — this set may be too large for this device's memory.");
      return;
    }
    downloadBlob(blob, 'resized-images.zip');
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
