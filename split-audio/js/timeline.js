// split-audio/js/timeline.js — the waveform editor surface. One <canvas>
// at the frame's CSS size (DPR-aware) showing a view window
// [viewStart, viewEnd] of the file: ruler, peaks, alternating numbered
// segments, cut markers with grab tabs, and the playhead. PointerEvents
// only (mouse, touch, pen through one path); pinch with two pointers.
//
// Colorblind rule: segments alternate a faint shade AND carry a numbered
// pill; the playhead is a triangle, cut markers are tabs; the selected
// marker is thicker and filled. Hue never carries state alone.
//
// The canvas is role="img". The segment table in main.js is the complete
// accessible editing surface; nothing is possible only here.
import { PEAK_RATE } from './peaks.js';

const RULER_H = 18;
const TAB_W = 12, TAB_H = 14;
const HIT_MOUSE = 12, HIT_TOUCH = 22, HIT_LINE = 4;
const CLICK_SLOP = 6;
const ZOOM_STEP = 1.5;
const MAX_PX_PER_SEC = 4 * PEAK_RATE;      // 4 px per 10 ms bucket
const TICK_STEPS = [0.1, 0.5, 1, 5, 10, 30, 60, 300, 600, 1800, 3600];

/**
 * @param {HTMLElement} frame the overflow:hidden wrapper (sized by CSS)
 * @param {HTMLCanvasElement} canvas
 * @param {{onSeek:(t:number)=>void, onAddCut:(t:number)=>void,
 *   onMoveCut:(i:number,t:number)=>void, onSelectCut:(i:number|null)=>void,
 *   formatTime:(t:number, d?:number)=>string}} h
 */
export function createTimeline(frame, canvas, h) {
  const ctx = canvas.getContext('2d');
  const s = {
    duration: 0, cuts: [], selected: null, playhead: 0,
    peaks: null, peaksUntil: 0,
    viewStart: 0, viewEnd: 0, width: 0, height: 0, dpr: 1,
    label: '', dirty: false, raf: 0, aria: '',
  };
  const pointers = new Map();          // pointerId -> {x, y}
  let gesture = null;                  // {type:'drag'|'pan'|'click'|'pinch', ...}

  // ---- geometry ---------------------------------------------------------------
  const span = () => Math.max(1e-6, s.viewEnd - s.viewStart);
  const xOf = (t) => (t - s.viewStart) / span() * s.width;
  const tOf = (x) => s.viewStart + x / s.width * span();
  const clampView = (start, len) => {
    const l = Math.min(Math.max(len, minSpan()), s.duration || len);
    return [Math.min(Math.max(start, 0), Math.max(0, s.duration - l)), l];
  };
  const minSpan = () => s.width / MAX_PX_PER_SEC;

  function setView(start, len) {
    const [a, l] = clampView(start, len);
    s.viewStart = a; s.viewEnd = a + l;
    frame.dataset.view = `${a.toFixed(4)}:${(a + l).toFixed(4)}`;
    invalidate();
  }
  function zoomAt(factor, anchorT) {
    const len = span() / factor;
    const start = anchorT - (anchorT - s.viewStart) * (len / span());
    setView(start, len);
  }

  // ---- colours from the shell tokens; refreshed on theme change ------------
  // The tokens are light-dark(oklch(…), oklch(…)). A custom property computes
  // to that unresolved token stream, and canvas rejects it — silently, leaving
  // fillStyle at the previous value, which paints the whole surface black. So
  // resolve each token through a probe element's `color`, whose computed value
  // IS the used colour for the current color-scheme (both themes, since
  // html[data-theme] only sets color-scheme).
  let colors = null;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.display = 'none';
  frame.appendChild(probe);
  function readColors() {
    // A detached (or display:none-in-a-detached-tree) probe can compute to '',
    // which canvas ignores — leaving the previous fillStyle and the black
    // surface this whole dance exists to prevent. Fall back to the literal.
    const v = (name, fb) => {
      probe.style.color = `var(${name}, ${fb})`;
      const c = getComputedStyle(probe).color;
      return c || fb;
    };
    colors = {
      bg: v('--surface', '#fff'), text: v('--text', '#111'), muted: v('--text-secondary', '#666'),
      accent: v('--accent', '#0a58ca'), accentText: v('--accent-contrast', '#fff'), border: v('--border', '#999'),
    };
  }
  const themeObserver = new MutationObserver(() => { colors = null; invalidate(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => { colors = null; invalidate(); };
  mq.addEventListener('change', onScheme);

  // ---- sizing --------------------------------------------------------------------
  function resize() {
    // The canvas fills the frame's CONTENT box; the frame is border-box with a
    // 1 px border, so measuring the border box clips 2 px off the right and
    // bottom of everything we draw.
    s.dpr = window.devicePixelRatio || 1;
    s.width = Math.max(1, Math.round(frame.clientWidth));
    s.height = Math.max(1, Math.round(frame.clientHeight));
    canvas.width = Math.round(s.width * s.dpr);
    canvas.height = Math.round(s.height * s.dpr);
    canvas.style.width = `${s.width}px`; canvas.style.height = `${s.height}px`;
    if (s.duration) setView(s.viewStart, span()); else invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(frame);

  // ---- drawing -----------------------------------------------------------------
  function invalidate() {
    if (s.dirty) return;
    s.dirty = true;
    s.raf = requestAnimationFrame(draw);
  }

  function tickStep() {
    const pxPerSec = s.width / span();
    return TICK_STEPS.find((st) => st * pxPerSec >= 60) ?? TICK_STEPS[TICK_STEPS.length - 1];
  }

  function draw() {
    s.dirty = false;
    if (!colors) readColors();
    const { width: w, height: hgt } = s;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, w, hgt);
    if (!s.duration) return;
    const bodyTop = RULER_H, bodyH = hgt - RULER_H;

    // Paint order matters: shades, then the waveform, then the pills. The bars
    // are opaque, so a pill drawn before them is erased on loud content — and
    // the number is the colourblind-safe half of the segment cue.
    const bounds = [0, ...s.cuts, s.duration];

    // Alternating segment shades.
    for (let i = 1; i + 1 < bounds.length; i += 2) {
      const x0 = Math.max(0, xOf(bounds[i])), x1 = Math.min(w, xOf(bounds[i + 1]));
      if (x1 <= 0 || x0 >= w) continue;
      ctx.globalAlpha = 0.06; ctx.fillStyle = colors.text; ctx.fillRect(x0, bodyTop, x1 - x0, bodyH); ctx.globalAlpha = 1;
    }

    // Waveform: one bar per pixel column from the buckets it covers.
    if (s.peaks) {
      const { peak, rate } = s.peaks;
      const mid = bodyTop + bodyH / 2, amp = (bodyH / 2) - 6;
      ctx.fillStyle = colors.muted;
      for (let x = 0; x < w; x++) {
        const t0 = tOf(x), t1 = tOf(x + 1);
        if (t0 >= s.peaksUntil) break;
        let b0 = Math.floor(t0 * rate), b1 = Math.max(b0 + 1, Math.ceil(t1 * rate));
        let m = 0;
        for (let b = b0; b < b1 && b < peak.length; b++) if (peak[b] > m) m = peak[b];
        const hh = Math.max(1, m / 255 * amp);
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    }

    // Numbered pills, on top of the waveform. A pill wider than its own
    // segment is suppressed: a number that overflows into the next part is
    // worse than no number at all.
    ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    for (let i = 0; i + 1 < bounds.length; i++) {
      const x0 = Math.max(0, xOf(bounds[i])), x1 = Math.min(w, xOf(bounds[i + 1]));
      if (x1 <= 0 || x0 >= w) continue;
      const label = String(i + 1);
      const pw = Math.max(18, ctx.measureText(label).width + 10), ph = 16;
      const px = Math.max(x0, 0) + 4, py = bodyTop + 4;
      if (px + pw <= x1) {
        ctx.fillStyle = colors.bg; ctx.strokeStyle = colors.text; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = colors.text; ctx.textAlign = 'center'; ctx.fillText(label, px + pw / 2, py + ph / 2 + 0.5);
      }
    }

    // Ruler.
    const step = tickStep();
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5); ctx.stroke();
    ctx.fillStyle = colors.muted; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left';
    const first = Math.ceil(s.viewStart / step) * step;
    for (let t = first; t <= s.viewEnd + 1e-9; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 5); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.fillText(h.formatTime(t, step < 1 ? 1 : 0), x + 3, 7);
    }

    // Cut markers: line + grab tab; selected is thicker and filled.
    s.cuts.forEach((c, i) => {
      const x = Math.round(xOf(c)) + 0.5;
      if (x < -TAB_W || x > w + TAB_W) return;
      const sel = i === s.selected;
      ctx.strokeStyle = sel ? colors.accent : colors.text; ctx.lineWidth = sel ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(x, bodyTop); ctx.lineTo(x, hgt); ctx.stroke();
      ctx.fillStyle = sel ? colors.accent : colors.bg; ctx.strokeStyle = sel ? colors.accent : colors.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x - TAB_W / 2, bodyTop, TAB_W, TAB_H, 3); ctx.fill(); ctx.stroke();
      if (sel) { ctx.strokeStyle = colors.accentText; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, bodyTop + 3); ctx.lineTo(x, bodyTop + TAB_H - 3); ctx.stroke(); }
    });

    // Playhead: triangle on the ruler + hairline.
    const px = Math.round(xOf(s.playhead)) + 0.5;
    if (px >= 0 && px <= w) {
      ctx.fillStyle = colors.text; ctx.strokeStyle = colors.text; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(px, 8); ctx.lineTo(px, hgt); ctx.stroke();
    }

    // Only on change: this runs every frame, and rewriting the label churns
    // the accessibility tree while a marker is being dragged.
    const aria = `Waveform${s.label ? ' of ' + s.label : ''}, ${h.formatTime(s.duration)}, ${s.cuts.length} ${s.cuts.length === 1 ? 'cut' : 'cuts'}`;
    if (aria !== s.aria) { s.aria = aria; canvas.setAttribute('aria-label', aria); }
  }

  // ---- pointer handling -----------------------------------------------------------
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  // The generous touch slop belongs to the grab tab, not to the whole body:
  // on a file cut every 10 s the markers are ~2 px apart at Fit, and a slop
  // that wide anywhere below the ruler turns every press into a drag —
  // click-to-seek and double-click-to-add stop existing. Below the tab band
  // you have to be nearly on the line.
  function hitMarker(x, y, pointerType) {
    if (y < RULER_H) return null;
    const inTab = y < RULER_H + TAB_H;
    const slop = inTab ? (pointerType === 'touch' ? HIT_TOUCH : HIT_MOUSE) : HIT_LINE;
    let best = null, bestD = slop + 1;
    s.cuts.forEach((c, i) => { const d = Math.abs(xOf(c) - x); if (d < bestD) { bestD = d; best = i; } });
    return best;
  }

  function onPointerDown(e) {
    if (!s.duration) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', dist: Math.abs(a.x - b.x) || 1, len: span(), anchorT: tOf((a.x + b.x) / 2) };
      return;
    }
    const i = hitMarker(p.x, p.y, e.pointerType);
    // Grab offset, not absolute position: a touch lands up to HIT_TOUCH px off
    // the line, and committing tOf(p.x) on the first move teleports the cut by
    // that much — minutes of audio on a long file at Fit.
    if (i !== null) { gesture = { type: 'drag', i, grabDx: xOf(s.cuts[i]) - p.x }; h.onSelectCut(i); return; }
    if (p.y < RULER_H) { gesture = { type: 'pan', x0: p.x, start0: s.viewStart }; return; }
    gesture = { type: 'click', x0: p.x, y0: p.y };
  }
  function onPointerMove(e) {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (gesture.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.abs(a.x - b.x) || 1;
      const len = gesture.len * (gesture.dist / dist);
      const cx = (a.x + b.x) / 2;
      setView(gesture.anchorT - cx / s.width * len, len);
      return;
    }
    if (gesture.type === 'drag') { h.onMoveCut(gesture.i, tOf(p.x + gesture.grabDx)); return; }
    if (gesture.type === 'pan') { setView(gesture.start0 - (p.x - gesture.x0) / s.width * span(), span()); return; }
    if (gesture.type === 'click' && Math.hypot(p.x - gesture.x0, p.y - gesture.y0) > CLICK_SLOP) { gesture.type = 'pan'; gesture.x0 = p.x; gesture.start0 = s.viewStart; }
  }
  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!gesture) return;
    if (gesture.type === 'click') h.onSeek(Math.min(Math.max(tOf(p.x), 0), s.duration));
    if (pointers.size === 0) gesture = null;
    else if (gesture.type === 'pinch') gesture = null;
  }
  // A cancelled pointer (the OS took it: a system gesture, a palm rejection)
  // is not a click, so it must not seek.
  function onPointerCancel(e) {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    pointers.delete(e.pointerId);
    gesture = null;
  }
  function onDblClick(e) {
    if (!s.duration) return;
    const p = local(e);
    if (p.y < RULER_H || hitMarker(p.x, p.y, 'mouse') !== null) return;
    h.onAddCut(tOf(p.x));
  }
  // preventDefault only where we actually act. A plain vertical wheel over the
  // frame is the page's: swallowing it traps the reader on a canvas that fills
  // the screen on a laptop.
  function onWheel(e) {
    if (!s.duration) return;
    const p = local(e);
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, tOf(p.x)); return; }
    const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    if (dx) { e.preventDefault(); setView(s.viewStart + dx / s.width * span(), span()); }
  }
  const ac = new AbortController();
  const { signal } = ac;
  canvas.addEventListener('pointerdown', onPointerDown, { signal });
  canvas.addEventListener('pointermove', onPointerMove, { signal });
  canvas.addEventListener('pointerup', onPointerUp, { signal });
  canvas.addEventListener('pointercancel', onPointerCancel, { signal });
  canvas.addEventListener('dblclick', onDblClick, { signal });
  canvas.addEventListener('wheel', onWheel, { passive: false, signal });

  // ---- public API ---------------------------------------------------------------------
  const api = {
    setDuration(d) { s.duration = d; s.playhead = 0; s.cuts = []; s.selected = null; s.peaks = null; s.peaksUntil = 0; resize(); setView(0, d); },
    setLabel(name) { s.label = name; invalidate(); },
    setPeaks(live, until) { s.peaks = live || null; s.peaksUntil = live ? (until ?? s.duration) : 0; invalidate(); },
    setCuts(cuts) { s.cuts = cuts; invalidate(); },
    setSelected(i) { s.selected = i; invalidate(); },
    setPlayhead(t) {
      s.playhead = t;
      // Keep a moving playhead in view when zoomed (only when it leaves).
      if (t < s.viewStart || t > s.viewEnd) setView(t - span() * 0.1, span());
      invalidate();
    },
    zoomIn() { zoomAt(ZOOM_STEP, anchor()); },
    zoomOut() { zoomAt(1 / ZOOM_STEP, anchor()); },
    fit() { setView(0, s.duration); },
    getView() { return { start: s.viewStart, end: s.viewEnd }; },
    draw: invalidate,
    destroy() { ac.abort(); ro.disconnect(); themeObserver.disconnect(); mq.removeEventListener('change', onScheme); cancelAnimationFrame(s.raf); probe.remove(); },
  };
  // Zoom keeps the playhead's screen position when visible, else the view centre.
  const anchor = () => (s.playhead >= s.viewStart && s.playhead <= s.viewEnd) ? s.playhead : (s.viewStart + s.viewEnd) / 2;
  resize();
  return api;
}
