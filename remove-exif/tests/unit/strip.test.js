// remove-exif/tests/unit/strip.test.js — the surgical stripper. The oracle is
// shared/exif.js hasMetadata() (independent parser); plus byte-identity of the
// image payload (JPEG: SOS-onward; PNG: IDAT; WebP: VP8 chunk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMetadata } from '../../../shared/exif.js';
import { stripImage } from '../../js/strip.js';
import { buildReport } from '../../js/report.js';
import { makeJpegWithMetadata, makeJpegWithTrailing, makePngWithMetadata, makePngWithTrailing, makeWebpWithMetadata, makeHeicBytes } from './fixtures.js';

const blob = (u8) => new Blob([u8]);
const find = (hay, needle) => {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

test('JPEG: fixture has metadata; stripped output is clean and same format', async () => {
  const src = makeJpegWithMetadata();
  const before = await hasMetadata(blob(src));
  assert.equal(before.exif, true);
  assert.equal(before.gps, true);
  const r = stripImage(src);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'jpeg');
  const after = await hasMetadata(blob(r.bytes));
  assert.equal(after.exif, false);
  assert.equal(after.xmp, false);
  assert.equal(after.gps, false);
});

test('JPEG: scan data (SOS onward) is byte-identical; JFIF kept; COM dropped', () => {
  const src = makeJpegWithMetadata();
  const r = stripImage(src);
  const sosSrc = find(src, [0xFF, 0xDA]);
  const sosOut = find(r.bytes, [0xFF, 0xDA]);
  assert.ok(sosSrc > 0 && sosOut > 0);
  assert.deepEqual([...r.bytes.slice(sosOut)], [...src.slice(sosSrc)]);
  assert.ok(find(r.bytes, [0xFF, 0xE0]) !== -1, 'APP0/JFIF kept');
  assert.equal(find(r.bytes, [0xFF, 0xFE]), -1, 'COM dropped');
  assert.equal(find(r.bytes, [0xFF, 0xED]), -1, 'APP13 dropped');
});

test('PNG: metadata chunks dropped, IDAT byte-identical, gAMA kept', async () => {
  const src = makePngWithMetadata();
  const r = stripImage(src);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'png');
  const enc = (s) => [...new TextEncoder().encode(s)];
  for (const gone of ['tEXt', 'eXIf', 'tIME']) assert.equal(find(r.bytes, enc(gone)), -1, gone + ' dropped');
  for (const kept of ['IHDR', 'gAMA', 'IDAT', 'IEND']) assert.ok(find(r.bytes, enc(kept)) !== -1, kept + ' kept');
  // IDAT chunk byte-identical: len(4)+type(4)+data(6)+crc(4) = 18 bytes.
  const idatSrc = find(src, enc('IDAT'));
  const idatOut = find(r.bytes, enc('IDAT'));
  assert.deepEqual(
    [...r.bytes.slice(idatOut - 4, idatOut - 4 + 18)],
    [...src.slice(idatSrc - 4, idatSrc - 4 + 18)],
    'IDAT chunk byte-identical');
  const after = await hasMetadata(blob(r.bytes));
  assert.equal(after.exif, false);
});

test('WebP: EXIF/XMP chunks dropped, VP8 payload identical, VP8X flags cleared, RIFF size fixed', async () => {
  const src = makeWebpWithMetadata();
  const r = stripImage(src);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'webp');
  const enc = (s) => [...new TextEncoder().encode(s)];
  assert.equal(find(r.bytes, enc('EXIF')), -1);
  assert.equal(find(r.bytes, enc('XMP ')), -1);
  const vp8Src = find(src, enc('VP8 '));
  const vp8Out = find(r.bytes, enc('VP8 '));
  assert.deepEqual([...r.bytes.slice(vp8Out)], [...src.slice(vp8Src)], 'VP8 chunk onward identical');
  const vp8xOut = find(r.bytes, enc('VP8X'));
  assert.equal(r.bytes[vp8xOut + 8] & 0x0C, 0, 'EXIF|XMP flag bits cleared');
  const riffSize = r.bytes[4] | (r.bytes[5] << 8) | (r.bytes[6] << 16) | (r.bytes[7] << 24);
  assert.equal(riffSize, r.bytes.length - 8, 'RIFF size matches');
  const after = await hasMetadata(blob(r.bytes));
  assert.equal(after.exif, false);
  assert.equal(after.xmp, false);
});

test('already-clean input passes through parseable and clean', async () => {
  const once = stripImage(makeJpegWithMetadata());
  const twice = stripImage(once.bytes);
  assert.equal(twice.ok, true);
  assert.deepEqual([...twice.bytes], [...once.bytes], 'idempotent');
});

test('HEIC is refused with reason heic; garbage gets reason unrecognized', () => {
  assert.deepEqual(stripImage(makeHeicBytes()), { ok: false, reason: 'heic' });
  assert.deepEqual(stripImage(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), { ok: false, reason: 'unrecognized' });
});

test('JPEG: 0xFF fill bytes before a marker are skipped, not copied (lossless path)', () => {
  const src = makeJpegWithMetadata();
  const padded = new Uint8Array(src.length + 1);
  padded.set(src.subarray(0, 2), 0);
  padded[2] = 0xFF; // legal fill byte before the next marker (APP0)
  padded.set(src.subarray(2), 3);
  const r = stripImage(padded);
  assert.equal(r.ok, true, 'padded JPEG takes the lossless path, not parse-error');
  assert.deepEqual([...r.bytes], [...stripImage(src).bytes], 'fill byte dropped; output otherwise identical');
});

test('JPEG: motion-photo trailer after EOI is dropped and counted', async () => {
  const src = makeJpegWithTrailing();
  const r = stripImage(src);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'jpeg');
  assert.equal(r.trailing, 32);
  assert.deepEqual([...r.bytes.slice(-2)], [0xFF, 0xD9], 'output ends exactly at EOI');
  const after = await hasMetadata(blob(r.bytes));
  assert.equal(after.exif, false);
  assert.equal(after.xmp, false);
  assert.equal(after.gps, false);
});

test('no trailer: existing fixtures all report trailing: 0', () => {
  assert.equal(stripImage(makeJpegWithMetadata()).trailing, 0);
  assert.equal(stripImage(makePngWithMetadata()).trailing, 0);
  assert.equal(stripImage(makeWebpWithMetadata()).trailing, 0);
});

test('PNG: post-IEND trailer is dropped and counted exactly', async () => {
  const clean = stripImage(makePngWithMetadata());
  const r = stripImage(makePngWithTrailing());
  assert.equal(r.ok, true);
  assert.equal(r.trailing, 21);
  assert.deepEqual([...r.bytes], [...clean.bytes], 'output identical to trailer-free strip');
  const after = await hasMetadata(new Blob([r.bytes]));
  assert.equal(after.exif, false);
});

test('truncation never throws: every prefix of every fixture through strip AND report', () => {
  const fixtures = [makeJpegWithMetadata(), makeJpegWithTrailing(), makePngWithMetadata(), makePngWithTrailing(), makeWebpWithMetadata()];
  for (const fix of fixtures) {
    for (let n = 0; n <= fix.length; n++) {
      const prefix = fix.subarray(0, n);
      try { stripImage(prefix); } catch (e) { assert.fail(`stripImage threw at prefix ${n}/${fix.length}: ${e.message}`); }
      try { buildReport(prefix); } catch (e) { assert.fail(`buildReport threw at prefix ${n}/${fix.length}: ${e.message}`); }
    }
  }
});
