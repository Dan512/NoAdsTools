// compress-video/js/probe.js — read the facts plan-encode.js needs from the
// source file. Uses mediabunny's Input (demux only — nothing is decoded
// here, so probing is fast even for big files).
import { loadMediabunny } from './engine.js';

let testProbe = null; // injected by _setProbeForTest

/**
 * @param {File} file
 * @returns {Promise<{durationSec:number, width:number, height:number,
 *   fps:number, audioBytes:number, hasAudio:boolean, sourceBytes:number,
 *   audioBitrate:number, audioCopyable:boolean}>} the source codec NAME is
 *   deliberately not among these: it is used here to answer audioCopyable
 *   and nothing downstream ever needs the string itself. Same reason
 *   audioChannels was dropped. Return it again if a disclosure ever needs
 *   to say what the source format was.
 * @throws {Error('probe_no_video_track')} for audio-only / unreadable files
 *   (EngineLoadError propagates from the loader).
 */
export async function probeFile(file) {
  if (testProbe) return testProbe(file);
  const mb = await loadMediabunny();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  const durationSec = await input.computeDuration();
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('probe_no_video_track');
  const width = await video.getDisplayWidth();
  const height = await video.getDisplayHeight();
  // Stats from the first ~200 packets: fps settles fast, and full-file scans
  // would make probing large files slow for no planning benefit.
  const vStats = await video.computePacketStats(200);
  const fps = vStats.averagePacketRate;

  let audioBytes = 0;
  let hasAudio = false;
  let audioBitrate = 0;
  let audioCopyable = false;
  const audio = await input.getPrimaryAudioTrack();
  if (audio) {
    hasAudio = true;
    const aStats = await audio.computePacketStats(200);
    // Extrapolated from the first ~200 packets (~4 s of AAC), not the whole
    // file — the same window the video stats use, for the same reason.
    // This is the COPY cost; when the codec can't be copied the planner
    // charges resolveAudio's transcode figure instead (see plan.audioBytes).
    audioBytes = Math.ceil((aStats.averageBitrate * durationSec) / 8);
    audioBitrate = aStats.averageBitrate;
    // Local only — it answers audioCopyable and is not returned; see the
    // note on the @returns above.
    const audioCodec = audio.codec;
    // Whether mediabunny can stream-copy this codec into the MP4 output.
    // When it can't, it transcodes no matter what we ask, and the planner
    // has to charge for THAT (resolveAudio's forced-re-encode branch).
    audioCopyable = audioCodec != null
      && new mb.Mp4OutputFormat().getSupportedAudioCodecs().includes(audioCodec);
  }
  if (!(durationSec > 0) || !(width > 0) || !(height > 0) || !(fps > 0)) {
    throw new Error('probe_no_video_track');
  }
  return {
    durationSec, width, height, fps, audioBytes, hasAudio, sourceBytes: file.size,
    audioBitrate, audioCopyable,
  };
}

// ---------- Test escape hatches ---------------------------------------------

/** Replace probeFile for specs. Pass null to clear. */
export function _setProbeForTest(fn) { testProbe = fn; }
