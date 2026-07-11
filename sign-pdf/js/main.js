// sign-pdf/js/main.js — boot + interactive wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Flow: intake ONE PDF (picker / drop / paste, PDF allowlist) →
// loadAndRender renders every page to an on-DOM canvas (pdfjs, lazy) and
// classifies locked/corrupt → make a signature (Draw a PointerEvents pad, or
// Type a name in a signature style) → place it with a draggable/resizable box
// over the chosen page → Apply stamps it with pdf-lib and downloads one PDF.
// pdfjs + pdf-lib are 0 bytes until a PDF is opened. The coordinate mapping
// (display box → PDF points) lives in the Node-tested place-rect.js; this file
// only feeds it live display boxes.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { isPdf } from './intake.js';
import { clampBox } from './place-rect.js';
import { drawSignatureToPng, typeSignatureToPng } from './signature.js';
import { loadAndRender, applySignature, PdfEngineError } from './sign.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  spPrivacyTitle: 'Privacy',
  spPrivacyLead: 'This tool signs PDFs in your browser. Your PDF and your signature never leave your device — no upload, no account, no tracking — and the source file’s document properties are not carried into the signed copy.',
  spPrivacyFetchHeading: 'What this page loads',
  spPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li>'
    + '<li>The pdf.js library (~1.73 MB main + worker, from this origin) — ONLY when you open a PDF. Used to render the page previews locally; its character maps and fonts are fetched from this origin only for PDFs that need them.</li>'
    + '<li>The pdf-lib library (~511 KB, from this origin) — ONLY when you apply the signature. Used to embed and stamp the signature locally.</li>',
  spPrivacyStorageHeading: 'Local storage',
  spPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:sign-pdf</code>. No PDF or signature data is ever stored.',
} });

injectTopbar({ toolId: 'sign-pdf', lang: false, settings: false });
injectFooter({ toolId: 'sign-pdf' });
initI18n();
initSettings({ toolId: 'sign-pdf' });
registerPrivacyRows([
  { headingKey: 'spPrivacyFetchHeading', bodyKey: 'spPrivacyFetchList', kind: 'list' },
  { headingKey: 'spPrivacyStorageHeading', bodyKey: 'spPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'spPrivacyTitle', leadKey: 'spPrivacyLead' });

// --- Constants ---------------------------------------------------------------
const DRAW_INK = '#12305c';      // dark blue-black ink for the draw pad
const DRAW_WIDTH = 2.6;          // stroke width in CSS px
const MIN_BOX = 24;              // placement-box floor in display px
const MAX_PREVIEW_W = 700;       // display width cap for a page preview
const EAGER = 10;                // pages rasterized up front; the rest lazy-render on scroll
const FONT = {
  'serif-italic': 'italic 600 72px "Times New Roman", "Georgia", serif',
  script: 'italic 600 78px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive',
  sans: '600 68px "Segoe UI", "Helvetica Neue", Arial, sans-serif',
};

// --- State -------------------------------------------------------------------
const state = {
  fileName: '',
  srcBytes: null,           // cached source bytes for apply
  pages: [],                // [{ pageIndex, canvas, frame, pageWidthPt, pageHeightPt, renderScale, rendered }]
  activeIndex: 0,
  frameW: 0,                // current page-frame display width (for resize scaling)
  signature: null,          // { bytes, width, height } | null
  sigUrl: null,             // ObjectURL for the placement preview
  box: null,                // { x, y, w, h } display px relative to the active frame
  currentStroke: null,
  working: false,
};
const strokes = [];         // draw-pad strokes: [{ color, width, points:[{x,y}] }]
let mode = 'draw';          // 'draw' | 'type'
let boxEl = null;           // the placement box element (built once, re-parented)
let boxImg = null;
let renderPage = null;      // async (index) => rendered:boolean — lazy rasterizer from loadAndRender

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const input = $('file-input');
const intakeNote = $('intake-note');
const workspace = $('workspace');
const docName = $('doc-name');
const docPages = $('doc-pages');
const modeGroup = document.querySelector('[aria-labelledby="mode-label"]');
const drawControls = $('draw-controls');
const drawCanvas = $('draw-canvas');
const drawUndo = $('draw-undo');
const drawClear = $('draw-clear');
const typeControls = $('type-controls');
const typeName = $('type-name');
const typeFont = $('type-font');
const typeColor = $('type-color');
const typeColorHex = $('type-color-hex');
const pagePicker = $('page-picker');
const pageSelect = $('page-select');
const placeHint = $('place-hint');
const lazyNote = $('lazy-note');
const pagesEl = $('pages');

// Lazy preview render (Fix I-1): only the first EAGER pages rasterize up front;
// the rest paint as their frame scrolls near the viewport, so a 100+ page PDF
// never allocates 100+ large canvases at once (a phone would run out of memory).
// The observer's root is the scrollable page list; rootMargin pre-renders a
// little ahead of the scroll so a page is usually painted by the time it's seen.
const pageObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver(onFrameVisible, { root: pagesEl, rootMargin: '400px 0px' })
  : null;

function onFrameVisible(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const idx = Number(e.target.dataset.index);
    const meta = state.pages[idx];
    if (meta && meta.canvas && !meta.rendered) void ensureRendered(idx);
  }
}

// Rasterize one page's canvas if it isn't already, then refresh the box/Apply
// state (the active page must be rendered before it can carry a placement box).
async function ensureRendered(index) {
  const meta = state.pages[index];
  if (!meta || !meta.canvas || !renderPage) return false;
  if (meta.rendered) return true;
  const ok = await renderPage(index);
  if (ok && index === state.activeIndex) ensureBox();
  updateApply();
  return ok;
}
const applyBtn = $('apply');
const applyHint = $('apply-hint');
const clearBtn = $('clear');
const runError = $('run-error');

const plural = (n, w) => (n === 1 ? w : `${w}s`);
const activePage = () => state.pages[state.activeIndex] || null;

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

function setIntakeNote(text) {
  intakeNote.textContent = text;   // textContent → any XSS in the name is inert
  intakeNote.hidden = false;
}

async function intake(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdfs = files.filter((f) => isPdf(f.name, f.type));
  if (!pdfs.length) { setIntakeNote('This tool signs one PDF — drop a PDF file.'); return; }
  const file = pdfs[0];             // one PDF at a time; a new drop replaces it
  const extras = files.length - 1;  // everything else in the drop is ignored

  resetWorkspace();
  runError.hidden = true;
  docName.textContent = file.name;  // textContent → XSS inert
  docPages.textContent = 'Rendering…';
  workspace.hidden = false;
  state.fileName = file.name;

  let result;
  try {
    result = await loadAndRender(file, { onPage, fitWidth: 1000, eager: EAGER });
  } catch (e) {
    resetWorkspace(); workspace.hidden = true;
    setIntakeNote(e instanceof PdfEngineError
      ? 'Couldn’t load the PDF engine — check your connection and add the file again.'
      : 'Couldn’t open this PDF — it may be corrupt.');
    return;
  }

  if (result.status === 'locked') {
    resetWorkspace(); workspace.hidden = true;
    setIntakeNote('This PDF is password-protected — unlock it first, then add it again.');
    return;
  }
  if (result.status !== 'ok') {
    resetWorkspace(); workspace.hidden = true;
    setIntakeNote('Couldn’t open this PDF — it may be corrupt or not a real PDF.');
    return;
  }

  state.srcBytes = result.bytes;
  renderPage = result.renderPage || null;
  state.frameW = dispWidth();
  docName.textContent = state.fileName;
  docPages.textContent = `${result.numPages} ${plural(result.numPages, 'page')}`;
  buildPageSelect(result.numPages);
  pagePicker.hidden = result.numPages <= 1;
  // A long document: tell the reader the later previews load as they scroll
  // (only the first EAGER pages are rendered up front — Fix I-1).
  lazyNote.hidden = result.numPages <= EAGER;
  placeHint.hidden = false;
  // Observe every frame for lazy render now that renderPage is wired up (before
  // this, an early intersect callback would no-op on the null renderPage).
  if (pageObserver) for (const p of state.pages) if (p.frame) pageObserver.observe(p.frame);
  setActivePage(0);

  // The draw pad is now visible — size it to its box.
  if (mode === 'draw') sizeDrawCanvas();

  if (extras > 0) {
    setIntakeNote(`Loaded this PDF · ignored ${extras} other ${plural(extras, 'file')} (this tool signs one PDF at a time).`);
  } else {
    intakeNote.hidden = true;
  }
  updateApply();
}

// Build one page-frame per rendered page. Called by loadAndRender BEFORE it
// awaits each page's render, so the canvas is attached + painted (visible) and
// pdfjs' rAF-driven render doesn't stall (playbook §4).
async function onPage(meta) {
  const frame = document.createElement('div');
  frame.className = 'page-frame';
  frame.dataset.index = String(meta.pageIndex);
  frame.style.width = `${dispWidth()}px`;

  const cap = document.createElement('span');
  cap.className = 'page-cap';
  cap.textContent = 'Signing here';
  frame.appendChild(cap);

  if (meta.canvas) {
    frame.appendChild(meta.canvas);
  } else {
    const fb = document.createElement('div');
    fb.className = 'page-fallback';
    fb.textContent = `Page ${meta.pageIndex + 1} could not be rendered.`;
    frame.appendChild(fb);
  }

  frame.addEventListener('click', (e) => {
    if (e.target.closest('.place-box')) return; // don't hijack a box interaction
    setActivePage(meta.pageIndex);
  });

  meta.frame = frame;
  pagesEl.appendChild(frame);
  state.pages.push(meta);
  // Yield a frame so layout + paint land before the render promise is awaited.
  await new Promise((r) => requestAnimationFrame(() => r()));
}

function dispWidth() {
  const avail = (pagesEl.clientWidth || 700) - 24; // minus the container padding
  return Math.max(200, Math.min(avail, MAX_PREVIEW_W));
}

function resetWorkspace() {
  if (boxEl && boxEl.parentElement) boxEl.parentElement.removeChild(boxEl);
  if (pageObserver) pageObserver.disconnect();
  // Revoke the signature preview URL so reloading a PDF never leaks it (Fix M-3).
  // The signature itself PERSISTS across documents — sigPreviewUrl() re-creates
  // the URL on demand from the still-held signature bytes when the next document
  // renders, so persistence is kept without a leaked object URL.
  if (state.sigUrl) { URL.revokeObjectURL(state.sigUrl); state.sigUrl = null; }
  pagesEl.textContent = '';
  renderPage = null;
  state.pages = [];
  state.activeIndex = 0;
  state.box = null;
  state.srcBytes = null;
}

// --- Page selection ----------------------------------------------------------
function buildPageSelect(n) {
  pageSelect.textContent = '';
  for (let i = 0; i < n; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Page ${i + 1}`;
    pageSelect.appendChild(opt);
  }
}
pageSelect.addEventListener('change', () => setActivePage(Number(pageSelect.value)));

function setActivePage(index) {
  if (index < 0 || index >= state.pages.length) return;
  state.activeIndex = index;
  for (const p of state.pages) p.frame.classList.toggle('is-active', p.pageIndex === index);
  if (pageSelect.value !== String(index)) pageSelect.value = String(index);
  state.box = null;              // a fresh placement on the newly-active page
  ensureBox();                   // hides the box if this page hasn't rasterized yet
  const active = activePage();
  if (active) active.frame.scrollIntoView({ block: 'nearest' });
  // The active page MUST be rendered before it can carry a placement box or be
  // signed. If it was lazy-deferred, rasterize it now; ensureRendered re-runs
  // ensureBox + updateApply once the pixels land (Fix I-1).
  void ensureRendered(index);
}

// --- Signature: Draw / Type toggle -------------------------------------------
modeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const next = btn.dataset.mode;
  if (next === mode) return;
  mode = next;
  for (const b of modeGroup.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  drawControls.hidden = mode !== 'draw';
  typeControls.hidden = mode !== 'type';
  if (mode === 'draw') { sizeDrawCanvas(); refreshDrawSignature(); }
  else refreshTypeSignature();
});

// --- Draw pad ----------------------------------------------------------------
function sizeDrawCanvas() {
  const r = drawCanvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  drawCanvas.width = Math.max(1, Math.round(r.width * dpr));
  drawCanvas.height = Math.max(1, Math.round(r.height * dpr));
  redrawStrokes();
}

function redrawStrokes() {
  const ctx = drawCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);        // draw in CSS px
  ctx.clearRect(0, 0, drawCanvas.width / dpr, drawCanvas.height / dpr);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const s of strokes) {
    if (s.points.length === 1) {
      const p = s.points[0];
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, s.width / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
      ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
    }
  }
}

function padPoint(e) {
  const r = drawCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

drawCanvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { drawCanvas.setPointerCapture(e.pointerId); } catch { /* older engines */ }
  state.currentStroke = { color: DRAW_INK, width: DRAW_WIDTH, points: [padPoint(e)] };
  strokes.push(state.currentStroke);
  redrawStrokes();
  drawCanvas.addEventListener('pointermove', onPadMove);
  drawCanvas.addEventListener('pointerup', onPadUp);
  drawCanvas.addEventListener('pointercancel', onPadUp);
});

function onPadMove(e) {
  if (!state.currentStroke) return;
  e.preventDefault();
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) state.currentStroke.points.push(padPoint(ev));
  redrawStrokes();
}

function onPadUp(e) {
  if (!state.currentStroke) return;
  try { drawCanvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  drawCanvas.removeEventListener('pointermove', onPadMove);
  drawCanvas.removeEventListener('pointerup', onPadUp);
  drawCanvas.removeEventListener('pointercancel', onPadUp);
  state.currentStroke = null;
  refreshDrawSignature();
}

drawUndo.addEventListener('click', () => { strokes.pop(); redrawStrokes(); refreshDrawSignature(); });
drawClear.addEventListener('click', () => { strokes.length = 0; redrawStrokes(); refreshDrawSignature(); });

async function refreshDrawSignature() {
  if (mode !== 'draw') return;
  const sig = await drawSignatureToPng(drawCanvas);
  setSignature(sig);
}

// --- Type --------------------------------------------------------------------
typeName.addEventListener('input', refreshTypeSignature);
typeFont.addEventListener('change', refreshTypeSignature);
typeColor.addEventListener('input', () => {
  typeColorHex.textContent = typeColor.value.toUpperCase();
  refreshTypeSignature();
});

async function refreshTypeSignature() {
  if (mode !== 'type') return;
  const sig = await typeSignatureToPng(typeName.value, {
    font: FONT[typeFont.value] || FONT['serif-italic'],
    color: typeColor.value,
  });
  setSignature(sig);
}

// --- Signature → placement box ----------------------------------------------
// The signature preview object URL is created lazily and cached in state.sigUrl,
// so resetWorkspace() can revoke it on every document load without breaking the
// persist-across-documents behavior: the next ensureBox() re-creates it here
// from the still-held signature bytes (Fix M-3 — no leaked URL, signature kept).
function sigPreviewUrl() {
  if (!state.signature) return '';
  if (!state.sigUrl) {
    state.sigUrl = URL.createObjectURL(new Blob([state.signature.bytes], { type: 'image/png' }));
  }
  return state.sigUrl;
}

function setSignature(sig) {
  if (state.sigUrl) { URL.revokeObjectURL(state.sigUrl); state.sigUrl = null; }
  state.signature = sig;
  if (sig) {
    ensureBox();                 // pulls the preview URL lazily via sigPreviewUrl()
  } else if (boxEl) {
    boxEl.hidden = true;
  }
  updateApply();
}

function buildBoxEl() {
  boxEl = document.createElement('div');
  boxEl.className = 'place-box';
  boxEl.tabIndex = 0;
  boxEl.setAttribute('role', 'group');
  boxEl.setAttribute('aria-label', 'Signature placement — drag to move, corner handles to resize, arrow keys to nudge');
  boxImg = document.createElement('img');
  boxImg.className = 'sig-preview';
  boxImg.alt = '';
  boxEl.appendChild(boxImg);
  for (const h of ['nw', 'ne', 'se', 'sw']) {
    const hd = document.createElement('span');
    hd.className = `handle handle-${h}`;
    hd.dataset.handle = h;
    hd.setAttribute('aria-hidden', 'true');
    hd.addEventListener('pointerdown', (e) => { e.stopPropagation(); beginBoxDrag(e, 'resize', h); });
    boxEl.appendChild(hd);
  }
  boxEl.addEventListener('pointerdown', (e) => beginBoxDrag(e, 'move', null));
  boxEl.addEventListener('keydown', onBoxKey);
}

function defaultBox(fw, fh, ratio) {
  let w = Math.min(fw * 0.42, fh * 0.42 * ratio, fw);
  w = Math.max(MIN_BOX, w);
  const h = w / ratio;
  const x = (fw - w) / 2;
  const y = fh - h - Math.min(fh * 0.12, 40); // sit near the bottom, a common spot
  return clampBox({ x, y, w, h }, fw, fh);
}

function ensureBox() {
  const p = activePage();
  if (!p || !p.rendered || !state.signature) { if (boxEl) boxEl.hidden = true; return; }
  const fw = p.frame.clientWidth, fh = p.frame.clientHeight;
  const ratio = (state.signature.width / state.signature.height) || 3;
  if (!state.box) {
    state.box = defaultBox(fw, fh, ratio);
  } else {
    let w = Math.min(state.box.w, fw, fh * ratio);
    const h = w / ratio;
    state.box = clampBox({ x: state.box.x, y: state.box.y, w, h }, fw, fh);
  }
  if (!boxEl) buildBoxEl();
  if (boxEl.parentElement !== p.frame) p.frame.appendChild(boxEl);
  boxImg.src = sigPreviewUrl();
  boxEl.hidden = false;
  positionBox();
}

function positionBox() {
  if (!boxEl || !state.box) return;
  boxEl.style.left = `${state.box.x}px`;
  boxEl.style.top = `${state.box.y}px`;
  boxEl.style.width = `${state.box.w}px`;
  boxEl.style.height = `${state.box.h}px`;
}

// --- Placement box interaction (PointerEvents: mouse + touch + pen) ----------
let drag = null;
const HANDLE_ANCHOR = {
  nw: (b) => ({ x: b.x + b.w, y: b.y + b.h }),
  ne: (b) => ({ x: b.x,       y: b.y + b.h }),
  se: (b) => ({ x: b.x,       y: b.y }),
  sw: (b) => ({ x: b.x + b.w, y: b.y }),
};
const HANDLE_CORNER = {
  nw: (b) => ({ x: b.x,       y: b.y }),
  ne: (b) => ({ x: b.x + b.w, y: b.y }),
  se: (b) => ({ x: b.x + b.w, y: b.y + b.h }),
  sw: (b) => ({ x: b.x,       y: b.y + b.h }),
};

function beginBoxDrag(e, dragMode, handle) {
  const p = activePage();
  if (!p || !state.box) return;
  e.preventDefault();
  const el = e.currentTarget;
  drag = {
    dragMode, handle,
    startX: e.clientX, startY: e.clientY,
    startBox: { ...state.box },
    el, pointerId: e.pointerId,
    fw: p.frame.clientWidth, fh: p.frame.clientHeight,
  };
  try { el.setPointerCapture(e.pointerId); } catch { /* older engines */ }
  el.addEventListener('pointermove', onBoxMove);
  el.addEventListener('pointerup', endBoxDrag);
  el.addEventListener('pointercancel', endBoxDrag);
}

function onBoxMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  const ratio = state.signature
    ? (state.signature.width / state.signature.height)
    : (drag.startBox.w / drag.startBox.h);
  if (drag.dragMode === 'move') {
    state.box = clampBox({ x: drag.startBox.x + dx, y: drag.startBox.y + dy, w: drag.startBox.w, h: drag.startBox.h }, drag.fw, drag.fh);
  } else {
    state.box = resizeBox(drag.startBox, drag.handle, dx, dy, ratio, drag.fw, drag.fh);
  }
  positionBox();
}

function endBoxDrag() {
  if (!drag) return;
  const { el, pointerId } = drag;
  try { el.releasePointerCapture(pointerId); } catch { /* ignore */ }
  el.removeEventListener('pointermove', onBoxMove);
  el.removeEventListener('pointerup', endBoxDrag);
  el.removeEventListener('pointercancel', endBoxDrag);
  drag = null;
}

// Aspect-locked resize: the corner OPPOSITE the dragged handle is the anchor;
// the box grows from it toward the pointer, keeping the signature's ratio. The
// larger of the horizontal/vertical intent drives the size so diagonal drags
// feel natural; clampBox keeps it inside the page.
function resizeBox(startBox, handle, dx, dy, ratio, fw, fh) {
  const anchor = HANDLE_ANCHOR[handle](startBox);
  const corner = HANDLE_CORNER[handle](startBox);
  const cx = corner.x + dx, cy = corner.y + dy;
  const distX = Math.abs(cx - anchor.x), distY = Math.abs(cy - anchor.y);
  let w = Math.max(distX, distY * ratio);
  w = Math.max(MIN_BOX, Math.min(w, fw, fh * ratio));
  const h = w / ratio;
  const growLeft = handle === 'nw' || handle === 'sw';
  const growUp = handle === 'nw' || handle === 'ne';
  const x = growLeft ? anchor.x - w : anchor.x;
  const y = growUp ? anchor.y - h : anchor.y;
  return clampBox({ x, y, w, h }, fw, fh);
}

function onBoxKey(e) {
  const p = activePage();
  if (!p || !state.box) return;
  const step = e.shiftKey ? 10 : 1;
  let dx = 0, dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = -step;
  else if (e.key === 'ArrowDown') dy = step;
  else return;
  e.preventDefault();
  state.box = clampBox({ x: state.box.x + dx, y: state.box.y + dy, w: state.box.w, h: state.box.h }, p.frame.clientWidth, p.frame.clientHeight);
  positionBox();
}

// --- Apply -------------------------------------------------------------------
function updateApply() {
  const p = activePage();
  const ready = !!(state.srcBytes && state.signature && state.box && p && p.rendered);
  if (!state.working) applyBtn.disabled = !ready;
  if (!state.signature) {
    applyHint.textContent = mode === 'draw' ? 'Draw your signature to enable Apply.' : 'Type your name to enable Apply.';
    applyHint.hidden = false;
  } else if (!ready) {
    applyHint.textContent = 'Place your signature on the page.';
    applyHint.hidden = false;
  } else {
    applyHint.hidden = true;
  }
}

function stem() {
  const base = String(state.fileName || 'document').replace(/\.pdf$/i, '').trim();
  return base || 'document';
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

applyBtn.addEventListener('click', async () => {
  const p = activePage();
  if (!state.srcBytes || !state.signature || !state.box || !p) return;
  state.working = true;
  applyBtn.disabled = true;
  const label = applyBtn.textContent;
  applyBtn.textContent = 'Working…';
  runError.hidden = true;
  try {
    // Map the box (display px, relative to the frame) to PDF points using the
    // LIVE display scale so a responsive resize can't desync the mapping.
    const fw = p.frame.clientWidth;
    const renderScale = fw / (p.pageWidthPt || fw); // display px per PDF point
    const bytes = await applySignature(state.srcBytes, {
      pngBytes: state.signature.bytes,
      pageIndex: p.pageIndex,
      box: { ...state.box },
      renderScale,
      pageWidthPt: p.pageWidthPt,
      pageHeightPt: p.pageHeightPt,
    });
    download(bytes, `${stem()}-signed.pdf`);
  } catch (err) {
    runError.textContent = (err instanceof PdfEngineError)
      ? 'Couldn’t load the PDF engine — check your connection and try again.'
      : 'Couldn’t sign this PDF — it may be too large for this device’s memory.';
    runError.hidden = false;
  } finally {
    state.working = false;
    applyBtn.textContent = label;
    updateApply();
  }
});

// --- Clear -------------------------------------------------------------------
clearBtn.addEventListener('click', () => {
  resetWorkspace();
  workspace.hidden = true;
  pagePicker.hidden = true;
  placeHint.hidden = true;
  lazyNote.hidden = true;
  intakeNote.hidden = true;
  runError.hidden = true;
  applyHint.hidden = true;
  strokes.length = 0;
  redrawStrokes();
  setSignature(null);
  typeName.value = '';
  state.fileName = '';
});

// --- Resize handling ---------------------------------------------------------
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 150);
});

function onResize() {
  if (mode === 'draw' && !drawControls.hidden) sizeDrawCanvas();
  if (!state.pages.length) return;
  const p = activePage();
  // Measure the active frame's CONTENT width before resizing. The box's
  // coordinates live in content-box px (matching Apply, which maps via
  // clientWidth), so rescale by the clientWidth ratio — not the style width,
  // which is ~4px wider than clientWidth because of the frame border (Fix M-2).
  const oldClientW = p ? p.frame.clientWidth : 0;
  const newW = dispWidth();
  for (const pg of state.pages) pg.frame.style.width = `${newW}px`;
  state.frameW = newW;
  if (state.box && p) {
    const newClientW = p.frame.clientWidth;
    const scale = oldClientW ? newClientW / oldClientW : 1;
    if (scale !== 1) {
      let b = { x: state.box.x * scale, y: state.box.y * scale, w: state.box.w * scale, h: state.box.h * scale };
      b = clampBox(b, newClientW, p.frame.clientHeight);
      state.box = b;
      positionBox();
    }
  }
}

document.documentElement.dataset.bootReady = '1';
