// openAudio runs against the real fixtures with the real vendored
// mediabunny (it imports in Node). What is pinned: container detection,
// codec, duration, tags, and the four named rejections. canDecode is false
// for compressed codecs in Node (no WebCodecs) and true for WAV; the browser
// spec covers the decoding path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openAudio, AudioOpenError, chunkTags, describeAudio } from '../../js/engine.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const mb = await import('../../../vendor/mediabunny/mediabunny.min.mjs');
const fixture = (name) => new File([readFileSync(resolve(__dir, '../fixtures', name))], name);

const EXPECT = {
  'tone-3s.mp3':  { container: 'MP3',  ext: 'mp3',  mime: 'audio/mpeg', codec: 'mp3',     sampleRate: 44100, isPcm: false, title: 'Tone' },
  'tone-3s.wav':  { container: 'WAV',  ext: 'wav',  mime: 'audio/wav',  codec: 'pcm-s16', sampleRate: 44100, isPcm: true,  title: undefined },
  'tone-3s.m4a':  { container: 'M4A',  ext: 'm4a',  mime: 'audio/mp4',  codec: 'aac',     sampleRate: 44100, isPcm: false, title: 'Tone' },
  'tone-3s.ogg':  { container: 'OGG',  ext: 'ogg',  mime: 'audio/ogg',  codec: 'opus',    sampleRate: 48000, isPcm: false, title: undefined },
  'tone-3s-vorbis.ogg': { container: 'OGG', ext: 'ogg', mime: 'audio/ogg', codec: 'vorbis', sampleRate: 44100, isPcm: false, title: undefined },
  'tone-3s.flac': { container: 'FLAC', ext: 'flac', mime: 'audio/flac', codec: 'flac',    sampleRate: 44100, isPcm: false, title: undefined },
};

for (const [name, want] of Object.entries(EXPECT)) {
  test(`openAudio describes ${name}`, async () => {
    const o = await openAudio(mb, fixture(name));
    assert.equal(o.container, want.container);
    assert.equal(o.ext, want.ext);
    assert.equal(o.mime, want.mime);
    assert.equal(o.codec, want.codec);
    assert.equal(o.sampleRate, want.sampleRate);
    assert.equal(o.channels, 2);
    assert.equal(o.isPcm, want.isPcm);
    assert.ok(o.duration > 2.9 && o.duration < 3.1, `duration ${o.duration}`);
    assert.equal(o.tags?.title, want.title);
    assert.equal(typeof o.makeOutputFormat, 'function');
    assert.ok(o.makeOutputFormat(mb).getSupportedCodecs().includes(o.codec));
    assert.equal(typeof o.canDecode, 'boolean');
    assert.ok(Number.isFinite(o.firstTimestamp));
  });
}

test('a video file is rejected as video_file', async () => {
  await assert.rejects(openAudio(mb, fixture('tiny.mp4')), (e) => e instanceof AudioOpenError && e.code === 'video_file');
});

test('a non-media file is rejected as unsupported_container', async () => {
  await assert.rejects(openAudio(mb, fixture('not-audio.txt')), (e) => e instanceof AudioOpenError && e.code === 'unsupported_container');
});

test('chunkTags copies the known fields, suffixes the title, and numbers the track', () => {
  const src = { title: 'Album Side A', artist: 'X', album: 'Y', images: [{ data: new Uint8Array(1) }], raw: { TSSE: 'enc' } };
  const t = chunkTags(src, 'fallback', 2, 5);
  assert.equal(t.title, 'Album Side A (part 3)');
  assert.equal(t.artist, 'X'); assert.equal(t.album, 'Y'); assert.equal(t.images, src.images);
  assert.equal(t.trackNumber, 3); assert.equal(t.tracksTotal, 5);
  assert.equal('raw' in t, false, 'raw is not forwarded');
  assert.equal(chunkTags(undefined, 'goblins', 0, 1).title, 'goblins (part 1)');
});

test('describeAudio reads like the summary line', () => {
  assert.equal(describeAudio({ container: 'WAV', sampleRate: 44100, channels: 2 }), 'WAV, 44.1 kHz stereo');
  assert.equal(describeAudio({ container: 'OGG', sampleRate: 48000, channels: 1 }), 'OGG, 48 kHz mono');
  assert.equal(describeAudio({ container: 'FLAC', sampleRate: 96000, channels: 6 }), 'FLAC, 96 kHz 6 channels');
  assert.equal(describeAudio({ container: 'MP3', sampleRate: 22050, channels: 2 }), 'MP3, 22.05 kHz stereo');
  assert.equal(describeAudio({ container: 'MP3', sampleRate: 11025, channels: 1 }), 'MP3, 11.025 kHz mono');
  assert.equal(describeAudio({ container: 'MP3', sampleRate: 8000, channels: 1 }), 'MP3, 8 kHz mono');
});

test('a truncated FLAC settles quickly instead of freezing', async () => {
  const bytes = readFileSync(resolve(__dir, '../fixtures', 'tone-3s.flac')).subarray(0, 8000);
  const file = new File([bytes], 'cut.flac');
  const TIMEOUT = Symbol('timeout');
  const result = await Promise.race([
    openAudio(mb, file).then((o) => ({ ok: true, o })).catch((e) => ({ ok: false, e })),
    new Promise((res) => setTimeout(() => res(TIMEOUT), 5000)),
  ]);
  assert.notEqual(result, TIMEOUT, 'openAudio did not settle within 5s on a truncated FLAC');
  if (result.ok) {
    assert.ok(result.o.duration > 2.9 && result.o.duration < 3.1, `duration ${result.o.duration}`);
  } else {
    assert.ok(result.e instanceof AudioOpenError, `rejected with a non-AudioOpenError: ${result.e}`);
  }
});

// A streamed encode (`flac -` or `ffmpeg -f flac -` piped to stdout) leaves
// STREAMINFO's 36-bit total_samples at 0: the low nibble of byte 21 plus
// bytes 22-25. Such a file records no length, so it is refused rather than
// sent into computeDuration()'s scan — refused by the header, not by the
// truncation, which is why the whole file is refused too.
test('a FLAC that does not record its length is refused, truncated or whole', async () => {
  const streamed = () => {
    const b = Uint8Array.from(readFileSync(resolve(__dir, '../fixtures', 'tone-3s.flac')));
    b[21] &= 0xF0; b[22] = b[23] = b[24] = b[25] = 0;
    return b;
  };
  const TIMEOUT = Symbol('timeout');
  const settle = async (bytes) => {
    let timer;
    const r = await Promise.race([
      openAudio(mb, new File([bytes], 'streamed.flac')).then((o) => ({ ok: true, o }), (e) => ({ ok: false, e })),
      new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), 5000); }),
    ]);
    clearTimeout(timer);
    return r;
  };
  for (const [label, bytes] of [['truncated', streamed().subarray(0, 8000)], ['whole', streamed()]]) {
    const r = await settle(bytes);
    assert.notEqual(r, TIMEOUT, `openAudio did not settle within 5s on the ${label} streamed FLAC`);
    assert.equal(r.ok, false, `the ${label} streamed FLAC was accepted instead of refused`);
    assert.ok(r.e instanceof AudioOpenError, `${label}: rejected with a non-AudioOpenError: ${r.e}`);
    assert.equal(r.e.code, 'unknown_length', label);
    assert.equal(r.e.container, 'FLAC', label);
  }
});

test('damaged files are rejected as damaged, never with an internal message', async () => {
  const wavBytes = readFileSync(resolve(__dir, '../fixtures', 'tone-3s.wav')).subarray(0, 60);
  await assert.rejects(
    openAudio(mb, new File([wavBytes], 'cut.wav')),
    (e) => e instanceof AudioOpenError && e.code === 'damaged',
  );
  const oggBytes = readFileSync(resolve(__dir, '../fixtures', 'tone-3s-vorbis.ogg')).subarray(0, 2000);
  await assert.rejects(
    openAudio(mb, new File([oggBytes], 'cut.ogg')),
    (e) => e instanceof AudioOpenError && e.code === 'damaged',
  );
});

test('Ogg FLAC is codec_unsupported, not no_audio', async () => {
  await assert.rejects(
    openAudio(mb, fixture('tone-1s-oggflac.ogg')),
    (e) => e instanceof AudioOpenError && e.code === 'codec_unsupported' && e.container === 'OGG',
  );
});

test('ALAC in M4A is codec_unsupported and names the codec when mediabunny knows it', async () => {
  await assert.rejects(
    openAudio(mb, fixture('tone-1s-alac.m4a')),
    (e) => e instanceof AudioOpenError && e.code === 'codec_unsupported' && e.container === 'M4A' && typeof e.detail === 'string',
  );
});
