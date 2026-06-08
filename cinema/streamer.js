// cinema/streamer.js
// Owns the single live playback. Wraps @dank074/discord-video-stream so the rest
// of the service deals in play/pause/resume/stop/seek + a position counter.
// Pause/seek/resume are implemented by tearing down and rebuilding the ffmpeg
// pipe at a tracked position. The voice connection (joinVoice) stays up across
// pause/seek; the Go Live stream itself is restarted each time.
//
// v6.0.0 API notes (confirmed against dist/*.d.ts + newApi.js):
//   - new Streamer(client); streamer.joinVoice(guildId, channelId); leaveVoice()
//   - playStream(input, streamer, options?, cancelSignal?) where `input` is a
//     Readable that the library demuxes itself (`options.format`), and `streamer`
//     is the SECOND argument. For Go Live it calls streamer.createStream()
//     internally, so we only joinVoice() first — playStream handles Go Live.
//   - prepareStream() is NOT used: in v6 it runs its OWN ffmpeg (fluent-ffmpeg)
//     against a URL/Readable. We already produce final H.264+Opus matroska via
//     cinema/encode.js (subtitle burn, audio-track map, seek), so we spawn ffmpeg
//     ourselves and feed its matroska stdout straight into playStream with
//     { type:'go-live', format:'matroska' }.
//   - playStream's returned promise resolves when the input EOFs (media ended)
//     and rejects on abort; both run the library's cleanup (which stops Go Live).
//     We drive deliberate stops via an AbortController so cleanup is deterministic.

import { spawn } from 'node:child_process';
import { Streamer, playStream } from '@dank074/discord-video-stream';
import { streamUrl } from '../utils/jellyfin.js';
import { buildFfmpegArgs } from './encode.js';

export class CinemaStreamer {
  constructor(client, encodeDefaults) {
    this.streamer = new Streamer(client);
    this.enc = encodeDefaults; // { width, height, fps, bitrateKbps }
    this.session = null;
    this.ff = null;
    this.positionSecs = 0;
    this.status = 'idle'; // idle | playing | paused
    this._base = 0;
    this._abort = null;
    this._playPromise = null;
    this._intentionalStop = false;
    // Hooks set by the owning service.
    this.onEnd = null;
    this.onError = null;
  }

  isBusy() { return this.session != null; }

  async play({ guildId, voiceChannelId, itemId, itemName, audioIndex, subIndex }) {
    if (this.session) throw new Error('busy');
    await this.streamer.joinVoice(guildId, voiceChannelId);
    this.session = { guildId, voiceChannelId, itemId, itemName, audioIndex, subIndex };
    this.positionSecs = 0;
    await this._spawnPipe(0);
    this.status = 'playing';
    return { ok: true };
  }

  async _spawnPipe(startSecs) {
    const s = this.session;
    const url = streamUrl(s.itemId);
    const args = buildFfmpegArgs({
      streamUrl: url, startSecs,
      audioIndex: s.audioIndex, subIndex: s.subIndex,
      width: this.enc.width, height: this.enc.height,
      fps: this.enc.fps, bitrateKbps: this.enc.bitrateKbps,
    });
    // encode.js produces final matroska; the library demuxes it (no re-encode).
    this.ff = spawn('ffmpeg', [...args, '-progress', 'pipe:2', '-f', 'matroska', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._base = startSecs;
    this._intentionalStop = false;
    this.ff.stderr.on('data', (b) => this._trackProgress(b.toString()));
    this.ff.on('exit', (code) => this._onFfmpegExit(code));

    // Fresh abort controller per pipe so a deliberate kill/stop aborts playStream.
    this._abort = new AbortController();
    // v6: playStream(input, streamer, options, cancelSignal). It runs
    // streamer.createStream() (Go Live) itself; we pass the matroska Readable.
    this._playPromise = playStream(
      this.ff.stdout,
      this.streamer,
      { type: 'go-live', format: 'matroska' },
      this._abort.signal,
    ).catch((e) => {
      // Aborts (deliberate pause/seek/stop) reject with the abort reason — ignore.
      if (this._intentionalStop || this.status === 'idle') return;
      this.onError?.(e);
    });
  }

  _trackProgress(text) {
    const m = /out_time_ms=(\d+)/.exec(text);
    if (m) this.positionSecs = this._base + Math.floor(Number(m[1]) / 1_000_000);
  }

  _onFfmpegExit(code) {
    // A clean ffmpeg exit while playing (not a deliberate kill) means the media
    // reached its end. code === null also covers a normal end-of-input close.
    if (this._intentionalStop) return;
    if (this.status === 'playing' && (code === 0 || code === null)) {
      this.onEnd?.();
      this._teardown();
    }
  }

  async pause() {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this._killPipe();
  }

  async resume() {
    if (this.status !== 'paused') return;
    await this._spawnPipe(this.positionSecs);
    this.status = 'playing';
  }

  async seek(secs) {
    if (!this.session) return;
    const wasPaused = this.status === 'paused';
    this._killPipe();
    this.positionSecs = Math.max(0, secs);
    await this._spawnPipe(this.positionSecs);
    if (wasPaused) {
      // Re-establish the paused state: tear the freshly-built pipe back down.
      this.status = 'paused';
      this._killPipe();
    } else {
      this.status = 'playing';
    }
  }

  async stop() {
    this._teardown();
    try { await this.streamer.leaveVoice(); } catch { /* ignore */ }
  }

  // Kill the current ffmpeg + abort the live playStream, without clearing session.
  // Used for pause/seek (we rebuild) and as the inner step of teardown.
  _killPipe() {
    this._intentionalStop = true;
    if (this._abort) { try { this._abort.abort(); } catch { /* */ } this._abort = null; }
    if (this.ff) { try { this.ff.kill('SIGKILL'); } catch { /* */ } this.ff = null; }
    this._playPromise = null;
  }

  _teardown() {
    this.status = 'idle';
    this._killPipe();
    this.session = null;
    this.positionSecs = 0;
  }

  state() {
    return { busy: this.isBusy(), status: this.status, positionSecs: this.positionSecs, session: this.session };
  }
}
