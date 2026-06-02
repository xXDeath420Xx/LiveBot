'use strict';
const { config } = require('./config');
const db = require('./db');
const { StatusRegistry } = require('./status');
const { Multistreamer } = require('./multistream');
const { createStatusServer } = require('./status-api');
const { createRelay } = require('./relay');
const { validateStreamKey } = require('./keys');

const registry = new StatusRegistry();

const makeMultistreamer = (onState) => new Multistreamer({
  retryLimit: config.destRetryLimit,
  retryBaseMs: config.destRetryBaseMs,
  onState
});

const relay = createRelay({ db, registry, makeMultistreamer });

const statusServer = createStatusServer({
  registry,
  activeCount: () => registry.size(),
  resolveKeyId: async (streamKey) => {
    if (!streamKey) return null;
    const r = await validateStreamKey(db, streamKey).catch(() => ({ ok: false }));
    return r.ok ? r.key.id : null;
  }
});

relay.run();
statusServer.listen(config.statusPort, '127.0.0.1', () => {
  console.log(`[relay] RTMP on :${config.rtmpPort}  status on 127.0.0.1:${config.statusPort}`);
});

function shutdown() {
  console.log('[relay] shutting down');
  statusServer.close();
  db.pool.end().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
