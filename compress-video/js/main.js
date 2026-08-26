// compress-video/js/main.js — boot + tool wiring. One video at a time:
// probe → configure (target size + live quality band + optional real-frame
// preview) → encode with progress/cancel → download. All state lives in
// this module; sections toggle via [hidden].
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { escapeHtml } from '/shared/escape.js';
import { planEncode } from './plan-encode.js';
import { hasWebCodecs, startCompress, EngineLoadError } from './engine.js';
import { probeFile } from './probe.js';
import { encodeSample, SAMPLE_POINTS } from './preview.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
} });

injectTopbar({ toolId: 'compress-video', lang: false, settings: false });
injectFooter({ toolId: 'compress-video' });
initI18n();
initSettings({ toolId: 'compress-video' });

const el = (id) => document.getElementById(id);
const dropzone = el('dropzone');
const input = el('file-input');
const wall = el('wall');
const errorBox = el('tool-error');
const summary = el('summary');
const configure = el('configure');
const targetMb = el('target-mb');
const resolution = el('resolution');
const bandMeter = el('band-meter');
const bandLabel = el('band-label');
const bandNote = el('band-note');
const suggestBtn = el('suggest-btn');
const previewBtn = el('preview-btn');
const previewArea = el('preview-area');
const encodeBtn = el('encode-btn');
const progress = el('progress');
const progressTrack = el('progress-track');
const progressFill = el('progress-fill');
const progressPct = el('progress-pct');
const cancelBtn = el('cancel-btn');
const result = el('result');
const resultLine = el('result-line');
const downloadBtn = el('download-btn');
const againBtn = el('again-btn');

// state: the one file being worked on
let file = null;      // File
let src = null;       // probeFile() result
let plan = null;      // planEncode() result (recomputed on every change)
let outBlob = null;   // finished MP4
let handle = null;    // startCompress handle during encoding
let userCancelled = false;
const urls = [];      // ObjectURLs to revoke

function revokeUrls() { while (urls.length) URL.revokeObjectURL(urls.pop()); }
function trackUrl(u) { urls.push(u); return u; }

function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
function clearError() { errorBox.hidden = true; errorBox.textContent = ''; }

function setIntakeDisabled(on) {
  input.disabled = on;
  dropzone.setAttribute('aria-disabled', String(on));
}

function prettyBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  const s = v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[u]}`;
}

function prettyDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

// ---------- boot-time capability wall ---------------------------------------

if (!hasWebCodecs()) {
  wall.hidden = false;
  input.disabled = true;
  dropzone.setAttribute('aria-disabled', 'true');
}

// ---------- intake -----------------------------------------------------------

function looksLikeVideo(f) {
  if (/^video\//i.test(f.type || '')) return true;
  return /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name || '');
}

input.addEventListener('change', () => {
  if (input.files[0]) handleFile(input.files[0]);
  input.value = '';
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!input.disabled) dropzone.classList.add('is-drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('is-drag');
  const f = e.dataTransfer?.files?.[0];
  if (f && !input.disabled) handleFile(f);
});
// A drop that misses the dropzone must not navigate the tab away.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function handleFile(f) {
  clearError();
  revokeUrls();
  configure.hidden = true;
  progress.hidden = true;
  result.hidden = true;
  previewArea.hidden = true;
  previewArea.innerHTML = '';
  outBlob = null;

  if (!looksLikeVideo(f)) {
    showError("This doesn't look like a video file. MP4, MOV, WebM, and MKV work here.");
    return;
  }
  summary.hidden = false;
  summary.textContent = 'Reading the video…';
  try {
    src = await probeFile(f);
  } catch (err) {
    summary.hidden = true;
    if (err instanceof EngineLoadError) {
      showError("Couldn't load the video engine. Check your connection and add the file again.");
    } else if (err && err.message === 'probe_no_video_track') {
      showError('No video track found in this file. An audio file or a damaged download would both look like this.');
    } else {
      showError("This file couldn't be read as a video. It may use a format this browser can't open.");
    }
    file = null;
    src = null;
    plan = null;
    return;
  }
  file = f;

  summary.innerHTML =
    `${escapeHtml(file.name)} · ${prettyDuration(src.durationSec)} · `
    + `${src.width}×${src.height} · ${src.fps.toFixed(0)} fps · `
    + `${prettyBytes(src.sourceBytes)}${src.hasAudio ? '' : ' · no audio track'}`;

  // Default target: 25 MB, or about half the source for already-small files.
  const sourceMb = src.sourceBytes / 1048576;
  targetMb.value = String(sourceMb > 50 ? 25 : Math.max(1, Math.round(sourceMb / 2)));
  resolution.value = 'source';
  configure.hidden = false;
  recompute();
}

// ---------- configure: live band --------------------------------------------

function currentTargetBytes() {
  const mb = parseFloat(targetMb.value);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1048576) : 0;
}

function currentOutHeight() {
  return resolution.value === 'source' ? null : parseInt(resolution.value, 10);
}

function recompute() {
  if (!src) return;
  const targetBytes = currentTargetBytes();
  const steps = bandMeter.querySelectorAll('.band-step');
  // preset pressed-state mirrors the input value
  for (const b of configure.querySelectorAll('.preset')) {
    b.setAttribute('aria-pressed', String(parseFloat(targetMb.value) === parseFloat(b.dataset.mb)));
  }
  if (!targetBytes) {
    plan = null;
    bandLabel.textContent = 'Enter a target size';
    bandNote.textContent = '';
    steps.forEach(s => s.classList.remove('is-filled'));
    bandMeter.setAttribute('aria-label', 'Quality: no target set');
    suggestBtn.hidden = true;
    encodeBtn.disabled = true;
    previewBtn.disabled = true;
    return;
  }
  plan = planEncode({ ...src, targetBytes }, { outHeight: currentOutHeight() });

  if (plan.unreachable) {
    bandLabel.textContent = 'Target too small for this video';
    bandNote.textContent =
      `The audio track is copied through unchanged, and it plus a minimum watchable `
      + `picture need about ${prettyBytes(plan.minTargetBytes)}. `
      + `That is the smallest target that can work for this clip.`;
    steps.forEach(s => s.classList.remove('is-filled'));
    bandMeter.setAttribute('aria-label', 'Quality: target unreachable');
    suggestBtn.hidden = true;
    encodeBtn.disabled = true;
    previewBtn.disabled = true;
    return;
  }

  encodeBtn.disabled = false;
  previewBtn.disabled = false;
  steps.forEach((s, i) => s.classList.toggle('is-filled', i < plan.band.step));
  bandMeter.setAttribute('aria-label', `Quality: ${plan.band.label}, ${plan.band.step} of 5`);
  bandLabel.textContent = plan.band.label;
  const outLine = `${plan.out.width}×${plan.out.height}`;
  bandNote.textContent =
    `About ${(plan.videoBitrate / 1e6).toFixed(1)} Mbps of video at ${outLine}. `
    + `An estimate from bitrate and pixels; the Preview button shows the real thing.`;
  if (plan.suggestion) {
    suggestBtn.hidden = false;
    suggestBtn.textContent =
      `At ${plan.out.height}p this will look ${plan.band.label.toLowerCase()}. `
      + `Use ${plan.suggestion.height}p instead (${plan.suggestion.band.label.toLowerCase()})`;
  } else {
    suggestBtn.hidden = true;
  }
}

// A settings change makes any rendered previews stale — clear them.
function settingsChanged() {
  previewArea.hidden = true;
  previewArea.innerHTML = '';
  recompute();
}

targetMb.addEventListener('input', settingsChanged);
resolution.addEventListener('change', settingsChanged);
for (const b of configure.querySelectorAll('.preset')) {
  b.addEventListener('click', () => { targetMb.value = b.dataset.mb; settingsChanged(); });
}
suggestBtn.addEventListener('click', () => {
  if (plan?.suggestion) { resolution.value = String(plan.suggestion.height); settingsChanged(); }
});

// ---------- preview ----------------------------------------------------------

previewBtn.addEventListener('click', async () => {
  if (!file || !plan || plan.unreachable) return;
  const snap = plan;
  revokeUrls();
  clearError();
  previewBtn.disabled = true;
  encodeBtn.disabled = true;
  setIntakeDisabled(true);
  const prevLabel = previewBtn.textContent;
  previewBtn.textContent = 'Encoding samples…';
  previewArea.innerHTML = '';
  previewArea.hidden = false;
  try {
    const sourceUrl = trackUrl(URL.createObjectURL(file));
    for (const frac of SAMPLE_POINTS) {
      const t = Math.max(0, Math.min(src.durationSec - 1, frac * src.durationSec));
      const sample = await encodeSample(file, snap, t);
      const sampleUrl = trackUrl(URL.createObjectURL(sample));
      const pair = document.createElement('div');
      pair.className = 'preview-pair';
      pair.innerHTML = `
        <figure>
          <video muted playsinline preload="metadata"></video>
          <figcaption>Original at ${Math.round(t)}s</figcaption>
        </figure>
        <figure>
          <video muted playsinline autoplay loop></video>
          <figcaption>At your target</figcaption>
        </figure>
        <button type="button" class="enlarge-btn" aria-pressed="false">Enlarge</button>`;
      const [orig, enc] = pair.querySelectorAll('video');
      orig.src = `${sourceUrl}#t=${t.toFixed(2)}`;
      enc.src = sampleUrl;
      // The spec's "zoomable" preview: full-width the pair so compression
      // artifacts are inspectable at real scale, not thumbnail scale.
      pair.querySelector('.enlarge-btn').addEventListener('click', (ev) => {
        const on = pair.classList.toggle('is-enlarged');
        ev.currentTarget.setAttribute('aria-pressed', String(on));
        ev.currentTarget.textContent = on ? 'Shrink' : 'Enlarge';
      });
      previewArea.appendChild(pair);
    }
  } catch (err) {
    previewArea.hidden = true;
    showError(err instanceof EngineLoadError
      ? "Couldn't load the video engine. Check your connection and try again."
      : "Couldn't encode a preview from this video. The full encode may still work; if it fails the same way, the file's codec is likely unsupported here.");
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = prevLabel;
    setIntakeDisabled(false);
    recompute();
  }
});

// ---------- encode -----------------------------------------------------------

encodeBtn.addEventListener('click', async () => {
  if (!file || !plan || plan.unreachable) return;
  setIntakeDisabled(true);
  clearError();
  userCancelled = false;
  configure.hidden = true;
  result.hidden = true;
  progress.hidden = false;
  setProgress(0);

  handle = startCompress(file, plan, { onProgress: setProgress });
  try {
    outBlob = await handle.done;
    progress.hidden = true;
    result.hidden = false;
    const target = currentTargetBytes();
    resultLine.textContent = outBlob.size <= target
      ? `${prettyBytes(outBlob.size)}, under your ${prettyBytes(target)} target.`
      : `${prettyBytes(outBlob.size)}, over your ${prettyBytes(target)} target. `
        + `Encoders overshoot sometimes; a slightly smaller target or a lower resolution will land it.`;
  } catch (err) {
    progress.hidden = true;
    if (userCancelled) { configure.hidden = false; return; }
    configure.hidden = false;
    if (err instanceof EngineLoadError) {
      showError("Couldn't load the video engine. Check your connection and try again.");
    } else if (err && err.message === 'video_unsupported') {
      showError("This video's codec can't be decoded by this browser, so it can't be re-encoded here. Converting it to MP4 elsewhere first would work around that.");
    } else {
      showError("The encode failed partway. For a large video that usually means the browser ran out of memory; a lower resolution often gets it through.");
    }
  } finally {
    handle = null;
    setIntakeDisabled(false);
  }
});

function setProgress(p) {
  const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
  progressFill.style.width = `${pct}%`;
  progressTrack.setAttribute('aria-valuenow', String(pct));
  progressPct.textContent = `${pct}%`;
}

cancelBtn.addEventListener('click', async () => {
  userCancelled = true;
  cancelBtn.disabled = true;
  try { await handle?.cancel(); } finally { cancelBtn.disabled = false; }
});

// ---------- result -----------------------------------------------------------

function downloadName(name) {
  const stem = name.replace(/\.[^.]*$/, '');
  return (stem || 'video') + '-compressed.mp4';
}

downloadBtn.addEventListener('click', () => {
  if (!outBlob) return;
  const url = URL.createObjectURL(outBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(file.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

againBtn.addEventListener('click', () => {
  result.hidden = true;
  configure.hidden = false;
  recompute();
});

document.documentElement.dataset.bootReady = '1';
