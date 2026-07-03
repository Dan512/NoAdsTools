// heic-to-jpg/js/main.js — boot + tool wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Processing: HEIC bytes -> lazy libheif decode -> canvas -> JPEG
// at the selected quality; "Keep photo info" (default OFF) re-injects the
// original EXIF via shared/exif.js.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { extractExifFromHeif, injectExifIntoJpeg } from '/shared/exif.js';
import { escapeHtml } from '/shared/escape.js';
import { loadHeicDecoder } from '/shared/heic-loader.js';
import { loadJSZip } from './zip.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  hjPrivacyTitle: 'Privacy',
  hjPrivacyLead: 'This tool converts HEIC photos to JPG entirely in your browser. Your photos never leave your device — no upload, no account, no tracking.',
  hjPrivacyFetchHeading: 'What this page loads',
  hjPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The HEIC decoder (libheif, ~1.1 MB WebAssembly, from this origin) — ONLY when your first file lands. Nothing is fetched before that.</li><li>The JSZip library (~97 KB, from this origin) — ONLY if you click "Download ZIP". Used to package your converted files locally.</li>',
  hjPrivacyStorageHeading: 'Local storage',
  hjPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:heic-to-jpg</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'heic-to-jpg', lang: false, settings: false });
injectFooter({ toolId: 'heic-to-jpg' });
initI18n();
initSettings({ toolId: 'heic-to-jpg' });
registerPrivacyRows([
  { headingKey: 'hjPrivacyFetchHeading', bodyKey: 'hjPrivacyFetchList', kind: 'list' },
  { headingKey: 'hjPrivacyStorageHeading', bodyKey: 'hjPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'hjPrivacyTitle', leadKey: 'hjPrivacyLead' });

const state = []; // { name, blob } per successfully converted row
const dropzone = document.getElementById('dropzone');
const input = document.getElementById('file-input');
const results = document.getElementById('results');
const list = document.getElementById('result-list');
const qualitySelect = document.getElementById('quality');
const keepMetadata = document.getElementById('keep-metadata');

input.addEventListener('change', () => { handleFiles([...input.files]); input.value = ''; });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); dropzone.classList.remove('is-drag');
  handleFiles([...e.dataTransfer.files]);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) handleFiles(files);
});
// A drop that misses the dropzone must not navigate the tab away (which
// would destroy every converted row). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function handleFiles(files) {
  for (const file of files) await processFile(file);
  results.hidden = list.children.length === 0;
}

// HEIC/HEIF sniff by MIME or extension — files from the picker/drop often
// arrive with an empty MIME type on Windows, so the extension check matters.
function isHeicFile(file) {
  if (/^image\/hei[cf]$/i.test(file.type || '')) return true;
  return /\.(heic|heif)$/i.test(file.name || '');
}

// Friendly label for "you gave me something that's already browser-readable".
function alreadyLabel(file) {
  const byMime = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'image/bmp': 'BMP', 'image/avif': 'AVIF' }[
    (file.type || '').toLowerCase()];
  if (byMime) return byMime;
  const m = /\.(jpe?g|png|webp|gif|bmp|avif)$/i.exec(file.name || '');
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return { jpg: 'JPG', jpeg: 'JPG', png: 'PNG', webp: 'WebP', gif: 'GIF', bmp: 'BMP', avif: 'AVIF' }[ext] ?? null;
}

function jpgName(name) {
  return /\.(heic|heif)$/i.test(name) ? name.replace(/\.(heic|heif)$/i, '.jpg') : `${name}.jpg`;
}

async function processFile(file) {
  const li = document.createElement('li');
  li.className = 'result-row';
  li.innerHTML = `<div class="result-name">${escapeHtml(file.name)}</div><div class="report">Converting…</div>`;
  list.appendChild(li);
  results.hidden = false;
  const reportEl = li.querySelector('.report');

  if (!isHeicFile(file)) {
    const label = alreadyLabel(file);
    reportEl.innerHTML = label
      ? `<span class="result-note">Already a ${escapeHtml(label)} — nothing to convert. This tool turns HEIC/HEIF photos into JPGs. Want the metadata gone instead? Try <a href="/remove-exif/">Remove EXIF data</a>.</span>`
      : `<div class="result-error">This doesn't look like a HEIC photo — nothing was converted.</div>`;
    return;
  }

  // Read the toggles at convert time — each file honors the current state.
  const quality = parseFloat(qualitySelect.value) || 0.92;
  const keep = keepMetadata.checked;

  try {
    const decoder = await loadHeicDecoder().catch(() => null);
    if (!decoder) {
      reportEl.innerHTML = `<div class="result-error">Couldn't load the HEIC decoder — check your connection and try again.</div>`;
      return;
    }
    const imageData = await decoder.decode(await file.arrayBuffer());
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width; canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(
      new ImageData(imageData.data, imageData.width, imageData.height), 0, 0);
    let blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error('jpeg_encode_failed');

    // "Keep photo info": splice the original HEIC's EXIF into the JPEG.
    // Finding none is not an error — convert anyway and say so.
    let metaNote = 'Photo info (EXIF/GPS) not carried over — the default.';
    if (keep) {
      const seg = await extractExifFromHeif(file);
      if (seg) {
        blob = await injectExifIntoJpeg(blob, seg);
        metaNote = 'Photo info kept — the original EXIF was copied into the JPG.';
      } else {
        metaNote = 'No photo info found to keep — converted without it.';
      }
    }

    const item = { name: jpgName(file.name), blob };
    state.push(item);
    reportEl.innerHTML = `
      <span class="convert-ok">Converted to JPG (${prettyBytes(blob.size)})</span>
      <span class="result-note">${metaNote}</span>
      <span class="result-note">Saves as ${escapeHtml(item.name)}</span>
      <button type="button" class="download-one">Download</button>`;
    // Capture THIS row's item — evaluating state[state.length - 1] at click
    // time would download whichever file was converted last, not this row's.
    li.querySelector('.download-one').addEventListener('click', () => downloadOne(item));
    addThumb(li, canvas);
  } catch (err) {
    // Distinguish "the browser couldn't re-encode" (canvas size limits — the
    // common case for 24/48 MP iPhone shots on iOS Safari) from "the file
    // couldn't be decoded" — blaming the file for a browser limit is dishonest.
    reportEl.innerHTML = err && err.message === 'jpeg_encode_failed'
      ? `<div class="result-error">This photo is too large for this browser to re-encode. Try the <a href="/photo-editor/">Photo Editor</a>, which can downscale large images on import.</div>`
      : `<div class="result-error">This file couldn't be decoded as HEIC — it may be damaged or use an unsupported variant.</div>`;
  }
}

// Small preview thumbnail drawn from the decode canvas. Data URL (a few KB)
// rather than an object URL so there's no revocation bookkeeping.
function addThumb(li, canvas) {
  try {
    const max = 96;
    const scale = Math.min(1, max / Math.max(canvas.width, canvas.height));
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(canvas.width * scale));
    t.height = Math.max(1, Math.round(canvas.height * scale));
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    const img = document.createElement('img');
    img.className = 'result-thumb';
    img.alt = '';
    img.width = 64; img.height = 64;
    img.src = t.toDataURL('image/jpeg', 0.7);
    li.insertBefore(img, li.firstChild);
    li.classList.add('has-thumb');
  } catch { /* a missing thumbnail is not worth an error row */ }
}

// Human-readable byte count for the converted-size line ("32 B", "1.4 MB").
function prettyBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  const s = v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[u]}`;
}

function downloadOne(item) {
  const url = URL.createObjectURL(item.blob);
  const a = document.createElement('a');
  a.href = url; a.download = item.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

document.getElementById('download-all').addEventListener('click', () => {
  state.forEach((item, i) => setTimeout(() => downloadOne(item), i * 300));
});
document.getElementById('download-zip').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    for (const item of state) zip.file(item.name, item.blob);
    const blobOut = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blobOut);
    const a = document.createElement('a');
    a.href = url; a.download = 'noadstools-converted.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    // Honest failure beats silence: JSZip couldn't load (or packaging failed).
    // zip.js resets its cache on rejection, so clicking again retries.
    let errEl = results.querySelector('.zip-error');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'result-error zip-error';
      results.insertBefore(errEl, list);
    }
    errEl.textContent = "Couldn't load the ZIP packager — check your connection and try again.";
  } finally { btn.disabled = false; }
});
document.getElementById('clear-all').addEventListener('click', () => {
  state.length = 0; list.innerHTML = ''; results.hidden = true;
});

document.documentElement.dataset.bootReady = '1';
