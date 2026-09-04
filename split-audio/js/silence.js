// split-audio/js/silence.js — cut points from the RMS buckets peaks.js
// produces. A gap is a maximal run of buckets quieter than the threshold
// that lasts at least minGapSec; one cut lands at its centre. Runs that
// touch the start or end of the file are not gaps (they would only create
// an empty segment). Pure; Node-tested.
import { dbToByte } from './peaks.js';

/**
 * @param {Uint8Array} rms dB-scale bytes from PeakBuilder
 * @param {number} rate buckets per second
 * @param {number} duration seconds
 * @param {number} [filled] number of buckets actually analysed (PeakBuilder's
 *   `filled`); buckets from there on are unknown, not silent, and are
 *   ignored.
 * @returns {number[]} cut times in seconds, ascending
 */
export function detectSilence(rms, rate, duration, { thresholdDb = -40, minGapSec = 1, filled } = {}) {
  const threshold = dbToByte(thresholdDb);
  const minLen = Math.max(1, Math.round(minGapSec * rate));
  const n = Math.min(rms.length, Math.ceil(duration * rate), Number.isFinite(filled) ? filled : Infinity);
  const cuts = [];
  let runStart = -1;
  const close = (endExclusive) => {
    if (runStart > 0 && endExclusive - runStart >= minLen) {
      cuts.push((runStart + endExclusive) / 2 / rate);
    }
  };
  for (let i = 0; i < n; i++) {
    const quiet = rms[i] < threshold;
    if (quiet && runStart < 0) runStart = i;
    else if (!quiet && runStart >= 0) { close(i); runStart = -1; }
  }
  // close() only ever runs from inside the loop, on a run some loud bucket
  // ended, so this is the single place the end-of-range rule lives: a run
  // still open at n touches the end of the analysed range, and a run
  // touching either end of the file is never a gap.
  return cuts;
}
