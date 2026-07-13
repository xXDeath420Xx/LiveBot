import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import encryption from '../../utils/encryption.js';
import logger from '../../utils/logger.js';

const router = express.Router();

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${DASHBOARD_URL}/auth/twitch/broadcaster/callback`;
const SCOPES = 'channel:read:vips channel:manage:vips moderation:read';

/**
 * GET /auth/twitch/broadcaster/callback
 * Handles the OAuth callback from Twitch
 * MUST be registered BEFORE /:guildId to avoid "callback" being matched as a guildId
 */
router.get('/auth/twitch/broadcaster/callback', async (req, res) => {
    logger.info('[TwitchBroadcasterAuth] Callback received', { code: !!req.query.code, state: !!req.query.state, error: req.query.error, hasSession: !!req.session, hasGuildId: !!req.session?.twitchBroadcasterGuildId, hasState: !!req.session?.twitchBroadcasterState });
    const { code, state, error } = req.query;
    const guildId = req.session.twitchBroadcasterGuildId;
    const expectedState = req.session.twitchBroadcasterState;

    // Clean up session
    delete req.session.twitchBroadcasterState;
    delete req.session.twitchBroadcasterGuildId;

    if (error || !code) {
        logger.error('[TwitchBroadcasterAuth] OAuth error:', { error, guildId });
        return res.redirect(`/manage/${guildId}?page=streamers&error=twitch_auth_failed`);
    }

    if (!state || state !== expectedState) {
        logger.error('[TwitchBroadcasterAuth] State mismatch');
        return res.redirect(`/manage/${guildId}?page=streamers&error=twitch_auth_failed`);
    }

    if (!guildId) {
        return res.redirect('/dashboard?error=no_guild');
    }

    try {
        // Exchange code for tokens
        const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI
            }
        });

        const { access_token, refresh_token, expires_in, scope } = tokenResponse.data;

        // Get broadcaster info
        const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${access_token}`
            }
        });

        const twitchUser = userResponse.data.data[0];
        if (!twitchUser) {
            return res.redirect(`/manage/${guildId}?page=streamers&error=twitch_user_not_found`);
        }

        // Encrypt tokens
        const encryptedToken = JSON.stringify(encryption.encrypt(access_token));
        const encryptedRefresh = refresh_token ? JSON.stringify(encryption.encrypt(refresh_token)) : null;
        const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString().slice(0, 19).replace('T', ' ');

        // Upsert config
        await pool.execute(`
            INSERT INTO twitch_role_sync_config
            (guild_id, broadcaster_twitch_id, broadcaster_twitch_username, broadcaster_token, broadcaster_refresh_token, token_expires_at, token_scopes, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                broadcaster_twitch_id = VALUES(broadcaster_twitch_id),
                broadcaster_twitch_username = VALUES(broadcaster_twitch_username),
                broadcaster_token = VALUES(broadcaster_token),
                broadcaster_refresh_token = VALUES(broadcaster_refresh_token),
                token_expires_at = VALUES(token_expires_at),
                token_scopes = VALUES(token_scopes),
                enabled = 1
        `, [
            guildId,
            twitchUser.id,
            twitchUser.login,
            encryptedToken,
            encryptedRefresh,
            expiresAt,
            Array.isArray(scope) ? scope.join(' ') : scope || SCOPES
        ]);

        logger.info(`[TwitchBroadcasterAuth] Connected broadcaster ${twitchUser.login} (${twitchUser.id}) for guild ${guildId} by ${req.user?.username}`);
        res.redirect(`/manage/${guildId}?page=streamers&success=twitch_connected`);
    } catch (err) {
        logger.error('[TwitchBroadcasterAuth] Error exchanging code:', { error: err.message, guildId });
        res.redirect(`/manage/${guildId}?page=streamers&error=twitch_auth_failed`);
    }
});

/**
 * GET /auth/twitch/broadcaster/:guildId
 * Initiates Twitch OAuth for a broadcaster to connect their channel
 */
router.get('/auth/twitch/broadcaster/:guildId', (req, res) => {
    if (!req.user) return res.redirect('/auth/discord');

    const state = crypto.randomBytes(16).toString('hex');
    req.session.twitchBroadcasterState = state;
    req.session.twitchBroadcasterGuildId = req.params.guildId;

    const params = new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        state
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

export default router;
