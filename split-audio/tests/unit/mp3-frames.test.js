// Pins against the real fixture (64 kbps joint-stereo MPEG-1 Layer III from
// LAME via ffmpeg, no CRC), measured 2026-09-03: 116 packets; frame 40 is
// 209 bytes with header ff fb 52 64, main_data_begin = 504 (the reservoir
// sits nearly full on a pure tone), and only the mid channel carries bits
// (part2_3_length 749 and 578, the side channel 0). Synthetic 100-byte
// frames (64 bytes of main data each) pin the reservoir arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  MP3_KEEP_INTACT, parseMp3Header, getBits, setBits, readSideInfo, crc16Mpeg, mp3FrameCrc,
  silenceMp3Frame, mp3Preroll,
} from '../../js/mp3-frames.js';

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
const frames = await framesOf('tone-3s.mp3');

/** A fake MPEG-1 Layer III stereo frame without CRC: 100 bytes, so 64 bytes of main data. */
function fakeFrame(mainDataBegin) {
  const d = new Uint8Array(100);
  d.set([0xFF, 0xFB, 0x52, 0x64]);
  setBits(d, 4, 0, 9, mainDataBegin);
  return d;
}

test('parseMp3Header reads the fixture header and rejects non-frames and reserved values', () => {
  assert.equal(frames.length, 116);
  assert.deepEqual(parseMp3Header(frames[40]), {
    mpeg1: true, layer3: true, crc: false, mono: false, channels: 2,
    headerLen: 4, sideInfoLen: 32, mainDataOffset: 36, mainDataBytes: 173, mdbBits: 9,
  });
  assert.equal(parseMp3Header(new Uint8Array([1, 2, 3, 4])), null, 'no sync');
  assert.equal(parseMp3Header(new Uint8Array([0xFF, 0xEB, 0x52, 0x64])), null, 'reserved version');
  assert.equal(parseMp3Header(new Uint8Array([0xFF, 0xF9, 0x52, 0x64])), null, 'reserved layer');
  // MPEG-2 (LSF) mono Layer III without CRC: 9 bytes of side info, 8-bit main_data_begin.
  assert.deepEqual(parseMp3Header(new Uint8Array([0xFF, 0xF3, 0x52, 0xC4])), {
    mpeg1: false, layer3: true, crc: false, mono: true, channels: 1,
    headerLen: 4, sideInfoLen: 9, mainDataOffset: 13, mainDataBytes: 0, mdbBits: 8,
  });
});

test('readSideInfo pins the fixture side info', () => {
  const si = readSideInfo(frames[40]);
  assert.equal(si.mainDataBegin, 504);
  assert.deepEqual(si.part23Lengths, [749, 0, 578, 0]);
  assert.deepEqual(si.bigValues, [43, 0, 17, 0]);
  assert.equal(readSideInfo(frames[1]).mainDataBegin, 30);
  assert.equal(readSideInfo(new Uint8Array([0xFF, 0xFB, 0x52, 0x64, 0, 0])), null, 'side info incomplete');
});

test('getBits and setBits round-trip a field that straddles byte boundaries', () => {
  const d = new Uint8Array(8);
  setBits(d, 2, 5, 12, 0xABC);
  assert.equal(getBits(d, 2, 5, 12), 0xABC);
  setBits(d, 2, 5, 12, 0);
  assert.deepEqual([...d], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('crc16Mpeg is CRC-16/CMS: polynomial 0x8005, initial value 0xFFFF', () => {
  assert.equal(crc16Mpeg(new TextEncoder().encode('123456789')), 0xAEE7);
});

test('silenceMp3Frame zeroes main_data_begin, part2_3_length, big_values and scalefac_compress and nothing else', () => {
  const f = frames[40];
  const s = silenceMp3Frame(f);
  assert.notEqual(s, f);
  assert.equal(s.length, f.length);
  assert.deepEqual([...s.subarray(0, 4)], [...f.subarray(0, 4)], 'header untouched');
  assert.deepEqual(s.subarray(36), f.subarray(36), 'main data untouched');
  const si = readSideInfo(s);
  assert.equal(si.mainDataBegin, 0);
  assert.deepEqual(si.part23Lengths, [0, 0, 0, 0]);
  assert.deepEqual(si.bigValues, [0, 0, 0, 0]);
  // readSideInfo doesn't expose scalefac_compress, so check the 4-bit field
  // directly: it sits 29 bits into each 59-bit granule/channel block, which
  // itself starts 20 bits (stereo) after the side-info header.
  for (let k = 0; k < 4; k++) {
    assert.equal(getBits(s, 4, 20 + k * 59 + 29, 4), 0, `scalefac_compress[${k}]`);
  }
  // Byte 4 holds main_data_begin, bytes 6-10 the first block's
  // part2_3_length, big_values and scalefac_compress, bytes 21-23 and 25 the
  // second granule's (byte 24 also carries a scalefac_compress bit, but that
  // particular bit was already 0, so it doesn't show up as changed). The
  // silent side channel's (k=1, k=3) scalefac_compress was already 0, so
  // those bytes don't move either. global_gain and the rest of the side info
  // stay as they were.
  const changed = [...s].map((b, i) => (b !== f[i] ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(changed, [4, 6, 7, 8, 9, 10, 21, 22, 23, 25]);
  const junk = new Uint8Array([1, 2, 3]);
  assert.equal(silenceMp3Frame(junk), junk, 'non-frame: same object back');
});

test('silenceMp3Frame recomputes the CRC-16 when the frame is protected', () => {
  // The same frame with the protection bit cleared and two CRC bytes inserted.
  const f = frames[40];
  const prot = new Uint8Array(f.length + 2);
  prot.set(f.subarray(0, 4));
  prot[1] &= ~1;
  prot.set(f.subarray(4), 6);
  assert.equal(parseMp3Header(prot).crc, true);
  assert.equal(parseMp3Header(prot).mainDataOffset, 38);
  const s = silenceMp3Frame(prot);
  assert.equal((s[4] << 8) | s[5], mp3FrameCrc(s));
  // 0x4372 once scalefac_compress is zeroed too; it was 0x9AAF when
  // silenceMp3Frame only zeroed part2_3_length and big_values.
  assert.equal(mp3FrameCrc(s), 0x4372);
  assert.equal(readSideInfo(s).mainDataBegin, 0);
});

// One-off, not a test that shells out: built a scratch MP3 from every
// fixture frame turned protected (CRC enabled, 2 bytes carved from the tail
// of that frame's own main data so total frame length still matches what
// its header declares) with frames 40-44 additionally run through
// silenceMp3Frame, then ran
//   ffmpeg -v error -err_detect crccheck -i scratch.mp3 -f null -
// Clean stream: no output, exit 0 — confirms mp3FrameCrc's coverage (header
// bytes 2-3 + side info) matches what ffmpeg's own CRC check expects, and
// that silenceMp3Frame's recomputed CRC (now covering the zeroed
// scalefac_compress bits too) still validates. Then flipped one bit inside
// frame 50's side info without recomputing its CRC: ffmpeg reported
// "CRC mismatch C386!" on stderr (still exit 0 — err_detect crccheck logs at
// error level but doesn't abort). Confirms ffmpeg is actually checking the
// bytes this module writes, not silently ignoring them. Verified 2026-09-03.

test('mp3Preroll on the fixture: three silent frames carry the 504-byte reservoir, two stay intact', () => {
  assert.equal(MP3_KEEP_INTACT, 2);
  assert.deepEqual(mp3Preroll(frames, 0), { count: 0, silent: 0 });
  assert.deepEqual(mp3Preroll(frames, 1), { count: 1, silent: 0 });
  assert.deepEqual(mp3Preroll(frames, 2), { count: 2, silent: 0 });
  assert.deepEqual(mp3Preroll(frames, 3), { count: 3, silent: 1 });
  assert.deepEqual(mp3Preroll(frames, 39), { count: 5, silent: 3 });
  assert.deepEqual(mp3Preroll(frames, 77), { count: 5, silent: 3 });
  assert.deepEqual(mp3Preroll(frames, 115), { count: 5, silent: 3 });
});

test('mp3Preroll arithmetic on synthetic frames', () => {
  // i0 = 7 keeps frames 5 and 6. Bytes needed before frame 5: frame 5 wants
  // 100, frame 6 wants 130 - 64 = 66, frame 8 wants 300 - 192 = 108. So 108,
  // which two silent frames (128 bytes) cover.
  const syn = [0, 0, 0, 0, 0, 100, 130, 0, 300, 0].map(fakeFrame);
  assert.deepEqual(mp3Preroll(syn, 7), { count: 4, silent: 2 });
  // A frame after the cut can reach further back (low bitrates): 400 - 192 = 208 needs four.
  assert.deepEqual(mp3Preroll([0, 0, 0, 0, 0, 100, 130, 0, 400, 0].map(fakeFrame), 7), { count: 6, silent: 4 });
  // No reservoir use at all: just the two kept frames.
  assert.deepEqual(mp3Preroll(syn.map(() => fakeFrame(0)), 7), { count: 2, silent: 0 });
  // Not enough history: keep what exists.
  assert.deepEqual(mp3Preroll(syn, 1), { count: 1, silent: 0 });
});
