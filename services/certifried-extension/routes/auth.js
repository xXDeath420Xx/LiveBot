/**
 * Authentication Routes
 * Handles Twitch Extension JWT and OAuth flows
 */

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { verifyTwitchJWT } from '../middleware/twitch-jwt.js';
import { createGameJWT, createRefreshToken, verifyRefreshToken } from '../middleware/oauth-auth.js';
import { getOrCreatePlayer } from '../game/player-factory.js';

const router = Router();

/** Game token + refresh token for a player row (every sign-in path returns both; H-405). */
function issueTokens(player) {
    return {
        token: createGameJWT({
            id: player.id,
            platform: player.platform,
            platformUserId: player.platform_user_id,
            displayName: player.display_name
        }),
        refreshToken: createRefreshToken(player.id)
    };
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Sign-in for a Discord user who is already logged in to the dashboard
 * (used by POST /cfx/session/discord in the dashboard, H-407). The Discord
 * chat commands use the same platform id, so it is the same player.
 */
export async function createDiscordSession(discordUser) {
    if (!discordUser?.id || !/^\d{17,20}$/.test(String(discordUser.id))) throw new Error('Invalid Discord user');
    const avatar = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`
        : null;
    const { player, created } = await getOrCreatePlayer(
        'discord', String(discordUser.id), discordUser.global_name || discordUser.username, avatar
    );
    if (player.is_banned) {
        const err = new Error('Account is banned');
        err.code = 'BANNED';
        throw err;
    }
    return { ...issueTokens(player), player: { id: player.id, displayName: player.display_name, level: player.level, isNew: created } };
}

// Store PKCE verifiers temporarily (in production, use Redis or similar)
const pkceStore = new Map();

/**
 * POST /auth/twitch
 * Authenticate via Twitch Extension JWT
 */
router.post('/twitch', async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token required', code: 'NO_TOKEN' });
        }

        const twitchData = verifyTwitchJWT(token);

        if (!twitchData) {
            return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
        }

        if (twitchData.isUnlinked) {
            return res.status(401).json({
                error: 'Please share your identity with the extension',
                code: 'UNLINKED_USER'
            });
        }

        const { player, created } = await getOrCreatePlayer('twitch', twitchData.userId, `Twitch User ${twitchData.userId}`);
        if (player.is_banned) {
            return res.status(403).json({ error: 'Account is banned', code: 'BANNED' });
        }

        res.json({
            success: true,
            ...issueTokens(player),
            player: {
                id: player.id,
                displayName: player.display_name,
                level: player.level,
                isNew: created
            }
        });

    } catch (error) {
        logger.error('[Auth] Twitch auth error', { error: error.message });
        res.status(500).json({ error: 'Authentication failed', code: 'AUTH_ERROR' });
    }
});

/**
 * POST /auth/oauth/twitch
 * OAuth2 flow for standalone Twitch authentication
 */
router.post('/oauth/twitch', async (req, res) => {
    try {
        const { code, redirectUri } = req.body;

        if (!code) {
            return res.status(400).json({ error: 'Code required', code: 'NO_CODE' });
        }

        // Exchange code for tokens with Twitch
        const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri || process.env.CFX_OAUTH_REDIRECT_URI
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.text();
            logger.warn('[Auth] Twitch OAuth token exchange failed', { error: errorData });
            return res.status(401).json({ error: 'OAuth failed', code: 'OAUTH_FAILED' });
        }

        const tokens = await tokenResponse.json();

        // Get user info from Twitch
        const userResponse = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });

        if (!userResponse.ok) {
            return res.status(401).json({ error: 'Failed to get user info', code: 'USER_FETCH_FAILED' });
        }

        const userData = await userResponse.json();
        const twitchUser = userData.data[0];

        const { player, created } = await getOrCreatePlayer('twitch', twitchUser.id, twitchUser.display_name, twitchUser.profile_image_url);
        if (player.is_banned) {
            return res.status(403).json({ error: 'Account is banned', code: 'BANNED' });
        }

        res.json({
            success: true,
            ...issueTokens(player),
            player: {
                id: player.id,
                displayName: player.display_name,
                avatar: twitchUser.profile_image_url,
                level: player.level,
                isNew: created
            }
        });

    } catch (error) {
        logger.error('[Auth] Twitch OAuth error', { error: error.message });
        res.status(500).json({ error: 'OAuth failed', code: 'OAUTH_ERROR' });
    }
});

/**
 * POST /auth/oauth/kick
 * OAuth2 flow for Kick authentication
 */
router.post('/oauth/kick', async (req, res) => {
    try {
        const { code, redirectUri } = req.body;

        if (!code) {
            return res.status(400).json({ error: 'Code required', code: 'NO_CODE' });
        }

        // Exchange code for tokens with Kick
        const tokenResponse = await fetch('https://id.kick.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.KICK_CLIENT_ID,
                client_secret: process.env.KICK_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri || process.env.CFX_KICK_OAUTH_REDIRECT_URI
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.text();
            logger.warn('[Auth] Kick OAuth token exchange failed', { error: errorData });
            return res.status(401).json({ error: 'OAuth failed', code: 'OAUTH_FAILED' });
        }

        const tokens = await tokenResponse.json();

        // Get user info from Kick official API
        const userResponse = await fetch('https://api.kick.com/public/v1/users', {
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`,
                'Accept': 'application/json'
            }
        });

        if (!userResponse.ok) {
            return res.status(401).json({ error: 'Failed to get user info', code: 'USER_FETCH_FAILED' });
        }

        const userData = await userResponse.json();
        const kickUser = Array.isArray(userData?.data) ? userData.data[0] : (userData?.data || userData);

        if (!kickUser || !kickUser.user_id) {
            return res.status(401).json({ error: 'Invalid user data from Kick', code: 'INVALID_USER_DATA' });
        }

        const { player, created } = await getOrCreatePlayer('kick', kickUser.user_id.toString(), kickUser.name, kickUser.profile_picture);
        if (player.is_banned) {
            return res.status(403).json({ error: 'Account is banned', code: 'BANNED' });
        }

        res.json({
            success: true,
            ...issueTokens(player),
            player: {
                id: player.id,
                displayName: player.display_name,
                avatar: kickUser.profile_picture,
                level: player.level,
                isNew: created
            }
        });

    } catch (error) {
        logger.error('[Auth] Kick OAuth error', { error: error.message });
        res.status(500).json({ error: 'OAuth failed', code: 'OAUTH_ERROR' });
    }
});

/**
 * POST /auth/refresh
 * Refresh access token
 */
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required', code: 'NO_TOKEN' });
        }

        const decoded = verifyRefreshToken(refreshToken);

        if (!decoded) {
            return res.status(401).json({ error: 'Invalid refresh token', code: 'INVALID_TOKEN' });
        }

        const [[player]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE id = ?',
            [decoded.playerId]
        );

        if (!player) {
            return res.status(401).json({ error: 'Player not found', code: 'PLAYER_NOT_FOUND' });
        }

        if (player.is_banned) {
            return res.status(403).json({ error: 'Account banned', code: 'BANNED' });
        }

        // A fresh refresh token too, so a player who keeps playing never has to sign in again
        res.json({
            success: true,
            ...issueTokens(player)
        });

    } catch (error) {
        logger.error('[Auth] Refresh error', { error: error.message });
        res.status(500).json({ error: 'Refresh failed', code: 'REFRESH_ERROR' });
    }
});

/**
 * GET /auth/me
 * Get current player info (requires auth)
 */
router.get('/me', async (req, res) => {
    // This would need unifiedAuth middleware
    res.status(501).json({ error: 'Use /game/state for full player info' });
});

// ===========================================
// OAuth Initiation Routes (for standalone mode)
// ===========================================

const CFX_BASE_URL = process.env.CFX_EBS_URL || 'https://certifriedmultitool.com';

/**
 * GET /auth/twitch
 * Redirect to Twitch OAuth authorization page
 */
router.get('/twitch', (req, res) => {
    const redirectUri = `${CFX_BASE_URL}/cfx-api/api/v1/auth/twitch/callback`;
    const scopes = 'user:read:email';

    const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
    authUrl.searchParams.set('client_id', process.env.TWITCH_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    // state ties the callback to this redirect (login CSRF)
    const state = crypto.randomBytes(16).toString('hex');
    pkceStore.set(`twitch:${state}`, { expires: Date.now() + 600000 });
    for (const [key, value] of pkceStore.entries()) {
        if (value.expires < Date.now()) pkceStore.delete(key);
    }
    authUrl.searchParams.set('state', state);

    res.redirect(authUrl.toString());
});

/**
 * GET /auth/twitch/callback
 * Handle Twitch OAuth callback
 */
router.get('/twitch/callback', async (req, res) => {
    try {
        const { code, error, state } = req.query;

        if (error) {
            return res.send(oauthErrorPage('Twitch authorization was denied'));
        }

        if (!code) {
            return res.send(oauthErrorPage('No authorization code received'));
        }

        const stateEntry = pkceStore.get(`twitch:${state}`);
        pkceStore.delete(`twitch:${state}`);
        if (!state || !stateEntry || stateEntry.expires < Date.now()) {
            return res.send(oauthErrorPage('Sign-in session expired, please try again'));
        }

        const redirectUri = `${CFX_BASE_URL}/cfx-api/api/v1/auth/twitch/callback`;

        // Exchange code for tokens
        const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            })
        });

        if (!tokenResponse.ok) {
            logger.warn('[Auth] Twitch token exchange failed', { status: tokenResponse.status });
            return res.send(oauthErrorPage('Failed to authenticate with Twitch'));
        }

        const tokens = await tokenResponse.json();

        // Get user info
        const userResponse = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });

        if (!userResponse.ok) {
            return res.send(oauthErrorPage('Failed to get Twitch user info'));
        }

        const userData = await userResponse.json();
        const twitchUser = userData.data[0];

        const { player } = await getOrCreatePlayer('twitch', twitchUser.id, twitchUser.display_name, twitchUser.profile_image_url);
        if (player.is_banned) {
            return res.send(oauthErrorPage('This account is banned from the game'));
        }

        // Send success page that posts message to opener
        res.send(oauthSuccessPage(issueTokens(player)));

    } catch (error) {
        logger.error('[Auth] Twitch callback error', { error: error.message });
        res.send(oauthErrorPage('Authentication failed'));
    }
});

/**
 * GET /auth/kick
 * Redirect to Kick OAuth authorization page (with PKCE)
 */
router.get('/kick', (req, res) => {
    const redirectUri = `${CFX_BASE_URL}/cfx-api/api/v1/auth/kick/callback`;
    const scopes = 'user:read';

    // Generate PKCE values
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    // Store verifier for callback (expires in 10 minutes)
    pkceStore.set(state, { codeVerifier, expires: Date.now() + 600000 });

    // Clean up old entries
    for (const [key, value] of pkceStore.entries()) {
        if (value.expires < Date.now()) pkceStore.delete(key);
    }

    const authUrl = new URL('https://id.kick.com/oauth/authorize');
    authUrl.searchParams.set('client_id', process.env.KICK_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(authUrl.toString());
});

/**
 * GET /auth/kick/callback
 * Handle Kick OAuth callback (with PKCE)
 */
router.get('/kick/callback', async (req, res) => {
    try {
        const { code, error, state } = req.query;

        if (error) {
            return res.send(oauthErrorPage('Kick authorization was denied'));
        }

        if (!code) {
            return res.send(oauthErrorPage('No authorization code received'));
        }

        // Retrieve PKCE verifier
        const pkceData = pkceStore.get(state);
        if (!pkceData || pkceData.expires < Date.now()) {
            pkceStore.delete(state);
            return res.send(oauthErrorPage('Session expired, please try again'));
        }
        pkceStore.delete(state);

        const redirectUri = `${CFX_BASE_URL}/cfx-api/api/v1/auth/kick/callback`;

        // Exchange code for tokens (with PKCE verifier)
        const tokenResponse = await fetch('https://id.kick.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.KICK_CLIENT_ID,
                client_secret: process.env.KICK_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
                code_verifier: pkceData.codeVerifier
            })
        });

        if (!tokenResponse.ok) {
            logger.warn('[Auth] Kick token exchange failed', { status: tokenResponse.status });
            return res.send(oauthErrorPage('Failed to authenticate with Kick'));
        }

        const tokens = await tokenResponse.json();

        // Get user info from Kick's public API
        const userResponse = await fetch('https://api.kick.com/public/v1/users', {
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`
            }
        });

        if (!userResponse.ok) {
            const errorText = await userResponse.text();
            logger.warn('[Auth] Kick user fetch failed', { status: userResponse.status, error: errorText });
            return res.send(oauthErrorPage('Failed to get Kick user info'));
        }

        const userData = await userResponse.json();
        // Handle multiple response formats (array or direct object)
        const kickUser = Array.isArray(userData?.data) ? userData.data[0] : (userData?.data || userData);

        if (!kickUser || !kickUser.user_id) {
            logger.error('[Auth] Kick user data invalid', { userData });
            return res.send(oauthErrorPage('Failed to get Kick user info'));
        }

        const { player } = await getOrCreatePlayer('kick', kickUser.user_id.toString(), kickUser.name, kickUser.profile_picture);
        if (player.is_banned) {
            return res.send(oauthErrorPage('This account is banned from the game'));
        }

        res.send(oauthSuccessPage(issueTokens(player)));

    } catch (error) {
        logger.error('[Auth] Kick callback error', { error: error.message, stack: error.stack });
        res.send(oauthErrorPage('Authentication failed'));
    }
});

/**
 * Page the OAuth popup lands on after a successful sign-in. Hands both tokens
 * to the game tab (postMessage, plus localStorage for when the opener link is
 * lost, e.g. under Cross-Origin-Opener-Policy) and closes, or goes to /game
 * when it was not opened as a popup.
 */
function oauthSuccessPage({ token, refreshToken }) {
    const targetOrigin = new URL(CFX_BASE_URL).origin;
    // Tokens are JWTs (base64url + dots); JSON.stringify plus '<' escaping keeps the inline script safe regardless
    const data = JSON.stringify({ type: 'cfx_oauth_success', token, refreshToken }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CertiFried - Signed in</title>
    <style>
        body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #111827; color: #f9fafb;
               display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; }
        h1 { font-size: 20px; margin: 0 0 8px; }
        p { color: #9ca3af; margin: 0; }
        a { color: #22c55e; }
    </style>
</head>
<body>
    <div>
        <h1>Signed in</h1>
        <p id="status">Taking you back to the game...</p>
    </div>
    <script>
        (function () {
            var data = ${data};
            var status = document.getElementById('status');
            try {
                localStorage.setItem('cfx_oauth_token', data.token);
                localStorage.setItem('cfx_oauth_refresh', data.refreshToken);
            } catch (e) { /* storage blocked: postMessage below still works */ }
            if (window.opener) {
                try { window.opener.postMessage(data, ${JSON.stringify(targetOrigin)}); } catch (e) { /* opener gone */ }
                setTimeout(function () { window.close(); }, 800);
                setTimeout(function () { status.textContent = 'You can close this window now.'; }, 1500);
            } else {
                setTimeout(function () { location.replace('/game'); }, 600);
            }
        })();
    </script>
</body>
</html>`;
}

/**
 * Generate OAuth error page (message is escaped; callers pass fixed text)
 */
function oauthErrorPage(message) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CertiFried - Sign-in failed</title>
    <style>
        body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #111827; color: #f9fafb;
               display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; }
        h1 { font-size: 20px; margin: 0 0 8px; color: #f87171; }
        p { color: #9ca3af; margin: 0 0 20px; }
        a { color: #22c55e; }
    </style>
</head>
<body>
    <div>
        <h1>Sign-in failed</h1>
        <p>${escapeHtml(message)}</p>
        <a href="/game">Back to the game</a>
    </div>
</body>
</html>`;
}

/**
 * POST /auth/dev
 * Test sign-in without an external account. Only works when CFX_DEV_AUTH=1 is
 * set AND the request comes straight from this machine (loopback, no proxy
 * headers), so it can never be reached through the website (H-400).
 */
export function devAuthAllowed(req) {
    if (process.env.CFX_DEV_AUTH !== '1') return false;
    const ip = req.socket?.remoteAddress || '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['forwarded'];
    return loopback && !proxied;
}

router.post('/dev', async (req, res) => {
    if (!devAuthAllowed(req)) {
        return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    }

    try {
        const testId = String(req.body?.testId || 'dev_test_user_001').slice(0, 60);
        const { player } = await getOrCreatePlayer('dev', testId, `TestPlayer_${testId}`, null,
            { extra: { cash: 50000, level: 5, xp: 1000 } });

        res.json({
            success: true,
            ...issueTokens(player),
            player: {
                id: player.id,
                displayName: player.display_name,
                level: player.level,
                xp: player.xp,
                cash: parseFloat(player.cash),
                prestigeLevel: player.prestige_level,
                prestigeTokens: player.prestige_tokens
            }
        });

    } catch (error) {
        logger.error('[Auth] Dev auth failed', { error: error.message });
        res.status(500).json({ error: 'Dev auth failed', code: 'ERROR' });
    }
});

export default router;
