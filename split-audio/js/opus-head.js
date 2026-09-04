// split-audio/js/opus-head.js — read and patch the pre-skip field of an
// OpusHead identification header (RFC 7845 section 5.1). mediabunny exposes
// the header as decoderConfig.description and its OGG muxer writes whatever
// description it is handed, so a chunk that starts with pre-roll packets
// gets a pre-skip equal to the pre-roll length and every player drops it.
// Measured 2026-09-03 against a pink-noise source at 48/96/128 kbps: the
// RFC's 80 ms left -38 dB residuals; 240 ms of pre-roll still left up to 6
// LSB of error in the first 30 ms; 320 ms was within 1 LSB. cut.js uses 400
// ms as its margin choice (OPUS_PREROLL_SEC) — a player never hears it,
// since it's hidden behind the OpusHead pre-skip patched here. Pure,
// Node-tested.
const MAGIC = 'OpusHead';
export const OPUS_RATE = 48000; // pre-skip is always counted at 48 kHz

/** A Uint8Array view over a BufferSource (Uint8Array, ArrayBuffer, DataView...) without copying. */
export function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return null;
}

export function isOpusHead(bytes) {
  const b = asBytes(bytes);
  if (!b || b.length < 19) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

/** Pre-skip in 48 kHz samples (bytes 10-11, little-endian), or -1 when the bytes are not an OpusHead. */
export function readOpusPreSkip(bytes) {
  const b = asBytes(bytes);
  return isOpusHead(b) ? b[10] | (b[11] << 8) : -1;
}

/**
 * A copy of the header with its pre-skip replaced (clamped to u16, i.e.
 * 65535 samples at 48 kHz = 1.365 s); the input is never mutated. Non-
 * OpusHead bytes come back as given. The clamp is unreachable in practice
 * only while cut.js's LOOKBACK_SEC (currently 1 s) caps how much pre-roll a
 * plan can ever request — raise that and this clamp becomes reachable.
 */
export function patchOpusPreSkip(bytes, preSkip) {
  const b = asBytes(bytes);
  if (!isOpusHead(b)) return bytes;
  const n = Math.max(0, Math.min(0xFFFF, Math.round(preSkip)));
  const out = new Uint8Array(b);
  out[10] = n & 0xFF;
  out[11] = n >> 8;
  return out;
}
