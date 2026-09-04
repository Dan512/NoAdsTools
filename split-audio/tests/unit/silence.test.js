import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectSilence } from '../../js/silence.js';
import { dbToByte, computePeaks, PEAK_RATE } from '../../js/peaks.js';
import { openAudio } from '../../js/engine.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const mb = await import('../../../vendor/mediabunny/mediabunny.min.mjs');
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// Synthetic RMS at 100 buckets/s: loud = -20 dB byte, quiet = -70 dB byte.
const LOUD = dbToByte(-20), QUIET = dbToByte(-70);
function rmsOf(spec) { // spec: [[seconds, byte], ...]
  const out = [];
  for (const [sec, byte] of spec) for (let i = 0; i < sec * 100; i++) out.push(byte);
  return Uint8Array.from(out);
}

test('one gap: a single cut at its centre', () => {
  const rms = rmsOf([[1, LOUD], [1.5, QUIET], [1, LOUD]]);
  const cuts = detectSilence(rms, 100, 3.5, { thresholdDb: -40, minGapSec: 1 });
  assert.equal(cuts.length, 1);
  near(cuts[0], 1.75, 0.011);
});

test('a gap shorter than minGapSec is ignored', () => {
  const rms = rmsOf([[1, LOUD], [0.5, QUIET], [1, LOUD]]);
  assert.deepEqual(detectSilence(rms, 100, 2.5, { thresholdDb: -40, minGapSec: 1 }), []);
  assert.equal(detectSilence(rms, 100, 2.5, { thresholdDb: -40, minGapSec: 0.3 }).length, 1);
});

test('gaps touching the start or end of the file produce no cut', () => {
  const rms = rmsOf([[2, QUIET], [1, LOUD], [2, QUIET]]);
  assert.deepEqual(detectSilence(rms, 100, 5, { thresholdDb: -40, minGapSec: 1 }), []);
});

test('the threshold is a dB comparison on the byte scale', () => {
  const rms = rmsOf([[1, LOUD], [1.5, dbToByte(-45)], [1, LOUD]]);
  assert.equal(detectSilence(rms, 100, 3.5, { thresholdDb: -40, minGapSec: 1 }).length, 1);
  assert.equal(detectSilence(rms, 100, 3.5, { thresholdDb: -50, minGapSec: 1 }).length, 0);
});

test('no gaps, no cuts; multiple gaps, one cut each', () => {
  assert.deepEqual(detectSilence(rmsOf([[3, LOUD]]), 100, 3, {}), []);
  const rms = rmsOf([[1, LOUD], [1, QUIET], [1, LOUD], [2, QUIET], [1, LOUD]]);
  const cuts = detectSilence(rms, 100, 6, { thresholdDb: -40, minGapSec: 1 });
  assert.equal(cuts.length, 2); near(cuts[0], 1.5, 0.011); near(cuts[1], 4, 0.011);
});

test('real fixture: tone-gap-tone.wav has exactly one gap, centred near 1.75 s', async () => {
  const opened = await openAudio(mb, new File([readFileSync(resolve(__dir, '../fixtures/tone-gap-tone.wav'))], 'g.wav'));
  const p = await computePeaks(mb, opened, null);
  const cuts = detectSilence(p.rms, PEAK_RATE, opened.duration, { thresholdDb: -40, minGapSec: 1 });
  assert.equal(cuts.length, 1);
  near(cuts[0], 1.75, 0.05);
});

test('buckets past `filled` are unknown, not silent', () => {
  const rms = rmsOf([[1, LOUD], [1.5, 0], [1, LOUD]]);
  assert.equal(detectSilence(rms, 100, 3.5, { thresholdDb: -40, minGapSec: 1 }).length, 1, 'without filled the zeros read as a gap');
  assert.deepEqual(detectSilence(rms, 100, 3.5, { thresholdDb: -40, minGapSec: 1, filled: 100 }), [], 'with filled they are ignored');
});

test('a quiet run at the start does not stop a later gap from being found', () => {
  const rms = rmsOf([[0.5, QUIET], [1, LOUD], [1.5, QUIET], [1, LOUD]]);
  const cuts = detectSilence(rms, 100, 4, { thresholdDb: -40, minGapSec: 1 });
  assert.equal(cuts.length, 1); near(cuts[0], 2.25, 0.011);
});
