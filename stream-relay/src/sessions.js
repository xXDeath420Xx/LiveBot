'use strict';

async function createSession(db, streamKeyId, destinationsCount) {
  const res = await db.query(
    'INSERT INTO stream_sessions (stream_key_id, destinations_count, status) VALUES (?, ?, "active")',
    [streamKeyId, destinationsCount]
  );
  return res.insertId;
}

async function endSession(db, sessionId, status = 'ended', errorMessage = null) {
  const rows = await db.query('SELECT started_at FROM stream_sessions WHERE id = ?', [sessionId]);
  if (!rows[0]) return;
  const startedAt = new Date(rows[0].started_at).getTime();
  const duration = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  await db.query(
    'UPDATE stream_sessions SET ended_at = NOW(), duration_seconds = ?, status = ?, error_message = ? WHERE id = ?',
    [duration, status, errorMessage, sessionId]
  );
}

// One row per destination per session (src/targets.js keeps it current). Returns the row id.
async function recordTarget(db, sessionId, destinationId, platform, state, lastError = null) {
  const res = await db.query(
    'INSERT INTO stream_session_targets (session_id, destination_id, platform, state, last_error) VALUES (?, ?, ?, ?, ?)',
    [sessionId, destinationId, platform, state, lastError]
  );
  return res.insertId;
}

// A newer error replaces the stored one; a state change without one keeps the last error seen.
async function updateTarget(db, targetId, state, lastError = null) {
  await db.query(
    'UPDATE stream_session_targets SET state = ?, last_error = COALESCE(?, last_error) WHERE id = ?',
    [state, lastError, targetId]
  );
}

async function endTargets(db, sessionId) {
  await db.query(
    "UPDATE stream_session_targets SET state = 'ended' WHERE session_id = ? AND state IN ('connecting', 'live')",
    [sessionId]
  );
}

module.exports = { createSession, endSession, recordTarget, updateTarget, endTargets };
