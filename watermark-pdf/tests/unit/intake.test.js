import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPdf, isRasterLogo } from '../../js/intake.js';

test('isPdf accepts a .pdf file (extension wins)', () => {
  assert.equal(isPdf('report.pdf', 'application/pdf'), true);
  assert.equal(isPdf('report.pdf', ''), true);           // MIME missing, ext carries it
  assert.equal(isPdf('REPORT.PDF', 'application/pdf'), true); // case-insensitive ext
});
test('isPdf accepts an extensionless file rescued by MIME', () => {
  assert.equal(isPdf('scan', 'application/pdf'), true);
  assert.equal(isPdf('', 'application/pdf'), true);
});
test('isPdf rejects images and other non-PDF types', () => {
  assert.equal(isPdf('photo.png', 'image/png'), false);
  assert.equal(isPdf('notes.txt', 'text/plain'), false);
  assert.equal(isPdf('x.pdf.exe', 'application/pdf'), false); // final extension wins
});

test('isRasterLogo accepts PNG and JPEG (extension wins)', () => {
  assert.equal(isRasterLogo('logo.png', 'image/png'), true);
  assert.equal(isRasterLogo('logo.jpg', 'image/jpeg'), true);
  assert.equal(isRasterLogo('logo.jpeg', 'image/jpeg'), true);
  assert.equal(isRasterLogo('LOGO.PNG', ''), true);        // case-insensitive, MIME missing
});
test('isRasterLogo accepts an extensionless file rescued by MIME', () => {
  assert.equal(isRasterLogo('mark', 'image/png'), true);
  assert.equal(isRasterLogo('mark', 'image/jpeg'), true);
});
test('isRasterLogo rejects PDFs, SVG, GIF, WebP and other types', () => {
  assert.equal(isRasterLogo('doc.pdf', 'application/pdf'), false);
  assert.equal(isRasterLogo('logo.svg', 'image/svg+xml'), false);
  assert.equal(isRasterLogo('logo.gif', 'image/gif'), false);
  assert.equal(isRasterLogo('logo.webp', 'image/webp'), false);
  assert.equal(isRasterLogo('logo.png.exe', 'image/png'), false); // final ext wins
  assert.equal(isRasterLogo('mark', ''), false);                  // no ext, no MIME
  assert.equal(isRasterLogo(undefined, undefined), false);
});
