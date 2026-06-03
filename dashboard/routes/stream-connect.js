// OAuth connect flow + connection management for the multicast Add-Platform feature.
//   GET    /stream/connect/:platform            -> redirect to provider OAuth (Discord-authed)
//   GET    /stream/connect/:platform/callback   -> exchange code, save account, create destination
//   GET    /stream/api/connections              -> list current user's connections
//   DELETE /stream/api/connections/:platform    -> disconnect
import express from 'express';
import crypto from 'crypto';
import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { PLATFORM_META, getAdapter } from '../services/platforms/registry.js';
import { accountStore } from '../services/platforms/accounts.js';

const router = express.Router();
const db = { query };
const ENABLE_GATED = process.env.STREAM_ENABLE_GATED_PLATFORMS === '1';

function ensureDiscordAuthed(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.id) return next();
  res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream'));
}

router.get('/stream/connect/:platform', ensureDiscordAuthed, (req, res) => {
  const meta = PLATFORM_META[req.params.platform];
  if (!meta) return res.redirect('/stream?error=unknown_platform');
  if (meta.reviewGated && !ENABLE_GATED) return res.redirect('/stream?error=platform_coming_soon');
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  req.session.streamOAuthState = state;
  req.session.streamOAuthPlatform = meta.platform;
  req.session.streamOAuthVerifier = codeVerifier;
  res.redirect(getAdapter(meta.platform).getAuthUrl(state, { codeChallenge }));
});

router.get('/stream/connect/:platform/callback', ensureDiscordAuthed, async (req, res) => {
  const platform = req.params.platform;
  const meta = PLATFORM_META[platform];
  if (!meta) return res.redirect('/stream?error=unknown_platform');
  if (req.query.error) return res.redirect('/stream?error=oauth_denied');
  if (!req.query.code || req.query.state !== req.session.streamOAuthState || platform !== req.session.streamOAuthPlatform) {
    return res.redirect('/stream?error=oauth_state');
  }
  const codeVerifier = req.session.streamOAuthVerifier;
  delete req.session.streamOAuthState; delete req.session.streamOAuthPlatform; delete req.session.streamOAuthVerifier;
  try {
    const adapter = getAdapter(platform);
    const result = await adapter.handleCallback(req.query.code, { codeVerifier });
    await accountStore.saveAccount({
      ownerDiscordId: req.user.id, platform,
      platformUserId: result.platformUserId, platformUsername: result.username,
      accessToken: result.tokens.access_token, refreshToken: result.tokens.refresh_token || null,
      expiresAt: result.tokens.expires_at || null, scopes: result.tokens.scope || null,
    });
    const account = await accountStore.getAccount(req.user.id, platform);

    // Find/create the user's stream_keys row id
    const keyRows = await db.query('SELECT id FROM stream_keys WHERE owner_type = "discord" AND owner_id = ? LIMIT 1', [req.user.id]);
    if (!keyRows[0]) return res.redirect('/stream?error=no_stream_key');
    const streamKeyId = keyRows[0].id;

    const dest = await adapter.connectDestination(account); // { name, rtmp_url, dest_stream_key, resolution, config }
    await db.query(
      `INSERT INTO stream_destinations (stream_key_id, account_id, platform, resolution, name, rtmp_url, dest_stream_key, config_json, enabled, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 50)`,
      [streamKeyId, account.id, platform, meta.mode, dest.name || meta.label,
       dest.rtmp_url || '', dest.dest_stream_key || '', dest.config ? JSON.stringify(dest.config) : null]
    );
    const flag = meta.mode === 'dynamic' ? 'connected_dynamic' : (dest.dest_stream_key ? 'connected' : 'connected_need_key');
    res.redirect('/stream?ok=' + flag + '&platform=' + platform);
  } catch (err) {
    logger.error(`[stream-connect] ${platform} callback failed: ${err.message}`);
    res.redirect('/stream?error=connect_failed');
  }
});

router.get('/stream/api/connections', ensureDiscordAuthed, async (req, res) => {
  res.json({ connections: await accountStore.listAccounts(req.user.id) });
});

router.delete('/stream/api/connections/:platform', ensureDiscordAuthed, async (req, res) => {
  await accountStore.deleteAccount(req.user.id, req.params.platform); // FK cascade removes its destinations
  res.json({ ok: true });
});

export default router;
