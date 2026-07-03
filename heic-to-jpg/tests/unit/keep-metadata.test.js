// heic-to-jpg/tests/unit/keep-metadata.test.js — the "Keep photo info" path,
// canvas-free: extract EXIF from a synthetic HEIC (shared/exif.js), inject it
// into a hand-built metadata-free JPEG, and verify presence/absence with the
// same detector the platform's privacy claims ride on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasMetadata,
  extractExifFromHeif,
  extractExifSegment,
  injectExifIntoJpeg,
} from '../../../shared/exif.js';
import { makeHeicWithExif, makeHeicNoExif, makeCleanJpeg, buildTiff } from './fixtures.js';

test('extractExifFromHeif finds the Exif item and frames it as a JPEG APP1 segment', async () => {
  const seg = await extractExifFromHeif(new Blob([makeHeicWithExif()]));
  assert.ok(seg, 'expected a segment');
  // APP1 marker + length field.
  assert.equal(seg[0], 0xFF);
  assert.equal(seg[1], 0xE1);
  // "Exif\0\0" header after marker + length.
  assert.equal(String.fromCharCode(...seg.slice(4, 10)), 'Exif\0\0');
  // Length field = payload + itself: segment total = 2 (marker) + length.
  const lenField = (seg[2] << 8) | seg[3];
  assert.equal(seg.length, 2 + lenField);
  // TIFF payload carried through byte-for-byte.
  const tiff = buildTiff();
  assert.deepEqual([...seg.slice(10)], [...tiff]);
});

test('extractExifFromHeif returns null when the HEIC has no metadata', async () => {
  const seg = await extractExifFromHeif(new Blob([makeHeicNoExif()]));
  assert.equal(seg, null);
});

test('keep OFF (control): a plain converted JPEG carries no EXIF/GPS', async () => {
  const verdict = await hasMetadata(new Blob([makeCleanJpeg()], { type: 'image/jpeg' }));
  assert.equal(verdict.format, 'jpeg');
  assert.equal(verdict.exif, false);
  assert.equal(verdict.gps, false);
});

test('keep ON: injecting the extracted segment makes EXIF + GPS detectable', async () => {
  const seg = await extractExifFromHeif(new Blob([makeHeicWithExif()]));
  const out = await injectExifIntoJpeg(new Blob([makeCleanJpeg()], { type: 'image/jpeg' }), seg);
  const verdict = await hasMetadata(out);
  assert.equal(verdict.format, 'jpeg');
  assert.equal(verdict.exif, true);
  assert.equal(verdict.gps, true, 'GPSInfo pointer must survive the round trip');
});

test('round trip: the segment extracted back out of the injected JPEG is identical', async () => {
  const seg = await extractExifFromHeif(new Blob([makeHeicWithExif()]));
  const out = await injectExifIntoJpeg(new Blob([makeCleanJpeg()], { type: 'image/jpeg' }), seg);
  const back = await extractExifSegment(out);
  assert.ok(back, 'expected to re-extract the segment');
  assert.deepEqual([...back], [...seg]);
});

test('inject is a safe no-op with a null/empty segment (the "none found" path)', async () => {
  const jpeg = new Blob([makeCleanJpeg()], { type: 'image/jpeg' });
  assert.equal(await injectExifIntoJpeg(jpeg, null), jpeg);
  const verdict = await hasMetadata(jpeg);
  assert.equal(verdict.exif, false);
});
