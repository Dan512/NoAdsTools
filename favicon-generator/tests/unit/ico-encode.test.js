// favicon-generator/tests/unit/ico-encode.test.js — the hand-rolled ICO
// container's binary structure, pinned byte-for-byte. Canvas cannot emit .ico,
// so this encoder is the one non-trivial pure bit; it never touches a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icoEncode } from '../../js/ico-encode.js';

const png = (n, fill) => Uint8Array.from({ length: n }, () => fill); // fake PNG bytes

test('single-image ICO: header + one entry + block', () => {
  const p = png(10, 0xAB);
  const out = new Uint8Array(icoEncode([{ size: 32, pngBytes: p }]));
  const dv = new DataView(out.buffer);
  assert.equal(dv.getUint16(0, true), 0);   // reserved
  assert.equal(dv.getUint16(2, true), 1);   // type icon
  assert.equal(dv.getUint16(4, true), 1);   // count
  // entry at offset 6
  assert.equal(out[6], 32);                  // width
  assert.equal(out[7], 32);                  // height
  assert.equal(dv.getUint16(10, true), 1);   // planes
  assert.equal(dv.getUint16(12, true), 32);  // bitCount
  assert.equal(dv.getUint32(14, true), 10);  // bytesInRes
  assert.equal(dv.getUint32(18, true), 6 + 16); // imageOffset = header end
  // block intact
  assert.deepEqual([...out.slice(22, 32)], [...p]);
});

test('three-image ICO: offsets accumulate correctly', () => {
  const a = png(4, 1), b = png(6, 2), c = png(8, 3);
  const out = new Uint8Array(icoEncode([
    { size: 16, pngBytes: a }, { size: 32, pngBytes: b }, { size: 48, pngBytes: c },
  ]));
  const dv = new DataView(out.buffer);
  assert.equal(dv.getUint16(4, true), 3);
  const base = 6 + 16 * 3;
  assert.equal(dv.getUint32(18, true), base);            // entry0 offset
  assert.equal(dv.getUint32(6 + 16 + 12, true), base + 4);   // entry1 = base + len(a)
  assert.equal(dv.getUint32(6 + 32 + 12, true), base + 10);  // entry2 = base + 4 + 6
  assert.deepEqual([...out.slice(base + 4, base + 10)], [...b]); // b intact
  assert.equal(out[6], 16); assert.equal(out[6 + 16], 32); assert.equal(out[6 + 32], 48);
});

test('size 256 encodes as width/height byte 0', () => {
  const out = new Uint8Array(icoEncode([{ size: 256, pngBytes: png(3, 9) }]));
  assert.equal(out[6], 0); assert.equal(out[7], 0);
});

test('total buffer length = header + all blocks', () => {
  const a = png(4, 1), b = png(6, 2), c = png(8, 3);
  const out = new Uint8Array(icoEncode([
    { size: 16, pngBytes: a }, { size: 32, pngBytes: b }, { size: 48, pngBytes: c },
  ]));
  assert.equal(out.length, 6 + 16 * 3 + (4 + 6 + 8));
});
