'use strict';
const { recordTarget, updateTarget, endTargets } = require('./sessions');

// ffmpeg and platform errors can carry the output URL, whose path is the destination's stream key.
// Keep the host (useful: which ingest refused), drop the path.
function redactError(msg) {
  if (msg === null || msg === undefined || msg === '') return null;
  return String(msg)
    .replace(/rtmps?:\/\/[^\s'"]+/gi, (u) => u.replace(/^(rtmps?:\/\/[^/\s'"]+).*$/i, '$1/…'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || null;
}

// The status registry and the tracker key destinations by name; two called "Twitch" would share a row.
function uniqueNames(destinations) {
  const seen = new Map();
  return destinations.map((d) => {
    const base = d.name || d.platform || 'Destination';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? { ...d, name: base } : { ...d, name: `${base} (${n})` };
  });
}

/**
 * Per-destination results of one relay session (stream_session_targets): one row per destination,
 * written when the session starts and updated as that destination's state changes. Updates for a
 * destination are chained so 'connecting' then 'live' cannot land out of order. Never throws: a
 * results row failing to write must not stop the stream.
 */
function createTargetTracker(db, sessionId, log = console) {
  const rows = new Map(); // destination name -> { id, chain }

  async function add(dest, state = 'connecting', lastError = null) {
    if (!sessionId) return null;
    try {
      const id = await recordTarget(db, sessionId, dest.id ?? null, dest.platform || 'custom', state, redactError(lastError));
      if (dest.name) rows.set(dest.name, { id, chain: Promise.resolve() });
      return id;
    } catch (err) {
      log.error('[relay] could not record destination result:', err.message);
      return null;
    }
  }

  function update(name, patch = {}) {
    const row = rows.get(name);
    if (!row || !patch.state) return Promise.resolve();
    row.chain = row.chain
      .then(() => updateTarget(db, row.id, patch.state, redactError(patch.lastError)))
      .catch((err) => log.error('[relay] could not update destination result:', err.message));
    return row.chain;
  }

  // Stream over: whatever was still connecting or live has ended (failed rows stay failed).
  async function endAll() {
    if (!sessionId) return;
    await Promise.all([...rows.values()].map((r) => r.chain));
    try { await endTargets(db, sessionId); } catch (err) { log.error('[relay] could not close destination results:', err.message); }
  }

  return { add, update, endAll };
}

module.exports = { createTargetTracker, redactError, uniqueNames };
