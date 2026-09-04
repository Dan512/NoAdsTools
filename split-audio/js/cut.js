// split-audio/js/cut.js — cut one segment out of an opened file by copying
// its encoded packets into a fresh container of the same format. Never
// re-encodes: the vendored mediabunny has no MP3/AAC encoder, and copying
// is the better product anyway (lossless, seconds not minutes).
//
// Why not mediabunny's Conversion.trim: its audio branch forces a transcode
// whenever the trim starts after the first packet, and for MP3/WAV whenever
// the output would not start at 0 (read from the bundle 2026-09-03). This
// loop re-stamps timestamps itself. `mb` is a parameter so Node tests and
// specs pass the real module or a fake; no DOM anywhere.
//
// Boundaries. A cut snaps to the NEAREST packet boundary and both
// neighbours resolve the same one, so the intended packet ranges of a cut
// list partition the source. Each chunk then carries, before its intended
// range, exactly the pre-roll its codec's decoder needs to be exact from
// the first intended sample (measured with the decoded-PCM oracle in
// scripts/verify-audio-chunks.mjs, 2026-09-03):
//   WAV     none: sliced at the sample (pcmSliceBounds)
//   FLAC    none: frames renumbered from 0 so seeking inside a chunk works
//   Vorbis  1 packet: the decoder primes on it and outputs nothing
//   AAC     1 frame: MDCT overlap; 23 ms of faded-in pre-cut audio remains
//   Opus    400 ms of packets, hidden by rewriting the OpusHead pre-skip
//   MP3     enough frames to hold the bit reservoir; the last two intact,
//           the earlier ones rewritten as silence (mp3-frames.js)
import { renumberFlacFrame } from './flac-renumber.js';
import { mp3Preroll, silenceMp3Frame } from './mp3-frames.js';
import { patchOpusPreSkip, OPUS_RATE } from './opus-head.js';

// Neither copy loop below otherwise yields: `await source.add()` resolves
// in a microtask for BufferTarget, and getNextPacket mostly hits
// mediabunny's 8 MiB read cache. A two-hour WAV is ~156,000 packets — ~7 s
// of unbroken main-thread work in Node, several times that on a phone —
// during which the caller's "Cutting N of M" status cannot even paint.
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
const YIELD_EVERY = 512; // packets

export const PCM_BYTES_PER_SAMPLE = Object.freeze({
  'pcm-s16': 2, 'pcm-s16be': 2, 'pcm-s24': 3, 'pcm-s24be': 3, 'pcm-s32': 4, 'pcm-s32be': 4,
  'pcm-f32': 4, 'pcm-f32be': 4, 'pcm-f64': 8, 'pcm-f64be': 8, 'pcm-u8': 1, 'pcm-s8': 1, 'ulaw': 1, 'alaw': 1,
});

/** Packets kept before a boundary for the planner: covers the deepest MP3 reservoir (511 bytes is 8 frames at 32 kbps) and 400 ms of Opus. */
export const LOOKBACK_SEC = 1;
/** Packets after the boundary the planner may inspect: an MP3 frame's reservoir can reach back past the cut too. The worst legal MPEG-1 case (32 kbps, 48 kHz, stereo, CRC on: 96-byte frames with 58 bytes of main data) needs the accumulated main data past 511 bytes, which 9 frames clear by only 11 bytes; 12 costs three extra packet reads per chunk and removes the cliff. */
export const LOOKAHEAD_PACKETS = 12;
/** Opus decoder convergence, measured against a pink-noise source at 48/96/128 kbps: 240 ms of pre-roll still left up to 6 LSB of error in the first 30 ms, 320 ms was within 1 LSB from the first sample, 480 ms exact. 400 ms is the margin choice; a player never hears it (OpusHead pre-skip). */
export const OPUS_PREROLL_SEC = 0.4;

/** Bytes per interleaved PCM frame, or 0 for a compressed codec. */
export function bytesPerFrame(codec, channels) {
  const b = PCM_BYTES_PER_SAMPLE[codec];
  return b ? b * channels : 0;
}

const NONE = Object.freeze({ count: 0, silent: 0, seconds: 0 });

/** A plan for `count` pre-roll packets taken from window[i0-count .. i0), the first `silent` of them to be silenced. */
export function prerollPlan(window, i0, count, silent = 0) {
  const n = Math.max(0, Math.min(i0, count));
  let seconds = 0;
  for (let k = i0 - n; k < i0; k++) seconds += window[k].duration;
  return { count: n, silent: Math.min(silent, n), seconds };
}

/** Enough packets before i0 to cover at least `minSec`, or all of them when the window is shorter. */
export function prerollBySeconds(window, i0, minSec) {
  let count = 0;
  let seconds = 0;
  while (count < i0 && seconds + 1e-6 < minSec) { count += 1; seconds += window[i0 - count].duration; }
  return prerollPlan(window, i0, count);
}

/**
 * Per-codec boundary strategy. `preroll(window, i0)` sees the packets around
 * the boundary (window[i0] is the first intended packet) and returns a plan.
 * `prepare(data, k, samples, plan)` may rewrite the k-th emitted packet
 * (`samples` = PCM frames emitted before it). `decoderConfig(config, plan)`
 * may return a patched decoder config for the output track.
 */
export const BOUNDARY = Object.freeze({
  mp3: {
    preroll(window, i0) {
      const { count, silent } = mp3Preroll(window.map((p) => p.data), i0);
      return prerollPlan(window, i0, count, silent);
    },
    prepare: (data, k, _samples, plan) => (k < plan.silent ? silenceMp3Frame(data) : data),
  },
  aac: { preroll: (window, i0) => prerollPlan(window, i0, 1) },
  vorbis: { preroll: (window, i0) => prerollPlan(window, i0, 1) },
  opus: {
    preroll: (window, i0) => prerollBySeconds(window, i0, OPUS_PREROLL_SEC),
    decoderConfig: (config, plan) => (plan.count && config && config.description
      ? { ...config, description: patchOpusPreSkip(config.description, Math.round(plan.seconds * OPUS_RATE)) }
      : config),
  },
  flac: {
    preroll: () => NONE,
    prepare: (data, k, samples) => renumberFlacFrame(data, k, samples),
  },
});
// engine.js's per-container codec allowlist keeps an unrecognised codec
// from ever reaching here; the throw guards against a future widening of
// that allowlist without a measured pre-roll strategy — AC-3, E-AC-3 and
// DTS all decode with overlap, so a zero-pre-roll chunk of them would ship
// a garbled lead-in.
export function boundaryFor(codec) {
  const b = BOUNDARY[codec];
  if (!b) throw new Error('codec_unsupported');
  return b;
}

/** Pure: of a packet and its successor, the one whose timestamp is nearer to t. Ties go to the earlier packet; `next` may be null at the end of the file. */
export function pickNearest(packet, next, t) {
  if (!next) return packet;
  return (next.timestamp - t) < (t - packet.timestamp) ? next : packet;
}

/** The packet at the boundary nearest t. getPacket(t) returns null (not undefined) for a t before the first packet; `??` handles either. */
export async function resolveBoundary(sink, t) {
  const p = (await sink.getPacket(t)) ?? (await sink.getFirstPacket());
  return pickNearest(p, await sink.getNextPacket(p), t);
}

/**
 * PCM packets slice at sample precision. The byte range of `packet` inside
 * [start, end) plus the re-based timestamp, or null when none of it is.
 * Adjacent segments round the same boundary to the same sample.
 */
export function pcmSliceBounds(packet, start, end, sampleRate, bpf) {
  const frames = Math.floor(packet.data.byteLength / bpf);
  const from = Math.min(frames, Math.max(0, Math.round((start - packet.timestamp) * sampleRate)));
  const to = Math.max(0, Math.min(frames, Math.round((end - packet.timestamp) * sampleRate)));
  if (to <= from) return null;
  return {
    from: from * bpf,
    to: to * bpf,
    timestamp: Math.max(packet.timestamp, start) - start,
    duration: (to - from) / sampleRate,
  };
}

/**
 * @param {object} mb the loaded mediabunny module
 * @param {Awaited<ReturnType<import('./engine.js').openAudio>>} opened
 * @param {{index:number, start:number, end:number}} seg
 * @param {object|null} tags from chunkTags(); null writes none
 * @param {{onPlan?: (plan: {start:number, end:number, count:number, silent:number, seconds:number}) => void}} [opts]
 *   onPlan receives the resolved boundaries (source timestamps) and the
 *   pre-roll plan. The PCM branch reports seg.start/seg.end as given — no
 *   snapping, no pre-roll; `end` is Infinity for the last chunk only on the
 *   compressed path.
 * @returns {Promise<Blob>}
 * @throws {Error} 'empty_chunk' when both cuts resolve to the same packet boundary
 */
export async function cutSegment(mb, opened, seg, tags, { onPlan } = {}) {
  const { track, codec, sampleRate, channels } = opened;
  const sink = new mb.EncodedPacketSink(track);
  const bpf = bytesPerFrame(codec, channels);
  const first = await sink.getFirstPacket();
  const isFirst = seg.index === 0;
  // Peak memory for one chunk is roughly three times its size: BufferTarget's
  // internal buffer doubles as it grows, finalize() slices out the exact
  // length, and the Blob wraps that slice — three live copies at once. The
  // source, by contrast, is read through mediabunny's 8 MiB packet cache and
  // never held whole.
  const output = new mb.Output({ format: opened.makeOutputFormat(mb), target: new mb.BufferTarget() });
  if (tags) output.setMetadataTags(tags);
  const source = new mb.EncodedAudioPacketSource(codec);
  output.addAudioTrack(source);
  const config = await track.getDecoderConfig();

  if (bpf) {
    await output.start();
    const meta = { decoderConfig: config };
    let packet = isFirst ? first : ((await sink.getPacket(seg.start)) ?? first);
    let k = 0;
    while (packet && packet.timestamp < seg.end) {
      const b = pcmSliceBounds(packet, seg.start, seg.end, sampleRate, bpf);
      if (b) {
        await source.add(new mb.EncodedPacket(packet.data.subarray(b.from, b.to), 'key', b.timestamp, b.duration), meta);
        k += 1;
        if (k % YIELD_EVERY === 0) await yieldToEventLoop();
      }
      packet = await sink.getNextPacket(packet);
    }
    onPlan?.({ start: seg.start, end: seg.end, ...NONE });
  } else {
    const startPacket = isFirst ? first : await resolveBoundary(sink, seg.start);
    const stopAt = seg.end >= opened.duration ? Infinity : (await resolveBoundary(sink, seg.end)).timestamp;
    if (startPacket.timestamp >= stopAt) throw new Error('empty_chunk');
    // The planner's window: up to LOOKBACK_SEC of packets before the
    // boundary, the boundary itself, and up to LOOKAHEAD_PACKETS after it
    // (never past the end boundary). A few hundred packets at most.
    const before = [];
    if (!isFirst) {
      let p = (await sink.getPacket(Math.max(opened.firstTimestamp, startPacket.timestamp - LOOKBACK_SEC))) ?? first;
      while (p && p.timestamp < startPacket.timestamp) { before.push(p); p = await sink.getNextPacket(p); }
    }
    const after = [];
    let next = startPacket;
    while (next && next.timestamp < stopAt && after.length <= LOOKAHEAD_PACKETS) { after.push(next); next = await sink.getNextPacket(next); }
    const boundary = boundaryFor(codec);
    const plan = boundary.preroll([...before, ...after], before.length);
    onPlan?.({ start: startPacket.timestamp, end: stopAt, ...plan });
    const meta = { decoderConfig: boundary.decoderConfig ? boundary.decoderConfig(config, plan) : config };
    await output.start();
    const queue = [...before.slice(before.length - plan.count), ...after];
    const base = queue[0].timestamp;
    let k = 0;
    let samples = 0;
    const emit = async (packet) => {
      const data = boundary.prepare ? boundary.prepare(packet.data, k, samples, plan) : packet.data;
      await source.add(new mb.EncodedPacket(data, 'key', packet.timestamp - base, packet.duration), meta);
      k += 1;
      samples += Math.round(packet.duration * sampleRate);
      if (k % YIELD_EVERY === 0) await yieldToEventLoop();
    };
    for (const packet of queue) await emit(packet);
    while (next && next.timestamp < stopAt) { await emit(next); next = await sink.getNextPacket(next); }
  }
  await output.finalize();
  return new Blob([output.target.buffer], { type: opened.mime });
}
