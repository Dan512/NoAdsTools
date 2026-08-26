// compress-video/js/probe.js — read the facts plan-encode.js needs from the
// source file. Uses mediabunny's Input (demux only — nothing is decoded
// here, so probing is fast even for big files).
import { loadMediabunny } from './engine.js';

let testProbe = null; // injected by _setProbeForTest

/**
 * @param {File} file
 * @returns {Promise<{durationSec:number, width:number, height:number,
 *   fps:number, audioBytes:number, hasAudio:boolean, sourceBytes:number}>}
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
  const audio = await input.getPrimaryAudioTrack();
  if (audio) {
    hasAudio = true;
    const aStats = await audio.computePacketStats(200);
    // The measured constant the size math subtracts (spec §5): audio is
    // copied, so its byte count is bitrate × duration, not a guess.
    audioBytes = Math.ceil((aStats.averageBitrate * durationSec) / 8);
  }
  if (!(durationSec > 0) || !(width > 0) || !(height > 0) || !(fps > 0)) {
    throw new Error('probe_no_video_track');
  }
  return { durationSec, width, height, fps, audioBytes, hasAudio, sourceBytes: file.size };
}

// ---------- Test escape hatches ---------------------------------------------

/** Replace probeFile for specs. Pass null to clear. */
export function _setProbeForTest(fn) { testProbe = fn; }
