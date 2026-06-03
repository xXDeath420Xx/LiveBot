'use strict';
const { config } = require('./config');

// Node 20 has global fetch; allow injection for tests.
async function resolveViaDashboard(streamKey, opts = {}) {
  const url = opts.url || config.resolverUrl;
  const secret = opts.secret || config.internalSecret;
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': secret },
    body: JSON.stringify({ streamKey }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error('resolver HTTP ' + res.status);
  const data = await res.json();
  return data.destinations || [];
}

module.exports = { resolveViaDashboard };
