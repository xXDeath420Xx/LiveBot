import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import encryption from '../../utils/encryption.js';
import logger from '../../utils/logger.js';
import { subscribeBroadcaster } from '../../core/twitch-eventsub-manager.js';
import { runBackfill } from '../../core/twitch-backfill.js';

const router = express.Router();

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${DASHBOARD_URL}/auth/twitch/broadcaster/callback`;
// Scope expansion history:
//   2026-10-14 — anti-abuse analytics v1 (view-bot / follow-bot / raid / harassment).
//   2026-10-18 — analytics v2: hype train, goals, ads, charity, polls, predictions, redemptions,
//                shoutouts, chatters (unique-count polling), + no-scope additions for channel.update
//                and existing-scope additions for subscription.message/end, chat.notification,
//                vip.add/remove, moderator.add/remove.
// Each added scope unlocks a corresponding EventSub subscription type in
// core/twitch-eventsub-manager.js — users who connected with an older scope set keep working at
// reduced analytics coverage until they re-OAuth. Dashboard surfaces the upgrade prompt.
const SCOPES = [
    // ─── Role sync + VIP/mod management ────────────────────────────────────────
    'channel:read:vips', 'channel:manage:vips', 'moderation:read',
    // ─── Analytics v1 (anti-abuse) ─────────────────────────────────────────────
    'moderator:read:followers',    // channel.follow v2
    'channel:read:subscriptions',  // channel.subscribe + .gift + .message + .end
    'bits:read',                   // channel.cheer
    'channel:moderate',            // channel.ban + mod action analytics
    'user:read:chat',              // channel.chat.message + .notification + chatter diversity
    'user:bot',                    // required alongside user:read:chat for webhook chat subs
    // ─── Analytics v2 (growth + engagement) ────────────────────────────────────
    'channel:read:hype_train',     // channel.hype_train.{begin,progress,end}
    'channel:read:goals',          // channel.goal.{begin,progress,end}
    'channel:read:ads',            // channel.ad_break.begin
    'channel:read:charity',        // channel.charity_campaign.{donate,progress,start,stop}
    'channel:read:redemptions',    // channel.channel_points_custom_reward_redemption.add
    'channel:read:polls',          // channel.poll.{begin,progress,end}
    'channel:read:predictions',    // channel.prediction.{begin,progress,lock,end}
    'moderator:read:shoutouts',    // channel.shoutout.{create,receive}
    'moderator:read:chatters',     // Helix GET /chat/chatters for unique-chatter polling
    // ─── Analytics v3 (Tier A read-only — wave 369) ────────────────────────────
    'moderator:read:suspicious_users',  // channel.suspicious_user.{message,update}
    'moderator:read:warnings',          // channel.warning.{send,acknowledge}
    'moderator:read:unban_requests',    // channel.unban_request.{create,resolve}
    'moderator:read:automod_settings',  // AutoMod config viewer
    'moderator:read:blocked_terms',     // Blocked words list
    'moderator:read:shield_mode',       // channel.shield_mode.{begin,end}
    'moderator:read:guest_star',        // channel.guest_star_session.{begin,end}
    'channel:read:editors',             // /channels/editors
    // Never requested (owner rule 2026-11-19, H-726): user:read:follows or any revenue scope. Grants made
    // before then keep user:read:follows until the broadcaster reconnects; nothing calls /channels/followed.
    // tests/twitch-scope-rules.test.js fails if any Twitch scope list in the repo asks for them again.
    'user:read:emotes',                // Available emote context (optional, nice-to-have)
].join(' ');

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
                broadcaster_token_status = 'active',
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

        // Fire-and-forget: create EventSub subscriptions for every type this broadcaster's new
        // scopes unlock (chat.message, follow v2, raid, subscribe, cheer, ban, …). Without this,
        // users wait up to 30 min for the next reconcile cron to pick up the new scopes.
        // Errors are logged inside subscribeBroadcaster; we never block the redirect on it.
        subscribeBroadcaster(twitchUser.id, twitchUser.login).catch(err =>
            logger.warn('[TwitchBroadcasterAuth] subscribeBroadcaster post-OAuth failed', {
                err: err.message, broadcaster: twitchUser.login
            }));

        // Fire-and-forget: Helix backfill for state EventSub webhooks can't retroactively emit —
        // follower count, subscriber count, bits leaderboard, active goals, current charity,
        // recent polls/predictions, VIP/mod rosters, teams, current stream + channel info.
        // Writes to twitch_broadcaster_backfill summary + idempotent inserts into event tables.
        // The analytics page coalesces session-SUM zeros against this summary so a brand-new
        // connection shows real numbers right away. See core/twitch-backfill.js.
        runBackfill({
            broadcasterId: twitchUser.id,
            accessToken: access_token,
            scopes: Array.isArray(scope) ? scope : String(scope || SCOPES).split(/[\s,]+/).filter(Boolean),
            login: twitchUser.login,
        }).catch(err =>
            logger.warn('[TwitchBroadcasterAuth] runBackfill post-OAuth failed', {
                err: err.message, broadcaster: twitchUser.login
            }));

        res.redirect(`/manage/${guildId}?page=streamers&success=twitch_connected&tab=analytics`);
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
