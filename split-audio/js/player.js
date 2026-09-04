// split-audio/js/player.js — <audio> transport over an object URL of the
// ORIGINAL file (never a chunk), playhead sync on requestAnimationFrame,
// and range play for a table row. canPlayType gates it: Safari returns ''
// for OGG, and then the transport is disabled while everything else works.
// canPlayType can also answer 'maybe' and then fail to decode, so the
// element's own error event is the second gate: onError shuts the transport
// down instead of leaving the button stuck at pause with the rAF loop
// re-arming at 60 Hz and nothing on screen to explain it.
export function createPlayer(audio, { onTime, onPlayState, onError }) {
  let url = null;
  let rangeEnd = null;
  let raf = 0;
  let ready = false;

  function tick() {
    if (rangeEnd !== null && audio.currentTime >= rangeEnd) {
      const end = rangeEnd;
      rangeEnd = null;
      audio.pause();
      audio.currentTime = end;
      onTime(end);
      return;
    }
    onTime(audio.currentTime);
    if (!audio.paused) raf = requestAnimationFrame(tick);
  }
  audio.addEventListener('play', () => { onPlayState(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  audio.addEventListener('pause', () => { onPlayState(false); cancelAnimationFrame(raf); onTime(audio.currentTime); });
  audio.addEventListener('ended', () => { rangeEnd = null; });
  audio.addEventListener('error', () => { rangeEnd = null; cancelAnimationFrame(raf); onPlayState(false); onError?.(audio.error); });

  const api = {
    /** @returns {boolean} whether the browser can play this MIME in the page */
    load(file, mime) {
      api.unload();
      if (audio.canPlayType(mime) === '') return false;
      url = URL.createObjectURL(file);
      audio.src = url;
      ready = true;
      return true;
    },
    unload() {
      // Detach the element from the URL BEFORE revoking it: a metadata fetch
      // still in flight against a revoked blob URL is a decode error, and the
      // error listener above would blame the next file for it.
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (url) { URL.revokeObjectURL(url); url = null; }
      ready = false;
      rangeEnd = null;
    },
    get ready() { return ready; },
    get playing() { return ready && !audio.paused; },
    seek(t) { if (!ready) return; rangeEnd = null; audio.currentTime = t; onTime(t); },
    // NotAllowedError is the autoplay policy, and the button click is the
    // gesture that clears it. Every other rejection is a real failure.
    play() { if (!ready) return; audio.play().catch((e) => { if (e?.name !== 'NotAllowedError') onError?.(e); }); },
    pause() { audio.pause(); },
    toggle() { if (!ready) return; if (audio.paused) api.play(); else api.pause(); },
    playRange(start, end) { if (!ready) return; audio.currentTime = start; rangeEnd = end; onTime(start); api.play(); },
  };
  return api;
}
