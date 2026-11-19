// OAuth connect flow + connection management for the multicast Add-Platform feature.
//   GET    /stream/connect/:platform            -> redirect to provider OAuth (Discord-authed)
//                                                  ?for=bot: the stream bot's Connections page links the channel
//                                                  to the user's stream bot profile instead of adding a multicast
//                                                  destination, and comes back to /stream/bot/connections
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
  res.redirect('/auth/discord?returnTo=' + encodeURIComponent(req.query.for === 'bot' ? '/stream/bot/connections' : '/stream'));
}

router.get('/stream/connect/:platform', ensureDiscordAuthed, (req, res) => {
  const meta = PLATFORM_META[req.params.platform];
  const back = req.query.for === 'bot' ? '/stream/bot/connections' : '/stream';
  if (!meta) return res.redirect(back + '?error=unknown_platform');
  if (meta.reviewGated && !ENABLE_GATED) return res.redirect(back + '?error=platform_coming_soon');
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  req.session.streamOAuthState = state;
  req.session.streamOAuthPlatform = meta.platform;
  req.session.streamOAuthVerifier = codeVerifier;
  if (req.query.for === 'bot') req.session.streamOAuthFor = 'bot'; else delete req.session.streamOAuthFor;
  const authUrl = getAdapter(meta.platform).getAuthUrl(state, { codeChallenge });
  // Log only non-secret context (no state/code_challenge/full URL).
  logger.info(`[stream-connect] initiate ${meta.platform} oauth (user ${req.user.id})`);
  res.redirect(authUrl);
});

router.get('/stream/connect/:platform/callback', ensureDiscordAuthed, async (req, res) => {
  const platform = req.params.platform;
  const meta = PLATFORM_META[platform];
  const forBot = req.session.streamOAuthFor === 'bot';
  const back = forBot ? '/stream/bot/connections' : '/stream';
  if (!meta) return res.redirect(back + '?error=unknown_platform');
  if (req.query.error) {
    logger.warn(`[stream-connect] ${platform} provider returned error: ${req.query.error} — ${req.query.error_description || 'no description'}`);
    return res.redirect(back + '?error=oauth_denied');
  }
  if (!req.query.code || req.query.state !== req.session.streamOAuthState || platform !== req.session.streamOAuthPlatform) {
    logger.warn(`[stream-connect] ${platform} state check failed (hasCode=${!!req.query.code}, stateMatch=${req.query.state === req.session.streamOAuthState}, platformMatch=${platform === req.session.streamOAuthPlatform})`);
    return res.redirect(back + '?error=oauth_state');
  }
  const codeVerifier = req.session.streamOAuthVerifier;
  delete req.session.streamOAuthState; delete req.session.streamOAuthPlatform; delete req.session.streamOAuthVerifier; delete req.session.streamOAuthFor;
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

    if (forBot) {
      // Stream bot: link the channel this sign-in proved, no multicast destination (core/stream-bot).
      if (!['twitch', 'kick'].includes(platform) || !account?.platformUserId) return res.redirect(back + '?error=no_channel_id');
      const { getStreamBot } = await import('../../core/stream-bot/index.js');
      const sb = await getStreamBot();
      const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
      const linked = await sb.store.linkChannel(profile.id, {
        platform, platformUserId: account.platformUserId, login: String(account.platformUsername || '').toLowerCase() || null,
        displayName: account.platformUsername || null, verifiedVia: 'stream_platform_accounts',
      });
      if (!linked.ok) return res.redirect(back + '?error=channel_taken');
      sb.ingest.invalidate(profile.id);
      sb.io.invalidate(profile.id);
      if (platform === 'kick') {
        const { ensureSubscribed } = await import('../../services/certifried-bot/kick-event-subscriptions.js');
        ensureSubscribed(account.platformUserId).catch(err => logger.warn(`[stream-connect] kick webhook subscribe failed: ${err.message}`));
      } else {
        import('../../core/twitch-eventsub-manager.js').then(m => m.subscribeBroadcaster(account.platformUserId, account.platformUsername))
          .catch(err => logger.warn(`[stream-connect] eventsub subscribe failed: ${err.message}`));
      }
      return res.redirect(back + '?ok=linked_' + platform);
    }

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
    res.redirect(back + '?error=connect_failed');
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
