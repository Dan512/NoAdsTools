// Unit tests for engine.js's pure pre-flight. Importing engine.js from
// node is safe: its module scope touches no DOM (hasWebCodecs only reads
// globals inside the function) and the engine<->calibrate import cycle
// resolves because both only use bindings at call time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDiscards, audioOptions } from '../../js/engine.js';

const vid = { track: { type: 'video' } };
const aud = { track: { type: 'audio' } };

// Minimal fake standing in for the mediabunny module: audioOptions only
// ever constructs mb.Quality, so that's all this needs to provide.
const fakeMb = { Quality: class { constructor(o) { Object.assign(this, o); } } };

test('checkDiscards: discarded video always fails', () => {
  assert.equal(checkDiscards([vid], {}), 'video_unsupported');
  assert.equal(checkDiscards([vid, aud], { audio: { mode: 'remove' } }), 'video_unsupported');
});

test('checkDiscards: discarded audio fails unless removal was requested', () => {
  assert.equal(checkDiscards([aud], { audio: { mode: 'copy' } }), 'audio_unsupported');
  assert.equal(checkDiscards([aud], { audio: { mode: 'encode' } }), 'audio_unsupported');
  assert.equal(checkDiscards([aud], {}), 'audio_unsupported'); // legacy plan shape
  assert.equal(checkDiscards([aud], { audio: { mode: 'remove' } }), null);
});

test('checkDiscards: nothing discarded, or no list at all, passes', () => {
  assert.equal(checkDiscards([], {}), null);
  assert.equal(checkDiscards(undefined, {}), null);
});

test('checkDiscards: video precedence holds even when the audio branch would also fire', () => {
  // Swapping the two `if` blocks would survive every other test here
  // (they all use a plan whose audio branch is inert when video also
  // fails), so this pins video-first with a plan where audio_unsupported
  // WOULD be returned if the audio check ran and won.
  assert.equal(checkDiscards([vid, aud], { audio: { mode: 'copy' } }), 'video_unsupported');
});

test('audioOptions: copy (absent or explicit) leaves audio unconfigured', () => {
  assert.deepEqual(audioOptions(fakeMb, undefined), {});
  assert.deepEqual(audioOptions(fakeMb, { mode: 'copy', bps: null, channels: null }), {});
});

test('audioOptions: remove discards the track', () => {
  assert.deepEqual(audioOptions(fakeMb, { mode: 'remove', bps: 0, channels: null }), {
    audio: { discard: true },
  });
});

test('audioOptions: encode asks for AAC at constant bitrate, channels only when set', () => {
  const opts = audioOptions(fakeMb, { mode: 'encode', bps: 96_000, channels: null });
  assert.equal(opts.audio.codec, 'aac');
  assert.equal(opts.audio.quality.bitrate, 96_000);
  assert.equal(opts.audio.quality.bitrateMode, 'constant');
  assert.equal('numberOfChannels' in opts.audio, false);

  const mono = audioOptions(fakeMb, { mode: 'encode', bps: 64_000, channels: 1 });
  assert.equal(mono.audio.numberOfChannels, 1);
});
