// remove-exif/tests/unit/report.test.js — the "what we found" extractor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../../js/report.js';
import { makeJpegWithMetadata, makeJpegWithMetadataBE, makePngWithMetadata, makeWebpWithMetadata } from './fixtures.js';

test('JPEG report decodes GPS presence + camera fields', () => {
  const r = buildReport(makeJpegWithMetadata());
  assert.equal(r.format, 'jpeg');
  assert.equal(r.gps, true);
  assert.equal(r.make, 'TestCam');
  assert.equal(r.model, 'X100');
  assert.equal(r.software, 'FixKit');
  assert.equal(r.dateTime, '2019:12:31 23:59:58'); // DateTimeOriginal preferred over DateTime
  assert.ok(r.found.includes('EXIF'));
  assert.ok(r.found.includes('XMP'));
});

test('BE fixture also decodes software (symmetry with the LE assertions)', () => {
  assert.equal(buildReport(makeJpegWithMetadataBE()).software, 'FixKit');
});

test('PNG report lists metadata chunk types', () => {
  const r = buildReport(makePngWithMetadata());
  assert.equal(r.format, 'png');
  assert.deepEqual(r.found.sort(), ['eXIf', 'tEXt', 'tIME']);
  assert.equal(r.gps, false);
});

test('WebP report decodes the embedded EXIF TIFF', () => {
  const r = buildReport(makeWebpWithMetadata());
  assert.equal(r.format, 'webp');
  assert.equal(r.gps, true);
  assert.equal(r.make, 'TestCam');
  assert.ok(r.found.includes('EXIF'));
  assert.ok(r.found.includes('XMP'));
});

test('big-endian (MM) TIFF decodes the same fields', () => {
  const r = buildReport(makeJpegWithMetadataBE());
  assert.equal(r.format, 'jpeg');
  assert.equal(r.gps, true);
  assert.equal(r.make, 'TestCam');
  assert.equal(r.model, 'X100');
  assert.equal(r.dateTime, '2019:12:31 23:59:58');
});

test('clean/unknown input reports nothing found', () => {
  const r = buildReport(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  assert.equal(r.format, 'unknown');
  assert.deepEqual(r.found, []);
  assert.equal(r.gps, false);
});
