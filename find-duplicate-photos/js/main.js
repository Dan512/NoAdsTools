// find-duplicate-photos/js/main.js — boot + tool wiring. English-first;
// minimal chrome (no language picker / settings gear); shared privacy panel
// with this tool's disclosure. Pipeline: intake (files/folders/drop/paste) →
// scan.js hashes in a worker pool (+ serial HEIC queue) → report.js groups →
// group cards with keep/duplicate toggles → ZIP / copy list / txt outputs.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { escapeHtml } from '/shared/escape.js';
import { createSession, addFiles, filesFromDataTransfer, scanPending, clearSession } from './scan.js';
import { buildGroups } from './report.js';
import { buildDuplicateListText, prettyBytes } from './list-text.js';
import { buildZipManifest } from './zip-set.js';
import { loadJSZip } from './zip.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  fdPrivacyTitle: 'Privacy',
  fdPrivacyLead: 'This tool finds duplicate photos entirely in your browser. Your photos never leave your device — no upload, no account, no tracking.',
  fdPrivacyFetchHeading: 'What this page loads',
  fdPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The libheif decoder (~1.1 MB, from this origin) — ONLY if you add a HEIC photo. Used to read iPhone photos locally.</li><li>The JSZip library (~97 KB, from this origin) — ONLY if you click "Download unique set". Used to package your photos locally.</li>',
  fdPrivacyStorageHeading: 'Local storage',
  fdPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools_lang</code>, <code>noadstools:settings:global</code>, and <code>noadstools:settings:find-duplicate-photos</code>. No photo data is ever stored.',
} });
injectTopbar({ toolId: 'find-duplicate-photos', lang: false, settings: false });
injectFooter({ toolId: 'find-duplicate-photos' });
initI18n();
initSettings({ toolId: 'find-duplicate-photos' });
registerPrivacyRows([
  { headingKey: 'fdPrivacyFetchHeading', bodyKey: 'fdPrivacyFetchList', kind: 'list' },
  { headingKey: 'fdPrivacyStorageHeading', bodyKey: 'fdPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'fdPrivacyTitle', leadKey: 'fdPrivacyLead' });

// --- State -------------------------------------------------------------------

const session = createSession();
let overrides = {};          // { [itemId]: keepBoolean } — user toggles
let sensitivity = 'normal';
let lastVm = null;           // view-model from the most recent render()
let zipBuilding = false;     // true while generateAsync is in flight — render() must not touch zipBtn

const SENSITIVITIES = ['strict', 'normal', 'loose'];
const SENSITIVITY_HINTS = {
  strict: 'only near-identical copies',
  normal: 'resized and recompressed copies',
  loose: 'catches more, may over-match',
};
const ZIP_WARN_BYTES = 800 * 1024 * 1024;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const folderLabel = document.getElementById('folder-label');
const scanStatus = document.getElementById('scan-status');
const heicNote = document.getElementById('heic-note');
const results = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const sensitivityFieldset = document.getElementById('sensitivity');
const sensitivityHint = document.getElementById('sensitivity-hint');
const zipBtn = document.getElementById('download-zip');
const copyBtn = document.getElementById('copy-list');
const listBtn = document.getElementById('download-list');
const clearBtn = document.getElementById('clear-all');
const zipWarning = document.getElementById('zip-warning');
const groupsEl = document.getElementById('groups');
const issuesEl = document.getElementById('issues');
const issuesSummary = document.getElementById('issues-summary');
const issuesList = document.getElementById('issues-list');

const plural = (n, word) => (n === 1 ? word : `${word}s`);
const itemsById = () => new Map(session.items.map(it => [it.id, it]));

// --- Intake --------------------------------------------------------------------

// The folder picker needs webkitdirectory (missing on iOS Safari) — hide the
// button there; iOS users multi-select from the photo library instead.
if (!('webkitdirectory' in document.createElement('input'))) folderLabel.hidden = true;

fileInput.addEventListener('change', () => { intake([...fileInput.files]); fileInput.value = ''; });
folderInput.addEventListener('change', () => { intake([...folderInput.files]); folderInput.value = ''; });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault(); dropzone.classList.remove('is-drag');
  intake(await filesFromDataTransfer(e.dataTransfer));
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) intake(files);
});
// A drop that misses the dropzone must not navigate the tab away (which
// would destroy the whole session). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

function intake(files) {
  if (!files || !files.length) return;
  const before = { ...session.counts };
  const added = addFiles(session, files);
  if (session.items.some(it => it.isHeic)) heicNote.hidden = false;
  if (!added.length) {
    // Nothing new in that drop — say why instead of doing nothing.
    const readdedDelta = session.counts.readded - before.readded;
    scanStatus.textContent = (readdedDelta > 0)
      ? 'Those photos are already in the list.'
      : 'No image files found in that drop.';
    scanStatus.hidden = false;
    render(); // refresh the skipped-file counts in the issues section
    return;
  }
  rescan();
}

// --- Scan + render loop ----------------------------------------------------------

// Serialize scans: adding files mid-scan queues one follow-up pass instead of
// double-dispatching the in-flight items (their status is still 'pending'
// until the worker answers).
let scanRunning = false;
let scanQueued = false;

async function rescan() {
  if (scanRunning) { scanQueued = true; return; }
  scanRunning = true;
  render(); // freeze-proof the actions immediately — lastVm is about to go stale
  try {
    do {
      scanQueued = false;
      if (!session.items.some(it => it.status === 'pending')) break;
      const gen = session.gen;
      scanStatus.textContent = 'Scanning…';
      scanStatus.hidden = false;
      await scanPending(session, ({ done, total }) => {
        scanStatus.textContent = `Scanning… ${done} / ${total}`;
      });
      if (session.gen !== gen) continue; // cleared mid-scan — re-check for new items
      // New items were hashed — clusters may have changed identity, so manual
      // toggles no longer point at the same groups (spec: reset on re-scan).
      overrides = {};
    } while (scanQueued);
  } finally {
    scanRunning = false;
    scanStatus.hidden = true;
    render();
  }
}

function render() {
  const vm = buildGroups({ items: session.items, sensitivity, overrides });
  lastVm = vm;
  const byId = itemsById();

  const hasItems = session.items.length > 0;
  results.hidden = !hasItems;
  renderIssues();
  if (!hasItems) { groupsEl.textContent = ''; summaryEl.textContent = ''; return; }

  // Summary — duplicateGroupCount (not groups.length): it matches the exported
  // list's count when a user keeps everything in a group.
  if (vm.duplicateGroupCount > 0) {
    summaryEl.textContent = `Found ${vm.duplicateGroupCount} duplicate ${plural(vm.duplicateGroupCount, 'group')} — ${vm.duplicateCount} ${plural(vm.duplicateCount, 'photo')}, ${prettyBytes(vm.reclaimableBytes)} you could free.`;
  } else {
    // The ✓ is a glyph inside the text node — never color-only.
    summaryEl.textContent = `✓ No duplicates found among ${vm.scannedCount} ${plural(vm.scannedCount, 'photo')}.`;
  }

  // Group cards. Full re-render loses keyboard focus — remember the focused
  // photo and restore it so Enter-toggling doesn't dump focus on <body>.
  const focusedId = document.activeElement?.classList?.contains('photo')
    ? document.activeElement.dataset.id : null;
  groupsEl.textContent = '';
  for (const g of vm.groups) {
    const card = document.createElement('section');
    card.className = 'group-card';
    const head = document.createElement('div');
    head.className = 'group-head';
    const matchLabel = g.matchType === 'exact' ? '= Identical files' : '≈ Visually similar';
    head.innerHTML = `<span class="group-match">${matchLabel}</span>`
      + `<span class="group-bytes">${g.reclaimableBytes > 0 ? `${prettyBytes(g.reclaimableBytes)} reclaimable` : 'everything kept'}</span>`;
    card.appendChild(head);

    const row = document.createElement('div');
    row.className = 'group-photos';
    for (const m of g.members) {
      const it = byId.get(m.id);
      if (!it) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo';
      btn.dataset.id = it.id;
      btn.setAttribute('aria-pressed', m.keep ? 'true' : 'false');
      const dims = (it.width && it.height) ? `${it.width}×${it.height} · ` : '';
      const thumb = it.thumbUrl
        ? `<img src="${it.thumbUrl}" alt="">`
        : '<span class="photo-noimg">no preview</span>';
      btn.innerHTML = `<span class="photo-thumb">${thumb}</span>`
        + `<span class="photo-state">${m.keep ? '✓ Keep' : '✕ Duplicate'}</span>`
        + `<span class="photo-name">${escapeHtml(it.relPath)}</span>`
        + `<span class="photo-meta">${dims}${prettyBytes(it.size)}</span>`;
      // Capture THIS member's id + state — never read "last item" state in a
      // closure (the playbook bug).
      const id = m.id;
      const keepNow = m.keep;
      btn.addEventListener('click', () => { overrides[id] = !keepNow; render(); });
      row.appendChild(btn);
    }
    card.appendChild(row);
    groupsEl.appendChild(card);
  }
  if (focusedId) groupsEl.querySelector(`.photo[data-id="${focusedId}"]`)?.focus();

  // Actions: ZIP size on the button; caution above ~800 MB; a "unique set"
  // without duplicates is just the input, so the outputs disable at 0 groups.
  // While a scan is running, lastVm/groups are about to be superseded by
  // newly-hashed items — the three action buttons must stay disabled so a
  // click can't act on the stale view-model (silently wrong ZIP/list).
  const noGroups = vm.groups.length === 0 || scanRunning;
  // While a ZIP build is in flight, leave the "Building ZIP…" label and
  // disabled state alone — a re-render (e.g. from a photo toggle) must not
  // re-enable the button mid-build or overwrite the in-progress label.
  if (!zipBuilding && !scanRunning) {
    const manifest = buildZipManifest({ items: session.items, groups: vm.groups });
    const manifestBytes = manifest.reduce((s, e) => s + e.size, 0);
    zipWarning.hidden = manifestBytes <= ZIP_WARN_BYTES;
    zipBtn.textContent = `Download unique set (ZIP) — ${prettyBytes(manifestBytes)}`;
    zipBtn.disabled = noGroups;
  } else if (!zipBuilding) {
    zipBtn.disabled = noGroups;
  }
  copyBtn.disabled = noGroups;
  listBtn.disabled = noGroups;
}

function renderIssues() {
  const bad = session.items.filter(it => it.status === 'failed' || it.error);
  const { nonImage, readded } = session.counts;
  const parts = [];
  if (bad.length) parts.push(`couldn't fully read ${bad.length} ${plural(bad.length, 'file')}`);
  if (nonImage) parts.push(`skipped ${nonImage} non-image ${plural(nonImage, 'file')}`);
  if (readded) parts.push(`skipped ${readded} already-added ${plural(readded, 'file')}`);
  if (!parts.length) { issuesEl.hidden = true; issuesList.textContent = ''; return; }
  const line = parts.join(' · ');
  issuesSummary.textContent = line.charAt(0).toUpperCase() + line.slice(1);
  issuesList.innerHTML = [
    ...bad.map(it => `<li>${escapeHtml(it.relPath)} — ${escapeHtml(it.error || 'could not be read')}</li>`),
    nonImage ? `<li>Skipped ${nonImage} non-image ${plural(nonImage, 'file')} — this tool reads photos only.</li>` : '',
    readded ? `<li>Skipped ${readded} already-added ${plural(readded, 'file')} — the same photo is never counted twice.</li>` : '',
  ].join('');
  issuesEl.hidden = false;
}

// --- Sensitivity -----------------------------------------------------------------

sensitivityHint.textContent = SENSITIVITY_HINTS[sensitivity];
sensitivityFieldset.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || t.name !== 'sensitivity') return;
  sensitivity = SENSITIVITIES.includes(t.value) ? t.value : 'normal';
  // Clusters change identity across thresholds — fresh auto keeper picks,
  // manual toggles discarded (spec'd explicitly; not a bug).
  overrides = {};
  sensitivityHint.textContent = SENSITIVITY_HINTS[sensitivity];
  render();
});

// --- Actions ----------------------------------------------------------------------

// Honest failure beats silence — one message slot above the group cards.
function showActionError(message) {
  let el = results.querySelector('.action-error');
  if (!el) {
    el = document.createElement('p');
    el.className = 'action-error';
    results.insertBefore(el, groupsEl);
  }
  el.textContent = message;
}
function clearActionError() {
  results.querySelector('.action-error')?.remove();
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

zipBtn.addEventListener('click', async () => {
  if (!lastVm || scanRunning) return;
  clearActionError();
  // Capture the view-model BEFORE the first await — clear-all can null out
  // lastVm while loadJSZip()'s fetch is in flight, and a stale reference
  // dereferenced after the await would throw.
  const vmAtClick = lastVm;
  zipBuilding = true;
  zipBtn.disabled = true;
  zipBtn.textContent = 'Building ZIP…';
  try {
    let JSZip;
    try {
      JSZip = await loadJSZip();
    } catch {
      // zip.js resets its cache on rejection, so clicking again retries.
      showActionError('The ZIP library failed to load. Check your connection and try again.');
      return;
    }
    if (lastVm !== vmAtClick || !session.items.length) {
      showActionError('The photo list changed while preparing the ZIP.');
      return;
    }
    const byId = itemsById();
    const manifest = buildZipManifest({ items: session.items, groups: vmAtClick.groups });
    const zip = new JSZip();
    for (const entry of manifest) {
      const it = byId.get(entry.id);
      if (!it) continue;
      // STORE: original bytes, no recompression — photos barely deflate anyway.
      zip.file(entry.zipPath, it.file, { compression: 'STORE' });
    }
    let blob;
    try {
      blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    } catch {
      showActionError("Building the ZIP failed — this set may be too large for this device's memory.");
      return;
    }
    downloadBlob(blob, 'photos-unique-set.zip');
  } finally {
    zipBuilding = false;
    render(); // recompute the label from the current manifest + disabled state from current groups
  }
});

let copyLabelTimer = 0;
copyBtn.addEventListener('click', async () => {
  if (!lastVm || scanRunning) return;
  clearActionError();
  const text = buildDuplicateListText({
    groups: lastVm.groups, itemsById: itemsById(), scannedCount: lastVm.scannedCount,
  });
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Clipboard API rejected (permissions, non-secure context) — textarea fallback.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (ok) {
    // Confirmation is a label change (text, not color).
    copyBtn.textContent = 'Copied';
    clearTimeout(copyLabelTimer);
    copyLabelTimer = setTimeout(() => { copyBtn.textContent = 'Copy list of duplicates'; }, 2000);
  } else {
    showActionError("Couldn't copy to the clipboard — use Download list (.txt) instead.");
  }
});

listBtn.addEventListener('click', () => {
  if (!lastVm || scanRunning) return;
  clearActionError();
  const text = buildDuplicateListText({
    groups: lastVm.groups, itemsById: itemsById(), scannedCount: lastVm.scannedCount,
  });
  downloadBlob(new Blob([text], { type: 'text/plain' }), 'duplicate-photos.txt');
});

clearBtn.addEventListener('click', () => {
  clearSession(session); // aborts any in-flight scan, revokes thumbnails
  overrides = {};
  lastVm = null;
  groupsEl.textContent = '';
  summaryEl.textContent = '';
  issuesList.textContent = '';
  issuesEl.hidden = true;
  results.hidden = true;
  zipWarning.hidden = true;
  scanStatus.hidden = true;
  scanStatus.textContent = '';
  heicNote.hidden = true;
  clearActionError();
});

document.documentElement.dataset.bootReady = '1';
