// Free multicast UI + JSON API.
//   GET  /stream                      — dashboard (Discord-authed)
//   GET  /stream/quick                — guest landing (creates a temp key)
//   GET  /stream/api/destinations     — list current key's destinations
//   POST /stream/api/destinations     — add a destination
//   PATCH/DELETE /stream/api/destinations/:id
//   POST /stream/api/key/regenerate   — rotate the Discord user's key
//   GET  /stream/api/status           — live status (proxied from relay)
import express from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { PLATFORMS } from '../services/stream-platforms.js';
import {
  getOrCreateDiscordKey, createGuestKey, listDestinations,
  validateDestinationInput, generateStreamKey
} from '../services/stream-store.js';
import { getRelayStatus } from '../services/relay-client.js';

const router = express.Router();
const db = { query };
const PUBLIC_HOST = process.env.STREAM_PUBLIC_HOST || 'certifriedmultitool.com';
const RTMP_PORT = process.env.STREAM_RTMP_PORT || '1936';

function ensureDiscordAuthed(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.id) return next();
  res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream'));
}

// Resolve the active stream key for this request: Discord user, or guest via session.
async function resolveKey(req) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.id) {
    return getOrCreateDiscordKey(db, req.user.id);
  }
  if (req.session?.guestStreamKeyId) {
    const rows = await db.query('SELECT * FROM stream_keys WHERE id = ? AND enabled = 1', [req.session.guestStreamKeyId]);
    return rows[0] || null;
  }
  return null;
}

router.get('/stream', ensureDiscordAuthed, async (req, res) => {
  const key = await getOrCreateDiscordKey(db, req.user.id);
  const destinations = await listDestinations(db, key.id);
  res.render('stream', {
    user: req.user,
    ingestUrl: `rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live/${key.stream_key}`,
    streamKey: key.stream_key,
    destinations,
    platforms: PLATFORMS,
    isGuest: false
  });
});

const guestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Too many guest sessions from this IP. Try later.' });

router.get('/stream/quick', guestLimiter, async (req, res) => {
  let key;
  if (req.session?.guestStreamKeyId) {
    const rows = await db.query('SELECT * FROM stream_keys WHERE id = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > NOW())', [req.session.guestStreamKeyId]);
    key = rows[0];
  }
  if (!key) {
    key = await createGuestKey(db, 6);
    req.session.guestStreamKeyId = key.id;
  }
  const destinations = await listDestinations(db, key.id);
  res.render('stream', {
    user: null,
    ingestUrl: `rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live/${key.stream_key}`,
    streamKey: key.stream_key,
    destinations,
    platforms: PLATFORMS,
    isGuest: true,
    expiresAt: key.expires_at
  });
});

router.get('/stream/api/destinations', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  res.json({ destinations: await listDestinations(db, key.id) });
});

router.post('/stream/api/destinations', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  const current = await listDestinations(db, key.id);
  const v = validateDestinationInput(req.body, current.length);
  if (!v.ok) return res.status(400).json({ error: v.error });
  await db.query(
    'INSERT INTO stream_destinations (stream_key_id, platform, name, rtmp_url, dest_stream_key, enabled, priority) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [key.id, v.value.platform, v.value.name, v.value.rtmp_url, v.value.dest_stream_key, current.length + 1]
  );
  res.json({ ok: true });
});

router.patch('/stream/api/destinations/:id', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  const enabled = req.body.enabled ? 1 : 0;
  await db.query('UPDATE stream_destinations SET enabled = ? WHERE id = ? AND stream_key_id = ?', [enabled, req.params.id, key.id]);
  res.json({ ok: true });
});

router.delete('/stream/api/destinations/:id', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  await db.query('DELETE FROM stream_destinations WHERE id = ? AND stream_key_id = ?', [req.params.id, key.id]);
  res.json({ ok: true });
});

router.post('/stream/api/key/regenerate', ensureDiscordAuthed, async (req, res) => {
  const newKey = generateStreamKey();
  await db.query('UPDATE stream_keys SET stream_key = ? WHERE owner_type = "discord" AND owner_id = ?', [newKey, req.user.id]);
  res.json({ ok: true, streamKey: newKey, ingestUrl: `rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live/${newKey}` });
});

router.get('/stream/api/status', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  res.json(await getRelayStatus(key.stream_key));
});

export default router;
