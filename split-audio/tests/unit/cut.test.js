// Two layers. The pure helpers (pickNearest, prerollPlan, prerollBySeconds,
// pcmSliceBounds, bytesPerFrame) get exact pins. cutSegment then runs for
// real against every fixture: three equal parts, each chunk reopened with
// mediabunny. The invariant is the spec addendum's: the INTENDED packet
// ranges of a cut list partition the source, and each chunk carries exactly
// its codec's pre-roll before its range (none for WAV and FLAC, one packet
// for Vorbis and AAC, 400 ms for Opus, reservoir-derived for MP3). Node
// cannot decode the compressed chunks (no WebCodecs); the decoded-PCM oracle
// scripts/verify-audio-chunks.mjs does that with ffmpeg.
//
// Measured on the fixtures 2026-09-03 (equal parts 3, cuts near 1 s and 2 s):
//   mp3    116 packets; boundaries at packets 39 and 77; pre-roll 5 frames (3 silenced) = 130.6 ms
//   m4a    131 packets; boundaries 44 and 87; pre-roll 1 frame
//   opus   151 packets; boundaries 51 and 101; pre-roll 20 packets = 400 ms; pre-skip 19200, chunk 1 keeps 312
//   vorbis 131 packets; boundaries 45 and 88; pre-roll 1 packet
//   flac   130 packets; boundaries 43 and 86; no pre-roll, frames renumbered from 0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openAudio, chunkTags } from '../../js/engine.js';
import { equalParts, segmentsFromCuts } from '../../js/segments.js';
import {
  OPUS_PREROLL_SEC, boundaryFor, bytesPerFrame, pickNearest, prerollPlan, prerollBySeconds, pcmSliceBounds, cutSegment,
} from '../../js/cut.js';
import { readFlacFrameNumber } from '../../js/flac-renumber.js';
import { readSideInfo } from '../../js/mp3-frames.js';
import { readOpusPreSkip } from '../../js/opus-head.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const mb = await import('../../../vendor/mediabunny/mediabunny.min.mjs');
const fixture = (name) => new File([readFileSync(resolve(__dir, '../fixtures', name))], name);

async function packetsOf(opened) {
  const sink = new mb.EncodedPacketSink(opened.track);
  const out = [];
  for (let p = await sink.getFirstPacket(); p; p = await sink.getNextPacket(p)) out.push(p);
  return out;
}

// Expected pre-roll per codec for a boundary at source packet i0 (0 = the file start).
const PREROLL = {
  mp3: (i0) => (i0 ? { count: 5, silent: 3 } : { count: 0, silent: 0 }),
  aac: (i0) => ({ count: i0 ? 1 : 0, silent: 0 }),
  vorbis: (i0) => ({ count: i0 ? 1 : 0, silent: 0 }),
  opus: (i0) => ({ count: i0 ? 20 : 0, silent: 0 }),
  flac: () => ({ count: 0, silent: 0 }),
};

test('bytesPerFrame knows the PCM layouts and returns 0 for compressed codecs', () => {
  assert.equal(bytesPerFrame('pcm-s16', 2), 4);
  assert.equal(bytesPerFrame('pcm-s24', 1), 3);
  assert.equal(bytesPerFrame('pcm-f32', 2), 8);
  assert.equal(bytesPerFrame('mp3', 2), 0);
});

test('boundaryFor refuses a codec without a measured strategy', () => {
  assert.throws(() => boundaryFor('ac3'), /codec_unsupported/);
  assert.equal(boundaryFor('flac').preroll().count, 0);
});

test('pickNearest chooses the packet boundary nearest the cut; ties go to the earlier packet', () => {
  const a = { timestamp: 1 };
  const b = { timestamp: 2 };
  assert.equal(pickNearest(a, b, 1.4), a);
  assert.equal(pickNearest(a, b, 1.6), b);
  assert.equal(pickNearest(a, b, 1.5), a);
  assert.equal(pickNearest(a, null, 9), a, 'last packet of the file');
});

test('prerollPlan and prerollBySeconds count packets back from the boundary and sum their durations', () => {
  const w = Array.from({ length: 6 }, (_, i) => ({ timestamp: i * 0.02, duration: 0.02 }));
  assert.deepEqual(prerollPlan(w, 4, 2), { count: 2, silent: 0, seconds: 0.04 });
  assert.deepEqual(prerollPlan(w, 1, 5, 3), { count: 1, silent: 1, seconds: 0.02 }, 'never more than exist');
  assert.deepEqual(prerollPlan(w, 0, 1), { count: 0, silent: 0, seconds: 0 });
  assert.equal(prerollBySeconds(w, 5, 0.05).count, 3, 'covers at least the requested time');
  assert.equal(prerollBySeconds(w, 5, 0.06).count, 3, 'three 20 ms packets are 60 ms even in floating point');
  assert.equal(prerollBySeconds(w, 5, 0.1).count, 5, 'window shorter than requested: all of it');
  assert.equal(OPUS_PREROLL_SEC, 0.4);
});

test('pcmSliceBounds slices at the sample and re-bases the timestamp', () => {
  const sr = 44100, bpf = 4;
  const pkt = { timestamp: 0.975, duration: 0.05, data: new Uint8Array(2205 * bpf) }; // 2205 frames
  const mid = pcmSliceBounds(pkt, 1.0, 2.0, sr, bpf);
  assert.equal(mid.from, Math.round(0.025 * sr) * bpf);
  assert.equal(mid.to, 2205 * bpf);
  assert.equal(mid.timestamp, 0);
  assert.ok(Math.abs(mid.duration - (2205 - Math.round(0.025 * sr)) / sr) < 1e-9);
  const whole = pcmSliceBounds({ ...pkt, timestamp: 1.5 }, 1.0, 2.0, sr, bpf);
  assert.deepEqual([whole.from, whole.to], [0, 2205 * bpf]);
  assert.ok(Math.abs(whole.timestamp - 0.5) < 1e-9);
  const tail = pcmSliceBounds({ ...pkt, timestamp: 1.98 }, 1.0, 2.0, sr, bpf);
  assert.equal(tail.to, Math.round(0.02 * sr) * bpf);
  assert.equal(pcmSliceBounds({ ...pkt, timestamp: 2.0 }, 1.0, 2.0, sr, bpf), null);
  assert.equal(pcmSliceBounds({ ...pkt, timestamp: 0.9 }, 1.0, 2.0, sr, bpf), null, 'ends before start');
  // Adjacent segments meet at the same sample: no gap, no overlap.
  const a = pcmSliceBounds(pkt, 0, 1.0, sr, bpf), b = pcmSliceBounds(pkt, 1.0, 2.0, sr, bpf);
  assert.equal(a.to, b.from);
});

for (const name of ['tone-3s.mp3', 'tone-3s.wav', 'tone-3s.m4a', 'tone-3s.ogg', 'tone-3s-vorbis.ogg', 'tone-3s.flac']) {
  test(`cutSegment splits ${name} into three chunks whose intended ranges partition the source`, async () => {
    const opened = await openAudio(mb, fixture(name));
    const segs = segmentsFromCuts(equalParts(3, opened.duration), opened.duration);
    const src = await packetsOf(opened);
    const frameSec = src[2].duration;   // packet 1 of a Vorbis stream is a short block; 2 is a full one
    let previousEnd = null;
    let counted = 0;
    for (const seg of segs) {
      let plan = null;
      const tags = chunkTags(opened.tags, 'tone-3s', seg.index, segs.length);
      const blob = await cutSegment(mb, opened, seg, tags, { onPlan: (p) => { plan = p; } });
      assert.ok(blob.size > 0);
      assert.equal(blob.type, opened.mime);
      const back = await openAudio(mb, new File([blob], `chunk.${opened.ext}`));
      assert.equal(back.codec, opened.codec);
      assert.equal(back.container, opened.container);
      assert.equal(back.tags?.title, `${opened.tags?.title || 'tone-3s'} (part ${seg.index + 1})`);
      assert.equal(back.tags?.trackNumber, seg.index + 1);
      assert.equal(back.tags?.tracksTotal, 3);
      if (opened.isPcm) {
        assert.ok(Math.abs(back.duration - (seg.end - seg.start)) < 1e-6, `${name} part ${seg.index + 1}: ${back.duration}`);
        continue;
      }
      // Both neighbours resolved the same boundary.
      if (previousEnd !== null) assert.equal(plan.start, previousEnd);
      previousEnd = plan.end;
      const i0 = src.findIndex((p) => p.timestamp === plan.start);
      const i1 = plan.end === Infinity ? src.length : src.findIndex((p) => p.timestamp === plan.end);
      assert.ok(i0 >= 0 && i1 > i0, `${name} part ${seg.index + 1}: boundaries ${i0}..${i1}`);
      if (seg.index === 0) assert.equal(i0, 0);
      counted += i1 - i0;
      const want = PREROLL[opened.codec](i0);
      assert.equal(plan.count, want.count, `${name} part ${seg.index + 1}: pre-roll count`);
      assert.equal(plan.silent, want.silent, `${name} part ${seg.index + 1}: silenced count`);
      const chunkPackets = await packetsOf(back);
      assert.equal(chunkPackets.length, (i1 - i0) + plan.count, `${name} part ${seg.index + 1}: chunk = pre-roll + intended range`);
      // Duration: the intended range, plus the pre-roll for every codec except
      // Opus, whose rewritten pre-skip hides it from any reader.
      const intended = (plan.end === Infinity ? opened.duration : plan.end) - plan.start;
      const extra = opened.codec === 'opus' ? 0 : plan.seconds;
      assert.ok(Math.abs(back.duration - (intended + extra)) <= frameSec * 1.5, `${name} part ${seg.index + 1}: ${back.duration} vs ${intended + extra}`);
      if (opened.codec === 'flac') {
        assert.equal(readFlacFrameNumber(chunkPackets[0].data), 0, 'FLAC chunk frames renumbered from 0');
        assert.equal(readFlacFrameNumber(chunkPackets[chunkPackets.length - 1].data), chunkPackets.length - 1);
      }
      if (opened.codec === 'mp3' && plan.silent) {
        const si = readSideInfo(chunkPackets[0].data);
        assert.equal(si.mainDataBegin, 0, 'first pre-roll frame is silenced');
        assert.ok(si.part23Lengths.every((v) => v === 0));
        assert.deepEqual(chunkPackets[plan.silent].data, src[i0 - plan.count + plan.silent].data, 'first kept frame is intact');
        assert.deepEqual(chunkPackets[plan.count].data, src[i0].data, 'first intended frame is intact');
      }
      if (opened.codec === 'opus') {
        const preSkip = readOpusPreSkip((await back.track.getDecoderConfig()).description);
        assert.equal(preSkip, plan.count ? Math.round(plan.seconds * 48000) : 312);
      }
    }
    if (!opened.isPcm) assert.equal(counted, src.length, 'the intended ranges partition the source');
  });
}

test('cutSegment refuses a chunk whose two cuts resolve to the same packet boundary', async () => {
  const opened = await openAudio(mb, fixture('tone-3s.flac'));
  // FLAC blocks here are 23 ms; cuts 5 ms apart snap to the same packet.
  await assert.rejects(cutSegment(mb, opened, { index: 1, start: 1.0, end: 1.005 }, null), /empty_chunk/);
});
