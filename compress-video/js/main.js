// compress-video/js/main.js — boot + tool wiring. One video at a time:
// probe → configure (target size + live quality band + optional real-frame
// preview) → encode with progress/cancel → download. All state lives in
// this module; sections toggle via [hidden].
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { escapeHtml } from '/shared/escape.js';
import { planEncode, correctedBitrate, chooseAuto, predictFromProbe, resolveAudio, AUDIO_STEPS } from './plan-encode.js';
import { hasWebCodecs, startCompress, probeAudioFloorBps, EngineLoadError } from './engine.js';
import { probeFile } from './probe.js';
import { encodeSample, SAMPLE_POINTS } from './preview.js';
import { shouldProbe, startProbe } from './calibrate.js';

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
const framerate = el('framerate');
const framerateLabel = el('framerate-label');
const audioSel = el('audio');
const audioLabel = el('audio-label');
const audioNote = el('audio-note');
const bandMeter = el('band-meter');
const bandLabel = el('band-label');
const bandNote = el('band-note');
const suggestBtn = el('suggest-btn');
const previewBtn = el('preview-btn');
const previewArea = el('preview-area');
const encodeBtn = el('encode-btn');
const progress = el('progress');
const progressLine = el('progress-line');
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

// Is there audio left to give up, and would giving it up actually shrink the
// FILE? Only in the case overAdvice() speaks to: the encoder is at its floor
// and ignoring the requested bitrate, so bytes the audio releases are not
// immediately spent back on a higher video request. Reachability of a lower
// rung is asked of resolveAudio rather than re-derived from AUDIO_STEPS and
// src.audioFloorBps here, so this can't drift from what the control offers.
function audioAdvice() {
  if (!src.hasAudio || !(plan.audioBytes > 0) || plan.audio.mode === 'remove') return null;
  const canReduce = AUDIO_STEPS.some(s => s.id !== 'copy'
    && resolveAudio(src, s.id).bytes < plan.audioBytes);
  return canReduce
    ? `reducing or removing the audio under Audio frees up to ${prettyBytes(plan.audioBytes)}`
    : `removing the audio under Audio frees ${prettyBytes(plan.audioBytes)}`;
}

// What to suggest when an encode lands over target: the honest next lever,
// not a dead end when the resolution is already at its floor. Resolution and
// frame rate come first because they lower the encoder's floor itself, so
// they scale with the overshoot; audio releases a fixed, bounded number of
// bytes, and losing the sound is usually the more noticeable trade.
function overAdvice() {
  if (plan.out.height > 360) return 'a lower resolution will land it';
  if (src.fps >= 40 && plan.outFps == null) return 'dropping the frame rate to 30 fps would help';
  const audio = audioAdvice();
  if (audio) return audio;
  return 'a shorter clip or a larger target are the ways out';
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
    const probed = await probeFile(f);
    // Resolved per file, never persisted: the lowest AAC bitrate this
    // browser will actually encode (null = it can't encode AAC at all).
    // Chromium's floor is 96 kbps. Read per file rather than once at boot,
    // because probeAudioFloorBps also returns null when the ENGINE failed to
    // load, and freezing that pessimistic answer would drop audio tracks
    // that are fine. probeFile succeeding means the engine is loaded already.
    // A silent file gets `undefined`, not null — plan-encode.js reads absent
    // as "unmeasured, be permissive" and null as the measured "no AAC
    // encoder here", and a silent file is the former. Nothing downstream
    // reads it today (every consumer checks hasAudio first), which is
    // exactly why the two meanings must not be allowed to blur.
    src = { ...probed, audioFloorBps: probed.hasAudio ? await probeAudioFloorBps() : undefined };
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
  resolution.value = 'auto';
  framerate.value = 'auto';
  framerateLabel.hidden = !(src.fps >= 40);
  audioSel.value = 'auto';
  audioLabel.hidden = !src.hasAudio;
  audioNote.hidden = true;
  // Clearing the TEXT, not just hiding: this element is #audio's
  // aria-describedby target, and the accessible-description algorithm ignores
  // a referenced node's hidden state. Leaving stale text here hands the next
  // file's screen-reader users the previous file's disclosure — a wrong one
  // that only they hear.
  audioNote.textContent = '';
  // Reset outside the hasAudio guard: a silent file takes none of the
  // branches below, and must not inherit the last file's hidden/disabled.
  for (const opt of audioSel.options) { opt.disabled = false; opt.hidden = false; }
  if (src.hasAudio) {
    // `!== null` and `!== false`, never truthiness or `!=`: plan-encode.js
    // reads both fields exactly this way (absent audioFloorBps is permissive,
    // absent audioCopyable means copyable). Any looser test would put this
    // control and the planner on opposite answers for a src that omits the
    // field, and the visible half of such a disagreement is a false
    // disclosure.
    const canEncode = src.audioFloorBps !== null;
    const copyable = src.audioCopyable !== false;
    for (const opt of audioSel.options) {
      const step = AUDIO_STEPS.find(s => s.id === opt.value);
      if (!step || step.bps == null) continue; // 'auto', 'copy', 'none': always offered
      // Offer a rung only when the planner will deliver it AT ITS LABEL:
      // anything that collapses to copy, or clamps to a different bitrate,
      // would put the control's own text at odds with what the encoder is
      // asked for. Asking resolveAudio is what keeps that true in the
      // uncarriable-codec branch, where the clamp is to a THIRD value rather
      // than a collapse a hand-written predicate would catch.
      const r = resolveAudio(src, step.id);
      const unavailable = r.id !== step.id || r.bps !== step.bps;
      opt.disabled = unavailable;
      opt.hidden = unavailable;
    }
    const copyOpt = audioSel.querySelector('option[value="copy"]');
    copyOpt.textContent = (!copyable && canEncode) ? 'Keep (converted to AAC)' : 'Keep original';
    if (!canEncode && copyable) {
      audioNote.hidden = false;
      audioNote.textContent = "This browser can't re-encode audio. The track can be kept or removed, but not shrunk.";
    } else if (!canEncode && !copyable) {
      audioLabel.hidden = true;
      audioNote.hidden = false;
      audioNote.textContent = "This browser can't keep this file's audio format, so the output will have no audio.";
    }
  }
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

function currentAudioId() {
  // Hidden control = no audio track, or the corner where the audio can't be
  // kept at all (resolveAudio turns 'copy' into removal on its own there).
  return audioLabel.hidden ? 'copy' : audioSel.value;
}

// Resolve the current control selections into a plan. `floorBpp` (optional)
// replaces the guessed encoder floor with one measured from this clip.
// `audioOverride` (optional) substitutes an audio step id for whatever the
// control says, so a caller can ask "what would this same configuration do
// under a different audio choice?" while keeping every OTHER pin the user
// set — asking chooseAuto with a bare audio pin instead would quietly let
// the resolution the user chose float, and answer a question nobody asked.
function derivePlan(targetBytes, floorBpp, audioOverride) {
  const autoRes = resolution.value === 'auto';
  const fpsSel = framerateLabel.hidden ? 'source' : framerate.value; // low-fps sources: no fps choice
  const autoFps = fpsSel === 'auto';
  const audioId = audioOverride ?? currentAudioId();
  const autoAudio = audioId === 'auto';
  let outHeight; let outFps; let audio;
  if (autoRes || autoFps || autoAudio) {
    const pins = { floorBpp };
    if (!autoRes) pins.outHeight = currentOutHeight() ?? src.height;
    if (!autoFps) pins.outFps = fpsSel === '30' ? 30 : null;
    // Conditional assignment, not a ternary with undefined: chooseAuto pins
    // by KEY PRESENCE, so an explicit undefined would pin to [undefined].
    if (!autoAudio) pins.audio = audioId;
    const pick = chooseAuto({ ...src, targetBytes }, pins);
    outHeight = pick.height;
    outFps = pick.fps;
    audio = pick.audio;
  } else {
    outHeight = currentOutHeight();
    outFps = fpsSel === '30' ? 30 : null;
    audio = audioId;
  }
  const plan = planEncode({ ...src, targetBytes }, { outHeight, outFps, floorBpp, audio });
  return { plan, autoRes, autoFps, autoAudio };
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
  const derived = derivePlan(targetBytes);
  const { autoRes, autoFps, autoAudio } = derived;
  plan = derived.plan;

  if (plan.unreachable) {
    bandLabel.textContent = 'Target too small for this video';
    // plan.audioBytes can be 0 (no track), the stream-copy figure, or a
    // forced-transcode figure (uncarriable codec) — never assume "copied
    // through unchanged" here.
    bandNote.textContent =
      (plan.audioBytes > 0
        ? `The audio track plus a minimum watchable picture need about ${prettyBytes(plan.minTargetBytes)}. `
        : `A minimum watchable picture needs about ${prettyBytes(plan.minTargetBytes)}. `)
      + `That is the smallest target that can work at ${plan.out.width}×${plan.out.height}`
      + `${plan.outFps ? ` at ${plan.outFps} fps` : ''}.`
      + (plan.audioBytes > 0 ? ' Removing the audio track under Audio lowers it.' : '');
    steps.forEach(s => s.classList.remove('is-filled'));
    bandMeter.setAttribute('aria-label', 'Quality: target unreachable');
    if (plan.suggestion) {
      suggestBtn.hidden = false;
      suggestBtn.textContent =
        `This size needs ${plan.suggestion.height}p or lower. `
        + `Use ${plan.suggestion.height}p (${plan.suggestion.band.label.toLowerCase()})`;
    } else {
      suggestBtn.hidden = true;
    }
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
  const droppedRes = plan.out.height < src.height;
  const droppedFps = plan.outFps != null;
  // Only credit "Auto" for a dimension it actually chose — a manually
  // pinned value (e.g. the user picked 30 fps themselves) must never read
  // as something auto decided; its own control already shows it.
  const noteRes = autoRes && droppedRes;
  const noteFps = autoFps && droppedFps;
  // Read the RESOLVED step, not the pick: a rung at or above the source
  // bitrate collapses to copy, and only plan.audio reports that.
  const noteAudio = autoAudio && src.hasAudio && plan.audio.mode === 'encode' && !plan.audio.forced;
  let autoNote = '';
  if (noteRes || noteFps || noteAudio) {
    let what = noteRes && noteFps ? `${plan.out.height}p at ${plan.outFps} fps`
      : noteRes ? `${plan.out.height}p` : noteFps ? `${plan.outFps} fps` : '';
    if (noteAudio) {
      const audioDesc = `${Math.round(plan.audio.bps / 1000)} kbps${plan.audio.channels === 1 ? ' mono' : ''} audio`;
      what = what ? `${what} with ${audioDesc}` : audioDesc;
    }
    if (plan.band.step <= 2) {
      // "the best any setting does" has to exclude the one setting Auto
      // refuses to take: chooseAuto never returns 'none', so whenever
      // removing the track would raise the band, that sentence is false and
      // the better setting is sitting right there in the Audio control.
      // Ask, rather than claim. Only asked below Acceptable — where the
      // claim is actually made — so the extra planning costs nothing on the
      // targets that are already fine, and the answer honors every pin the
      // user set (derivePlan, not a bare chooseAuto).
      let removalBeats = false;
      if (autoAudio && plan.audioBytes > 0) {
        const removed = derivePlan(targetBytes, undefined, 'none').plan;
        removalBeats = !removed.unreachable && removed.band.step > plan.band.step;
      }
      autoNote = removalBeats
        ? `Auto picked ${what}, the best it does without dropping the sound; Remove audio does better. `
        : `Auto picked ${what}, the best any setting does at this size. `;
    } else {
      autoNote = `Auto picked ${what} for this target. `;
    }
  }
  // forced marks the cases where plan.audio.id under-reports: a transcode the
  // user didn't ask for, or the track being dropped because it can't be kept.
  const forcedNote = plan.audio.forced
    ? (plan.audio.mode === 'remove'
      ? ` This file's audio can't be kept here, so the output will have no audio.`
      : ` This file's audio format doesn't fit MP4, so it gets converted to AAC.`)
    : '';
  bandNote.textContent =
    `${autoNote}About ${(plan.videoBitrate / 1e6).toFixed(1)} Mbps of video at ${outLine}. `
    + `An estimate from bitrate and pixels; the Preview button shows the real thing.`
    + forcedNote;
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
framerate.addEventListener('change', settingsChanged);
audioSel.addEventListener('change', settingsChanged);
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

// Shared cleanup for a cancel that lands outside the full-encode try/finally
// below (during the probe, or in the gap right after it) — one copy so the
// two call sites can't drift apart.
function cancelBackToConfigure() {
  progress.hidden = true;
  configure.hidden = false;
  handle = null;
  setIntakeDisabled(false);
  // A probe-driven re-plan can have left `plan` holding adjusted values
  // that the visible band never showed (the panel was hidden throughout
  // the probe/encode) — resync it to what's actually on screen.
  recompute();
}

encodeBtn.addEventListener('click', async () => {
  if (!file || !plan || plan.unreachable) return;
  setIntakeDisabled(true);
  clearError();
  userCancelled = false;
  configure.hidden = true;
  result.hidden = true;
  progress.hidden = false;
  setProgress(0);

  // Calibration probe: encode a couple of short real segments first, on
  // clips long enough that this pays for itself, so a content-dependent
  // encoder floor gets caught BEFORE a full encode is spent on a plan that
  // was never going to hit the target. Optimization only — a probe that
  // fails or gets cancelled must not be treated as an encode failure.
  const target = currentTargetBytes();
  // Everything the re-plan below can change and the band note already
  // showed. Audio belongs here for the same reason width/height/fps do: the
  // re-plan runs chooseAuto again against a measured floor, and its audio
  // answer can differ from the one the user was last shown. Recording only
  // the picture would let the track be silently re-encoded.
  const planBefore = { w: plan.out.width, h: plan.out.height, fps: plan.outFps, audio: plan.audio.id };
  let probeNote = '';
  // Set when the two probes together already proved a lower bitrate alone
  // won't land the target and there's no smaller resolution/fps left to
  // move to — skips the post-encode second pass, which would otherwise
  // re-encode just to re-discover what the probes already measured.
  let probeProvedFloorBound = false;
  if (shouldProbe(src.durationSec)) {
    progressLine.textContent = 'Checking a sample of your video so the size comes out right.';
    try {
      handle = startProbe(file, plan, src.durationSec, { onProgress: setProgress });
      const { probeBytes, probeSecs } = await handle.done;
      const effFps = plan.outFps ?? src.fps;
      const p1 = predictFromProbe({
        probeBytes, probeSecs, durationSec: src.durationSec,
        audioBytes: plan.audioBytes, out: plan.out, fps: effFps,
      });
      if (p1.predictedBytes > target) {
        const b2 = correctedBitrate({
          videoBitrate: plan.videoBitrate, actualBytes: p1.predictedBytes,
          targetBytes: target, audioBytes: plan.audioBytes, durationSec: src.durationSec,
        });
        let measuredBpp = p1.achievedBpp;
        let settled = false;
        if (b2) {
          if (userCancelled) { cancelBackToConfigure(); return; }
          // Does asking for less actually produce less? Only the encoder
          // can answer that, and one short segment is enough to ask.
          progressLine.textContent = 'Checking whether a lower bitrate is enough.';
          // `trial` (and `plan` below, if this doesn't pan out) only get
          // videoBitrate overridden — bpp, band, minTargetBytes, and
          // suggestion are still the ones computed at the OLD bitrate and
          // go stale here. Nothing reads them downstream today; only
          // videoBitrate, out, and outFps are.
          const trial = { ...plan, videoBitrate: b2 };
          handle = startProbe(file, trial, src.durationSec, { onProgress: setProgress, segments: 1 });
          const r2 = await handle.done;
          if (userCancelled) { cancelBackToConfigure(); return; }
          const p2 = predictFromProbe({
            probeBytes: r2.probeBytes, probeSecs: r2.probeSecs,
            durationSec: src.durationSec, audioBytes: trial.audioBytes,
            out: trial.out, fps: trial.outFps ?? src.fps,
          });
          if (p2.predictedBytes <= target) { plan = trial; settled = true; }
          else { measuredBpp = p2.achievedBpp; }
        }
        if (!settled) {
          // The encoder is at its floor for this footage: fewer pixels or
          // frames is the only lever left.
          const candidate = derivePlan(target, measuredBpp).plan;
          const moved = candidate && !candidate.unreachable
            && (candidate.out.width !== plan.out.width
              || candidate.out.height !== plan.out.height
              || candidate.outFps !== plan.outFps);
          if (moved) {
            plan = candidate;
          } else {
            // No smaller setting left to try, and the confirmation probe
            // (if it ran) already showed a lower bitrate doesn't land it
            // either — this clip is floor-bound, full stop.
            probeProvedFloorBound = true;
            if (b2) plan = { ...plan, videoBitrate: b2 };
          }
        }
      }
    } catch {
      // A cancel during either probe must land exactly like a cancel during
      // the full encode: this early return skips the encode try/finally
      // below entirely, so it repeats that path's cleanup by hand.
      if (userCancelled) { cancelBackToConfigure(); return; }
      // Any other probe failure is not a failed encode — it was only an
      // optimization attempt. Fall through and encode with the original plan.
    }
    const pictureMoved = plan.out.width !== planBefore.w
      || plan.out.height !== planBefore.h || plan.outFps !== planBefore.fps;
    const audioMoved = plan.audio.id !== planBefore.audio;
    // What the audio BECAME, as a noun phrase. mode, not id: a forced
    // transcode reports id 'copy' while re-encoding, and naming the id there
    // would repeat the under-report this note exists to prevent.
    const audioPhrase = plan.audio.mode === 'encode'
      ? `${Math.round(plan.audio.bps / 1000)} kbps${plan.audio.channels === 1 ? ' mono' : ''} audio`
      : plan.audio.mode === 'remove' ? 'no audio' : 'the original audio';
    if (pictureMoved) {
      probeNote = ` The sample check moved this to ${plan.out.width}×${plan.out.height}`
        + `${plan.outFps ? ` at ${plan.outFps} fps` : ''}`
        + (audioMoved ? ` with ${audioPhrase}` : '')
        + ` to fit.`;
    } else if (audioMoved) {
      // Audio alone moved, so the sentence must not name dimensions that
      // didn't change — "moved this to 1920×1080" would read as a change
      // where there was none.
      // NOT REACHABLE TODAY, and deliberately kept: the `moved` gate above
      // only adopts a candidate whose width/height/fps differ, so a
      // candidate that changes nothing but the audio is discarded and this
      // branch never fires. It exists so that widening that gate — the
      // obvious next change, since an audio-only candidate is a real way to
      // fit that is currently thrown away — cannot reintroduce the silent
      // re-encode this whole block was added to stop.
      probeNote = plan.audio.mode === 'copy'
        ? ` The sample check went back to the original audio to fit.`
        : ` The sample check switched the audio to ${audioPhrase} to fit.`;
    }
    setProgress(0);
  }
  progressLine.textContent = 'Encoding happens on your device. Closing this tab will stop it.';

  // The probe's own done-promise can resolve (rather than reject) on a
  // cancel that lands after its last segment already finished executing —
  // without this check that gap would silently start a full encode on a
  // job the user just cancelled.
  if (userCancelled) { cancelBackToConfigure(); return; }

  handle = startCompress(file, plan, { onProgress: setProgress });
  try {
    outBlob = await handle.done;
    progress.hidden = true;
    result.hidden = false;
    if (outBlob.size <= target) {
      resultLine.textContent = `${prettyBytes(outBlob.size)}, under your ${prettyBytes(target)} target.${probeNote}`;
    } else if (probeProvedFloorBound) {
      // The probe(s) already established that a lower bitrate doesn't land
      // it and there's nowhere smaller to move: the automatic second pass
      // would just re-encode to re-discover that same answer.
      resultLine.textContent =
        `${prettyBytes(outBlob.size)}, over your ${prettyBytes(target)} target. ${overAdvice()}.`;
    } else {
      const b2 = correctedBitrate({
        videoBitrate: plan.videoBitrate,
        actualBytes: outBlob.size,
        targetBytes: target,
        audioBytes: plan.audioBytes,
        durationSec: src.durationSec,
      });
      if (b2 === null || userCancelled) {
        resultLine.textContent =
          `${prettyBytes(outBlob.size)}, over your ${prettyBytes(target)} target. `
          + `Encoders overshoot sometimes; ${overAdvice()}.`;
      } else {
        resultLine.textContent =
          `${prettyBytes(outBlob.size)}, over your ${prettyBytes(target)} target. `
          + `Re-compressing to get under your ${prettyBytes(target)} target…`;
        againBtn.disabled = true;
        progress.hidden = false;
        setProgress(0);
        try {
          // Spread, not a hand-copied field list, for the same reason
          // `trial` above spreads: the second pass re-plans the VIDEO
          // BITRATE and nothing else, and a list would silently drop any
          // field planEncode gains later.
          handle = startCompress(file, { ...plan, videoBitrate: b2 }, { onProgress: setProgress });
          const second = await handle.done;
          if (second.size < outBlob.size) outBlob = second;
          resultLine.textContent = outBlob.size <= target
            ? `${prettyBytes(outBlob.size)}, under your ${prettyBytes(target)} target.${probeNote}`
            : `${prettyBytes(outBlob.size)}, still over your ${prettyBytes(target)} target after a `
              + `second pass. This clip is not going smaller with these settings; `
              + `${overAdvice()}.`;
        } catch {
          // Cancel or a failed second pass both fall back to the first result,
          // which is valid output the user can already download.
          resultLine.textContent =
            `${prettyBytes(outBlob.size)}, over your ${prettyBytes(target)} target. `
            + `Encoders overshoot sometimes; ${overAdvice()}.`;
        } finally {
          progress.hidden = true;
          againBtn.disabled = false;
        }
      }
    }
  } catch (err) {
    progress.hidden = true;
    if (userCancelled) { configure.hidden = false; return; }
    configure.hidden = false;
    if (err instanceof EngineLoadError) {
      showError("Couldn't load the video engine. Check your connection and try again.");
    } else if (err && err.message === 'video_unsupported') {
      showError("This video's codec can't be decoded by this browser, so it can't be re-encoded here. Converting it to MP4 elsewhere first would work around that.");
    } else if (err && err.message === 'audio_unsupported') {
      showError("The audio track can't be carried into the output MP4. Set Audio to Remove audio to compress the video without sound.");
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
