// split-audio/js/flac-renumber.js — rewrite the frame/sample number in a
// FLAC frame header. mediabunny copies FLAC frames verbatim, so a chunk cut
// from the middle of a file would start at frame 44 and decoders seek by
// that number. Pure byte work, Node-tested against the fixture.

/** Byte length of an extended-UTF-8 number from its lead byte: 1–7, or 0 for an invalid lead byte. */
export function utf8Length(lead) {
  if (lead < 0x80) return 1;
  if ((lead & 0xE0) === 0xC0) return 2;
  if ((lead & 0xF0) === 0xE0) return 3;
  if ((lead & 0xF8) === 0xF0) return 4;
  if ((lead & 0xFC) === 0xF8) return 5;
  if ((lead & 0xFE) === 0xFC) return 6;
  return lead === 0xFE ? 7 : 0; // 0xFE lead: 36-bit sample numbers; else invalid
}

/** FLAC's extended UTF-8: up to 36 bits in 7 bytes. Uses division, not shifts, so numbers past 2^31 survive. */
export function utf8Encode(n) {
  const limits = [0x80, 0x800, 0x10000, 0x200000, 0x4000000, 0x80000000, 2 ** 36];
  const leads = [0x00, 0xC0, 0xE0, 0xF0, 0xF8, 0xFC, 0xFE];
  let len = 1;
  while (len < 7 && n >= limits[len - 1]) len += 1;
  if (len === 1) return [n];
  const cont = [];
  let rest = n;
  for (let k = 1; k < len; k++) { cont.unshift(0x80 | (rest % 64)); rest = Math.floor(rest / 64); }
  return [leads[len - 1] | rest, ...cont];
}

export function crc8(bytes, end) {
  let c = 0;
  for (let i = 0; i < end; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
  }
  return c;
}

// CRC-16 (poly 0x8005, init 0) table: the bitwise loop runs ~26 MB/s, which
// is a 24 s stall on a two-hour FLAC; the table is 12x faster.
const T16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xFFFF : (c << 1) & 0xFFFF;
  T16[i] = c;
}

export function crc16(bytes, end) {
  let c = 0;
  for (let i = 0; i < end; i++) c = ((c << 8) ^ T16[((c >> 8) ^ bytes[i]) & 0xFF]) & 0xFFFF;
  return c;
}

function isFrame(data) {
  if (data.length < 6 || data[0] !== 0xFF || (data[1] & 0xFE) !== 0xF8) return false;
  const len = utf8Length(data[4]);
  if (len === 0) return false;
  return data.length >= 4 + len + extraHeaderBytes(data[2]);
}

/** The number in a frame header, or -1 when the bytes are not a frame. */
export function readFlacFrameNumber(data) {
  if (!isFrame(data)) return -1;
  const len = utf8Length(data[4]);
  if (len === 1) return data[4];
  let n = data[4] & (0xFF >> (len + 1));
  for (let k = 1; k < len; k++) n = n * 64 + (data[4 + k] & 0x3F);
  return n;
}

function extraHeaderBytes(byte2) {
  const bs = byte2 >> 4;
  const sr = byte2 & 0x0F;
  return (bs === 6 ? 1 : bs === 7 ? 2 : 0) + (sr === 12 ? 1 : (sr === 13 || sr === 14) ? 2 : 0);
}

/**
 * Returns a new Uint8Array with the number replaced (frame index for fixed
 * block size, first-sample index for variable) and CRC-8 + CRC-16 recomputed.
 * Returns `data` itself when it is not a frame or already carries the number.
 * The result may be `data` itself, which for mediabunny packets is a view
 * into a shared read buffer; callers must treat it as read-only.
 */
export function renumberFlacFrame(data, frameIndex, sampleOffset) {
  if (!isFrame(data)) return data;
  const oldLen = utf8Length(data[4]);
  const extra = extraHeaderBytes(data[2]);
  // isFrame only proves the header's own bytes are present. The rewrite
  // also reads the header CRC-8 and the frame's trailing CRC-16, so a
  // buffer that stops short of both is not a frame we can renumber —
  // without this, a 6-byte input came back as a fabricated 8-byte frame.
  if (data.length < 4 + oldLen + extra + 3) return data;
  const variable = (data[1] & 1) === 1;
  const target = variable ? sampleOffset : frameIndex;
  if (readFlacFrameNumber(data) === target) return data;
  const oldHeaderLen = 4 + oldLen + extra + 1;
  const num = utf8Encode(target);
  const header = new Uint8Array(4 + num.length + extra + 1);
  header.set(data.subarray(0, 4), 0);
  header.set(num, 4);
  header.set(data.subarray(4 + oldLen, 4 + oldLen + extra), 4 + num.length);
  header[header.length - 1] = crc8(header, header.length - 1);
  const body = data.subarray(oldHeaderLen, data.length - 2);
  const out = new Uint8Array(header.length + body.length + 2);
  out.set(header, 0);
  out.set(body, header.length);
  const c = crc16(out, out.length - 2);
  out[out.length - 2] = c >> 8;
  out[out.length - 1] = c & 0xFF;
  return out;
}
