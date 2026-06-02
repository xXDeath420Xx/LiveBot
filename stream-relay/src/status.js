'use strict';

class StatusRegistry {
  constructor() {
    this.streams = new Map(); // streamId -> { keyId, startedAt, destinations: Map }
  }

  startStream(streamId, { keyId, startedAt }) {
    this.streams.set(streamId, { keyId, startedAt, destinations: new Map() });
  }

  setDestination(streamId, name, patch) {
    const s = this.streams.get(streamId);
    if (!s) return;
    const prev = s.destinations.get(name) || { name };
    s.destinations.set(name, { ...prev, ...patch, name });
  }

  endStream(streamId) {
    this.streams.delete(streamId);
  }

  snapshotByKeyId(keyId) {
    for (const s of this.streams.values()) {
      if (s.keyId === keyId) {
        return {
          live: true,
          startedAt: s.startedAt,
          destinations: [...s.destinations.values()]
        };
      }
    }
    return { live: false, destinations: [] };
  }

  size() {
    return this.streams.size;
  }
}

module.exports = { StatusRegistry };
