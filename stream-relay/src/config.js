'use strict';
require('dotenv').config();
const crypto = require('node:crypto');

function int(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}

function loadConfig(env = process.env) {
  return {
    rtmpPort: int(env.RTMP_PORT, 1936),
    statusPort: int(env.STATUS_PORT, 4090),
    publicHost: env.PUBLIC_HOST || 'certifriedmultitool.com',
    maxDestinationsPerKey: int(env.MAX_DESTINATIONS, 8),
    maxConcurrentStreams: int(env.MAX_CONCURRENT, 10),
    destRetryLimit: int(env.DEST_RETRY_LIMIT, 5),
    destRetryBaseMs: int(env.DEST_RETRY_BASE_MS, 2000),
    // Secret used to sign external playback URLs. We never hand it out, so
    // external HTTP-FLV/RTMP playback is effectively impossible; the relay's
    // own loopback pull is exempt (NMS skips play-auth when isLocal).
    playSecret: env.RELAY_PLAY_SECRET || crypto.randomBytes(24).toString('hex'),
    db: {
      host: env.DB_HOST || 'localhost',
      port: int(env.DB_PORT, 3306),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME || 'cert_CertiFriedUtility'
    }
  };
}

module.exports = { loadConfig, config: loadConfig() };
