// cinema/streamer.js
// Owns the single live playback. Uses @dank074/discord-video-stream's OWN ffmpeg
// pipeline (prepareStream) because its output is exactly what the library's
// demuxer expects — a hand-rolled `-f nut` pipe produced "No main startcode found"
// and never went live. Trade-off: default audio track, no burned subtitles (the
// custom-encoder path that supported the picker doesn't actually stream).
//
// Pause WITHOUT dropping viewers: SIGSTOP the underlying ffmpeg process (frames
// halt, Go Live stays up on the last frame), SIGCONT to resume. Seek rebuilds the
// pipeline (can't seek a live encoder) and re-freezes if it was paused.

import { Streamer, playStream, prepareStream } from '@dank074/discord-video-stream';
import { streamUrl } from '../utils/jellyfin.js';

export class CinemaStreamer {
  constructor(client, encodeDefaults) {
    this.streamer = new Streamer(client);
    this.enc = encodeDefaults; // { width, height, fps, bitrateKbps }
    this.session = null;
    this.ff = null;            // underlying ffmpeg child process (for SIGSTOP pause)
    this._command = null;      // fluent-ffmpeg command from prepareStream
    this.positionSecs = 0;
    this.status = 'idle';      // idle | playing | paused
    this._base = 0;
    this._abort = null;
    this._playPromise = null;
    this._intentionalStop = false;
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
    this._base = startSecs;
    this._intentionalStop = false;
    this._abort = new AbortController();
    const { command, output } = prepareStream(
      url,
      {
        width: this.enc.width, height: this.enc.height, frameRate: this.enc.fps,
        bitrateVideo: this.enc.bitrateKbps, bitrateVideoMax: this.enc.bitrateKbps,
        customInputOptions: startSecs > 0 ? [`-ss ${startSecs}`] : [],
      },
      this._abort.signal,
    );
    this._command = command;
    this.ff = command?.ffmpegProc || null;
    // ffmpegProc is set when the command actually spawns — capture it for pause.
    command?.on?.('start', () => { this.ff = command.ffmpegProc || this.ff; });
    command?.on?.('progress', (p) => {
      const m = /(\d+):(\d+):(\d+)/.exec(p?.timemark || '');
      if (m) this.positionSecs = this._base + (+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
    // playStream resolves on media EOF (natural end), rejects on abort/error.
    this._playPromise = playStream(output, this.streamer, { type: 'go-live' }, this._abort.signal)
      .then(() => { if (!this._intentionalStop) { this._teardown(); this.onEnd?.(); } })
      .catch((e) => { if (!this._intentionalStop && this.status !== 'idle') this.onError?.(e); });
  }

  _proc() { return this.ff || this._command?.ffmpegProc || null; }

  async pause() {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    // Freeze the encoder — Go Live (and viewers) stay up on the last frame.
    const proc = this._proc();
    if (proc) { try { proc.kill('SIGSTOP'); } catch { /* */ } }
  }

  async resume() {
    if (this.status !== 'paused') return;
    this.status = 'playing';
    const proc = this._proc();
    if (proc) { try { proc.kill('SIGCONT'); } catch { /* */ } }
    else await this._spawnPipe(this.positionSecs); // fallback if process vanished
  }

  async seek(secs) {
    if (!this.session) return;
    const wasPaused = this.status === 'paused';
    // Seek needs a rebuild (briefly drops Go Live, unlike pause).
    this._killPipe();
    this.positionSecs = Math.max(0, secs);
    await this._spawnPipe(this.positionSecs);
    this.status = wasPaused ? 'paused' : 'playing';
    if (wasPaused) { const proc = this._proc(); if (proc) { try { proc.kill('SIGSTOP'); } catch { /* */ } } }
  }

  async stop() {
    this._teardown();
    try { await this.streamer.leaveVoice(); } catch { /* ignore */ }
  }

  // Abort the live playStream + kill ffmpeg, keeping session (seek) or as teardown step.
  _killPipe() {
    this._intentionalStop = true;
    if (this._abort) { try { this._abort.abort(); } catch { /* */ } this._abort = null; }
    const proc = this._proc();
    if (proc) { try { proc.kill('SIGKILL'); } catch { /* */ } }
    this.ff = null;
    this._command = null;
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
