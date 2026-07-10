// resize-image/js/plan-dims.js — PURE. Compute the output W×H (+ an action
// label) for one image given the controls and its native size. No DOM/pica.
const posInt = (n) => { const v = Math.max(1, Math.round(n)); return v; };

/**
 * @returns {{width:number,height:number,action:'resized'|'kept-native'|'enlarged'|'stretched'}}
 */
export function planDimensions({ mode, targetW, targetH, percent, allowUpscale, aspectLock, nativeW, nativeH }) {
  if (mode === 'percentage') {
    const p = Number(percent) || 0;
    if (p > 100 && !allowUpscale) return { width: nativeW, height: nativeH, action: 'kept-native' };
    const w = posInt(nativeW * p / 100), h = posInt(nativeH * p / 100);
    return { width: w, height: h, action: p > 100 ? 'enlarged' : 'resized' };
  }
  // dimensions mode
  const tw = Number(targetW) || 0, th = Number(targetH) || 0;
  if (!aspectLock) {
    // exact W×H (both expected; caller guards). Flag stretch if aspect drifts.
    const w = posInt(tw), h = posInt(th);
    const srcAR = nativeW / nativeH, dstAR = w / h;
    const stretched = Math.abs(srcAR - dstAR) / srcAR > 0.01;
    return { width: w, height: h, action: stretched ? 'stretched' : 'resized' };
  }
  // fit-box: min scale over the provided constraints.
  const sW = tw > 0 ? tw / nativeW : Infinity;
  const sH = th > 0 ? th / nativeH : Infinity;
  let scale = Math.min(sW, sH);
  if (!Number.isFinite(scale)) scale = 1; // neither provided (caller should prevent)
  if (scale >= 1 && !allowUpscale) return { width: nativeW, height: nativeH, action: scale > 1 ? 'kept-native' : 'resized' };
  const w = posInt(nativeW * scale), h = posInt(nativeH * scale);
  return { width: w, height: h, action: scale > 1 ? 'enlarged' : 'resized' };
}
