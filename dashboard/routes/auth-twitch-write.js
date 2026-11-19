/**
 * Tier B OAuth flow — write-scope consent.
 *
 * This is a SEPARATE OAuth round from the read-scope flow in auth-twitch-broadcaster.js
 * because Twitch doesn't do incremental consent cleanly: adding a scope to an existing
 * grant forces the user to re-approve everything. By keeping write scopes on their own
 * token column (tier_b_token), broadcasters who want only analytics never have to grant
 * write permissions, and those who want full control grant them in a separate click.
 *
 * The write token is encrypted + stored in twitch_role_sync_config.tier_b_token. Every
 * Tier B action in core/twitch-write.js reads it via getTierBAuth().
 */
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import encryption from '../../utils/encryption.js';
import logger from '../../utils/logger.js';
import { subscribeBroadcaster } from '../../core/twitch-eventsub-manager.js';

const router = express.Router();

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${DASHBOARD_URL}/auth/twitch/broadcaster-write/callback`;

// Full write-scope set. We ask for all at once because the point of this flow is to turn
// CertiFried into the broadcaster's primary control panel.
const WRITE_SCOPES = [
    'channel:manage:broadcast',
    'channel:manage:polls',
    'channel:manage:predictions',
    'channel:manage:raids',
    'channel:manage:ads',
    'channel:manage:redemptions',
    'channel:manage:schedule',
    'channel:manage:videos',
    'clips:edit',
    'moderator:manage:chat_messages',
    'moderator:manage:banned_users',
    'moderator:manage:warnings',
    'moderator:manage:unban_requests',
    'moderator:manage:shield_mode',
    'moderator:manage:chat_settings',
    'moderator:manage:automod',
    'moderator:manage:blocked_terms',
    'user:write:chat',                   // AI chat-send (announcements, prompts, poll results)
    'channel:manage:moderators',         // add/remove mods via Helix (dashboard mod management)
    'channel:manage:vips',               // add/remove VIPs via Helix (also on Tier A — kept here
                                         //  so the roles manager stays on a single auth tier)
    'channel:read:vips',                 // list VIPs for the roles manager UI
].join(' ');

router.get('/auth/twitch/broadcaster-write/callback', async (req, res) => {
    const guildId = req.session.twitchWriteGuildId;
    const expectedState = req.session.twitchWriteState;
    delete req.session.twitchWriteState;
    delete req.session.twitchWriteGuildId;

    logger.info('[TwitchWriteAuth] callback hit', {
        hasCode: !!req.query.code,
        hasState: !!req.query.state,
        hasError: !!req.query.error,
        error: req.query.error || null,
        sessionGuildId: guildId || null,
        sessionStatePrefix: expectedState ? expectedState.slice(0, 8) + '...' : null,
        urlStatePrefix: req.query.state ? String(req.query.state).slice(0, 8) + '...' : null,
    });

    if (req.query.error) {
        logger.warn('[TwitchWriteAuth] callback had Twitch error', { error: req.query.error, guildId });
        return res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=denied`);
    }
    if (!guildId || !expectedState || req.query.state !== expectedState) {
        // Session state got overwritten (double-click on init link) or expired.
        // Log which specific condition failed so this isn't a silent dead-end
        // during OAuth debugging.
        logger.warn('[TwitchWriteAuth] state check failed', {
            hasGuildId: !!guildId,
            hasExpectedState: !!expectedState,
            stateMatch: req.query.state === expectedState,
            urlState: req.query.state ? String(req.query.state).slice(0, 8) + '...' : null,
            sessionState: expectedState ? String(expectedState).slice(0, 8) + '...' : null,
        });
        return res.redirect(`/dashboard?error=write_auth_bad_state`);
    }
    if (!req.query.code) {
        logger.warn('[TwitchWriteAuth] callback missing code', { guildId });
        return res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=no_code`);
    }

    try {
        const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code: req.query.code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI,
            },
        });
        const { access_token, refresh_token, expires_in, scope } = tokenResponse.data;
        const scopesGranted = Array.isArray(scope) ? scope.join(' ') : (scope || WRITE_SCOPES);

        // Validate the token resolves to the SAME broadcaster who's already connected on
        // this guild — prevents a different Twitch account from accidentally granting write
        // scope on top of the existing read scope.
        const validateRes = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: { Authorization: `OAuth ${access_token}` },
        });
        const grantedUserId = String(validateRes.data?.user_id || '');

        const [[existing]] = await pool.execute(
            `SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE guild_id = ? LIMIT 1`,
            [guildId]);
        if (!existing || String(existing.broadcaster_twitch_id) !== grantedUserId) {
            logger.warn('[TwitchWriteAuth] write grant from different Twitch user than the read grant', { guildId, grantedUserId });
            return res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=wrong_user`);
        }

        const encryptedToken = JSON.stringify(encryption.encrypt(access_token));
        const encryptedRefresh = refresh_token ? JSON.stringify(encryption.encrypt(refresh_token)) : null;
        const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString().slice(0, 19).replace('T', ' ');

        await pool.execute(
            `UPDATE twitch_role_sync_config
                SET tier_b_token = ?, tier_b_refresh_token = ?, tier_b_token_expires_at = ?,
                    tier_b_scopes = ?, tier_b_granted_at = NOW(), tier_b_token_status = 'active'
              WHERE guild_id = ?`,
            [encryptedToken, encryptedRefresh, expiresAt, scopesGranted, guildId]);

        logger.info('[TwitchWriteAuth] Tier B granted', {
            guildId, broadcasterId: grantedUserId, scopesCount: scopesGranted.split(/\s+/).length,
        });

        // The write flow doesn't add any new READ-side EventSub topics, but if the broadcaster
        // happened to grant moderator:manage:automod we can now subscribe to the automod.*
        // topics. Fire-and-forget — subscribeBroadcaster filters by eligible scope set.
        subscribeBroadcaster(grantedUserId, existing.broadcaster_twitch_username || grantedUserId).catch(err =>
            logger.warn('[TwitchWriteAuth] post-grant subscribe failed', { err: err.message }));

        res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=ok#controls`);
    } catch (err) {
        logger.error('[TwitchWriteAuth] token exchange failed', { guildId, err: err.message });
        res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=failed`);
    }
});

router.get('/auth/twitch/broadcaster-write/:guildId', (req, res) => {
    if (!req.user) return res.redirect('/auth/discord');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.twitchWriteState = state;
    req.session.twitchWriteGuildId = req.params.guildId;
    logger.info('[TwitchWriteAuth] init', {
        userId: req.user.id,
        guildId: req.params.guildId,
        statePrefix: state.slice(0, 8) + '...',
        referer: req.get('referer') || null,
    });
    const params = new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: WRITE_SCOPES,
        state,
        // force_verify ensures the broadcaster sees the exact scope list before granting,
        // even if they're already logged in. Important for a WRITE grant — we never want a
        // silent passthrough.
        force_verify: 'true',
    });
    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

export default router;
