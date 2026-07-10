// color-palette-from-image/js/main.js — boot + tool wiring. English-first;
// minimal chrome (no language picker / settings gear); shared privacy panel
// with this tool's disclosure. Pipeline: intake (file / drop / paste) →
// createImageBitmap → draw into a ≤256px working canvas → getImageData →
// sample non-transparent pixels (cached) → quantize.js (hand-rolled median-cut)
// → dominant + N swatches, each showing its exact hex/RGB as TEXT (the color
// block is NEVER the only signal — the site owner is colorblind). Copy as hex
// list / CSS variables / JSON, or download the swatches as a PNG. No worker
// (quantizing a capped sample set is fast); NO vendored library, and — the
// headline privacy claim — ZERO third-party requests beyond the page's own assets.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { isAcceptedImage } from './intake.js';
import { quantize } from './quantize.js';
import { rgbToHex, rgbToHsl, labelOn, hexList, cssVars, toJson } from './color.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  cpPrivacyTitle: 'Privacy',
  cpPrivacyLead: 'This tool extracts a color palette entirely in your browser. Your image never leaves your device — no upload, no account, no tracking. The palette math is hand-written and runs on your image locally.',
  cpPrivacyFetchHeading: 'What this page loads',
  cpPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>Nothing else. This page makes NO third-party requests and loads NO extra libraries — palette extraction is pure JavaScript running on your image in the browser. After the page loads, it fetches nothing at all.</li>',
  cpPrivacyStorageHeading: 'Local storage',
  cpPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:color-palette-from-image</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'color-palette-from-image', lang: false, settings: false });
injectFooter({ toolId: 'color-palette-from-image' });
initI18n();
initSettings({ toolId: 'color-palette-from-image' });
registerPrivacyRows([
  { headingKey: 'cpPrivacyFetchHeading', bodyKey: 'cpPrivacyFetchList', kind: 'list' },
  { headingKey: 'cpPrivacyStorageHeading', bodyKey: 'cpPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'cpPrivacyTitle', leadKey: 'cpPrivacyLead' });

// --- Constants --------------------------------------------------------------

const WORKING_MAX = 256;      // longest side of the working canvas (bounds cost)
const TARGET_SAMPLES = 10000; // cap on pixels fed to quantize (palette unaffected)
const ALPHA_MIN = 128;        // skip near-transparent pixels

// --- State ------------------------------------------------------------------

const state = {
  samples: null,   // cached [r,g,b][] from the current image
  count: 6,        // palette size
  colors: [],      // current N-color palette
  dominant: null,  // most-populous cluster
  previewUrl: null,
};

// --- DOM --------------------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const statusLine = document.getElementById('status-line');
const result = document.getElementById('result');
const previewImg = document.getElementById('preview-img');
const previewName = document.getElementById('preview-name');
const countSelect = document.getElementById('color-count');
const dominantCard = document.getElementById('dominant-card');
const dominantSwatch = document.getElementById('dominant-swatch');
const dominantHex = document.getElementById('dominant-hex');
const dominantRgb = document.getElementById('dominant-rgb');
const dominantHsl = document.getElementById('dominant-hsl');
const dominantCopied = document.getElementById('dominant-copied');
const swatchGrid = document.getElementById('swatch-grid');
const copyHexBtn = document.getElementById('copy-hex');
const copyCssBtn = document.getElementById('copy-css');
const copyJsonBtn = document.getElementById('copy-json');
const downloadPngBtn = document.getElementById('download-png');
const actionError = document.getElementById('action-error');

// --- Status / error helpers -------------------------------------------------

function showStatus(text) { statusLine.hidden = false; statusLine.textContent = text; }
function hideStatus() { statusLine.hidden = true; statusLine.textContent = ''; }
function showActionError(text) { actionError.hidden = false; actionError.textContent = text; }
function clearActionError() { actionError.hidden = true; actionError.textContent = ''; }

// --- Intake -----------------------------------------------------------------

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
// destroy the current result). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function onAdd(files) {
  // Single active image — take the first accepted file; a new drop replaces.
  const file = (files || []).find((f) => isAcceptedImage(f.name, f.type));
  if (!file) {
    showStatus('No supported image found — this tool reads JPEG, PNG, WebP, AVIF, GIF, and BMP.');
    return;
  }
  hideStatus();
  await loadImage(file);
}

async function loadImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    showStatus('That image could not be read in this browser. Try a different file.');
    return;
  }
  const samples = sampleBitmap(bitmap);
  setPreview(file);
  try { bitmap.close?.(); } catch { /* ignore */ }

  if (!samples.length) {
    showStatus('That image had no opaque pixels to read a color from.');
    result.hidden = true;
    return;
  }
  state.samples = samples;
  clearActionError();
  result.hidden = false;
  render();
}

// Draw into a ≤256px working canvas, read pixels, and collect up to
// TARGET_SAMPLES opaque [r,g,b] samples. The downscale bounds cost without
// changing the palette; getImageData is same-origin (File-decoded), never tainted.
function sampleBitmap(bitmap) {
  const scale = Math.min(1, WORKING_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; }
  catch { return []; }
  const total = w * h;
  const step = Math.max(1, Math.floor(total / TARGET_SAMPLES));
  const samples = [];
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if (data[o + 3] < ALPHA_MIN) continue;
    samples.push([data[o], data[o + 1], data[o + 2]]);
  }
  return samples;
}

function setPreview(file) {
  if (state.previewUrl) { try { URL.revokeObjectURL(state.previewUrl); } catch { /* ignore */ } }
  state.previewUrl = URL.createObjectURL(file);
  previewImg.src = state.previewUrl;
  // textContent is inert — a hostile filename can never become markup here.
  previewName.textContent = file.name;
}

// --- Render -----------------------------------------------------------------

function render() {
  if (!state.samples || !state.samples.length) return;
  state.colors = quantize(state.samples, state.count);
  // Dominant is the shown palette's most-populous entry, so it always appears
  // among the swatches. (It can shift as the count slider changes — intended.)
  state.dominant = state.colors[0] || null;
  renderDominant();
  renderSwatches();
}

function renderDominant() {
  const c = state.dominant;
  if (!c) return;
  const hex = rgbToHex(c);
  const [h, s, l] = rgbToHsl(c);
  dominantSwatch.style.background = hex;
  dominantHex.textContent = hex;
  dominantRgb.textContent = `RGB ${c[0]}, ${c[1]}, ${c[2]}`;
  dominantHsl.textContent = `HSL ${h}, ${s}%, ${l}%`;
  dominantCard.setAttribute('aria-label', `Copy dominant color ${hex}`);
  dominantCopied.hidden = true;
}

function renderSwatches() {
  swatchGrid.textContent = '';
  for (const c of state.colors) {
    const hex = rgbToHex(c);
    const rgbText = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    // The hex + RGB carry the color as text for the accessible name too.
    btn.setAttribute('aria-label', `Copy ${hex}, ${rgbText}`);

    const block = document.createElement('span');
    block.className = 'swatch-color';
    block.style.background = hex;
    block.style.color = labelOn(c); // contrast-safe label per swatch luminance

    const hexSpan = document.createElement('span');
    hexSpan.className = 'swatch-hex';
    hexSpan.textContent = hex;
    block.appendChild(hexSpan);

    const rgb = document.createElement('span');
    rgb.className = 'swatch-rgb';
    rgb.textContent = rgbText;

    btn.appendChild(block);
    btn.appendChild(rgb);

    // Capture THIS swatch's hex + label span — never a loop-closure of the last.
    const capturedHex = hex;
    btn.addEventListener('click', () => onSwatchCopy(btn, hexSpan, capturedHex));
    swatchGrid.appendChild(btn);
  }
}

// --- Copy (Clipboard API + textarea fallback) -------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API rejected (permissions / non-secure context) — textarea fallback.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function onSwatchCopy(btn, hexSpan, hex) {
  const ok = await copyText(hex);
  if (!ok) { showActionError('This browser blocked copying to the clipboard.'); return; }
  clearActionError();
  // Confirmation is a text change, not a color change (colorblind-safe). The
  // RGB line stays visible, so the swatch keeps a text value even mid-flash.
  const prev = hexSpan.textContent;
  hexSpan.textContent = 'Copied';
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => { hexSpan.textContent = prev; }, 2000);
}

function wireCopyAll(btn, build) {
  const label = btn.textContent;
  btn.addEventListener('click', async () => {
    if (!state.colors.length) return;
    const ok = await copyText(build(state.colors));
    if (!ok) { showActionError('This browser blocked copying to the clipboard.'); return; }
    clearActionError();
    btn.textContent = 'Copied';
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => { btn.textContent = label; }, 2000);
  });
}
wireCopyAll(copyHexBtn, hexList);
wireCopyAll(copyCssBtn, cssVars);
wireCopyAll(copyJsonBtn, toJson);

dominantCard.addEventListener('click', async () => {
  const c = state.dominant;
  if (!c) return;
  const ok = await copyText(rgbToHex(c));
  if (!ok) { showActionError('This browser blocked copying to the clipboard.'); return; }
  clearActionError();
  dominantCopied.hidden = false;
  clearTimeout(dominantCard._copyTimer);
  dominantCard._copyTimer = setTimeout(() => { dominantCopied.hidden = true; }, 2000);
});

// --- Download palette PNG ---------------------------------------------------

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Render the swatches with their hex + RGB labels onto a canvas. Labels use the
// same contrast-safe color as the on-screen swatches (labelOn), so the text
// stays readable on very light or very dark colors.
function drawPaletteCanvas(colors) {
  const cellW = 160, cellH = 160;
  const cols = Math.max(1, colors.length);
  const canvas = document.createElement('canvas');
  canvas.width = cellW * cols;
  canvas.height = cellH;
  const ctx = canvas.getContext('2d');
  colors.forEach((c, i) => {
    const x = i * cellW;
    ctx.fillStyle = rgbToHex(c);
    ctx.fillRect(x, 0, cellW, cellH);
    ctx.fillStyle = labelOn(c);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 22px sans-serif';
    ctx.fillText(rgbToHex(c), x + cellW / 2, cellH / 2 - 10);
    ctx.font = '400 14px sans-serif';
    ctx.fillText(`rgb(${c[0]}, ${c[1]}, ${c[2]})`, x + cellW / 2, cellH / 2 + 18);
  });
  return canvas;
}

downloadPngBtn.addEventListener('click', () => {
  if (!state.colors.length) return;
  clearActionError();
  let canvas;
  try { canvas = drawPaletteCanvas(state.colors); }
  catch { showActionError('The palette image could not be created in this browser.'); return; }
  canvas.toBlob((blob) => {
    if (!blob) { showActionError('The palette image could not be created in this browser.'); return; }
    downloadBlob(blob, 'palette.png');
  }, 'image/png');
});

// --- Controls ---------------------------------------------------------------

countSelect.addEventListener('change', () => {
  const n = Number(countSelect.value);
  state.count = Number.isFinite(n) && n > 0 ? n : 6;
  if (state.samples && state.samples.length) render(); // re-quantize from cache — instant
});

document.documentElement.dataset.bootReady = '1';
