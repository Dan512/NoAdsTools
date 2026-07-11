import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPdf } from '../../js/intake.js';

test('accepts a .pdf file (extension wins)', () => {
  assert.equal(isPdf('report.pdf', 'application/pdf'), true);
  assert.equal(isPdf('report.pdf', ''), true);           // MIME missing, ext carries it
  assert.equal(isPdf('REPORT.PDF', 'application/pdf'), true); // case-insensitive ext
});

test('accepts an extensionless file rescued by MIME', () => {
  assert.equal(isPdf('scan', 'application/pdf'), true);
  assert.equal(isPdf('', 'application/pdf'), true);
});

test('rejects images and other non-PDF types', () => {
  assert.equal(isPdf('photo.png', 'image/png'), false);
  assert.equal(isPdf('photo.jpg', 'image/jpeg'), false);
  assert.equal(isPdf('notes.txt', 'text/plain'), false);
  assert.equal(isPdf('archive.zip', 'application/zip'), false);
});

test('rejects a disguised double-extension (x.pdf.exe) — final extension wins over MIME', () => {
  assert.equal(isPdf('x.pdf.exe', 'application/pdf'), false);
  assert.equal(isPdf('invoice.pdf.exe', ''), false);
});

test('rejects an extensionless file with no PDF MIME', () => {
  assert.equal(isPdf('scan', ''), false);
  assert.equal(isPdf('scan', 'image/png'), false);
  assert.equal(isPdf(undefined, undefined), false);
});
