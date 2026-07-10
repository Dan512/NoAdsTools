// favicon-generator/js/ico-encode.js — PURE. Assemble a multi-resolution ICO
// (PNG-in-ICO) from [{size, pngBytes:Uint8Array}]. Little-endian. No DOM.
//
// Structure (see spec §5):
//   ICONDIR       6 bytes : reserved=0 (u16), type=1 (icon, u16), count=N (u16)
//   ICONDIRENTRY  16 bytes each: width(u8; 0 means 256), height(u8),
//                 colorCount=0(u8), reserved=0(u8), planes=1(u16),
//                 bitCount=32(u16), bytesInRes(u32), imageOffset(u32, absolute)
//   then each pngBytes block appended in order.
export function icoEncode(images) {
  const n = images.length;
  const headerSize = 6 + 16 * n;
  const dataSize = images.reduce((s, im) => s + im.pngBytes.length, 0);
  const out = new Uint8Array(headerSize + dataSize);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true);   // reserved
  dv.setUint16(2, 1, true);   // type = 1 (icon)
  dv.setUint16(4, n, true);   // image count
  let offset = headerSize;
  for (let i = 0; i < n; i++) {
    const im = images[i];
    const e = 6 + 16 * i;
    out[e]     = im.size >= 256 ? 0 : im.size; // width  (0 => 256)
    out[e + 1] = im.size >= 256 ? 0 : im.size; // height
    out[e + 2] = 0;                            // palette color count
    out[e + 3] = 0;                            // reserved
    dv.setUint16(e + 4, 1, true);              // color planes
    dv.setUint16(e + 6, 32, true);             // bits per pixel
    dv.setUint32(e + 8, im.pngBytes.length, true); // bytes in resource
    dv.setUint32(e + 12, offset, true);        // offset from file start
    out.set(im.pngBytes, offset);
    offset += im.pngBytes.length;
  }
  return out.buffer;
}
