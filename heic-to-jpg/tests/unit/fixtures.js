// heic-to-jpg/tests/unit/fixtures.js — hand-assembled byte fixtures for the
// keep-metadata (EXIF extract/inject) tests. The byte helpers + TIFF builder
// follow the remove-exif fixtures pattern (own copy — sibling tool dirs don't
// import across each other).
//
// makeHeicWithExif() builds a structurally valid HEIF container — ftyp +
// meta{iinf/infe(Exif) + iloc} + mdat carrying a real TIFF payload — exactly
// the subset shared/exif.js's extractExifFromHeif() parses. The pixel data is
// absent on purpose: these fixtures feed the METADATA path (and, in browser
// specs, a faked decoder), never a real decode.
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

// --- TIFF/IFD payload (little-endian). IFD0: Make="TestCam", Model="X100",
// Software="FixKit", DateTime, ExifIFD pointer -> {DateTimeOriginal},
// GPSInfo pointer -> minimal GPS IFD (so hasMetadata reports gps: true).
export function buildTiff() {
  const u16 = u16le;
  const u32 = u32le;
  const entry = (tag, type, count, value4) => [...u16(tag), ...u16(type), ...u32(count), ...value4];
  // Layout (offsets from TIFF start): header 0..7, IFD0 at 8.
  // IFD0: count(2) + 6 entries*12 + next(4) = 78 -> data area starts at 86.
  const make = 'TestCam\0';                    // 8 bytes  @86
  const model = 'X100\0\0';                    // 6 bytes  @94  (padded even)
  const software = 'FixKit\0\0';               // 8 bytes  @100
  const dateTime = '2020:01:02 03:04:05\0';    // 20 bytes @108
  const exifIfdOff = 128;                      // ExifIFD: 2+12+4 = 18 -> @128..145
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
  return bytes('II', u16(0x2A), u32(8), ifd0, make, model, software, dateTime, exifIfd, dto, gpsIfd);
}

// --- Minimal metadata-free JPEG: SOI + APP0/JFIF + DQT + SOS + scan + EOI.
// Structurally valid for shared/exif.js's marker walker; the scan bytes are
// dummies (nothing decodes them in these tests).
export function makeCleanJpeg() {
  const app0 = bytes([0xFF, 0xE0], u16be(16), 'JFIF\0', [1, 1, 0], u16be(1), u16be(1), [0, 0]);
  const dqt = bytes([0xFF, 0xDB], u16be(67), [0], new Array(64).fill(9));
  const sos = bytes([0xFF, 0xDA], u16be(8), [1, 1, 0, 0, 63, 0]);
  const scan = bytes([0x12, 0x34, 0x56, 0x78, 0x9A]);
  const eoi = bytes([0xFF, 0xD9]);
  return bytes([0xFF, 0xD8], app0, dqt, sos, scan, eoi);
}

// --- Synthetic HEIC WITH an EXIF item. Box layout (all sizes exact):
//   ftyp (20 B)  brand 'heic'
//   meta (77 B)  fullbox
//     iinf (35 B)  version 0, 1 entry
//       infe (21 B)  version 2, item_ID 1, item_type 'Exif'
//     iloc (30 B)  version 0, offset/length size 4, 1 item, 1 extent
//   mdat (8 + 4 + tiff B)  4-byte "Exif prefix offset" (0) + TIFF stream
// The iloc extent points at the mdat payload by absolute file offset.
export function makeHeicWithExif() {
  const tiff = buildTiff();
  const ftyp = bytes(u32be(20), 'ftyp', 'heic', u32be(0), 'heic');

  const infe = bytes(
    u32be(21), 'infe',
    [2, 0, 0, 0],      // version 2 + flags
    u16be(1),          // item_ID
    u16be(0),          // item_protection_index
    'Exif',            // item_type
    [0],               // item_name: empty, null-terminated
  );
  const iinf = bytes(u32be(8 + 4 + 2 + infe.length), 'iinf', [0, 0, 0, 0], u16be(1), infe);

  const metaSize = 8 + 4 + iinf.length + 30; // header + ver/flags + iinf + iloc
  const exifItemOffset = ftyp.length + metaSize + 8; // absolute: after the mdat header
  const exifItemLength = 4 + tiff.length;            // prefix-offset field + TIFF

  const iloc = bytes(
    u32be(30), 'iloc',
    [0, 0, 0, 0],        // version 0 + flags
    [0x44, 0x00],        // offset_size=4, length_size=4, base_offset_size=0
    u16be(1),            // item_count
    u16be(1),            // item_ID
    u16be(0),            // data_reference_index (0 = this file)
    u16be(1),            // extent_count
    u32be(exifItemOffset),
    u32be(exifItemLength),
  );
  const meta = bytes(u32be(metaSize), 'meta', [0, 0, 0, 0], iinf, iloc);
  const mdat = bytes(u32be(8 + exifItemLength), 'mdat', u32be(0), tiff);
  return bytes(ftyp, meta, mdat);
}

// --- Minimal HEIC-looking bytes with NO meta box (ftyp only) — exercises the
// "keep is ON but there's no metadata to keep" path.
export function makeHeicNoExif() {
  return bytes(u32be(20), 'ftyp', 'heic', u32be(0), 'heic');
}
