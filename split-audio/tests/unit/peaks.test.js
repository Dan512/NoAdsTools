// PeakBuilder is pure and gets synthetic input. computePeaks then runs for
// real on the WAV fixtures (PCM decodes in Node through mediabunny's
// built-in decoder; compressed codecs need WebCodecs and are covered by the
// browser spec). The dB byte scale is pinned because a linear byte scale
// would put -40 dB at 2.55 and silence detection would be useless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openAudio } from '../../js/engine.js';
import { PEAK_RATE, dbToByte, rmsToByte, PeakBuilder, computePeaks, peaksFromPlanar } from '../../js/peaks.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const mb = await import('../../../vendor/mediabunny/mediabunny.min.mjs');
const fixture = (name) => new File([readFileSync(resolve(__dir, '../fixtures', name))], name);

test('dbToByte maps -90..0 dBFS onto 0..255 with 0.35 dB steps', () => {
  assert.equal(dbToByte(0), 255);
  assert.equal(dbToByte(-90), 0);
  assert.equal(dbToByte(-40), 142);
  assert.equal(dbToByte(-60), 85);
  assert.equal(dbToByte(-120), 0);
  assert.equal(dbToByte(6), 255);
  assert.equal(rmsToByte(0), 0);
  assert.equal(rmsToByte(1), 255);
});

test('PeakBuilder buckets at PEAK_RATE, folds channels by max (peak) and mean-square (rms)', () => {
  const sr = 1000;
  const b = new PeakBuilder(1, sr);            // 100 buckets of 10 frames
  assert.equal(b.length, PEAK_RATE);
  // A stereo signal whose channels cancel: mono averaging would read silence.
  const frames = 1000;
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) { const v = 0.5 * Math.sin(2 * Math.PI * 50 * i / sr); data[2 * i] = v; data[2 * i + 1] = -v; }
  // Feed in odd-sized pieces so pieces straddle bucket edges.
  let t = 0;
  for (let off = 0; off < frames; off += 37) {
    const n = Math.min(37, frames - off);
    b.addFrames(data.subarray(off * 2, (off + n) * 2), 2, off / sr, sr);
    t += n;
  }
  const { peak, rms, filled } = b.finish();
  assert.equal(filled, 100);
  assert.ok(peak.every((p) => p >= 120 && p <= 128), `peak bytes ${peak.slice(0, 5)}`);
  const expectRms = rmsToByte(0.5 / Math.SQRT2);   // sine RMS = amp/sqrt2
  assert.ok(rms.every((r) => Math.abs(r - expectRms) <= 3), `rms bytes ${rms.slice(0, 5)} vs ${expectRms}`);
});

test('PeakBuilder leaves untouched buckets at 0 and reports filled progress', () => {
  const b = new PeakBuilder(2, 100);
  b.addFrames(new Float32Array(100).fill(0.25), 1, 0, 100);   // first second only
  assert.equal(b.finish().filled, 100);
  const { peak } = b.finish();
  assert.equal(peak[50], 64);
  assert.equal(peak[150], 0);
});

test('peaksFromPlanar (decodeAudioData fallback) matches PeakBuilder', () => {
  const sr = 100;
  const left = new Float32Array(200).fill(0.5), right = new Float32Array(200).fill(-0.5);
  const p = peaksFromPlanar([left, right], sr, 2);
  assert.equal(p.filled, 200);
  assert.equal(p.peak[10], 128);
});

test('computePeaks on the tone-gap-tone fixture: quiet in the gap, loud outside', async () => {
  const opened = await openAudio(mb, fixture('tone-gap-tone.wav'));
  let lastProgress = 0;
  const p = await computePeaks(mb, opened, (s) => { lastProgress = s; });
  assert.equal(p.rate, PEAK_RATE);
  assert.equal(p.length, Math.ceil(3.5 * PEAK_RATE));
  assert.ok(lastProgress >= 3.4, `progress reached ${lastProgress}`);
  const at = (sec) => p.rms[Math.floor(sec * PEAK_RATE)];
  assert.ok(at(0.5) > dbToByte(-40), `tone 1 rms byte ${at(0.5)}`);
  assert.ok(at(1.7) < dbToByte(-60), `gap rms byte ${at(1.7)}`);
  assert.ok(at(3.0) > dbToByte(-40), `tone 2 rms byte ${at(3.0)}`);
  // ffmpeg's sine source is 1/8 full scale and the mono-to-stereo upmix is
  // another -3 dB: measured on the raw WAV, max |sample| is 2896 of 32768, so
  // amplitude 0.088 and peak byte 23. (The plan's '> 60' assumed a full-scale tone.)
  assert.ok(p.peak[50] >= 20 && p.peak[50] <= 26, `tone 1 peak byte ${p.peak[50]}, expected about 23`);
  assert.equal(p.peak[170], 0, 'gap peak byte');
});

test('PeakBuilder drops frames before 0 and past the duration, and reports a finite length for a bad duration', () => {
  const b = new PeakBuilder(1, 100);
  b.addFrames(new Float32Array(50).fill(0.5), 1, -1, 100);   // AAC priming lands before 0 (t spans -1..-0.51)
  b.addFrames(new Float32Array(50).fill(0.5), 1, 1.2, 100);  // past the end (t spans 1.2..1.69)
  const { peak, filled } = b.finish();
  assert.equal(filled, 0);
  assert.ok(peak.every((v) => v === 0));
  assert.equal(new PeakBuilder(NaN, 100).length, 1);
});

// A fake mediabunny module whose sink yields two 0.5 s samples and then behaves as told.
function fakeMb({ throwAfter = Infinity, throwFirst = false } = {}) {
  const closed = [];
  const sample = (t) => ({
    numberOfChannels: 1, numberOfFrames: 50, timestamp: t, sampleRate: 100,
    copyTo(buf) { buf.fill(0.5); },
    close() { closed.push(t); },
  });
  return {
    closed,
    AudioSampleSink: class {
      async *samples() {
        if (throwFirst) throw new Error('decoder failed at once');
        for (let i = 0; i < 2; i++) {
          if (i >= throwAfter) throw new Error('decoder failed mid-stream');
          yield sample(i * 0.5);
        }
        if (throwAfter !== Infinity) throw new Error('decoder failed mid-stream');
      }
    },
  };
}
const fakeOpened = { duration: 2, sampleRate: 100, track: {} };

test('computePeaks keeps the buckets computed before a mid-stream decoder failure and closes every sample', async () => {
  const mb = fakeMb({ throwAfter: 2 });
  const p = await computePeaks(mb, fakeOpened, null);
  assert.equal(p.partial, true);
  assert.equal(p.error.message, 'decoder failed mid-stream');
  assert.equal(p.filled, 100, 'two 0.5 s samples analysed');
  assert.equal(p.peak[10], 128);
  assert.equal(p.peak[150], 0, 'unanalysed');
  assert.deepEqual(mb.closed, [0, 0.5]);
});

test('computePeaks rejects when nothing could be decoded', async () => {
  await assert.rejects(computePeaks(fakeMb({ throwFirst: true }), fakeOpened, null), /decoder failed at once/);
});

test('computePeaks resolves null when aborted, and still closes the sample it was holding', async () => {
  const mb = fakeMb();
  const ctl = new AbortController();
  ctl.abort();
  assert.equal(await computePeaks(mb, fakeOpened, null, ctl.signal), null);
  assert.deepEqual(mb.closed, [0]);
});
