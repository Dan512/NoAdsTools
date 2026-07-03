// qr-code-generator/js/main.js — boot + tool wiring. English-first; minimal
// chrome (no language picker / settings gear); shared privacy panel with this
// tool's disclosure. Encoding: vendored Nayuki qrcodegen (module grid) →
// canvas preview (debounced ~150 ms) → PNG (canvas) / SVG (renderToSvg).
//
// HTML-sink note: nothing user-typed ever reaches innerHTML. The payload goes
// to the canvas as fillRects and to the SVG as module geometry only (qr.js
// never embeds the text); status/meta lines use textContent with fixed strings.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import qrcodegen from '/vendor/qrcodegen/qrcodegen.js';
import { buildWifiPayload, renderToSvg } from './qr.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  qrPrivacyTitle: 'Privacy',
  qrPrivacyLead: 'This tool generates QR codes entirely in your browser. Nothing you type — URLs, WiFi passwords — leaves your device. No upload, no account, no tracking.',
  qrPrivacyFetchHeading: 'What this page loads',
  qrPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The QR encoder (Project Nayuki’s qrcodegen library, ~42 KB, from this origin) — loads with the page and runs locally.</li>',
  qrPrivacyStorageHeading: 'Local storage',
  qrPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools:settings:global</code> and <code>noadstools:settings:qr-code-generator</code>. Nothing you type is ever stored or sent.',
} });

injectTopbar({ toolId: 'qr-code-generator', lang: false, settings: false });
injectFooter({ toolId: 'qr-code-generator' });
initI18n();
initSettings({ toolId: 'qr-code-generator' });
registerPrivacyRows([
  { headingKey: 'qrPrivacyFetchHeading', bodyKey: 'qrPrivacyFetchList', kind: 'list' },
  { headingKey: 'qrPrivacyStorageHeading', bodyKey: 'qrPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'qrPrivacyTitle', leadKey: 'qrPrivacyLead' });

const { QrCode } = qrcodegen;
const ECC = { L: QrCode.Ecc.LOW, M: QrCode.Ecc.MEDIUM, Q: QrCode.Ecc.QUARTILE, H: QrCode.Ecc.HIGH };
const QUIET_ZONE = 4; // modules, the QR-spec minimum

const el = (id) => document.getElementById(id);
const tabText = el('tab-text');
const tabWifi = el('tab-wifi');
const panelText = el('panel-text');
const panelWifi = el('panel-wifi');
const textInput = el('text-input');
const ssidInput = el('wifi-ssid');
const passwordInput = el('wifi-password');
const passwordHint = el('wifi-password-hint');
const encryptionSelect = el('wifi-encryption');
const hiddenCheck = el('wifi-hidden');
const sizeSelect = el('qr-size');
const eccSelect = el('qr-ecc');
const emptyEl = el('qr-empty');
const errorEl = el('qr-error');
const canvas = el('qr-canvas');
const metaEl = el('qr-meta');
const pngBtn = el('download-png');
const svgBtn = el('download-svg');

let mode = 'text'; // 'text' | 'wifi'
let currentQr = null;

// --- payload -------------------------------------------------------------

function activePayload() {
  if (mode === 'text') {
    const v = textInput.value;
    if (v === '') return { payload: null, hint: 'Type something above and the code appears here.' };
    return { payload: v };
  }
  const payload = buildWifiPayload({
    ssid: ssidInput.value,
    password: passwordInput.value,
    encryption: encryptionSelect.value,
    hidden: hiddenCheck.checked,
  });
  if (payload === null) return { payload: null, hint: 'Enter the network name (SSID) and the code appears here.' };
  return { payload };
}

// --- rendering -----------------------------------------------------------

// Exact-size canvas (256/512/1024 — what the PNG download advertises), with
// per-module rounded edges so fractional module widths don't leave seams.
function drawToCanvas(qr, cnv, sizePx, border = QUIET_ZONE) {
  const total = qr.size + border * 2;
  cnv.width = sizePx;
  cnv.height = sizePx;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, sizePx, sizePx);
  const cell = sizePx / total;
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.getModule(x, y)) continue;
      const x0 = Math.round((x + border) * cell);
      const y0 = Math.round((y + border) * cell);
      const x1 = Math.round((x + border + 1) * cell);
      const y1 = Math.round((y + border + 1) * cell);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

function showState({ empty = null, error = null, ready = false }) {
  emptyEl.hidden = empty === null;
  if (empty !== null) emptyEl.textContent = empty;
  errorEl.hidden = error === null;
  if (error !== null) errorEl.textContent = error;
  canvas.hidden = !ready;
  metaEl.hidden = !ready;
  pngBtn.disabled = !ready;
  svgBtn.disabled = !ready;
}

function render() {
  const { payload, hint } = activePayload();
  if (payload === null) {
    currentQr = null;
    showState({ empty: hint });
    return;
  }
  try {
    currentQr = QrCode.encodeText(payload, ECC[eccSelect.value]);
  } catch {
    // qrcodegen throws when the payload exceeds version-40 capacity.
    currentQr = null;
    showState({ error: 'Too much text for one QR code — shorten it, or lower the error correction.' });
    return;
  }
  const sizePx = Number(sizeSelect.value);
  drawToCanvas(currentQr, canvas, sizePx);
  metaEl.textContent = `${sizePx} × ${sizePx} px · ${currentQr.size} × ${currentQr.size} modules`;
  showState({ ready: true });
}

// Typing is debounced ~150 ms; structural changes (tab, selects, checkbox)
// render immediately.
let debounceTimer = 0;
function scheduleRender() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(render, 150);
}

// --- wiring --------------------------------------------------------------

function setMode(next) {
  const switched = mode !== next;
  mode = next;
  const isText = mode === 'text';
  tabText.classList.toggle('is-active', isText);
  tabWifi.classList.toggle('is-active', !isText);
  tabText.setAttribute('aria-pressed', String(isText));
  tabWifi.setAttribute('aria-pressed', String(!isText));
  panelText.hidden = !isText;
  panelWifi.hidden = isText;
  // Landing on the WiFi tab puts the cursor where the work starts.
  if (switched && !isText) ssidInput.focus();
  render();
}
tabText.addEventListener('click', () => setMode('text'));
tabWifi.addEventListener('click', () => setMode('wifi'));

textInput.addEventListener('input', scheduleRender);
ssidInput.addEventListener('input', scheduleRender);
passwordInput.addEventListener('input', scheduleRender);

function syncPasswordField() {
  const open = encryptionSelect.value === 'None';
  passwordInput.disabled = open;
  // Two honest hints share the element: "no password needed" for open
  // networks, and a warning while a secured network's password is still
  // empty — a printed WIFI: code without P: won't join a secured network.
  if (open) {
    passwordHint.textContent = 'Open network — no password needed.';
    passwordHint.hidden = false;
  } else if (passwordInput.value === '') {
    passwordHint.textContent = 'Secured networks need a password — the code won’t join without one.';
    passwordHint.hidden = false;
  } else {
    passwordHint.hidden = true;
  }
}
encryptionSelect.addEventListener('change', () => { syncPasswordField(); render(); });
passwordInput.addEventListener('input', syncPasswordField);
hiddenCheck.addEventListener('change', render);
sizeSelect.addEventListener('change', render);
eccSelect.addEventListener('change', render);

// --- downloads -----------------------------------------------------------

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

pngBtn.addEventListener('click', () => {
  if (!currentQr) return;
  canvas.toBlob((blob) => { if (blob) downloadBlob(blob, 'qr-code.png'); }, 'image/png');
});
svgBtn.addEventListener('click', () => {
  if (!currentQr) return;
  const svg = renderToSvg(currentQr, QUIET_ZONE);
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'qr-code.svg');
});

// Some browsers restore form values on back-navigation; reconcile once at boot.
syncPasswordField();
render();

document.documentElement.dataset.bootReady = '1';
