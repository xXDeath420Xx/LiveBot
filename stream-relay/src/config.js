'use strict';
require('dotenv').config();

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
    db: {
      host: env.DB_HOST || 'localhost',
      port: int(env.DB_PORT, 3306),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME || 'CertiFriedUtility'
    }
  };
}

module.exports = { loadConfig, config: loadConfig() };
