'use strict';

// db: { query(sql, params) -> rows[] }
async function validateStreamKey(db, streamKey, now = Date.now()) {
  const rows = await db.query(
    'SELECT * FROM stream_keys WHERE stream_key = ? LIMIT 1',
    [streamKey]
  );
  const key = rows[0];
  if (!key) return { ok: false, reason: 'not_found' };
  if (!key.enabled) return { ok: false, reason: 'disabled' };
  if (key.expires_at && new Date(key.expires_at).getTime() < now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, key };
}

module.exports = { validateStreamKey };
