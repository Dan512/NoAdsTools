// split-audio/js/peaks.js — waveform peaks and RMS at PEAK_RATE buckets per
// second from a STREAMING decode, so a two-hour file costs 1.4 MB of
// buckets and never holds its PCM (a 15-minute stereo file decoded whole is
// ~320 MB, which is why the decodeAudioData fallback is duration-capped in
// main.js). PeakBuilder is pure; computePeaks wires it to mediabunny's
// AudioSampleSink; peaksFromPlanar serves the fallback.
export const PEAK_RATE = 100;

/** -90..0 dBFS -> 0..255 (0.35 dB per step). Linear bytes would put -40 dB at 2.55. */
export function dbToByte(db) {
  return Math.max(0, Math.min(255, Math.round((db + 90) / 90 * 255)));
}

export function rmsToByte(rms) {
  return rms <= 0 ? 0 : dbToByte(20 * Math.log10(rms));
}

export class PeakBuilder {
  constructor(duration, sampleRate) {
    this.sampleRate = sampleRate;
    this.length = Math.max(1, Math.ceil((Number.isFinite(duration) ? duration : 0) * PEAK_RATE));
    this.peak = new Uint8Array(this.length);   // linear max |sample|, for drawing
    this.rms = new Uint8Array(this.length);    // dB scale, for silence detection
    this.filled = 0;                            // buckets finalized so far
    this._bucket = -1; this._max = 0; this._sumSq = 0; this._n = 0;
  }

  /**
   * @param {Float32Array} data interleaved frames, `channels` wide
   * @param {number} channels
   * @param {number} t0 timestamp (s) of the first frame
   * @param {number} sr sample rate of `data`
   *
   * Calls must arrive in ascending `t0` order (mediabunny's sink is
   * monotonic); a bucket revisited later is overwritten, not merged.
   */
  addFrames(data, channels, t0, sr) {
    const frames = Math.floor(data.length / channels);
    for (let f = 0; f < frames; f++) {
      const b = Math.floor((t0 + f / sr) * PEAK_RATE);
      if (b !== this._bucket) { this._flush(); this._bucket = b; }
      let max = 0, sq = 0;
      for (let c = 0; c < channels; c++) {
        const v = data[f * channels + c];
        const a = v < 0 ? -v : v;
        if (a > max) max = a;
        sq += v * v;
      }
      if (max > this._max) this._max = max;
      this._sumSq += sq / channels;
      this._n += 1;
    }
  }

  _flush() {
    if (this._n && this._bucket >= 0 && this._bucket < this.length) {
      this.peak[this._bucket] = Math.min(255, Math.round(this._max * 255));
      this.rms[this._bucket] = rmsToByte(Math.sqrt(this._sumSq / this._n));
      this.filled = Math.max(this.filled, this._bucket + 1);
    }
    this._max = 0; this._sumSq = 0; this._n = 0;
  }

  /** The live arrays (they fill in place), for progressive drawing. */
  live() {
    return { peak: this.peak, rms: this.rms, rate: PEAK_RATE, length: this.length, filled: this.filled };
  }

  finish() {
    this._flush();
    this._bucket = -1;
    return this.live();
  }
}

/**
 * Stream-decode through mediabunny. Yields to the event loop every ~100 ms
 * so the timeline can paint partial peaks; onProgress gets seconds done.
 * Contract: resolves null when `signal` aborts (the caller must discard it);
 * rejects when nothing at all could be decoded; and when the decoder throws
 * mid-stream it resolves with the buckets computed so far plus
 * `partial: true` and `error` (spec §5.3: keep what was decoded). Everything
 * past `filled` is unanalysed, which detectSilence must be told via
 * `filled`.
 */
export async function computePeaks(mb, opened, onProgress, signal) {
  const builder = new PeakBuilder(opened.duration, opened.sampleRate);
  const sink = new mb.AudioSampleSink(opened.track);
  let lastYield = performance.now();
  let buf = null;   // reused across samples: a fresh array per sample is gigabytes of churn on a long file
  let error = null;
  try {
    for await (const sample of sink.samples()) {
      try {
        if (signal?.aborted) break;
        const ch = sample.numberOfChannels;
        const need = sample.numberOfFrames * ch;
        if (!buf || buf.length < need) buf = new Float32Array(need);
        const view = buf.subarray(0, need);
        sample.copyTo(view, { planeIndex: 0, format: 'f32' });
        builder.addFrames(view, ch, sample.timestamp, sample.sampleRate);
      } finally {
        sample.close();
      }
      if (onProgress) onProgress(builder.filled / PEAK_RATE, builder.live());
      if (performance.now() - lastYield > 100) {
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
  } catch (e) {
    error = e;
  }
  if (signal?.aborted) return null;
  const out = builder.finish();
  if (error) {
    if (!out.filled) throw error;
    out.partial = true;
    out.error = error;
  }
  return out;
}

/** For the decodeAudioData fallback: planar channel arrays (AudioBuffer.getChannelData). */
export function peaksFromPlanar(channels, sampleRate, duration) {
  const n = channels[0].length;
  const builder = new PeakBuilder(duration, sampleRate);
  const CHUNK = 65536;
  const inter = new Float32Array(CHUNK * channels.length);
  for (let off = 0; off < n; off += CHUNK) {
    const len = Math.min(CHUNK, n - off);
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      for (let i = 0; i < len; i++) inter[i * channels.length + c] = src[off + i];
    }
    builder.addFrames(inter.subarray(0, len * channels.length), channels.length, off / sampleRate, sampleRate);
  }
  return builder.finish();
}
