// remove-exif/js/main.js — boot + tool wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Processing: bytes -> report -> surgical strip (canvas re-encode
// fallback, honestly labeled) -> verified-clean re-check via shared/exif.js.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { hasMetadata } from '/shared/exif.js';
import { stripImage } from './strip.js';
import { buildReport } from './report.js';
import { loadJSZip } from './zip.js';
import { escapeHtml } from '/shared/escape.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  rxPrivacyTitle: 'Privacy',
  rxPrivacyLead: 'This tool removes photo metadata entirely in your browser. Your images never leave your device — no upload, no account, no tracking.',
  rxPrivacyFetchHeading: 'What this page loads',
  rxPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The JSZip library (~97 KB, from this origin) — ONLY if you click "Download ZIP". Used to package your cleaned files locally.</li>',
  rxPrivacyStorageHeading: 'Local storage',
  rxPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:remove-exif</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'remove-exif', lang: false, settings: false });
injectFooter({ toolId: 'remove-exif' });
initI18n();
initSettings({ toolId: 'remove-exif' });
registerPrivacyRows([
  { headingKey: 'rxPrivacyFetchHeading', bodyKey: 'rxPrivacyFetchList', kind: 'list' },
  { headingKey: 'rxPrivacyStorageHeading', bodyKey: 'rxPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'rxPrivacyTitle', leadKey: 'rxPrivacyLead' });

const state = []; // { name, mime, bytes } per successful row
const dropzone = document.getElementById('dropzone');
const input = document.getElementById('file-input');
const results = document.getElementById('results');
const list = document.getElementById('result-list');

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
// would destroy every processed row). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function handleFiles(files) {
  for (const file of files) await processFile(file);
  results.hidden = list.children.length === 0;
}

async function processFile(file) {
  const li = document.createElement('li');
  li.className = 'result-row';
  li.innerHTML = `<div class="result-name">${escapeHtml(file.name)}</div><div class="report">Reading…</div>`;
  list.appendChild(li);
  results.hidden = false;
  const reportEl = li.querySelector('.report');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const report = buildReport(bytes);
    let r = stripImage(bytes);
    let note = 'Metadata removed surgically — pixels untouched.';
    if (!r.ok && r.reason === 'heic') {
      reportEl.innerHTML = `<div class="result-error">HEIC isn't supported here — convert it with our free <a href="/heic-to-jpg/">HEIC to JPG</a> tool, then clean it here.</div>`;
      return;
    }
    if (!r.ok) {
      const fb = await canvasFallback(file);
      if (!fb) {
        reportEl.innerHTML = `<div class="result-error">This file couldn't be read as an image.</div>`;
        return;
      }
      r = fb;
      note = 'File was re-encoded (unrecognized structure) — metadata removed, image re-compressed.';
    }
    const verify = await hasMetadata(new Blob([r.bytes]));
    const clean = !verify.exif && !verify.xmp && !verify.gps;
    const item = { name: file.name, mime: mimeFor(r.format), bytes: r.bytes };
    state.push(item);
    reportEl.innerHTML = `
      <span class="report-gps ${report.gps ? 'is-found' : 'is-clear'}">${report.gps ? 'Location (GPS): found — removed' : 'Location (GPS): none found'}</span>
      ${report.make || report.model ? `<span class="report-camera">Camera: ${escapeHtml([report.make, report.model].filter(Boolean).join(' '))}</span>` : ''}
      ${report.dateTime ? `<span class="report-date">Taken: ${escapeHtml(report.dateTime)}</span>` : ''}
      ${report.software ? `<span class="report-software">Software: ${escapeHtml(report.software)}</span>` : ''}
      ${report.found.length ? `<span class="report-found">Found: ${escapeHtml(report.found.join(', '))}</span>` : '<span class="report-found">No metadata blocks found.</span>'}
      ${r.trailing > 0 ? `<span class="report-trailing">Trailing data removed (${prettyBytes(r.trailing)}) — e.g. a motion-photo video clip</span>` : ''}
      ${clean ? '<span class="verified-clean">Verified clean — re-scanned after removal</span>' : '<span class="result-error">Verification failed — do not trust this output; please report this file type.</span>'}
      <span class="result-note">${note}</span>
      <button type="button" class="download-one">Download</button>`;
    // Capture THIS row's item — evaluating state[state.length - 1] at click
    // time would download whichever file was processed last, not this row's.
    li.querySelector('.download-one').addEventListener('click', () => downloadOne(item));
  } catch (err) {
    reportEl.innerHTML = `<div class="result-error">Something went wrong reading this file.</div>`;
  }
}

function mimeFor(format) {
  return { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format] ?? 'application/octet-stream';
}

// Human-readable byte count for the trailing-data report line ("32 B", "1.4 MB").
function prettyBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  const s = v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[u]}`;
}

async function canvasFallback(file) {
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const type = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/png';
    const blobOut = await new Promise((res) => canvas.toBlob(res, type, 0.95));
    if (!blobOut) return null;
    const format = type.split('/')[1] === 'jpeg' ? 'jpeg' : type.split('/')[1];
    return { ok: true, format, bytes: new Uint8Array(await blobOut.arrayBuffer()) };
  } catch { return null; }
}

function downloadOne(item) {
  const url = URL.createObjectURL(new Blob([item.bytes], { type: item.mime }));
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
    for (const item of state) zip.file(item.name, item.bytes);
    const blobOut = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blobOut);
    const a = document.createElement('a');
    a.href = url; a.download = 'noadstools-clean.zip';
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
