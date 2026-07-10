// crop-image/js/main.js — boot + interactive crop wiring. English-first;
// minimal chrome (no language picker / settings gear); shared privacy panel
// with this tool's disclosure. Pipeline: intake (files / drop / paste) →
// createImageBitmap → one crop item per image (each keeps its own rect + aspect)
// → interactive stage (crop box + 8 handles + dimmed mask + rule-of-thirds) →
// per-image download / ZIP. The fiddly geometry lives in the Node-tested
// crop-rect.js; this file only translates pointer deltas → source px → those
// functions and repaints. Crop is cheap, so there is no worker.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { escapeHtml } from '/shared/escape.js';
import { isAcceptedImage, sourceFormat } from './intake.js';
import { clampRect, moveRect, applyAspect, resizeByHandle, fitInitialRect, mapRect } from './crop-rect.js';
import { cropToBlob } from './crop-render.js';
import { loadJSZip } from './zip.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  ciPrivacyTitle: 'Privacy',
  ciPrivacyLead: 'This tool crops images entirely in your browser. Your images never leave your device — no upload, no account, no tracking. The crop is drawn at full source resolution; re-encoding it also removes the image’s EXIF/GPS metadata.',
  ciPrivacyFetchHeading: 'What this page loads',
  ciPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The JSZip library (~97 KB, from this origin) — only if you click "Download all (ZIP)". Used to package your images locally.</li>',
  ciPrivacyStorageHeading: 'Local storage',
  ciPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:crop-image</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'crop-image', lang: false, settings: false });
injectFooter({ toolId: 'crop-image' });
initI18n();
initSettings({ toolId: 'crop-image' });
registerPrivacyRows([
  { headingKey: 'ciPrivacyFetchHeading', bodyKey: 'ciPrivacyFetchList', kind: 'list' },
  { headingKey: 'ciPrivacyStorageHeading', bodyKey: 'ciPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'ciPrivacyTitle', leadKey: 'ciPrivacyLead' });

// --- Constants --------------------------------------------------------------

const MIN_SIZE = 16; // source-pixel floor for the crop rectangle
const FORMAT_EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const THUMB_SIZE = 120;

// data-ratio value → aspect ratio (w/h). 'free' → null; 'original' → per image.
const RATIOS = {
  '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9,
  '3:4': 3 / 4, '2:3': 2 / 3, '9:16': 9 / 16,
};

// --- State ------------------------------------------------------------------

const state = {
  items: [],       // crop items (see makeItem)
  keys: new Set(), // re-add guard (name|size|lastModified)
  activeId: null,
  scale: 1,        // display px per source px for the active image
  seq: 0,
  nonImage: 0,
  readded: 0,
};

// --- DOM --------------------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const fileLabelText = document.getElementById('file-label-text');
const fileInput = document.getElementById('file-input');
const statusLine = document.getElementById('status-line');
const editor = document.getElementById('editor');
const strip = document.getElementById('strip');
const stage = document.getElementById('stage');
const frame = document.getElementById('stage-frame');
const stageImg = document.getElementById('stage-img');
const cropBox = document.getElementById('crop-box');
const presets = document.getElementById('presets');
const inX = document.getElementById('in-x');
const inY = document.getElementById('in-y');
const inW = document.getElementById('in-w');
const inH = document.getElementById('in-h');
const readout = document.getElementById('readout');
const downloadBtn = document.getElementById('download');
const zipBtn = document.getElementById('download-zip');
const clearBtn = document.getElementById('clear-all');
const actionError = document.getElementById('action-error');
const skipped = document.getElementById('skipped');
const skippedSummary = document.getElementById('skipped-summary');
const skippedList = document.getElementById('skipped-list');

const plural = (n, word) => (n === 1 ? word : `${word}s`);
const activeItem = () => state.items.find((it) => it.id === state.activeId) || null;

// Once images are loaded the full dashed dropzone collapses to a compact inline
// "+ Add images" control, so the crop stage sits above the fold (mobile-first).
// The "+" glyph + text keeps the affordance readable without relying on hue.
function setDropzoneCompact(compact) {
  dropzone.classList.toggle('is-compact', compact);
  if (fileLabelText) fileLabelText.textContent = compact ? '+ Add images' : 'Choose files';
}

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
// destroy the whole session). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function onAdd(files) {
  if (!files || !files.length) return;
  const beforeReadded = state.readded;
  const fresh = [];
  for (const file of files) {
    if (!isAcceptedImage(file.name, file.type)) { state.nonImage++; continue; }
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (state.keys.has(key)) { state.readded++; continue; }
    state.keys.add(key);
    fresh.push(file);
  }
  renderSkipped();
  if (!fresh.length) {
    statusLine.hidden = false;
    statusLine.textContent = (state.readded > beforeReadded)
      ? 'Those images are already loaded.'
      : 'No supported images found — this tool reads JPEG, PNG, and WebP.';
    return;
  }

  let firstNewId = null;
  for (const file of fresh) {
    const item = await makeItem(file);
    if (!item) continue; // decode failed — skipped with a note
    state.items.push(item);
    if (!firstNewId) firstNewId = item.id;
  }
  if (!state.items.length) return;

  statusLine.hidden = true;
  editor.hidden = false;
  setDropzoneCompact(true);
  // Focus the newest image if nothing is active yet; otherwise keep the current
  // one so an add mid-edit doesn't yank the user away.
  if (!state.activeId) state.activeId = firstNewId || state.items[0].id;
  renderStrip();
  renderStage();
  updateZipButton();
}

async function makeItem(file) {
  const fmt = sourceFormat(file.name, file.type) || 'jpeg';
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Undecodable image — surface it in the skipped panel rather than crash.
    state.nonImage++;
    renderSkipped();
    return null;
  }
  const srcW = bitmap.width, srcH = bitmap.height;
  const item = {
    id: `c${++state.seq}`,
    file, name: file.name, sourceFormat: fmt,
    bitmap, srcW, srcH,
    ratio: null, ratioKey: 'free',
    rect: fitInitialRect({ w: srcW, h: srcH }, null),
    thumbUrl: makeThumb(bitmap),
  };
  return item;
}

function makeThumb(bitmap) {
  try {
    const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return c.toDataURL('image/webp', 0.7);
  } catch {
    return null;
  }
}

function renderSkipped() {
  if (!state.nonImage) { skipped.hidden = true; skippedList.textContent = ''; return; }
  skippedSummary.textContent = `Skipped ${state.nonImage} ${plural(state.nonImage, 'file')}`;
  skippedList.innerHTML = '<li>This tool crops JPEG, PNG, and WebP images only. AVIF and GIF are not supported yet; a damaged or unreadable image is skipped too.</li>';
  skipped.hidden = false;
}

// --- Stage render -----------------------------------------------------------

function bounds() {
  const it = activeItem();
  return it ? { w: it.srcW, h: it.srcH } : { w: 1, h: 1 };
}

function renderStage() {
  const it = activeItem();
  if (!it) { editor.hidden = true; return; }

  // Reset the frame BEFORE measuring. A stale inline width from the previous
  // render (e.g. after the viewport narrowed, or after a clear + re-add at a
  // narrower width) otherwise inflates stage.clientWidth and pushes #tool past
  // the viewport → horizontal overflow at 375px.
  frame.style.width = '';
  frame.style.height = '';
  // Fit the image into the stage, letterboxed (may upscale a small image).
  const availW = Math.max(1, stage.clientWidth);
  const availH = Math.max(1, stage.clientHeight);
  const scale = Math.min(availW / it.srcW, availH / it.srcH);
  state.scale = scale;
  const dispW = Math.max(1, Math.round(it.srcW * scale));
  const dispH = Math.max(1, Math.round(it.srcH * scale));

  frame.style.width = `${dispW}px`;
  frame.style.height = `${dispH}px`;

  // Paint the image into the display canvas at device resolution for sharpness.
  const dpr = window.devicePixelRatio || 1;
  stageImg.width = Math.round(dispW * dpr);
  stageImg.height = Math.round(dispH * dpr);
  stageImg.style.width = `${dispW}px`;
  stageImg.style.height = `${dispH}px`;
  const ctx = stageImg.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, stageImg.width, stageImg.height);
  ctx.drawImage(it.bitmap, 0, 0, stageImg.width, stageImg.height);

  positionCropBox();
  syncInputs();
  renderPresets();
}

function positionCropBox() {
  const it = activeItem();
  if (!it) return;
  const d = mapRect(it.rect, state.scale);
  cropBox.style.left = `${d.x}px`;
  cropBox.style.top = `${d.y}px`;
  cropBox.style.width = `${d.w}px`;
  cropBox.style.height = `${d.h}px`;
}

function syncInputs() {
  const it = activeItem();
  if (!it) return;
  const r = it.rect;
  // Don't stomp a field the user is mid-edit in (would move the caret).
  const active = document.activeElement;
  if (active !== inX) inX.value = String(r.x);
  if (active !== inY) inY.value = String(r.y);
  if (active !== inW) inW.value = String(r.w);
  if (active !== inH) inH.value = String(r.h);
  inX.max = String(Math.max(0, it.srcW - r.w));
  inY.max = String(Math.max(0, it.srcH - r.h));
  inW.max = String(it.srcW);
  inH.max = String(it.srcH);
  updateReadout();
}

function updateReadout() {
  const it = activeItem();
  if (!it) { readout.textContent = ''; return; }
  readout.textContent = `${it.rect.w} × ${it.rect.h} px`;
}

// --- Pointer interaction ----------------------------------------------------

let drag = null; // { mode:'move'|'resize', handle, startX, startY, startRect, el, pointerId }

function beginDrag(e, mode, handle) {
  const it = activeItem();
  if (!it) return;
  e.preventDefault();
  const el = e.currentTarget;
  drag = {
    mode, handle,
    startX: e.clientX, startY: e.clientY,
    startRect: { ...it.rect },
    el, pointerId: e.pointerId,
  };
  try { el.setPointerCapture(e.pointerId); } catch { /* older engines */ }
  el.addEventListener('pointermove', onDragMove);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

function onDragMove(e) {
  if (!drag) return;
  const it = activeItem();
  if (!it) return;
  // Display-pixel delta ÷ scale = source-pixel delta. This is the whole trick.
  const ddx = (e.clientX - drag.startX) / state.scale;
  const ddy = (e.clientY - drag.startY) / state.scale;
  const b = { w: it.srcW, h: it.srcH };
  if (drag.mode === 'move') {
    it.rect = moveRect(drag.startRect, ddx, ddy, b);
  } else {
    it.rect = resizeByHandle(drag.startRect, drag.handle, ddx, ddy, { ratio: it.ratio, minSize: MIN_SIZE, bounds: b });
  }
  positionCropBox();
  syncInputs();
}

function endDrag(e) {
  if (!drag) return;
  const { el, pointerId } = drag;
  try { el.releasePointerCapture(pointerId); } catch { /* ignore */ }
  el.removeEventListener('pointermove', onDragMove);
  el.removeEventListener('pointerup', endDrag);
  el.removeEventListener('pointercancel', endDrag);
  drag = null;
}

// Interior drag = move. A pointerdown that lands on a handle is stopped there,
// so it never reaches this listener.
cropBox.addEventListener('pointerdown', (e) => beginDrag(e, 'move', null));
for (const h of cropBox.querySelectorAll('.handle')) {
  h.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    beginDrag(e, 'resize', h.dataset.handle);
  });
}

// Keyboard: arrow keys nudge the focused rectangle (1 px, Shift = 10 px).
cropBox.addEventListener('keydown', (e) => {
  const it = activeItem();
  if (!it) return;
  const step = e.shiftKey ? 10 : 1;
  let dx = 0, dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = -step;
  else if (e.key === 'ArrowDown') dy = step;
  else return;
  e.preventDefault();
  it.rect = moveRect(it.rect, dx, dy, { w: it.srcW, h: it.srcH });
  positionCropBox();
  syncInputs();
});

// --- Aspect presets ---------------------------------------------------------

presets.addEventListener('click', (e) => {
  const btn = e.target.closest('.preset');
  if (!btn) return;
  const it = activeItem();
  if (!it) return;
  const key = btn.dataset.ratio;
  const ratio = key === 'free' ? null
    : key === 'original' ? it.srcW / it.srcH
    : RATIOS[key] || null;
  it.ratioKey = key;
  it.ratio = ratio;
  it.rect = applyAspect(it.rect, ratio, { w: it.srcW, h: it.srcH });
  positionCropBox();
  syncInputs();
  renderPresets();
});

function renderPresets() {
  const it = activeItem();
  const key = it ? it.ratioKey : 'free';
  for (const btn of presets.querySelectorAll('.preset')) {
    btn.setAttribute('aria-pressed', btn.dataset.ratio === key ? 'true' : 'false');
  }
}

// --- Exact inputs -----------------------------------------------------------

function readInt(el, fallback) {
  const raw = String(el.value).trim();
  if (raw === '') return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? n : fallback;
}

function applyExact(changed) {
  const it = activeItem();
  if (!it) return;
  const r = it.rect;
  let x = readInt(inX, r.x), y = readInt(inY, r.y);
  let w = readInt(inW, r.w), h = readInt(inH, r.h);
  // While a ratio is locked, keep W/H proportional: the edited dimension wins.
  if (it.ratio) {
    if (changed === 'h') w = Math.round(h * it.ratio);
    else if (changed === 'w') h = Math.round(w / it.ratio);
  }
  // Floor to the min crop size so typing W/H = 1 can't make a sub-floor crop.
  w = Math.max(MIN_SIZE, w);
  h = Math.max(MIN_SIZE, h);
  it.rect = clampRect({ x, y, w, h }, { w: it.srcW, h: it.srcH });
  positionCropBox();
  updateReadout();
  // Reflect clamping in the sibling fields, but leave the field being typed in.
  const a = document.activeElement;
  if (a !== inX) inX.value = String(it.rect.x);
  if (a !== inY) inY.value = String(it.rect.y);
  if (a !== inW) inW.value = String(it.rect.w);
  if (a !== inH) inH.value = String(it.rect.h);
}

inX.addEventListener('input', () => applyExact('x'));
inY.addEventListener('input', () => applyExact('y'));
inW.addEventListener('input', () => applyExact('w'));
inH.addEventListener('input', () => applyExact('h'));
// On blur, normalize the field to the (clamped) rect so a half-typed or
// out-of-range value doesn't linger.
for (const el of [inX, inY, inW, inH]) {
  el.addEventListener('blur', () => syncInputs());
}

// --- Thumbnail strip --------------------------------------------------------

function renderStrip() {
  if (state.items.length <= 1) { strip.hidden = true; strip.textContent = ''; }
  else {
    strip.hidden = false;
    strip.textContent = '';
    for (const it of state.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'strip-thumb';
      btn.dataset.id = it.id;
      const isActive = it.id === state.activeId;
      btn.setAttribute('aria-current', isActive ? 'true' : 'false');
      const thumb = it.thumbUrl
        ? `<img src="${it.thumbUrl}" alt="" width="120" height="60">`
        : '<span class="strip-cap">no preview</span>';
      btn.innerHTML = thumb
        + `<span class="strip-cap">${isActive ? 'Editing' : ''}</span>`
        + `<span class="strip-name">${escapeHtml(it.name)}</span>`;
      const id = it.id; // capture THIS item's id — never a loop-closure of the last
      btn.addEventListener('click', () => setActive(id));
      strip.appendChild(btn);
    }
  }
  // ZIP only earns its place with more than one image (a single crop is just
  // "Download crop"). Kept honest either way.
  updateZipButton();
}

function setActive(id) {
  if (id === state.activeId) return;
  state.activeId = id;
  renderStrip();
  renderStage();
}

// --- Download + ZIP ---------------------------------------------------------

function outName(item) {
  const dot = item.name.lastIndexOf('.');
  if (dot > 0) return `${item.name.slice(0, dot)}-cropped${item.name.slice(dot)}`;
  return `${item.name}-cropped.${FORMAT_EXT[item.sourceFormat] || 'img'}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function showActionError(msg) { actionError.hidden = false; actionError.textContent = msg; }
function clearActionError() { actionError.hidden = true; actionError.textContent = ''; }

downloadBtn.addEventListener('click', async () => {
  const it = activeItem();          // capture THIS item at click time
  if (!it) return;
  clearActionError();
  downloadBtn.disabled = true;
  const label = downloadBtn.textContent;
  downloadBtn.textContent = 'Preparing…';
  try {
    const blob = await cropToBlob(it.bitmap, it.rect, it.sourceFormat);
    downloadBlob(blob, outName(it));
  } catch {
    showActionError('This image could not be cropped in this browser. Try a different image or format.');
  } finally {
    downloadBtn.textContent = label;
    downloadBtn.disabled = false;
  }
});

function updateZipButton() {
  const multi = state.items.length > 1;
  zipBtn.hidden = !multi;
  zipBtn.disabled = !multi;
}

zipBtn.addEventListener('click', async () => {
  const items = state.items.slice(); // snapshot before the first await
  if (items.length < 2) return;
  clearActionError();
  zipBtn.disabled = true;
  const label = zipBtn.textContent;
  zipBtn.textContent = 'Building ZIP…';
  try {
    let JSZip;
    try { JSZip = await loadJSZip(); }
    catch {
      showActionError('The ZIP library could not load. Check your connection and try again.');
      return;
    }
    const zip = new JSZip();
    const used = new Set();
    for (const it of items) {
      let blob;
      try { blob = await cropToBlob(it.bitmap, it.rect, it.sourceFormat); }
      catch { continue; } // skip an image that fails to encode; the rest still ship
      let name = outName(it);
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
      zip.file(name, blob, { compression: 'STORE' });
    }
    let blob;
    try { blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); }
    catch {
      showActionError("Building the ZIP failed — this set may be too large for this device's memory.");
      return;
    }
    downloadBlob(blob, 'cropped-images.zip');
  } finally {
    zipBtn.textContent = label;
    updateZipButton();
  }
});

// --- Clear ------------------------------------------------------------------

clearBtn.addEventListener('click', () => {
  for (const it of state.items) {
    try { it.bitmap?.close?.(); } catch { /* ignore */ }
    // thumbUrls are data: URLs (no ObjectURL to revoke).
  }
  state.items = [];
  state.keys = new Set();
  state.activeId = null;
  state.nonImage = 0;
  state.readded = 0;
  editor.hidden = true;
  setDropzoneCompact(false);
  strip.hidden = true; strip.textContent = '';
  skipped.hidden = true; skippedList.textContent = '';
  statusLine.hidden = true; statusLine.textContent = '';
  clearActionError();
  updateZipButton();
});

// --- Resize handling --------------------------------------------------------

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (activeItem()) renderStage(); }, 120);
});

updateZipButton();
document.documentElement.dataset.bootReady = '1';
