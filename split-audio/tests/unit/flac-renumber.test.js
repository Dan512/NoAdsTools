// Pins against the real fixture: its first frame header is
// ff f8 a9 88 00 e6 (sync, fixed blocking; 1024-sample blocks @ 44.1 kHz;
// frame number 0; CRC-8 0xe6), measured 2026-09-03.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { utf8Length, utf8Encode, crc8, crc16, readFlacFrameNumber, renumberFlacFrame } from '../../js/flac-renumber.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const mb = await import('../../../vendor/mediabunny/mediabunny.min.mjs');

async function framesOf(name) {
  const file = new File([readFileSync(resolve(__dir, '../fixtures', name))], name);
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  const sink = new mb.EncodedPacketSink(track);
  const out = [];
  for (let p = await sink.getFirstPacket(); p; p = await sink.getNextPacket(p)) out.push(p.data);
  return out;
}

test('utf8Encode/utf8Length round-trip the FLAC extended UTF-8 number', () => {
  for (const n of [0, 1, 0x7F, 0x80, 0x7FF, 0x800, 0xFFFF, 0x10000, 0x1FFFFF, 0x200000, 0x3FFFFFF, 0x4000000, 0x7FFFFFFF, 2 ** 35]) {
    const bytes = utf8Encode(n);
    assert.equal(utf8Length(bytes[0]), bytes.length, `length for ${n}`);
    assert.equal(readFlacFrameNumber(new Uint8Array([0xFF, 0xF8, 0, 0, ...bytes, 0])), n, `decode ${n}`);
  }
});

test('crc8 and crc16 match the CRCs the encoder wrote into the fixture', async () => {
  const [f0] = await framesOf('tone-3s.flac');
  assert.deepEqual([...f0.subarray(0, 6)], [0xff, 0xf8, 0xa9, 0x88, 0x00, 0xe6]);
  assert.equal(crc8(f0, 5), 0xe6);
  assert.equal(crc16(f0, f0.length - 2), (f0[f0.length - 2] << 8) | f0[f0.length - 1]);
});

test('renumberFlacFrame rewrites the number and both CRCs, and is a no-op when the number already matches', async () => {
  const frames = await framesOf('tone-3s.flac');
  const f44 = frames[44];
  assert.equal(readFlacFrameNumber(f44), 44);
  const r = renumberFlacFrame(f44, 0, 0);
  assert.equal(readFlacFrameNumber(r), 0);
  assert.equal(r.length, f44.length, 'frame 44 and frame 0 both take one UTF-8 byte');
  assert.equal(crc8(r, 5), r[5]);
  assert.equal(crc16(r, r.length - 2), (r[r.length - 2] << 8) | r[r.length - 1]);
  assert.deepEqual(r.subarray(6, r.length - 2), f44.subarray(6, f44.length - 2), 'audio payload untouched');
  assert.equal(renumberFlacFrame(frames[0], 0, 0), frames[0], 'same object back when nothing changes');
  // A number that needs more bytes grows the header.
  const big = renumberFlacFrame(f44, 200, 0);
  assert.equal(readFlacFrameNumber(big), 200);
  assert.equal(big.length, f44.length + 1);
  assert.equal(crc8(big, 6), big[6]);
});

test('renumberFlacFrame leaves non-frame data alone', () => {
  const junk = new Uint8Array([1, 2, 3]);
  assert.equal(renumberFlacFrame(junk, 5, 0), junk);
});

test('the fixture\'s last frames: two-byte numbers, and a block-size code that adds a header byte', async () => {
  const frames = await framesOf('tone-3s.flac');
  assert.equal(readFlacFrameNumber(frames[128]), 128, 'the encoder\'s own two-byte form');
  assert.equal(readFlacFrameNumber(frames[129]), 129);
  assert.equal(frames[129][2] >> 4, 6, 'last block: block-size code 6, one extra header byte');
  const tail = renumberFlacFrame(frames[129], 0, 0);
  assert.equal(readFlacFrameNumber(tail), 0);
  assert.equal(tail.length, frames[129].length - 1, 'a two-byte number shrinks to one');
  assert.equal(tail[5], frames[129][6], 'block-size byte relocated');
  assert.equal(crc8(tail, 6), tail[6]);
  assert.equal(crc16(tail, tail.length - 2), (tail[tail.length - 2] << 8) | tail[tail.length - 1]);
  assert.deepEqual(tail.subarray(7, tail.length - 2), frames[129].subarray(8, frames[129].length - 2), 'audio payload untouched');
});

test('a variable-blocksize frame takes the sample offset, not the frame index, and relocates its extra header bytes', () => {
  // sync 0xFFF9 (variable blocking), block-size code 7 (two extra bytes), number 5, four payload bytes.
  const syn = new Uint8Array([0xFF, 0xF9, 0x79, 0x88, 0x05, 0x12, 0x34, 0x00, 9, 8, 7, 6, 0, 0]);
  syn[7] = crc8(syn, 7);
  const c = crc16(syn, syn.length - 2);
  syn[syn.length - 2] = c >> 8;
  syn[syn.length - 1] = c & 0xFF;
  assert.equal(readFlacFrameNumber(syn), 5);
  const r = renumberFlacFrame(syn, 3, 1000);
  assert.equal(readFlacFrameNumber(r), 1000, 'variable blocking: the sample offset');
  assert.equal(r.length, syn.length + 1, '1000 takes two UTF-8 bytes');
  assert.deepEqual([r[6], r[7]], [0x12, 0x34], 'extra header bytes relocated');
  assert.equal(crc8(r, 8), r[8]);
  assert.equal(crc16(r, r.length - 2), (r[r.length - 2] << 8) | r[r.length - 1]);
  assert.deepEqual([...r.subarray(9, r.length - 2)], [9, 8, 7, 6]);
  assert.equal(renumberFlacFrame(syn, 99, 5), syn, 'frame index ignored; same sample offset: same object');
});

test('MP3 sync words, invalid lead bytes and truncated headers are not FLAC frames', () => {
  const mp3 = new Uint8Array([0xFF, 0xFB, 0x50, 0x64, 0x00, 0x00, 0x01, 0x8f, 1, 2, 3, 4]);
  assert.equal(renumberFlacFrame(mp3, 1, 1152), mp3);
  assert.equal(readFlacFrameNumber(mp3), -1);
  const cont = new Uint8Array([0xFF, 0xF8, 0xa9, 0x88, 0x80, 0x00]);
  assert.equal(readFlacFrameNumber(cont), -1, 'continuation byte as lead');
  assert.equal(renumberFlacFrame(cont, 5, 0), cont);
  assert.equal(readFlacFrameNumber(new Uint8Array([0xFF, 0xF8, 0xa9, 0x88, 0x00])), -1, 'too short for CRCs');
  const short = new Uint8Array([0xFF, 0xF8, 0x00, 0x00, 0x05, 0x00]);
  assert.equal(renumberFlacFrame(short, 0, 0), short, 'too short to hold both CRCs');
  assert.equal(utf8Length(0x80), 0);
  assert.equal(utf8Length(0xFF), 0);
  assert.equal(utf8Length(0xFE), 7);
});
