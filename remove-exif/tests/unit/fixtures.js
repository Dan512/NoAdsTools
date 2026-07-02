// remove-exif/tests/unit/fixtures.js — hand-assembled byte fixtures for the
// stripper/report tests. Structurally valid JPEG/PNG/WebP with known metadata;
// payloads (scan data, IDAT, VP8) are dummy bytes — the stripper copies them
// verbatim and the tests assert exactly that.
function bytes(...parts) {
  const arrs = parts.map(p => (typeof p === 'string')
    ? new TextEncoder().encode(p)
    : Uint8Array.from(p));
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const u16be = (n) => [n >> 8 & 0xFF, n & 0xFF];
const u32be = (n) => [n >>> 24 & 0xFF, n >>> 16 & 0xFF, n >>> 8 & 0xFF, n & 0xFF];
const u16le = (n) => [n & 0xFF, n >> 8 & 0xFF];
const u32le = (n) => [n & 0xFF, n >>> 8 & 0xFF, n >>> 16 & 0xFF, n >>> 24 & 0xFF];

// --- TIFF/IFD payload for the JPEG APP1 Exif segment. Default little-endian
// ("II"); pass 'MM' for big-endian (same layout, all u16/u32 fields swapped).
// IFD0: Make="TestCam", Model="X100", Software="FixKit", DateTime, ExifIFD
// pointer -> {DateTimeOriginal}, GPSInfo pointer -> minimal GPS IFD.
export function buildTiff(order = 'II') {
  const u16 = order === 'MM' ? u16be : u16le;
  const u32 = order === 'MM' ? u32be : u32le;
  const entry = (tag, type, count, value4) => [...u16(tag), ...u16(type), ...u32(count), ...value4];
  // Layout (offsets from TIFF start): header 0..7, IFD0 at 8.
  // IFD0: count(2) + 6 entries*12 + next(4) = 2+72+4 = 78 -> data area starts at 8+78 = 86.
  const make = 'TestCam\0';                    // 8 bytes  @86
  const model = 'X100\0\0';                    // 6 bytes  @94  (padded even)
  const software = 'FixKit\0\0';               // 8 bytes  @100
  const dateTime = '2020:01:02 03:04:05\0';    // 20 bytes @108
  const exifIfdOff = 128;                      // ExifIFD: count+1 entry+next = 2+12+4 = 18 -> @128..145
  const dto = '2019:12:31 23:59:58\0';         // 20 bytes @146
  const gpsIfdOff = 166;                       // GPS IFD: 2+12+4 = 18 -> @166..183
  const ifd0 = [
    ...u16(6),
    ...entry(0x010F, 2, make.length, u32(86)),
    ...entry(0x0110, 2, 5, u32(94)),
    ...entry(0x0131, 2, 7, u32(100)),
    ...entry(0x0132, 2, dateTime.length, u32(108)),
    ...entry(0x8769, 4, 1, u32(exifIfdOff)),     // ExifIFD pointer
    ...entry(0x8825, 4, 1, u32(gpsIfdOff)),      // GPSInfo pointer
    ...u32(0),
  ];
  const exifIfd = [...u16(1), ...entry(0x9003, 2, dto.length, u32(146)), ...u32(0)];
  const gpsIfd = [...u16(1), ...entry(0x0000, 1, 4, [2, 3, 0, 0]), ...u32(0)];
  return bytes(order, u16(0x2A), u32(8), ifd0, make, model, software, dateTime, exifIfd, dto, gpsIfd);
}

function makeJpeg(order) {
  const tiff = buildTiff(order);
  const exifPayload = bytes('Exif\0\0', tiff);
  const app1 = bytes([0xFF, 0xE1], u16be(exifPayload.length + 2), exifPayload);
  const xmpPayload = bytes('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta>gps here</x:xmpmeta>');
  const app1Xmp = bytes([0xFF, 0xE1], u16be(xmpPayload.length + 2), xmpPayload);
  const app0 = bytes([0xFF, 0xE0], u16be(16), 'JFIF\0', [1, 1, 0], u16be(1), u16be(1), [0, 0]);
  const app13 = bytes([0xFF, 0xED], u16be(20), 'Photoshop 3.0\0', [1, 2, 3, 4]);
  const com = bytes([0xFF, 0xFE], u16be(9), 'secret!');
  const dqt = bytes([0xFF, 0xDB], u16be(67), [0], new Array(64).fill(9));
  const sos = bytes([0xFF, 0xDA], u16be(8), [1, 1, 0, 0, 63, 0]);
  const scan = bytes([0x12, 0x34, 0x56, 0x78, 0x9A]);
  const eoi = bytes([0xFF, 0xD9]);
  return bytes([0xFF, 0xD8], app0, app1, app1Xmp, app13, com, dqt, sos, scan, eoi);
}

export function makeJpegWithMetadata() {
  return makeJpeg('II');
}

// Same JPEG but with a big-endian ("MM") TIFF — exercises the byte-swapped
// branches of the report's IFD reader.
export function makeJpegWithMetadataBE() {
  return makeJpeg('MM');
}

// Samsung/Google "motion photo" style: an MP4-ish trailer (with, in real
// life, its own GPS track) appended AFTER the JPEG EOI marker. Exactly 32
// trailing bytes; none of them form FF D9.
export function makeJpegWithTrailing() {
  const trailer = bytes(u32be(24), 'ftypmp4 ', new Array(20).fill(0xAB)); // 4+8+20 = 32 bytes
  return bytes(makeJpegWithMetadata(), trailer);
}

export function makePngWithMetadata() {
  const chunk = (type, data) => bytes(u32be(data.length), type, data, [0, 0, 0, 0]); // dummy CRC — never validated/recomputed
  const ihdr = chunk('IHDR', bytes(u32be(1), u32be(1), [8, 0, 0, 0, 0]));
  const text = chunk('tEXt', bytes('Author\0Dan'));
  const exif = chunk('eXIf', bytes([0x49, 0x49, 0x2A, 0x00]));
  const time = chunk('tIME', bytes(u16be(2020), [1, 2, 3, 4, 5]));
  const gama = chunk('gAMA', bytes(u32be(45455)));
  const idat = chunk('IDAT', bytes([0x08, 0xD7, 0x63, 0x60, 0x00, 0x00]));
  const iend = chunk('IEND', bytes([]));
  return bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], ihdr, text, exif, time, gama, idat, iend);
}

// PNG with junk appended after IEND (same trailer-drop rule as JPEG/EOI).
export function makePngWithTrailing() {
  const trailer = bytes('JUNK', new Array(17).fill(0xCD)); // 21 bytes
  return bytes(makePngWithMetadata(), trailer);
}

export function makeWebpWithMetadata() {
  const chunk = (fourcc, data) => {
    const padded = data.length % 2 ? bytes(data, [0]) : data;
    return bytes(fourcc, u32le(data.length), padded);
  };
  // VP8X flags byte: ICC=0x20 ALPHA=0x10 EXIF=0x08 XMP=0x04 ANIM=0x02 -> set EXIF|XMP.
  const vp8x = chunk('VP8X', bytes([0x0C, 0, 0, 0], [0, 0, 0], [0, 0, 0]));
  const exif = chunk('EXIF', buildTiff());
  const xmp = chunk('XMP ', bytes('<x:xmpmeta/>'));
  const vp8 = chunk('VP8 ', bytes([0x10, 0x20, 0x30, 0x40, 0x55]));
  const body = bytes('WEBP', vp8x, exif, xmp, vp8);
  return bytes('RIFF', u32le(body.length), body);
}

export function makeHeicBytes() {
  return bytes(u32be(20), 'ftyp', 'heic', u32be(0), 'heic');
}
