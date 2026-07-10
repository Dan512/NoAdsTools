// favicon-generator/js/main.js — boot + wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Pipeline: intake (one source image via file / drop / paste) →
// createImageBitmap → live preview (16 / 32 / 180 + tab mock) as the controls
// change → "Download package" renders each size (render.js), hand-rolls the
// favicon.ico (ico-encode.js), builds site.webmanifest + the HTML snippet
// (manifest.js), and STOREs everything into favicon-package.zip (JSZip, lazy).
//
// SAFETY: user-derived strings (the site name, the source filename) only ever
// reach the DOM through textContent — never innerHTML — so markup in them is
// inert by construction (no escape step can be skipped). The manifest JSON is
// made inert by JSON.stringify inside manifest.js.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { isAcceptedImage } from './intake.js';
import { renderSquareCanvas, squareAndResize } from './render.js';
import { icoEncode } from './ico-encode.js';
import { buildManifest, buildHtmlSnippet } from './manifest.js';
import { loadJSZip } from './zip.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  fgPrivacyTitle: 'Privacy',
  fgPrivacyLead: 'This tool builds a favicon package entirely in your browser. Your image never leaves your device — no upload, no account, no tracking. The icons are drawn from your image on a canvas, and the ZIP is assembled locally.',
  fgPrivacyFetchHeading: 'What this page loads',
  fgPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The JSZip library (~97 KB, from this origin) — only if you click "Download package". Used to pack the favicon files locally.</li>',
  fgPrivacyStorageHeading: 'Local storage',
  fgPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:favicon-generator</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'favicon-generator', lang: false, settings: false });
injectFooter({ toolId: 'favicon-generator' });
initI18n();
initSettings({ toolId: 'favicon-generator' });
registerPrivacyRows([
  { headingKey: 'fgPrivacyFetchHeading', bodyKey: 'fgPrivacyFetchList', kind: 'list' },
  { headingKey: 'fgPrivacyStorageHeading', bodyKey: 'fgPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'fgPrivacyTitle', leadKey: 'fgPrivacyLead' });

// --- State ------------------------------------------------------------------

const state = {
  bitmap: null,
  srcW: 0, srcH: 0,
  fit: 'pad',           // 'pad' | 'crop'
  bgMode: 'transparent',// 'transparent' | 'color'
  nonImage: 0,
};

// --- DOM --------------------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const fileLabelText = document.getElementById('file-label-text');
const fileInput = document.getElementById('file-input');
const statusLine = document.getElementById('status-line');
const editor = document.getElementById('editor');
const sourceNote = document.getElementById('source-note');
const siteNameInput = document.getElementById('site-name');
const themeColorInput = document.getElementById('theme-color');
const themeColorHex = document.getElementById('theme-color-hex');
const bgModeGroup = document.getElementById('bg-mode');
const bgColorRow = document.getElementById('bg-color-row');
const bgColorInput = document.getElementById('bg-color');
const bgColorHex = document.getElementById('bg-color-hex');
const fitGroup = document.getElementById('fit-mode');
const tabMock = document.querySelector('.fg-tab-mock');
const tabTitle = document.getElementById('tab-title');
const downloadBtn = document.getElementById('download-package');
const clearBtn = document.getElementById('clear-all');
const actionError = document.getElementById('action-error');
const skipped = document.getElementById('skipped');
const skippedSummary = document.getElementById('skipped-summary');
const skippedList = document.getElementById('skipped-list');

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
// A drop that misses the dropzone must not navigate the tab away (destroying the
// session). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function onAdd(files) {
  if (!files || !files.length) return;
  // This tool takes ONE source image — use the first accepted file.
  const file = files.find((f) => isAcceptedImage(f.name, f.type));
  if (!file) {
    state.nonImage++;
    renderSkipped();
    statusLine.hidden = false;
    statusLine.textContent = 'No supported image found — this tool reads PNG, JPEG, and WebP.';
    return;
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    state.nonImage++;
    renderSkipped();
    statusLine.hidden = false;
    statusLine.textContent = 'That image could not be decoded — it may be damaged or an unsupported variant.';
    return;
  }

  // Replace any previous source.
  if (state.bitmap) { try { state.bitmap.close?.(); } catch { /* ignore */ } }
  state.bitmap = bitmap;
  state.srcW = bitmap.width;
  state.srcH = bitmap.height;

  clearActionError();
  editor.hidden = false;
  setDropzoneCompact(true);
  // Show the loaded source name (textContent — markup in the name is inert).
  statusLine.hidden = false;
  statusLine.textContent = `Source: ${file.name} — ${state.srcW} × ${state.srcH} px`;

  updateSourceNote();
  syncTabMock();
  renderPreviews();
}

function setDropzoneCompact(compact) {
  dropzone.classList.toggle('is-compact', compact);
  if (fileLabelText) fileLabelText.textContent = compact ? 'Replace image' : 'Choose file';
}

function renderSkipped() {
  if (!state.nonImage) { skipped.hidden = true; skippedList.textContent = ''; return; }
  skippedSummary.textContent = `Skipped ${state.nonImage} ${state.nonImage === 1 ? 'file' : 'files'}`;
  skippedList.innerHTML = '<li>This tool reads PNG, JPEG, and WebP images. SVG source is not supported yet (export a PNG for now); GIF, BMP, and AVIF are out of scope, and a damaged or unreadable image is skipped too.</li>';
  skipped.hidden = false;
}

// --- Notes ------------------------------------------------------------------

function updateSourceNote() {
  if (!state.bitmap) { sourceNote.hidden = true; return; }
  const notes = [];
  if (state.srcW !== state.srcH) {
    notes.push(state.fit === 'crop'
      ? 'Your image is not square, so it is cropped to a centered square — no distortion.'
      : 'Your image is not square, so it is padded to a square — no distortion.');
  }
  if (Math.min(state.srcW, state.srcH) < 512) {
    notes.push('It is smaller than 512 px, so the 192 and 512 icons are upscaled and may look soft.');
  }
  if (notes.length) { sourceNote.hidden = false; sourceNote.textContent = notes.join(' '); }
  else { sourceNote.hidden = true; sourceNote.textContent = ''; }
}

// --- Preview ----------------------------------------------------------------

/** Chosen background for the favicon PNGs + .ico. null = transparent. */
function currentBg() {
  return state.bgMode === 'color' ? bgColorInput.value : null;
}
/** Apple dislikes transparency, so apple-touch always gets a solid background. */
function appleBg() {
  return currentBg() || '#ffffff';
}

function drawPreview(targetId, size, bgColor) {
  const src = renderSquareCanvas(state.bitmap, size, { fit: state.fit, bgColor });
  const target = document.getElementById(targetId);
  target.width = size; target.height = size;
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(src, 0, 0);
}

let rafId = 0;
function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; renderPreviews(); });
}

function renderPreviews() {
  if (!state.bitmap) return;
  const bg = currentBg();
  drawPreview('prev-16', 16, bg);
  drawPreview('prev-32', 32, bg);
  drawPreview('prev-180', 180, appleBg()); // apple-touch appearance (solid bg)
  drawPreview('tab-favicon', 16, bg);
}

function syncTabMock() {
  tabTitle.textContent = (siteNameInput.value || 'My Site').trim() || 'My Site';
  tabMock.style.borderBottomColor = themeColorInput.value;
}

// --- Controls ---------------------------------------------------------------

siteNameInput.addEventListener('input', syncTabMock);

themeColorInput.addEventListener('input', () => {
  themeColorHex.textContent = themeColorInput.value;
  tabMock.style.borderBottomColor = themeColorInput.value;
});

bgColorInput.addEventListener('input', () => {
  bgColorHex.textContent = bgColorInput.value;
  if (state.bgMode === 'color') scheduleRender();
});

bgModeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.fg-opt');
  if (!btn) return;
  state.bgMode = btn.dataset.bg;
  for (const b of bgModeGroup.querySelectorAll('.fg-opt')) {
    b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
  }
  bgColorRow.hidden = state.bgMode !== 'color';
  renderPreviews();
});

fitGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.fg-opt');
  if (!btn) return;
  state.fit = btn.dataset.fit;
  for (const b of fitGroup.querySelectorAll('.fg-opt')) {
    b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
  }
  updateSourceNote();
  renderPreviews();
});

// --- Download ---------------------------------------------------------------

function showActionError(msg) { actionError.hidden = false; actionError.textContent = msg; }
function clearActionError() { actionError.hidden = true; actionError.textContent = ''; }

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

downloadBtn.addEventListener('click', async () => {
  if (!state.bitmap) return;
  clearActionError();
  downloadBtn.disabled = true;
  const label = downloadBtn.textContent;
  downloadBtn.textContent = 'Building…';
  try {
    const opts = { fit: state.fit, bgColor: currentBg() };
    // Render every size (favicon PNGs use the chosen bg; apple-touch is solid).
    const r16 = await squareAndResize(state.bitmap, 16, opts);
    const r32 = await squareAndResize(state.bitmap, 32, opts);
    const r48 = await squareAndResize(state.bitmap, 48, opts);
    const r192 = await squareAndResize(state.bitmap, 192, opts);
    const r512 = await squareAndResize(state.bitmap, 512, opts);
    const rApple = await squareAndResize(state.bitmap, 180, { fit: state.fit, bgColor: appleBg() });

    const ico = icoEncode([
      { size: 16, pngBytes: r16.pngBytes },
      { size: 32, pngBytes: r32.pngBytes },
      { size: 48, pngBytes: r48.pngBytes },
    ]);

    const name = (siteNameInput.value || 'My Site').trim() || 'My Site';
    const themeColor = themeColorInput.value;
    const manifest = buildManifest({ name, shortName: name, themeColor, bgColor: appleBg() });
    const snippet = buildHtmlSnippet({ themeColor });

    let JSZip;
    try { JSZip = await loadJSZip(); }
    catch {
      showActionError('The ZIP library could not load. Check your connection and try again.');
      return;
    }

    const zip = new JSZip();
    const store = { compression: 'STORE' }; // PNG/ICO are already compact
    zip.file('favicon.ico', ico, store);
    zip.file('favicon-16x16.png', r16.blob, store);
    zip.file('favicon-32x32.png', r32.blob, store);
    zip.file('favicon-48x48.png', r48.blob, store);
    zip.file('favicon-192x192.png', r192.blob, store);
    zip.file('favicon-512x512.png', r512.blob, store);
    zip.file('apple-touch-icon.png', rApple.blob, store);
    zip.file('site.webmanifest', manifest, store);
    zip.file('favicon-snippet.html', snippet, store);

    let blob;
    try { blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); }
    catch {
      showActionError('Building the ZIP failed — this may be a memory limit on this device.');
      return;
    }
    downloadBlob(blob, 'favicon-package.zip');
  } catch {
    showActionError('The favicon package could not be generated in this browser. Try a different image.');
  } finally {
    downloadBtn.textContent = label;
    downloadBtn.disabled = false;
  }
});

// --- Clear ------------------------------------------------------------------

clearBtn.addEventListener('click', () => {
  if (state.bitmap) { try { state.bitmap.close?.(); } catch { /* ignore */ } }
  state.bitmap = null;
  state.srcW = 0; state.srcH = 0;
  state.nonImage = 0;
  editor.hidden = true;
  setDropzoneCompact(false);
  sourceNote.hidden = true; sourceNote.textContent = '';
  skipped.hidden = true; skippedList.textContent = '';
  statusLine.hidden = true; statusLine.textContent = '';
  clearActionError();
});

document.documentElement.dataset.bootReady = '1';
