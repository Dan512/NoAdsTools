// split-audio/js/engine.js — open an audio file with mediabunny and describe
// it. DOM-free and Node-testable: `mb` (the loaded mediabunny module) is a
// parameter, and the file is any Blob (a File in the browser, Node's File in
// tests). main.js owns the lazy loader and the <audio> canPlayType check.

export class AudioOpenError extends Error {
  /**
   * @param {'unsupported_container'|'video_file'|'no_audio'|'codec_unsupported'|'damaged'|'unknown_length'} code
   * @param {string} detail
   * @param {string} container container label, when one was identified before the throw
   */
  constructor(code, detail = '', container = '') {
    super(code);
    this.name = 'AudioOpenError';
    this.code = code;
    this.detail = detail;
    this.container = container;
  }
}

// Same container in, mostly the same container out — the one exception is
// QuickTime: an audio-only .mov is remuxed to MP4 and labelled M4A (correct
// behaviour, just not "same"). `make` builds a fresh OutputFormat per cut
// because an Output owns its format instance. IsobmffInputFormat covers
// both the MP4 and QuickTime flavours of .m4a.
//
// `codecs` is an explicit allowlist of what cut.js has a measured boundary
// strategy for (see its BOUNDARY table), not everything the output format
// can technically produce — Mp4OutputFormat, for instance, also accepts
// ac3, eac3, opus and flac, but a chunk in one of those would get no
// pre-roll and a garbled lead-in. Anything not on the list is rejected as
// codec_unsupported, naming the codec, rather than silently shipping a bad
// cut.
const CONTAINERS = [
  { is: (mb, f) => f instanceof mb.Mp3InputFormat,     label: 'MP3',  ext: 'mp3',  mime: 'audio/mpeg', make: (mb) => new mb.Mp3OutputFormat(), codecs: ['mp3'] },
  { is: (mb, f) => f instanceof mb.WaveInputFormat,    label: 'WAV',  ext: 'wav',  mime: 'audio/wav',  make: (mb) => new mb.WavOutputFormat(), codecs: (mb) => mb.PCM_AUDIO_CODECS },
  { is: (mb, f) => f instanceof mb.IsobmffInputFormat, label: 'M4A',  ext: 'm4a',  mime: 'audio/mp4',  make: (mb) => new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), codecs: ['aac'] },
  { is: (mb, f) => f instanceof mb.OggInputFormat,     label: 'OGG',  ext: 'ogg',  mime: 'audio/ogg',  make: (mb) => new mb.OggOutputFormat(), codecs: ['opus', 'vorbis'] },
  { is: (mb, f) => f instanceof mb.FlacInputFormat,    label: 'FLAC', ext: 'flac', mime: 'audio/flac', make: (mb) => new mb.FlacOutputFormat(), codecs: ['flac'] },
];

// getDurationFromMetadata() reads the container's own figure (STREAMINFO,
// mvhd, the WAV data chunk size, a Xing header) and returns instantly; it
// matched computeDuration()'s full packet scan on every intact fixture.
// computeDuration() is the fallback for Ogg, whose containers carry no such
// figure. FLAC is the one container whose scan can hang: on a FLAC whose
// stream is truncated it loops forever, synchronously (a tab freeze; a
// Promise.race timeout can't rescue a synchronous loop). And a FLAC that
// never recorded its length — STREAMINFO total_samples = 0, what a streamed
// encode (`flac -`, `ffmpeg -f flac -` piped to stdout) writes — is exactly
// the file that would fall through to that scan. So it is refused honestly
// rather than risked. Every other container is safe to scan.
async function readDuration(input, container) {
  const known = await input.getDurationFromMetadata();
  if (known != null) return known;
  if (container.label === 'FLAC') throw new AudioOpenError('unknown_length', '', container.label);
  return input.computeDuration();
}

/**
 * @returns {Promise<{input:object, track:object, codec:string, duration:number,
 *   firstTimestamp:number, sampleRate:number, channels:number, isPcm:boolean,
 *   container:string, ext:string, mime:string, makeOutputFormat:(mb:object)=>object,
 *   tags:object|null, canDecode:boolean}>}
 */
async function describe(mb, input) {
  let format = null;
  try { format = await input.getFormat(); } catch { format = null; }
  const container = format && CONTAINERS.find((c) => c.is(mb, format));
  if (!container) throw new AudioOpenError('unsupported_container');
  if (await input.getPrimaryVideoTrack()) throw new AudioOpenError('video_file');
  const track = await input.getPrimaryAudioTrack();
  // mediabunny's Ogg demuxer maps only Opus and Vorbis tracks; an Ogg
  // stream carrying anything else (FLAC-in-Ogg, for instance) comes back
  // with no primary audio track at all. That's our codec support limit,
  // not a missing track, so it's reported as codec_unsupported rather than
  // the misleading no_audio.
  if (!track) throw new AudioOpenError(container.label === 'OGG' ? 'codec_unsupported' : 'no_audio', 'unknown', container.label);
  const codec = track.codec;
  const allowed = typeof container.codecs === 'function' ? container.codecs(mb) : container.codecs;
  if (!codec || !allowed.includes(codec) || !container.make(mb).getSupportedCodecs().includes(codec)) {
    throw new AudioOpenError('codec_unsupported', codec || 'unknown', container.label);
  }
  const [duration, tags, canDecode, firstTimestamp] = await Promise.all([
    readDuration(input, container), input.getMetadataTags(), track.canDecode(), track.getFirstTimestamp(),
  ]);
  return {
    input, track, codec, duration, firstTimestamp,
    sampleRate: track.sampleRate, channels: track.numberOfChannels,
    isPcm: mb.PCM_AUDIO_CODECS.includes(codec),
    container: container.label, ext: container.ext, mime: container.mime,
    makeOutputFormat: container.make, tags: tags || null, canDecode,
  };
}

export async function openAudio(mb, file) {
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    return await describe(mb, input);
  } catch (e) {
    input.dispose?.();
    throw e instanceof AudioOpenError ? e : new AudioOpenError('damaged', String(e?.message ?? e));
  }
}

// The fields mediabunny's setMetadataTags validates, minus `raw` (encoder
// noise that can carry a stale track number) and the two we set ourselves.
const TAG_FIELDS = ['title', 'description', 'artist', 'album', 'albumArtist', 'discNumber', 'discsTotal', 'genre', 'date', 'lyrics', 'images', 'comment'];

/** Per-chunk tags: the source's, with title suffixed and trackNumber/tracksTotal set. */
export function chunkTags(source, fallbackTitle, index, count) {
  const tags = {};
  for (const k of TAG_FIELDS) if (source && source[k] !== undefined) tags[k] = source[k];
  tags.title = `${(source && source.title) || fallbackTitle} (part ${index + 1})`;
  tags.trackNumber = index + 1;
  tags.tracksTotal = count;
  return tags;
}

/** "WAV, 44.1 kHz stereo" for the summary line. */
export function describeAudio({ container, sampleRate, channels }) {
  const khz = String(+(sampleRate / 1000).toFixed(3));
  const ch = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`;
  return `${container}, ${khz} kHz ${ch}`;
}
