// The real fixture's OpusHead, measured 2026-09-03: 19 bytes, version 1,
// 2 channels, pre-skip 312, input rate 48000, gain 0, mapping family 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { OPUS_RATE, asBytes, isOpusHead, readOpusPreSkip, patchOpusPreSkip } from '../../js/opus-head.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const mb = await import('../../../vendor/mediabunny/mediabunny.min.mjs');

async function opusHeadOf(name) {
  const file = new File([readFileSync(resolve(__dir, '../fixtures', name))], name);
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  return (await track.getDecoderConfig()).description;
}
const head = await opusHeadOf('tone-3s.ogg');

test('mediabunny hands us the OpusHead as decoderConfig.description', () => {
  assert.ok(head instanceof Uint8Array);
  assert.equal(head.length, 19);
  assert.equal(new TextDecoder().decode(head.subarray(0, 8)), 'OpusHead');
  assert.ok(isOpusHead(head));
  assert.equal(readOpusPreSkip(head), 312);
  assert.equal(head[9], 2, 'channel count');
  assert.equal(head[12] | (head[13] << 8) | (head[14] << 16) | (head[15] << 24), OPUS_RATE, 'input sample rate');
});

test('patchOpusPreSkip writes bytes 10-11 little-endian and leaves everything else, including the input, alone', () => {
  const p = patchOpusPreSkip(head, 19200);
  assert.equal(readOpusPreSkip(p), 19200);
  assert.deepEqual([p[10], p[11]], [0x00, 0x4B]);
  assert.equal(readOpusPreSkip(head), 312, 'input not mutated');
  assert.deepEqual([...p.subarray(0, 10)], [...head.subarray(0, 10)]);
  assert.deepEqual([...p.subarray(12)], [...head.subarray(12)]);
  assert.equal(readOpusPreSkip(patchOpusPreSkip(head, 1e9)), 0xFFFF, 'clamped to u16');
  assert.equal(readOpusPreSkip(patchOpusPreSkip(head, -5)), 0);
});

test('non-OpusHead bytes pass through untouched and read as -1', () => {
  const junk = new Uint8Array([1, 2, 3]);
  assert.equal(patchOpusPreSkip(junk, 5), junk);
  assert.equal(readOpusPreSkip(junk), -1);
  assert.equal(isOpusHead(null), false);
});

test('asBytes accepts Uint8Array, ArrayBuffer and DataView', () => {
  const buf = head.slice().buffer;
  assert.equal(readOpusPreSkip(buf), 312);
  assert.equal(readOpusPreSkip(new DataView(buf)), 312);
  assert.equal(asBytes(head), head);
  assert.equal(asBytes('nope'), null);
});
