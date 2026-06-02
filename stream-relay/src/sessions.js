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

async function recordTarget(db, sessionId, destinationId, platform, state, lastError = null) {
  await db.query(
    'INSERT INTO stream_session_targets (session_id, destination_id, platform, state, last_error) VALUES (?, ?, ?, ?, ?)',
    [sessionId, destinationId, platform, state, lastError]
  );
}

module.exports = { createSession, endSession, recordTarget };
