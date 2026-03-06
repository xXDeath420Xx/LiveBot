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

const router = Router();

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

        // Get or create player
        const [[existing]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
            ['twitch', twitchData.userId]
        );

        let player;
        if (existing) {
            player = existing;
            await pool.execute(
                'UPDATE cfx_players SET last_online_at = NOW() WHERE id = ?',
                [player.id]
            );
        } else {
            // Create new player
            const [result] = await pool.execute(
                `INSERT INTO cfx_players (platform, platform_user_id, display_name)
                 VALUES ('twitch', ?, ?)`,
                [twitchData.userId, `Twitch User ${twitchData.userId}`]
            );

            const playerId = result.insertId;

            // Create initial grow slots
            await pool.execute(
                `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, 1), (?, 2)`,
                [playerId, playerId]
            );

            // Grant starter strains
            const [starters] = await pool.execute('SELECT id FROM cfx_strains WHERE is_starter = 1');
            for (const strain of starters) {
                await pool.execute(
                    'INSERT INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                    [playerId, strain.id]
                );
            }

            [[player]] = await pool.execute('SELECT * FROM cfx_players WHERE id = ?', [playerId]);

            logger.info('[Auth] New player created via Twitch extension', { playerId, twitchUserId: twitchData.userId });
        }

        // Create game JWT
        const gameToken = createGameJWT({
            id: player.id,
            platform: 'twitch',
            platformUserId: twitchData.userId,
            displayName: player.display_name
        });

        res.json({
            success: true,
            token: gameToken,
            player: {
                id: player.id,
                displayName: player.display_name,
                level: player.level,
                isNew: !existing
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

        // Get or create player
        const [[existing]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
            ['twitch', twitchUser.id]
        );

        let player;
        if (existing) {
            player = existing;
            await pool.execute(
                'UPDATE cfx_players SET display_name = ?, avatar_url = ?, last_online_at = NOW() WHERE id = ?',
                [twitchUser.display_name, twitchUser.profile_image_url, player.id]
            );
        } else {
            const [result] = await pool.execute(
                `INSERT INTO cfx_players (platform, platform_user_id, display_name, avatar_url)
                 VALUES ('twitch', ?, ?, ?)`,
                [twitchUser.id, twitchUser.display_name, twitchUser.profile_image_url]
            );

            const playerId = result.insertId;

            // Create initial slots
            await pool.execute(
                `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, 1), (?, 2)`,
                [playerId, playerId]
            );

            // Grant starter strains
            const [starters] = await pool.execute('SELECT id FROM cfx_strains WHERE is_starter = 1');
            for (const strain of starters) {
                await pool.execute(
                    'INSERT INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                    [playerId, strain.id]
                );
            }

            [[player]] = await pool.execute('SELECT * FROM cfx_players WHERE id = ?', [playerId]);
            logger.info('[Auth] New player created via Twitch OAuth', { playerId, twitchId: twitchUser.id });
        }

        const gameToken = createGameJWT({
            id: player.id,
            platform: 'twitch',
            platformUserId: twitchUser.id,
            displayName: twitchUser.display_name
        });

        const refreshToken = createRefreshToken(player.id);

        res.json({
            success: true,
            token: gameToken,
            refreshToken,
            player: {
                id: player.id,
                displayName: twitchUser.display_name,
                avatar: twitchUser.profile_image_url,
                level: player.level,
                isNew: !existing
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

        // Get or create player (Kick uses user_id, name, profile_picture)
        const [[existing]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
            ['kick', kickUser.user_id.toString()]
        );

        let player;
        if (existing) {
            player = existing;
            await pool.execute(
                'UPDATE cfx_players SET display_name = ?, avatar_url = ?, last_online_at = NOW() WHERE id = ?',
                [kickUser.name, kickUser.profile_picture, player.id]
            );
        } else {
            const [result] = await pool.execute(
                `INSERT INTO cfx_players (platform, platform_user_id, display_name, avatar_url)
                 VALUES ('kick', ?, ?, ?)`,
                [kickUser.user_id.toString(), kickUser.name, kickUser.profile_picture]
            );

            const playerId = result.insertId;

            await pool.execute(
                `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, 1), (?, 2)`,
                [playerId, playerId]
            );

            const [starters] = await pool.execute('SELECT id FROM cfx_strains WHERE is_starter = 1');
            for (const strain of starters) {
                await pool.execute(
                    'INSERT INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                    [playerId, strain.id]
                );
            }

            [[player]] = await pool.execute('SELECT * FROM cfx_players WHERE id = ?', [playerId]);
            logger.info('[Auth] New player created via Kick OAuth (POST)', { playerId, kickId: kickUser.user_id });
        }

        const gameToken = createGameJWT({
            id: player.id,
            platform: 'kick',
            platformUserId: kickUser.user_id.toString(),
            displayName: kickUser.name
        });

        const refreshToken = createRefreshToken(player.id);

        res.json({
            success: true,
            token: gameToken,
            refreshToken,
            player: {
                id: player.id,
                displayName: kickUser.name,
                avatar: kickUser.profile_picture,
                level: player.level,
                isNew: !existing
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

        const newToken = createGameJWT({
            id: player.id,
            platform: player.platform,
            platformUserId: player.platform_user_id,
            displayName: player.display_name
        });

        res.json({
            success: true,
            token: newToken
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

    res.redirect(authUrl.toString());
});

/**
 * GET /auth/twitch/callback
 * Handle Twitch OAuth callback
 */
router.get('/twitch/callback', async (req, res) => {
    try {
        const { code, error } = req.query;

        if (error) {
            return res.send(oauthErrorPage('Twitch authorization was denied'));
        }

        if (!code) {
            return res.send(oauthErrorPage('No authorization code received'));
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

        // Get or create player
        const [[existing]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
            ['twitch', twitchUser.id]
        );

        let player;
        if (existing) {
            player = existing;
            await pool.execute(
                'UPDATE cfx_players SET display_name = ?, avatar_url = ?, last_online_at = NOW() WHERE id = ?',
                [twitchUser.display_name, twitchUser.profile_image_url, player.id]
            );
        } else {
            const [result] = await pool.execute(
                `INSERT INTO cfx_players (platform, platform_user_id, display_name, avatar_url)
                 VALUES ('twitch', ?, ?, ?)`,
                [twitchUser.id, twitchUser.display_name, twitchUser.profile_image_url]
            );

            const playerId = result.insertId;

            // Create initial slots
            await pool.execute(
                `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, 1), (?, 2)`,
                [playerId, playerId]
            );

            // Grant starter strains
            const [starters] = await pool.execute('SELECT id FROM cfx_strains WHERE is_starter = 1');
            for (const strain of starters) {
                await pool.execute(
                    'INSERT INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                    [playerId, strain.id]
                );
            }

            [[player]] = await pool.execute('SELECT * FROM cfx_players WHERE id = ?', [playerId]);
            logger.info('[Auth] New player created via Twitch OAuth', { playerId, twitchId: twitchUser.id });
        }

        const gameToken = createGameJWT({
            id: player.id,
            platform: 'twitch',
            platformUserId: twitchUser.id,
            displayName: twitchUser.display_name
        });

        // Send success page that posts message to opener
        res.send(oauthSuccessPage(gameToken));

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

        // Get or create player (Kick uses user_id, name, profile_picture)
        const [[existing]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
            ['kick', kickUser.user_id.toString()]
        );

        let player;
        if (existing) {
            player = existing;
            await pool.execute(
                'UPDATE cfx_players SET display_name = ?, avatar_url = ?, last_online_at = NOW() WHERE id = ?',
                [kickUser.name, kickUser.profile_picture, player.id]
            );
        } else {
            const [result] = await pool.execute(
                `INSERT INTO cfx_players (platform, platform_user_id, display_name, avatar_url)
                 VALUES ('kick', ?, ?, ?)`,
                [kickUser.user_id.toString(), kickUser.name, kickUser.profile_picture]
            );

            const playerId = result.insertId;

            await pool.execute(
                `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, 1), (?, 2)`,
                [playerId, playerId]
            );

            const [starters] = await pool.execute('SELECT id FROM cfx_strains WHERE is_starter = 1');
            for (const strain of starters) {
                await pool.execute(
                    'INSERT INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                    [playerId, strain.id]
                );
            }

            [[player]] = await pool.execute('SELECT * FROM cfx_players WHERE id = ?', [playerId]);
            logger.info('[Auth] New player created via Kick OAuth', { playerId, kickId: kickUser.user_id });
        }

        const gameToken = createGameJWT({
            id: player.id,
            platform: 'kick',
            platformUserId: kickUser.user_id.toString(),
            displayName: kickUser.name
        });

        res.send(oauthSuccessPage(gameToken));

    } catch (error) {
        logger.error('[Auth] Kick callback error', { error: error.message, stack: error.stack });
        // Show actual error in development
        const errorMsg = process.env.NODE_ENV === 'production'
            ? 'Authentication failed'
            : `Authentication failed: ${error.message}`;
        res.send(oauthErrorPage(errorMsg));
    }
});

/**
 * Generate OAuth success page that posts message to opener
 */
function oauthSuccessPage(token) {
    const targetOrigin = CFX_BASE_URL.replace('/cfx-api', '');
    return `<!DOCTYPE html>
<html>
<head>
    <title>CertiFried - Login Success</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #111827;
            color: #f9fafb;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
        }
        .success { color: #22c55e; font-size: 24px; margin-bottom: 16px; }
        .message { color: #9ca3af; }
        .debug { color: #6b7280; font-size: 12px; margin-top: 16px; }
    </style>
</head>
<body>
    <div>
        <div class="success">✓ Login Successful</div>
        <div class="message" id="status">Completing login...</div>
        <div class="debug" id="debug"></div>
    </div>
    <script>
        const debug = document.getElementById('debug');
        const status = document.getElementById('status');
        const targetOrigin = '${targetOrigin}';

        // Always save to localStorage as fallback (before trying postMessage)
        try {
            localStorage.setItem('cfx_oauth_token', '${token}');
            debug.textContent = 'Token saved';
        } catch (e) {
            debug.textContent = 'localStorage failed';
        }

        debug.textContent += ' | Opener: ' + (window.opener ? 'yes' : 'no');

        if (window.opener) {
            try {
                window.opener.postMessage({
                    type: 'cfx_oauth_success',
                    token: '${token}'
                }, targetOrigin);
                status.textContent = 'You can close this window...';
                debug.textContent += ' | Message sent!';
                setTimeout(() => window.close(), 2000);
            } catch (err) {
                status.textContent = 'Closing... (go back to game tab)';
                debug.textContent += ' | postMessage error: ' + err.message;
                setTimeout(() => window.close(), 3000);
            }
        } else {
            status.textContent = 'Login complete! Close this and return to game.';
            debug.textContent += ' | Using localStorage fallback';
            setTimeout(() => window.close(), 3000);
        }
    </script>
</body>
</html>`;
}

/**
 * Generate OAuth error page
 */
function oauthErrorPage(message) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>CertiFried - Login Error</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #111827;
            color: #f9fafb;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
        }
        .error { color: #ef4444; font-size: 24px; margin-bottom: 16px; }
        .message { color: #9ca3af; margin-bottom: 24px; }
        button {
            background: #374151;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
        }
        button:hover { background: #4b5563; }
    </style>
</head>
<body>
    <div>
        <div class="error">✗ Login Failed</div>
        <div class="message">${message}</div>
        <button onclick="window.close()">Close Window</button>
    </div>
</body>
</html>`;
}

/**
 * POST /auth/dev
 * Development-only authentication for testing
 * Creates or returns a test player without external auth
 */
router.post('/dev', async (req, res) => {
    // Only allow in development
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Dev auth disabled in production', code: 'FORBIDDEN' });
    }

    try {
        const { testId } = req.body;
        const devUserId = testId || 'dev_test_user_001';
        const displayName = `TestPlayer_${devUserId}`;

        // Get or create dev test player
        let [[player]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
            ['dev', devUserId]
        );

        if (!player) {
            // Create new test player with starter resources
            const [result] = await pool.execute(
                `INSERT INTO cfx_players (platform, platform_user_id, display_name, cash, level, xp)
                 VALUES ('dev', ?, ?, 50000, 5, 1000)`,
                [devUserId, displayName]
            );

            const playerId = result.insertId;

            // Create grow slots
            await pool.execute(
                `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, 1), (?, 2), (?, 3), (?, 4)`,
                [playerId, playerId, playerId, playerId]
            );

            // Grant ALL starter strains with seeds
            const [starters] = await pool.execute('SELECT id FROM cfx_strains WHERE is_starter = 1');
            for (const strain of starters) {
                await pool.execute(
                    'INSERT INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                    [playerId, strain.id]
                );
                await pool.execute(
                    `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity, total_gifted)
                     VALUES (?, ?, 20, 20)`,
                    [playerId, strain.id]
                );
            }

            // Create player stats
            await pool.execute('INSERT INTO cfx_player_stats (player_id) VALUES (?)', [playerId]);

            // Create player settings
            await pool.execute('INSERT INTO cfx_player_settings (player_id) VALUES (?)', [playerId]);

            [[player]] = await pool.execute('SELECT * FROM cfx_players WHERE id = ?', [playerId]);
            logger.info('[Auth] Created dev test player', { playerId, devUserId });
        }

        // Create game JWT
        const gameToken = createGameJWT({
            id: player.id,
            platform: 'dev',
            platformUserId: devUserId,
            displayName: player.display_name
        });

        res.json({
            success: true,
            token: gameToken,
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
