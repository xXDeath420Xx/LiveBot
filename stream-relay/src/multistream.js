'use strict';
const { spawn: realSpawn } = require('node:child_process');
const { buildDestinationUrl, buildFfmpegArgs } = require('./destinations');

class Multistreamer {
  constructor({
    retryLimit = 5,
    retryBaseMs = 2000,
    spawn = realSpawn,
    scheduleRetry,
    onState = () => {}
  } = {}) {
    this.retryLimit = retryLimit;
    this.retryBaseMs = retryBaseMs;
    this.spawn = spawn;
    // default: real timer with exponential backoff (capped at 30s)
    this.scheduleRetry = scheduleRetry || ((fn, attempt) =>
      setTimeout(fn, Math.min(this.retryBaseMs * 2 ** attempt, 30000)));
    this.onState = onState;
    this.streams = new Map(); // streamId -> [{ name, child, stopped }]
  }

  start(streamId, inputUrl, destinations) {
    const procs = destinations.map((dest) => {
      const entry = { name: dest.name, dest, attempts: 0, child: null, stopped: false };
      this._launch(streamId, inputUrl, entry);
      return entry;
    });
    this.streams.set(streamId, procs);
  }

  _launch(streamId, inputUrl, entry) {
    const outputUrl = buildDestinationUrl(entry.dest);
    const args = buildFfmpegArgs(inputUrl, outputUrl);
    this.onState(entry.name, { state: 'connecting' });
    const child = this.spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    entry.child = child;
    // Treat a successful spawn as "live" (passthrough starts immediately).
    this.onState(entry.name, { state: 'live' });

    if (child.stderr) {
      child.stderr.on('data', (d) => {
        const msg = d.toString();
        if (/error/i.test(msg)) entry.lastError = msg.slice(0, 480);
      });
    }
    child.on('close', (code) => {
      if (entry.stopped) return; // intentional stop
      if (code === 0) { this.onState(entry.name, { state: 'ended' }); return; }
      if (entry.attempts >= this.retryLimit) {
        this.onState(entry.name, { state: 'failed', lastError: entry.lastError || `exit ${code}` });
        return;
      }
      const attempt = entry.attempts++;
      this.onState(entry.name, { state: 'connecting', lastError: entry.lastError || `exit ${code}` });
      this.scheduleRetry(() => {
        if (!entry.stopped) this._launch(streamId, inputUrl, entry);
      }, attempt);
    });
    child.on('error', (err) => { entry.lastError = err.message; });
  }

  stop(streamId) {
    const procs = this.streams.get(streamId);
    if (!procs) return;
    for (const entry of procs) {
      entry.stopped = true;
      if (entry.child && !entry.child.killed) entry.child.kill('SIGTERM');
    }
    this.streams.delete(streamId);
  }

  count() {
    return this.streams.size;
  }
}

module.exports = { Multistreamer };
