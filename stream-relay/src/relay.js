'use strict';
const NodeMediaServer = require('node-media-server');
const { config } = require('./config');
const { validateStreamKey } = require('./keys');
const { createSession, endSession } = require('./sessions');

// db: { query }, registry: StatusRegistry, multistreamer: Multistreamer
function createRelay({ db, registry, multistreamer }) {
  const nms = new NodeMediaServer({
    rtmp: { port: config.rtmpPort, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
    http: { port: 0, allow_origin: '*' } // disabled-ish; no public playback used
  });

  // streamId -> { sessionId }
  const sessions = new Map();

  nms.on('prePublish', async (id, StreamPath) => {
    const streamKey = StreamPath.split('/')[2];
    const reject = () => { const s = nms.getSession(id); if (s) s.reject(); };

    if (!streamKey) { console.log('[relay] no stream key'); return reject(); }

    let result;
    try {
      result = await validateStreamKey(db, streamKey);
    } catch (err) {
      console.error('[relay] DB error on validate, failing closed:', err.message);
      return reject();
    }
    if (!result.ok) { console.log(`[relay] reject key (${result.reason})`); return reject(); }

    if (registry.size() >= config.maxConcurrentStreams) {
      console.log('[relay] global concurrency cap reached, rejecting');
      return reject();
    }
    console.log(`[relay] accepted key id=${result.key.id}`);
  });

  nms.on('postPublish', async (id, StreamPath) => {
    const streamKey = StreamPath.split('/')[2];
    let result;
    try { result = await validateStreamKey(db, streamKey); } catch { return; }
    if (!result.ok) return;
    const keyId = result.key.id;

    let destinations = [];
    try {
      destinations = await db.query(
        'SELECT * FROM stream_destinations WHERE stream_key_id = ? AND enabled = 1 ORDER BY priority ASC',
        [keyId]
      );
    } catch (err) { console.error('[relay] dest load error:', err.message); return; }

    destinations = destinations.slice(0, config.maxDestinationsPerKey);
    if (destinations.length === 0) { console.log('[relay] no destinations enabled'); return; }

    await db.query('UPDATE stream_keys SET last_used_at = NOW() WHERE id = ?', [keyId]);

    let sessionId = null;
    try { sessionId = await createSession(db, keyId, destinations.length); } catch {}
    sessions.set(id, { sessionId, keyId });

    registry.startStream(id, { keyId, startedAt: Date.now() });
    const inputUrl = `rtmp://127.0.0.1:${config.rtmpPort}${StreamPath}`;

    multistreamer.onState = (name, patch) => registry.setDestination(id, name, patch);
    multistreamer.start(id, inputUrl, destinations);
    console.log(`[relay] fan-out started: ${destinations.length} destinations (key ${keyId})`);
  });

  nms.on('donePublish', async (id) => {
    multistreamer.stop(id);
    registry.endStream(id);
    const meta = sessions.get(id);
    if (meta && meta.sessionId) { try { await endSession(db, meta.sessionId, 'ended'); } catch {} }
    sessions.delete(id);
    console.log(`[relay] stream ${id} ended`);
  });

  return { nms, run: () => nms.run() };
}

module.exports = { createRelay };
