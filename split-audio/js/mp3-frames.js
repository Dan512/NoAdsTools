// split-audio/js/mp3-frames.js — the MPEG-1 Layer III frame surgery a
// packet-copying cutter needs. Layer III frames borrow bytes from earlier
// frames (the bit reservoir: main_data_begin points up to 511 bytes back),
// so a chunk that starts at frame i0 must also carry the frames that hold
// those bytes. We prepend them, keep the last MP3_KEEP_INTACT of them intact
// (their MDCT overlap feeds the first intended frame), and rewrite the
// earlier ones as silent frames so nothing before the cut is heard. All of
// this is bit-field work on the 17/32-byte side info; the main data bytes
// are never touched, which is what keeps the reservoir bytes available.
// Silencing zeroes part2_3_length, big_values and scalefac_compress together
// in every granule/channel block — leaving scalefac_compress non-zero while
// part2_3_length is 0 tells a decoder the block holds scalefactor bits it
// has no room for; libmad computes part3_length = part2_3_length -
// part2_length and returns MAD_ERROR_BADPART3LEN on the negative result.
// LAME's own silent frames zero all three fields the same way.
// Measured 2026-09-03 with a decoded-PCM oracle: intended audio bit-exact
// at every tested cut (CBR and VBR); keeping only one frame intact lost
// 9-22 ms on VBR. Pure, Node-tested on real packets.

// Measured 2026-09-03 on the fixture at cuts 40/77/100: keep = 1 lost about
// 24 ms; keep = 2 is exact with about 2 ms (83 samples) of headroom; keep = 3
// would add 26 ms of lead-in for 26 ms more margin.
export const MP3_KEEP_INTACT = 2;
export const MAX_MAIN_DATA_BEGIN = 511;   // 9-bit field: no frame can reach further back than this
const GR_CH_BITS = 59;                    // side-info bits per granule/channel block (MPEG-1)

/**
 * Header facts from the 4-byte frame header, or null when the bytes do not
 * start with a frame sync. `crc` is true when the protection bit is 0 (a
 * CRC-16 follows the header). Side-info lengths: MPEG-1 17 mono / 32 stereo,
 * MPEG-2/2.5 9 / 17. `mdbBits` is the width of main_data_begin (9 or 8).
 */
export function parseMp3Header(d) {
  if (!d || d.length < 4 || d[0] !== 0xFF || (d[1] & 0xE0) !== 0xE0) return null;
  const version = (d[1] >> 3) & 3;        // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved
  const layer = (d[1] >> 1) & 3;          // 1 = Layer III, 2 = Layer II, 3 = Layer I, 0 = reserved
  if (version === 1 || layer === 0) return null;
  const mpeg1 = version === 3;
  const layer3 = layer === 1;
  const crc = (d[1] & 1) === 0;
  const mono = ((d[3] >> 6) & 3) === 3;
  const headerLen = 4 + (crc ? 2 : 0);
  const sideInfoLen = layer3 ? (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17)) : 0;
  const mainDataOffset = headerLen + sideInfoLen;
  return {
    mpeg1, layer3, crc, mono, channels: mono ? 1 : 2, headerLen, sideInfoLen, mainDataOffset,
    mainDataBytes: Math.max(0, d.length - mainDataOffset), mdbBits: mpeg1 ? 9 : 8,
  };
}

/** Read n bits (MSB first) starting at bit `bitOff` of the bytes from `byteBase`. */
export function getBits(d, byteBase, bitOff, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const b = bitOff + i;
    v = v * 2 + ((d[byteBase + (b >> 3)] >> (7 - (b & 7))) & 1);
  }
  return v;
}

/** Write n bits (MSB first) of `value` at bit `bitOff` of the bytes from `byteBase`. Mutates d. */
export function setBits(d, byteBase, bitOff, n, value) {
  for (let i = 0; i < n; i++) {
    const b = bitOff + i;
    const idx = byteBase + (b >> 3);
    const mask = 1 << (7 - (b & 7));
    if ((value >> (n - 1 - i)) & 1) d[idx] |= mask; else d[idx] &= ~mask;
  }
}

/** First granule/channel block: after main_data_begin (9), private bits (5 mono / 3 stereo) and scfsi (4 per channel). */
function firstBlockBit(h) { return h.mono ? 18 : 20; }

/**
 * main_data_begin for any Layer III frame; part2_3_length and big_values per
 * granule/channel block for MPEG-1 (empty arrays otherwise). null when the
 * bytes are not a Layer III frame with a complete side info.
 */
export function readSideInfo(d) {
  const h = parseMp3Header(d);
  if (!h || !h.layer3 || d.length < h.mainDataOffset) return null;
  const mainDataBegin = getBits(d, h.headerLen, 0, h.mdbBits);
  const part23Lengths = [];
  const bigValues = [];
  if (h.mpeg1) {
    const first = firstBlockBit(h);
    for (let k = 0; k < h.channels * 2; k++) {
      part23Lengths.push(getBits(d, h.headerLen, first + k * GR_CH_BITS, 12));
      bigValues.push(getBits(d, h.headerLen, first + k * GR_CH_BITS + 12, 9));
    }
  }
  return { ...h, mainDataBegin, part23Lengths, bigValues };
}

/** MPEG audio CRC-16: polynomial 0x8005, initial value 0xFFFF, no reflection, no final XOR (CRC-16/CMS; "123456789" gives 0xAEE7). */
export function crc16Mpeg(bytes) {
  let c = 0xFFFF;
  for (const byte of bytes) {
    c ^= byte << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c;
}

/** The CRC a protected Layer III frame must carry: over header bytes 2-3 and the whole side info. */
export function mp3FrameCrc(d, h = parseMp3Header(d)) {
  const covered = new Uint8Array(2 + h.sideInfoLen);
  covered[0] = d[2];
  covered[1] = d[3];
  covered.set(d.subarray(h.headerLen, h.headerLen + h.sideInfoLen), 2);
  return crc16Mpeg(covered);
}

/**
 * A copy of the frame that decodes as silence and references no reservoir:
 * main_data_begin = 0 and, in every granule/channel block, part2_3_length =
 * big_values = scalefac_compress = 0 (all three together — see the module
 * header for why a lone non-zero scalefac_compress breaks decoders like
 * libmad, and how LAME's own silent frames zero the same three fields).
 * CRC-16 recomputed when the frame carries one. The main data bytes are
 * untouched (later frames may still borrow them). Frames that are not
 * MPEG-1 Layer III come back unchanged, as the same object.
 */
export function silenceMp3Frame(d) {
  const h = parseMp3Header(d);
  if (!h || !h.mpeg1 || !h.layer3 || d.length < h.mainDataOffset) return d;
  const out = new Uint8Array(d);
  setBits(out, h.headerLen, 0, 9, 0);
  const first = firstBlockBit(h);
  for (let k = 0; k < h.channels * 2; k++) {
    setBits(out, h.headerLen, first + k * GR_CH_BITS, 12, 0);       // part2_3_length
    setBits(out, h.headerLen, first + k * GR_CH_BITS + 12, 9, 0);   // big_values
    setBits(out, h.headerLen, first + k * GR_CH_BITS + 29, 4, 0);   // scalefac_compress
  }
  if (h.crc) {
    const c = mp3FrameCrc(out, h);
    out[4] = c >> 8;
    out[5] = c & 0xFF;
  }
  return out;
}

/**
 * How many frames to prepend before frame i0 so that every frame from the
 * first kept one onward finds its reservoir bytes, and how many of those to
 * silence. `frames` is an array of frame byte arrays (a window around i0 is
 * enough: about a second before it and a few frames after). Frames
 * i0-keep .. i0-1 are kept intact; frames before them are silenced. Frames
 * after i0 are inspected too, until the main data since the first kept
 * frame exceeds MAX_MAIN_DATA_BEGIN, because their reservoir can also reach
 * back past the cut at low bitrates.
 * @returns {{count:number, silent:number}} count includes the silent ones
 */
export function mp3Preroll(frames, i0, keep = MP3_KEEP_INTACT) {
  if (!(i0 > 0)) return { count: 0, silent: 0 };
  const firstKept = Math.max(0, i0 - keep);
  let need = 0;
  let span = 0;
  for (let j = firstKept; j < frames.length && (j <= i0 || span <= MAX_MAIN_DATA_BEGIN); j++) {
    const h = parseMp3Header(frames[j]);
    if (!h || !h.layer3 || frames[j].length < h.mainDataOffset) continue;
    need = Math.max(need, getBits(frames[j], h.headerLen, 0, h.mdbBits) - span);
    span += h.mainDataBytes;
  }
  let silent = 0;
  let covered = 0;
  for (let k = firstKept - 1; k >= 0 && covered < need; k--) {
    const h = parseMp3Header(frames[k]);
    covered += h ? h.mainDataBytes : 0;
    silent += 1;
  }
  return { count: (i0 - firstKept) + silent, silent };
}
