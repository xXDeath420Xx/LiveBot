'use strict';
const http = require('node:http');

// Bound to 127.0.0.1 only — never exposed publicly.
function createStatusServer({ registry, resolveKeyId, activeCount }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, active: activeCount() }));
      return;
    }

    if (url.pathname === '/status') {
      const key = url.searchParams.get('key') || '';
      const keyId = await resolveKeyId(key);
      if (!keyId) { res.end(JSON.stringify({ live: false, destinations: [] })); return; }
      res.end(JSON.stringify(registry.snapshotByKeyId(keyId)));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

module.exports = { createStatusServer };
