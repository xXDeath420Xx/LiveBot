import crypto from 'crypto';
import { isKnownPlatform } from './stream-platforms.js';

export const MAX_DESTINATIONS = 8;

export function generateStreamKey() {
  return 'cf_' + crypto.randomBytes(16).toString('hex');
}

// currentCount = how many destinations the key already has.
export function validateDestinationInput(input, currentCount) {
  if (currentCount >= MAX_DESTINATIONS) {
    return { ok: false, error: `Destination limit reached (${MAX_DESTINATIONS})` };
  }
  const platform = String(input.platform || '').toLowerCase();
  if (!isKnownPlatform(platform)) return { ok: false, error: 'Unknown platform' };

  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'Name is required' };

  const rtmpUrl = String(input.rtmp_url || '').trim();
  if (!/^rtmps?:\/\/.+/i.test(rtmpUrl)) return { ok: false, error: 'rtmp_url must start with rtmp:// or rtmps://' };

  const destKey = String(input.dest_stream_key || '').trim().slice(0, 500);

  return { ok: true, value: { platform, name, rtmp_url: rtmpUrl.slice(0, 500), dest_stream_key: destKey } };
}

// --- DB-backed helpers (db = utils/db.js's { query }) ---

export async function getOrCreateDiscordKey(db, discordId) {
  const rows = await db.query(
    'SELECT * FROM stream_keys WHERE owner_type = "discord" AND owner_id = ? LIMIT 1',
    [discordId]
  );
  if (rows[0]) return rows[0];
  const key = generateStreamKey();
  const res = await db.query(
    'INSERT INTO stream_keys (owner_type, owner_id, stream_key, enabled) VALUES ("discord", ?, ?, 1)',
    [discordId, key]
  );
  const created = await db.query('SELECT * FROM stream_keys WHERE id = ?', [res.insertId]);
  return created[0];
}

export async function createGuestKey(db, ttlHours = 6) {
  const key = generateStreamKey();
  const guestId = 'guest_' + crypto.randomBytes(6).toString('hex');
  const res = await db.query(
    'INSERT INTO stream_keys (owner_type, owner_id, stream_key, enabled, expires_at) VALUES ("guest", ?, ?, 1, DATE_ADD(NOW(), INTERVAL ? HOUR))',
    [guestId, key, ttlHours]
  );
  return db.query('SELECT * FROM stream_keys WHERE id = ?', [res.insertId]).then(r => r[0]);
}

export async function listDestinations(db, streamKeyId) {
  return db.query('SELECT * FROM stream_destinations WHERE stream_key_id = ? ORDER BY priority ASC, id ASC', [streamKeyId]);
}
