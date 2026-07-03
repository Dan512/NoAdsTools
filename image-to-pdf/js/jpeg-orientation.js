// image-to-pdf/js/jpeg-orientation.js — read the EXIF Orientation tag from
// JPEG bytes. Why it matters here: the tool embeds JPEG bytes into the PDF
// unmodified, but PDF viewers ignore EXIF inside embedded images — so a
// camera shot tagged "rotate 90°" would come out sideways. main.js uses this
// to route tagged JPEGs (value ≠ 1) through the canvas re-encode path, where
// createImageBitmap has already baked the rotation in.
//
// Returns the Orientation value (1–8); returns 1 (no rotation) on ANY parse
// doubt — never throws. Bounds-guarded segment walk: SOI -> APP1 'Exif\0\0'
// -> TIFF header -> IFD0 -> tag 0x0112 (type SHORT, count 1).

export function jpegOrientation(bytes) {
  try {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 1;
    let o = 2;
    while (o + 4 <= bytes.length) {
      if (bytes[o] !== 0xFF) return 1;
      const marker = bytes[o + 1];
      // Standalone markers (no length field): TEM, RSTn. SOS/EOI end the
      // metadata zone — EXIF can't legally appear after them.
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { o += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) return 1;
      const len = (bytes[o + 2] << 8) | bytes[o + 3];
      if (len < 2 || o + 2 + len > bytes.length) return 1;
      if (marker === 0xE1 && len >= 2 + 6 + 8) {
        const p = o + 4;
        if (bytes[p] === 0x45 && bytes[p + 1] === 0x78 && bytes[p + 2] === 0x69
            && bytes[p + 3] === 0x66 && bytes[p + 4] === 0 && bytes[p + 5] === 0) {
          return orientationFromTiff(bytes, p + 6, o + 2 + len);
        }
      }
      o += 2 + len;
    }
    return 1;
  } catch {
    return 1;
  }
}

function orientationFromTiff(bytes, tiff, end) {
  if (tiff + 8 > end || end > bytes.length) return 1;
  let le;
  if (bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49) le = true;        // 'II'
  else if (bytes[tiff] === 0x4D && bytes[tiff + 1] === 0x4D) le = false;  // 'MM'
  else return 1;
  const u16 = (off) => le
    ? bytes[off] | (bytes[off + 1] << 8)
    : (bytes[off] << 8) | bytes[off + 1];
  const u32 = (off) => le
    ? (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
    : ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  if (u16(tiff + 2) !== 0x2A) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd < tiff || ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 1;
    if (u16(e) === 0x0112) {
      if (u16(e + 2) !== 3 || u32(e + 4) !== 1) return 1; // SHORT, count 1
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}
