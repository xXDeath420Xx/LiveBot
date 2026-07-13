// Member-side Twitch link OAuth flow.
//   GET  /link/twitch           — landing page (must be Discord-authed)
//   GET  /link/twitch/start     — redirects to Twitch OAuth authorize URL
//   GET  /link/twitch/callback  — handles Twitch code, writes community_twitch_links
//                                 for every guild the user shares with any of our bots.
//
// This populates the same `community_twitch_links` table that
// `jobs/twitch-role-sync-scheduler.js` reads — so the link grants the Discord
// Mod/VIP role on the next sync cycle (15-minute cron, or via Sync Now).

import express from 'express';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const router = express.Router();

const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BASE_URL             = process.env.DASHBOARD_BASE_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3001}`;
const REDIRECT_URI         = `${BASE_URL}/link/twitch/callback`;

function ensureDiscordAuthed(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.id) return next();
    res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/link/twitch'));
}

router.get('/link/twitch', ensureDiscordAuthed, (req, res) => {
    res.render('link-twitch', {
        user: req.user,
        already: req.query.success === '1',
        error: req.query.error || null,
        guildCount: typeof req.query.count === 'string' ? parseInt(req.query.count, 10) : null,
    });
});

router.get('/link/twitch/start', ensureDiscordAuthed, (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.twitchLinkState = state;
    const params = new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'user:read:email',
        state,
        force_verify: 'true',  // make Twitch always ask, so users can switch accounts
    });
    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/link/twitch/callback', ensureDiscordAuthed, async (req, res) => {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect('/link/twitch?error=' + encodeURIComponent(oauthError));
    if (!code) return res.redirect('/link/twitch?error=no_code');
    if (!state || state !== req.session.twitchLinkState) return res.redirect('/link/twitch?error=state_mismatch');
    delete req.session.twitchLinkState;

    try {
        // Exchange code for token
        const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI,
            }),
        });
        const tokenData = await tokenResp.json();
        if (!tokenData.access_token) {
            logger.error('[LinkTwitch] Token exchange failed', { tokenData });
            return res.redirect('/link/twitch?error=token_exchange_failed');
        }

        // Fetch the user's Twitch identity
        const userResp = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                'Client-Id': TWITCH_CLIENT_ID,
            },
        });
        const userData = await userResp.json();
        const twitchUser = userData?.data?.[0];
        if (!twitchUser?.id) {
            logger.error('[LinkTwitch] User fetch failed', { userData });
            return res.redirect('/link/twitch?error=user_fetch_failed');
        }

        const discordUserId = req.user.id;
        const twitchUserId  = twitchUser.id;
        const twitchLogin   = twitchUser.login;

        // Find every guild where (a) any of our bots is present, and (b) the
        // authed Discord user is a member. Write a community_twitch_links row
        // for each — one OAuth link covers every shared server.
        const sharedGuildIds = new Set();
        const userGuildIds = new Set((req.user.guilds || []).map(g => g.id));

        if (global.botManager?.clients) {
            for (const [, botClient] of global.botManager.clients) {
                for (const [, guild] of botClient.guilds.cache) {
                    if (userGuildIds.has(guild.id)) sharedGuildIds.add(guild.id);
                }
            }
        }

        if (sharedGuildIds.size === 0) {
            return res.redirect('/link/twitch?success=1&count=0');
        }

        for (const gid of sharedGuildIds) {
            await pool.execute(
                `INSERT INTO community_twitch_links (guild_id, discord_user_id, twitch_username, twitch_user_id, last_checked)
                 VALUES (?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE twitch_username = VALUES(twitch_username), twitch_user_id = VALUES(twitch_user_id), last_checked = NOW()`,
                [gid, discordUserId, twitchLogin, twitchUserId]
            );
        }

        logger.info(`[LinkTwitch] Linked Discord ${req.user.username} (${discordUserId}) → Twitch ${twitchLogin} (${twitchUserId}) across ${sharedGuildIds.size} guild(s)`);
        res.redirect(`/link/twitch?success=1&count=${sharedGuildIds.size}`);
    } catch (err) {
        logger.error('[LinkTwitch] callback error:', { error: err.message, stack: err.stack });
        res.redirect('/link/twitch?error=server_error');
    }
});

export default router;
