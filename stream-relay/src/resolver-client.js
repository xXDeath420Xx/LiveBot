'use strict';
const { config } = require('./config');

// Node 20 has global fetch; allow injection for tests.
async function callResolver(streamKey, opts = {}) {
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
  return res.json();
}

async function resolveViaDashboard(streamKey, opts = {}) {
  const data = await callResolver(streamKey, opts);
  return data.destinations || [];
}

// The destinations to start, plus the ones the dashboard could not resolve at go-live
// ({ id, name, platform, error }) so the relay can record them as failed for the session.
async function resolveWithFailures(streamKey, opts = {}) {
  const data = await callResolver(streamKey, opts);
  return {
    destinations: data.destinations || [],
    failed: Array.isArray(data.failed) ? data.failed : [],
  };
}

module.exports = { resolveViaDashboard, resolveWithFailures };
