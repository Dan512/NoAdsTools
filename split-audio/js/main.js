// split-audio/js/main.js — boot + wiring. One file at a time: open with
// mediabunny → peaks for the waveform (streaming) → the cut list, shared by
// the timeline and the table → chunks cut on demand → single downloads or a
// STORE zip. All state lives here; sections toggle via [hidden].
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { escapeHtml } from '/shared/escape.js';
import { loadMediabunny, EngineLoadError } from '/shared/mediabunny-loader.js';
import { openAudio, AudioOpenError, chunkTags, describeAudio } from './engine.js';
import { cutSegment } from './cut.js';
import { computePeaks, peaksFromPlanar } from './peaks.js';
import { detectSilence } from './silence.js';
import {
  MIN_SEGMENT_SEC, MAX_CUTS, normalizeCuts, segmentsFromCuts, addCut, removeCut, moveCut, clampCut,
  cutRange, equalParts, everyN, formatTime, parseTime, splitName, chunkName, estimateBytes,
} from './segments.js';
import { loadJSZip } from './zip.js';
import { createTimeline } from './timeline.js';
import { createPlayer } from './player.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
} });

injectTopbar({ toolId: 'split-audio', lang: false, settings: false });
injectFooter({ toolId: 'split-audio' });
initI18n();
initSettings({ toolId: 'split-audio' });

const el = (id) => document.getElementById(id);
const dropzone = el('dropzone');
const fileInput = el('file-input');
const errorBox = el('tool-error');
const editor = el('editor');
const summary = el('summary');
const addCutBtn = el('add-cut-btn');
const timeNow = el('time-now');
const timeTotal = el('time-total');
const audioEl = el('audio');
const playBtn = el('play-btn');
const prevBtn = el('prev-btn');
const nextBtn = el('next-btn');
const playNote = el('play-note');
const timelineFrame = el('timeline-frame');
const timelineCanvas = el('timeline');
const peaksNote = el('peaks-note');
const modeBtns = [...document.querySelectorAll('#tool .mode-btn')];
const panels = { manual: el('mode-manual'), equal: el('mode-equal'), every: el('mode-every'), silence: el('mode-silence') };
const equalN = el('equal-n');
const everyValue = el('every-value');
const everyUnit = el('every-unit');
const silenceDb = el('silence-db');
const silenceDbOut = el('silence-db-out');
const silenceGap = el('silence-gap');
const silenceApply = el('silence-apply');
const silenceResult = el('silence-result');
const clearCutsBtn = el('clear-cuts-btn');
const segmentsBody = el('segments-body');
const statusLine = el('status');
const largeNote = el('large-note');
const downloadAllBtn = el('download-all-btn');

const LARGE_FILE_BYTES = 500e6;   // a note, not a block: each chunk and the ZIP are built in memory
// decodeAudioData holds the WHOLE file as f32 PCM on the main thread, so the
// cap has to be bytes, not seconds: 15 minutes of 44.1 kHz stereo is ~320 MB,
// and WebKit/iOS always takes this path. 128 MB is about 6 minutes of it.
const FALLBACK_DECODE_MAX_BYTES = 128e6;
const URL_REVOKE_MS = 60_000;

// ---- state -----------------------------------------------------------------
const state = {
  file: null, mb: null, opened: null,
  cuts: [],            // sorted seconds; the only editing state
  peaks: null,         // { peak, rms, rate, length, filled } or null
  playhead: 0,
  selected: null,      // index into cuts, or null
  busy: false,
  peaksAbort: null,
};
let playRange = null;  // assigned in Task 14: (start, end) => void

function revokeLater(url) { setTimeout(() => URL.revokeObjectURL(url), URL_REVOKE_MS); }
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  revokeLater(url);
}

function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
function clearError() { errorBox.hidden = true; errorBox.textContent = ''; }
function setStatus(msg) { statusLine.textContent = msg; }

function prettyBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[u]}`;
}

// Loader-vs-file split (playbook: never blame the file for our asset).
function messageFor(err) {
  if (err instanceof EngineLoadError) return "Couldn't load the audio engine from this site. Check your connection and add the file again.";
  if (err instanceof AudioOpenError) {
    switch (err.code) {
      case 'video_file': return 'This is a video file. Split Audio works on audio files: MP3, WAV, M4A, OGG, FLAC.';
      case 'no_audio': return 'This file has no audio track.';
      // The error carries its own container label: state.opened is still null here.
      case 'codec_unsupported': {
        const container = err.container || 'file';
        return err.detail === 'unknown'
          ? `This ${container} uses a codec we can't split without re-encoding.`
          : `This ${container} uses ${err.detail.toUpperCase()}, which we can't split without re-encoding.`;
      }
      case 'damaged': return "This file looks damaged or incomplete, so it can't be read.";
      case 'unknown_length': return "This FLAC doesn't record its length, so it can't be split here. Re-encode it with a standard FLAC encoder first.";
      default: return "This doesn't look like an audio file we can read (MP3, WAV, M4A, OGG, FLAC).";
    }
  }
  return "Couldn't read this file.";
}

// ---- intake ------------------------------------------------------------------
function setIntakeDisabled(on) { fileInput.disabled = on; dropzone.setAttribute('aria-disabled', String(on)); }

// One place decides whether the transport is live and what the note says:
// the canPlayType gate at open, and the <audio> error a "maybe" can still
// turn into once decoding actually starts.
function setTransport(canPlay, note) {
  for (const b of [playBtn, prevBtn, nextBtn]) b.disabled = !canPlay;
  playNote.textContent = canPlay ? '' : note;
  playNote.hidden = canPlay;
}

// A cut runs for seconds on a large file. Everything that could change the
// file or the cut list under it goes dead for the duration: intake, the
// preset apply buttons, and every control in the table (the number and range
// inputs beside those buttons stay live by design). setCuts is a no-op while
// busy, so the timeline can't move a cut either.
const applyBtns = [...document.querySelectorAll('#tool .mode-panel button[id$="-apply"]')];
// renderList rebuilds the whole tbody and throws the disabled flags away with
// the old nodes, so the busy pass over the table is its own function and
// renderList runs it too. Without that, a queued rAF rebuild lands mid-cut
// and ships a fully live table.
function applyBusyToTable() {
  segmentsBody.setAttribute('aria-busy', String(state.busy));
  for (const c of segmentsBody.querySelectorAll('button, input')) {
    if (c instanceof HTMLInputElement && c.readOnly) continue;
    c.disabled = state.busy;
  }
}
function setBusy(on) {
  state.busy = on;
  setIntakeDisabled(on);
  addCutBtn.disabled = on;
  clearCutsBtn.disabled = on;
  downloadAllBtn.disabled = on;
  for (const b of applyBtns) b.disabled = on || (b === silenceApply && !state.peaks);
  applyBusyToTable();
}

function resetForNewFile() {
  state.peaksAbort?.abort();
  player.unload();
  state.opened?.input?.dispose?.();
  state.file = null; state.opened = null; state.cuts = []; state.peaks = null;
  state.playhead = 0; state.selected = null;
  peaksNote.hidden = true; setStatus('');
  silenceApply.disabled = true;
  silenceResult.textContent = 'Waiting for the waveform…';
  editor.hidden = true;
}

async function handleFile(file) {
  if (!file) return;
  if (state.cuts.length && !window.confirm('Discard the current cuts and open the new file?')) return;
  clearError();
  resetForNewFile();
  setIntakeDisabled(true);
  try {
    state.mb = await loadMediabunny();
    state.opened = await openAudio(state.mb, file);
    state.file = file;
  } catch (err) {
    showError(messageFor(err));
    setIntakeDisabled(false);
    return;
  }
  setIntakeDisabled(false);
  const { opened } = state;
  summary.innerHTML = `<strong>${escapeHtml(file.name)}</strong> · ${formatTime(opened.duration)} · ${escapeHtml(describeAudio(opened))} · ${prettyBytes(file.size)}`;
  timeTotal.textContent = formatTime(opened.duration);
  timeNow.textContent = formatTime(0);
  largeNote.hidden = file.size <= LARGE_FILE_BYTES;
  editor.hidden = false;
  setMode('manual');
  timeline.setDuration(opened.duration);
  timeline.setLabel(file.name);
  setPlayhead(0);
  setTransport(player.load(file, opened.mime), `Your browser can't play ${opened.container} in the page. Cuts and downloads still work.`);
  setCuts([]);
  buildPeaks();
}

// Peaks never block anything: cutting needs no decoder. Three tiers, in
// order: streaming decode; decodeAudioData for short files; none.
async function buildPeaks() {
  const { opened, file } = state;
  const ctl = new AbortController();
  state.peaksAbort = ctl;
  // computePeaks hands back its live arrays with every decoded sample, so
  // the timeline can draw the waveform as it arrives.
  const onProgress = (sec, live) => { if (!ctl.signal.aborted) timeline?.setPeaks(live, sec); };
  // Nothing reaches state until the run is confirmed current: file A's late
  // decode must never land on file B's waveform.
  let peaks = null;
  try {
    peaks = opened.canDecode
      ? await computePeaks(state.mb, opened, onProgress, ctl.signal)
      : await fallbackPeaks(opened, file, ctl.signal);
  } catch {
    peaks = null;
  }
  if (ctl.signal.aborted || state.peaksAbort !== ctl) return;
  state.peaks = peaks;
  if (!state.peaks) {
    peaksNote.textContent = "Couldn't decode this file for the waveform. Cuts, playback and downloads still work.";
    peaksNote.hidden = false;
    silenceResult.textContent = "Silence detection needs the waveform, which couldn't be decoded.";
  } else if (state.peaks.partial) {
    peaksNote.textContent = `Couldn't decode all of this file for the waveform: it is blank after ${formatTime(state.peaks.filled / state.peaks.rate)}. Cuts, playback and downloads still work.`;
    peaksNote.hidden = false;
    silenceResult.textContent = `Only the first ${formatTime(state.peaks.filled / state.peaks.rate)} has a waveform; gaps are found in that part.`;
  } else {
    silenceResult.textContent = '';
  }
  // Peaks can land mid-cut: setBusy owns this button for the duration, so
  // never hand it back here.
  silenceApply.disabled = !state.peaks || state.busy;
  timeline?.setPeaks(state.peaks, opened.duration);
}

async function fallbackPeaks(opened, file, signal) {
  if (opened.duration * opened.sampleRate * opened.channels * 4 > FALLBACK_DECODE_MAX_BYTES) return null;
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) return null;
  const bytes = await file.arrayBuffer();
  if (signal?.aborted) return null;
  const ab = await new Ctx(1, 1, 44100).decodeAudioData(bytes);
  if (signal?.aborted) return null;
  const chans = [];
  for (let c = 0; c < ab.numberOfChannels; c++) chans.push(ab.getChannelData(c));
  return peaksFromPlanar(chans, ab.sampleRate, ab.duration);
}

fileInput.addEventListener('change', () => { handleFile(fileInput.files?.[0]); fileInput.value = ''; });
// A missed drop must not navigate the tab away.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
dropzone.addEventListener('dragenter', () => dropzone.classList.add('is-drag'));
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); });
dropzone.addEventListener('dragleave', (e) => { if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('is-drag'); });
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('is-drag');
  if (fileInput.disabled) return;
  handleFile(e.dataTransfer?.files?.[0]);
});

// ---- cuts ----------------------------------------------------------------------
function segments() { return segmentsFromCuts(state.cuts, state.opened.duration); }

// Every incoming list is normalised here (sorted, deduped, spaced by
// MIN_SEGMENT_SEC, capped at MAX_CUTS), so no preset or detector can bypass
// the rules. Chunks are cut on demand and never cached: cutting is fast, and
// a cache of large chunks is exactly the memory a 500 MB file cannot spare.
function setCuts(next, { keepSelection = false } = {}) {
  if (state.busy) return;   // a cut is running against this exact list
  state.cuts = normalizeCuts(next, state.opened.duration);
  if (!keepSelection || state.selected >= state.cuts.length) state.selected = null;
  renderList();
  timeline?.setCuts(state.cuts);
  timeline?.setSelected(state.selected);
}

function selectCut(i) {
  state.selected = i;
  timeline?.setSelected(i);
  for (const tr of segmentsBody.children) tr.classList.toggle('is-selected', i !== null && Number(tr.dataset.index) === i + 1);
}

function addCutAt(t) {
  if (state.busy) return;   // a cut is running against this exact list
  const next = addCut(state.cuts, t, state.opened.duration);
  if (next === state.cuts) { setStatus(`No room for a cut at ${formatTime(t)}: chunks must be at least ${MIN_SEGMENT_SEC} s.`); return; }
  setStatus('');
  setCuts(next);
  selectCut(next.indexOf(next.find((c) => Math.abs(c - t) < 1e-9)));
  setMode('manual', { silent: true });
}

function applyPlayhead(t) {
  state.playhead = t;
  timeNow.textContent = formatTime(t);
  timeline.setPlayhead(t);
}
function setPlayhead(t) {
  const d = state.opened?.duration ?? 0;
  const c = Math.min(Math.max(t, 0), d);
  if (player.ready) player.seek(c);   // onTime applies it
  else applyPlayhead(c);
}

const player = createPlayer(audioEl, {
  onTime: applyPlayhead,
  onPlayState: (playing) => {
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.setAttribute('aria-pressed', String(playing));
  },
  // canPlayType said "maybe" and the decode failed anyway.
  onError: () => {
    setTransport(false, `Your browser couldn't play ${state.opened?.container || 'this file'} in the page. Cuts and downloads still work.`);
  },
});
playRange = (start, end) => { player.playRange(start, end); };

playBtn.addEventListener('click', () => player.toggle());
prevBtn.addEventListener('click', () => {
  const before = state.cuts.filter((c) => c < state.playhead - 0.5);
  setPlayhead(before.length ? before[before.length - 1] : 0);
});
nextBtn.addEventListener('click', () => {
  const after = state.cuts.find((c) => c > state.playhead + 0.05);
  setPlayhead(after ?? (state.opened?.duration ?? 0));
});

// Shortcuts: only when focus is on the page itself, never inside a control
// (Space on a focused button must keep activating the button).
document.addEventListener('keydown', (e) => {
  if (editor.hidden || state.busy || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(t.tagName) || t.isContentEditable)) return;
  switch (e.key) {
    case ' ': e.preventDefault(); player.toggle(); break;
    case 's': case 'S': e.preventDefault(); addCutAt(state.playhead); break;
    case 'ArrowLeft': e.preventDefault(); setPlayhead(state.playhead - (e.shiftKey ? 10 : 1)); break;
    case 'ArrowRight': e.preventDefault(); setPlayhead(state.playhead + (e.shiftKey ? 10 : 1)); break;
    case 'Delete': case 'Backspace':
      // Unconditional: Backspace on <body> is "go back" in some setups, and
      // losing the open file to a stray keypress is not a recoverable mistake.
      e.preventDefault();
      if (state.selected !== null) { setCuts(removeCut(state.cuts, state.selected)); setMode('manual', { silent: true }); }
      break;
    default:
  }
});

// A marker drag fires pointermove as fast as the pointer reports, and the
// table rebuild is a whole innerHTML plus the focus-restore pass — not
// something to run per event. The canvas is the live surface (it is already
// rAF-capped inside the timeline); the table follows once per frame.
let listFrame = 0;
function scheduleList() {
  if (listFrame) return;
  listFrame = requestAnimationFrame(() => { listFrame = 0; renderList(); });
}

const timeline = createTimeline(timelineFrame, timelineCanvas, {
  onSeek: (t) => setPlayhead(t),
  onAddCut: addCutAt,
  onMoveCut: (i, t) => {
    if (state.busy) return;   // a cut is running against this exact list
    state.cuts = normalizeCuts(moveCut(state.cuts, i, t, state.opened.duration), state.opened.duration);
    // The dragged marker stays selected; onSelectCut claimed it at pointerdown
    // and renderList re-applies it when the coalesced rebuild lands.
    state.selected = i;
    timeline.setCuts(state.cuts);
    scheduleList();
    setMode('manual', { silent: true });
  },
  onSelectCut: selectCut,
  formatTime,
});
el('zoom-in-btn').addEventListener('click', () => timeline.zoomIn());
el('zoom-out-btn').addEventListener('click', () => timeline.zoomOut());
el('fit-btn').addEventListener('click', () => timeline.fit());

addCutBtn.addEventListener('click', () => addCutAt(state.playhead));
clearCutsBtn.addEventListener('click', () => { setCuts([]); setMode('manual', { silent: true }); setStatus(''); });

// ---- split modes (generators: they replace the cut list) ----------------------
function setMode(mode, { silent = false } = {}) {
  for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  for (const [k, p] of Object.entries(panels)) p.hidden = k !== mode;
  if (!silent && mode === 'manual') setStatus('');
}
for (const b of modeBtns) b.addEventListener('click', () => setMode(b.dataset.mode));

el('equal-apply').addEventListener('click', () => {
  const n = Math.min(100, Math.max(2, Math.round(Number(equalN.value) || 2)));
  equalN.value = String(n);
  setCuts(equalParts(n, state.opened.duration));
  // Report what the file allowed, never the request: equalParts caps n so no part is shorter than MIN_SEGMENT_SEC.
  const parts = state.cuts.length + 1;
  setStatus(parts === n ? `Split into ${n} parts.` : `Split into ${parts} parts, the most this file allows at ${MIN_SEGMENT_SEC} s per part.`);
});

el('every-apply').addEventListener('click', () => {
  const v = Math.max(1, Math.round(Number(everyValue.value) || 1));
  everyValue.value = String(v);
  const step = v * Number(everyUnit.value);
  setCuts(everyN(step, state.opened.duration));
  // everyN stops at MAX_CUTS, so a short interval on a long file leaves one
  // long last part rather than silently doing something else. Say so, and
  // report the list we ended up with, never the request.
  const n = state.cuts.length;
  const capped = n === MAX_CUTS ? ' (the most this tool allows; the last part holds the rest)' : '';
  setStatus(n ? `Split every ${formatTime(step, 0)} into ${n + 1} parts${capped}.` : 'The file is shorter than that interval.');
});

silenceDb.addEventListener('input', () => { silenceDbOut.textContent = `${silenceDb.value} dB`.replace('-', '−'); });
silenceApply.addEventListener('click', () => {
  // setCuts is a no-op while busy, so without this Find gaps would report a
  // count for cuts it did not apply.
  if (!state.peaks || state.busy) return;
  const cuts = detectSilence(state.peaks.rms, state.peaks.rate, state.opened.duration, {
    thresholdDb: Number(silenceDb.value), minGapSec: Math.max(0.2, Number(silenceGap.value) || 1),
    filled: state.peaks.filled,
  });
  setCuts(cuts);
  const found = state.cuts.length;
  silenceResult.textContent = found
    ? `Found ${found} ${found === 1 ? 'gap' : 'gaps'}.`
    : 'No gaps found; try a higher threshold or a shorter minimum.';
});

// ---- table ---------------------------------------------------------------------
// Every edit rebuilds the whole tbody, and the table is the ONLY keyboard path
// to the cut list (the canvas is pointer-only), so focus has to be carried
// across by name (playbook §4's reorder rule). `change` fires while the browser
// is already mid-focus-transfer and activeElement can be <body> by then, so the
// last control focused inside the table is remembered as well; any pointer
// press outside the table forgets it, so a canvas double-click never yanks
// focus into a row.
let lastFocusKey = null;
segmentsBody.addEventListener('focusin', (e) => { lastFocusKey = e.target?.dataset?.focusKey || null; });
document.addEventListener('pointerdown', (e) => { if (!segmentsBody.contains(e.target)) lastFocusKey = null; }, true);

function focusKeyNow() {
  const a = document.activeElement;
  if (a && segmentsBody.contains(a)) return a.dataset?.focusKey || null;
  if (a && a !== document.body) return null;   // parked somewhere else on purpose
  return lastFocusKey;
}

function restoreFocus(key) {
  if (!key) return;
  // A disabled control cannot take focus, so a rebuild landing mid-cut falls
  // through the same fallbacks instead of dropping focus on the floor.
  const at = (k) => {
    const node = segmentsBody.querySelector(`[data-focus-key="${k}"]`);
    return node && !node.disabled ? node : null;
  };
  const n = Number(key.split(':')[0]);
  // Merge deletes the row its own button lived in: land on the merged row.
  const target = at(key) || (n > 1 ? at(`${n - 1}:end`) : null) || (addCutBtn.disabled ? null : addCutBtn);
  if (!target) return;   // everything is dead this frame; leave focus where it is
  target.focus();
  lastFocusKey = target.dataset?.focusKey || null;
}

function renderList() {
  const { opened, file } = state;
  const segs = segments();
  const key = focusKeyNow();
  const rows = segs.map((s) => {
    const n = s.index + 1;
    const last = s.index === segs.length - 1;
    return `<tr data-index="${n}">
      <td><span class="seg-num" aria-label="Part ${n}">${n}</span></td>
      <td><input class="t-start" data-focus-key="${n}:start" aria-label="Start of part ${n}" aria-describedby="row-err-${n}" value="${formatTime(s.start)}"${s.index === 0 ? ' readonly' : ''}></td>
      <td><input class="t-end" data-focus-key="${n}:end" aria-label="End of part ${n}" aria-describedby="row-err-${n}" value="${formatTime(s.end)}"${last ? ' readonly' : ''}></td>
      <td>${formatTime(s.end - s.start)}</td>
      <td>≈ ${prettyBytes(estimateBytes(file.size, s.end - s.start, opened.duration))}</td>
      <td><div class="row-actions">
        <button type="button" class="play-seg" data-focus-key="${n}:play" data-index="${s.index}" aria-label="Play part ${n}">Play</button>
        <button type="button" class="dl-seg" data-focus-key="${n}:dl" data-index="${s.index}" aria-label="Download part ${n}">Download</button>
        ${s.index > 0 ? `<button type="button" class="merge-seg" data-focus-key="${n}:merge" data-index="${s.index}" aria-label="Merge part ${n} with previous">Merge with previous</button>` : ''}
      </div><p class="row-error" id="row-err-${n}" hidden></p></td>
    </tr>`;
  });
  segmentsBody.innerHTML = rows.join('');
  downloadAllBtn.hidden = segs.length < 2;
  selectCut(state.selected);
  // Before restoreFocus, so it can see which controls are dead this frame.
  applyBusyToTable();
  restoreFocus(key);
}

// A row's end input edits the cut at its index; a start input edits the cut
// before it. Out-of-range values are flagged, not clamped, and restored on
// blur (the spec: "rejected inline").
segmentsBody.addEventListener('change', (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.readOnly) return;
  const tr = input.closest('tr');
  const segIndex = Number(tr.dataset.index) - 1;
  const cutIndex = input.classList.contains('t-end') ? segIndex : segIndex - 1;
  const t = parseTime(input.value);
  const err = tr.querySelector('.row-error');
  const dur = state.opened.duration;
  const { lo, hi } = cutRange(state.cuts, cutIndex, dur);
  if (Number.isNaN(t) || Math.abs(clampCut(state.cuts, cutIndex, t, dur) - t) > 1e-9) {
    input.setAttribute('aria-invalid', 'true');
    err.textContent = `Must be between ${formatTime(Math.ceil(lo * 10) / 10)} and ${formatTime(Math.floor(hi * 10) / 10)}.`;
    err.hidden = false;
    return;
  }
  input.removeAttribute('aria-invalid');
  err.hidden = true;
  setCuts(moveCut(state.cuts, cutIndex, t, dur), { keepSelection: true });
  setMode('manual', { silent: true });
});
segmentsBody.addEventListener('focusout', (e) => {
  const input = e.target;
  if (input instanceof HTMLInputElement && input.getAttribute('aria-invalid') === 'true') {
    const tr = input.closest('tr');
    const seg = segments()[Number(tr.dataset.index) - 1];
    input.value = formatTime(input.classList.contains('t-end') ? seg.end : seg.start);
    input.removeAttribute('aria-invalid');
    tr.querySelector('.row-error').hidden = true;
  }
});
segmentsBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const i = Number(btn.dataset.index);
  const seg = segments()[i];
  if (btn.classList.contains('dl-seg')) downloadSegment(seg);
  else if (btn.classList.contains('merge-seg')) { setCuts(removeCut(state.cuts, i - 1)); setMode('manual', { silent: true }); }
  else if (btn.classList.contains('play-seg')) { selectCut(i > 0 ? i - 1 : null); playRange?.(seg.start, seg.end); }
});

// ---- downloads ------------------------------------------------------------------
function segmentBlob(seg, count) {
  const { base } = splitName(state.file.name);
  return cutSegment(state.mb, state.opened, seg, chunkTags(state.opened.tags, base, seg.index, count));
}
// cut.js throws 'empty_chunk' when both cuts of a chunk snap to the same
// packet boundary (two cuts within one frame of each other).
function cutFailureMessage(err) {
  return err?.message === 'empty_chunk' ? 'This chunk is shorter than one frame of this file. Move a cut.' : "Couldn't cut this chunk.";
}

const CHANGED_MID_CUT = 'The cuts changed while cutting. Download again.';

async function downloadSegment(seg) {
  if (state.busy) return;
  setBusy(true);
  // setCuts always assigns a fresh array, so identity is the staleness check.
  const opened = state.opened;
  const cutsAtStart = state.cuts;
  const segs = segments();
  const { base } = splitName(state.file.name);
  const row = segmentsBody.querySelector(`tr[data-index="${seg.index + 1}"] .row-error`);
  try {
    setStatus(`Cutting part ${seg.index + 1}…`);
    const blob = await segmentBlob(seg, segs.length);
    if (state.opened !== opened || state.cuts !== cutsAtStart) { setStatus(CHANGED_MID_CUT); return; }
    triggerDownload(blob, chunkName(base, seg.index, segs.length, opened.ext));
    setStatus('');
    row.hidden = true;
  } catch (err) {
    row.textContent = cutFailureMessage(err); row.hidden = false; setStatus('');
  } finally { setBusy(false); }
}

async function downloadAll() {
  if (state.busy) return;
  setBusy(true);
  const opened = state.opened;
  const cutsAtStart = state.cuts;
  const segs = segments();
  const { base } = splitName(state.file.name);
  try {
    let JSZip;
    try { JSZip = await loadJSZip(); }
    catch { setStatus("Couldn't load the ZIP packer from this site. Check your connection and try Download all again."); return; }
    const zip = new JSZip();
    for (const seg of segs) {
      setStatus(`Cutting ${seg.index + 1} of ${segs.length}…`);
      let blob;
      try { blob = await segmentBlob(seg, segs.length); }
      catch (err) { setStatus(`Stopped at part ${seg.index + 1}: ${cutFailureMessage(err)}`); return; }
      if (state.opened !== opened || state.cuts !== cutsAtStart) { setStatus(CHANGED_MID_CUT); return; }
      zip.file(chunkName(base, seg.index, segs.length, opened.ext), blob);
    }
    setStatus('Packing the ZIP…');
    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    triggerDownload(out, `${base}-split.zip`);
    setStatus(`Downloaded ${segs.length} chunks.`);
  } finally { setBusy(false); }
}
downloadAllBtn.addEventListener('click', downloadAll);

document.documentElement.dataset.bootReady = '1';
