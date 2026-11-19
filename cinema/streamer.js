// cinema/streamer.js
// Owns the single live playback via @dank074/discord-video-stream's prepareStream.
// Pause = SIGSTOP the ffmpeg proc (Go Live stays up on last frame); resume = SIGCONT.
// Seek rebuilds the pipeline. PLAYLIST: play() accepts an ordered `queue`; on
// natural EOF the streamer advances to the next item IN-PLACE (voice stays joined,
// only the ffmpeg/Go-Live pipe respawns) so a season plays through with no bot
// round-trip and no dependence on in-memory bot state (wiped on every bot restart).
//
// ROBUSTNESS (2026-08-31):
//  * Generation token (_gen): every spawned/killed pipe bumps _gen; a playStream
//    promise's then/catch only acts if its captured gen is still current. This kills
//    the double-advance / episode-skipping bug where a stale or twice-settled promise
//    bumped queueIndex a second time (E03->E05->E07, duplicate onAdvance logs).
//  * Error-skip: a corrupt/unreadable file (ffmpeg "Invalid data found") no longer
//    dead-stops the whole binge; it auto-advances past the bad file. A consecutive-
//    failure cap (MAX_CONSEC_ERRORS) prevents an infinite spin through a run of bad
//    files — after the cap it tears down cleanly so the panel goes idle honestly.

import { Streamer, playStream, prepareStream } from '@dank074/discord-video-stream';
import { streamUrl } from '../utils/jellyfin.js';

const MAX_CONSEC_ERRORS = 4;

export class CinemaStreamer {
  constructor(client, encodeDefaults) {
    this.streamer = new Streamer(client);
    this.enc = encodeDefaults;
    this.session = null;
    this.ff = null;
    this._command = null;
    this.positionSecs = 0;
    this.status = 'idle';
    this._base = 0;
    this._abort = null;
    this._playPromise = null;
    this._intentionalStop = false;
    this._gen = 0;           // generation token — see file header
    this._consecErrors = 0;  // consecutive spawn failures (reset on real playback)
    this._advancing = false; // re-entrancy guard for playNext()
    this.queue = [];
    this.queueIndex = 0;
    this.onEnd = null;
    this.onError = null;
    this.onAdvance = null;
  }

  isBusy() { return this.session != null; }

  async play({ guildId, voiceChannelId, itemId, itemName, audioIndex, subIndex, queue }) {
    if (this.session) throw new Error('busy');
    await this.streamer.joinVoice(guildId, voiceChannelId);
    this.queue = (Array.isArray(queue) && queue.length) ? queue.slice() : [{ itemId, itemName }];
    this.queueIndex = 0;
    this._consecErrors = 0;
    const first = this.queue[0];
    this.session = { guildId, voiceChannelId, itemId: first.itemId, itemName: first.itemName, audioIndex, subIndex };
    this.positionSecs = 0;
    await this._spawnPipe(0);
    this.status = 'playing';
    return { ok: true };
  }

  // Advance to next queue item in-place (voice stays joined). Used by natural EOF,
  // error-skip, AND manual skip. Re-entrancy-guarded so a racing auto+manual (or a
  // twice-settled promise) cannot double-advance.
  async playNext() {
    if (!this.session) return { done: true };
    if (this._advancing) return { done: false, skipped: true };
    this._advancing = true;
    try {
      if (this.queueIndex >= this.queue.length - 1) {
        this._teardown();
        try { await this.streamer.leaveVoice(); } catch { /* */ }
        this.onEnd?.();
        return { done: true };
      }
      this._killPipe();
      this.queueIndex += 1;
      const next = this.queue[this.queueIndex];
      this.session.itemId = next.itemId;
      this.session.itemName = next.itemName;
      this.positionSecs = 0;
      await this._spawnPipe(0);
      this.status = 'playing';
      this.onAdvance?.();
      return { done: false, item: next };
    } finally {
      this._advancing = false;
    }
  }

  async _spawnPipe(startSecs) {
    const s = this.session;
    const url = streamUrl(s.itemId);
    this._base = startSecs;
    this._intentionalStop = false;
    this._abort = new AbortController();
    const gen = ++this._gen; // this pipe's generation; captured by the callbacks below
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
    command?.on?.('start', () => { this.ff = command.ffmpegProc || this.ff; });
    command?.on?.('progress', (p) => {
      const m = (p?.timemark || '').match(/(\d+):(\d+):(\d+)/);
      if (m) {
        this.positionSecs = this._base + (+m[1] * 3600 + +m[2] * 60 + +m[3]);
        this._consecErrors = 0; // real frames are flowing — this file is healthy
      }
    });
    this._playPromise = playStream(output, this.streamer, { type: 'go-live' }, this._abort.signal)
      .then(() => {
        if (gen !== this._gen || this._intentionalStop) return; // stale/aborted pipe — ignore
        this._consecErrors = 0; // clean end of a file
        if (this.queueIndex < this.queue.length - 1) {
          this.playNext().catch((e) => this.onError?.(e));
        } else {
          this._teardown();
          this.streamer.leaveVoice().catch(() => {});
          this.onEnd?.();
        }
      })
      .catch((e) => {
        if (gen !== this._gen || this._intentionalStop || this.status === 'idle') return; // stale/aborted — ignore
        this.onError?.(e);
        this._consecErrors += 1;
        // Skip past a broken/unreadable file to the next episode instead of dead-stopping.
        if (this._consecErrors <= MAX_CONSEC_ERRORS && this.queueIndex < this.queue.length - 1) {
          this.playNext().catch((err) => this.onError?.(err));
        } else {
          // First/only item failed, or too many bad files in a row — stop honestly.
          this._teardown();
          this.streamer.leaveVoice().catch(() => {});
          this.onEnd?.();
        }
      });
  }

  _proc() { return this.ff || this._command?.ffmpegProc || null; }

  async pause() {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    const proc = this._proc();
    if (proc) { try { proc.kill('SIGSTOP'); } catch { /* */ } }
  }

  async resume() {
    if (this.status !== 'paused') return;
    this.status = 'playing';
    const proc = this._proc();
    if (proc) { try { proc.kill('SIGCONT'); } catch { /* */ } }
    else await this._spawnPipe(this.positionSecs);
  }

  async seek(secs) {
    if (!this.session) return;
    const wasPaused = this.status === 'paused';
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

  _killPipe() {
    this._intentionalStop = true;
    this._gen++; // invalidate the outgoing pipe's callbacks
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
    this.queue = [];
    this.queueIndex = 0;
    this._consecErrors = 0;
    this._advancing = false;
  }

  state() {
    const upNext = (this.session && this.queueIndex + 1 < this.queue.length) ? this.queue[this.queueIndex + 1] : null;
    return {
      busy: this.isBusy(), status: this.status, positionSecs: this.positionSecs, session: this.session,
      queueLength: this.queue.length, queueIndex: this.queueIndex,
      queueRemaining: this.session ? Math.max(0, this.queue.length - this.queueIndex - 1) : 0,
      upNext: upNext ? { itemId: upNext.itemId, itemName: upNext.itemName } : null,
    };
  }
}
