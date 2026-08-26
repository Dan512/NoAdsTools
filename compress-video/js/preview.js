// compress-video/js/preview.js — encode short sample segments at the exact
// bitrate/resolution the plan would use, so the user sees real output
// pixels before committing to the full encode. Hardware encoding makes each
// ~1 s sample roughly a second of work.
import { loadMediabunny } from './engine.js';

// Fractions of the duration to sample: early, middle, late.
export const SAMPLE_POINTS = Object.freeze([0.1, 0.5, 0.9]);

/**
 * Encode ~`sampleSec` starting at `startSec` with the plan's settings.
 * Audio is discarded — the preview question is about pixels, and dropping
 * it keeps samples fast.
 * @returns {Promise<Blob>} a small MP4 of just that segment
 */
export async function encodeSample(file, plan, startSec, sampleSec = 1) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat(),
    target: new mb.BufferTarget(),
  });
  const conversion = await mb.Conversion.init({
    input, output,
    trim: { start: startSec, end: startSec + sampleSec },
    video: {
      quality: new mb.Quality({ bitrate: plan.videoBitrate }),
      width: plan.out.width,
      height: plan.out.height,
      fit: 'contain',
      ...(plan.outFps ? { frameRate: plan.outFps } : {}),
    },
    audio: { discard: true },
  });
  await conversion.execute();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
