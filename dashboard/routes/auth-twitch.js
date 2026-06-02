import express from 'express';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import fetch from 'node-fetch';
import encryption from '../../utils/encryption.js';
import logger from '../../utils/logger.js';

const router = express.Router();

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/auth/twitch/callback`;
// Distinct redirect for the Discord-account-link verification flow (writes twitch_oauth_accounts).
const LINK_REDIRECT_URI = `${BASE_URL}/auth/twitch/link/callback`;

// Allowed paths for returnTo redirect (prevents open redirect attacks)
const ALLOWED_RETURN_PATHS = ['/my-schedules', '/schedule', '/dashboard', '/manage'];
const DEFAULT_RETURN_PATH = '/my-schedules';

/**
 * Validate and sanitize returnTo parameter to prevent open redirect attacks
 * Uses URL API for proper parsing to avoid bypass via URL encoding tricks
 * @param {string} returnTo - The return URL from query parameter
 * @returns {string} Safe return path or default
 */
function sanitizeReturnTo(returnTo) {
    if (!returnTo || typeof returnTo !== 'string') {
        return DEFAULT_RETURN_PATH;
    }

    try {
        // Use URL API to parse the path - base URL ensures we catch absolute URL tricks
        const dummyBase = 'http://localhost';
        const parsed = new URL(returnTo, dummyBase);

        // If the parsed URL has a different origin, it's an absolute URL (open redirect attempt)
        if (parsed.origin !== dummyBase) {
            logger.warn('[Twitch Auth] Blocked absolute URL redirect attempt', { returnTo });
            return DEFAULT_RETURN_PATH;
        }

        // Get normalized pathname (URL API handles encoding normalization)
        const normalizedPath = parsed.pathname;

        // Check against allowed paths
        const isAllowed = ALLOWED_RETURN_PATHS.some(allowed =>
            normalizedPath === allowed || normalizedPath.startsWith(allowed + '/')
        );

        if (!isAllowed) {
            logger.warn('[Twitch Auth] Blocked disallowed return path', {
                returnTo,
                normalizedPath
            });
            return DEFAULT_RETURN_PATH;
        }

        // Return the normalized path with any query string (but not hash)
        // This ensures consistent behavior regardless of input encoding
        return normalizedPath + parsed.search;

    } catch (error) {
        // URL parsing failed - malformed input
        logger.warn('[Twitch Auth] Failed to parse returnTo URL', {
            returnTo,
            error: error.message
        });
        return DEFAULT_RETURN_PATH;
    }
}

// Twitch OAuth login - redirects to Twitch
router.get('/auth/twitch', (req, res) => {
    // Sanitize returnTo to prevent open redirect attacks
    const returnTo = sanitizeReturnTo(req.query.returnTo);

    // Store validated return URL in session
    if (req.session) {
        req.session.twitchReturnTo = returnTo;
    }

    const params = new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'user:read:email',
        force_verify: 'false'
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

// Twitch OAuth callback
router.get('/auth/twitch/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        logger.error('[Twitch Auth] OAuth error', { error });
        return res.redirect('/schedule?error=twitch_auth_failed');
    }

    if (!code) {
        return res.redirect('/schedule?error=no_code');
    }

    try {
        // Exchange code for access token
        const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI
            })
        });

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            logger.error('[Twitch Auth] Failed to get access token', { error: JSON.stringify(tokenData) });
            return res.redirect('/schedule?error=token_failed');
        }

        // Get user info from Twitch
        const userResponse = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Client-Id': TWITCH_CLIENT_ID
            }
        });

        const userData = await userResponse.json();

        if (!userData.data || !userData.data[0]) {
            logger.error('[Twitch Auth] Failed to get user data', { error: JSON.stringify(userData) });
            return res.redirect('/schedule?error=user_data_failed');
        }

        const twitchUser = userData.data[0];

        // Upsert user in database
        const [existingUsers] = await pool.execute(
            'SELECT * FROM schedule_users WHERE twitch_id = ?',
            [twitchUser.id]
        );

        let userId;
        if (existingUsers.length > 0) {
            // Update existing user
            await pool.execute(
                `UPDATE schedule_users SET
                    twitch_login = ?,
                    twitch_display_name = ?,
                    twitch_email = ?,
                    twitch_avatar = ?,
                    twitch_access_token = ?,
                    twitch_refresh_token = ?,
                    last_login = NOW()
                WHERE twitch_id = ?`,
                [
                    twitchUser.login,
                    twitchUser.display_name,
                    twitchUser.email || null,
                    twitchUser.profile_image_url,
                    tokenData.access_token,
                    tokenData.refresh_token || null,
                    twitchUser.id
                ]
            );
            userId = existingUsers[0].id;
        } else {
            // Create new user
            const [result] = await pool.execute(
                `INSERT INTO schedule_users
                    (twitch_id, twitch_login, twitch_display_name, twitch_email, twitch_avatar, twitch_access_token, twitch_refresh_token)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    twitchUser.id,
                    twitchUser.login,
                    twitchUser.display_name,
                    twitchUser.email || null,
                    twitchUser.profile_image_url,
                    tokenData.access_token,
                    tokenData.refresh_token || null
                ]
            );
            userId = result.insertId;
        }

        // Set session
        req.session.twitchUser = {
            id: userId,
            twitch_id: twitchUser.id,
            login: twitchUser.login,
            display_name: twitchUser.display_name,
            avatar: twitchUser.profile_image_url
        };

        // Redirect to return URL or my-schedules (sanitize again as defense-in-depth)
        const returnTo = sanitizeReturnTo(req.session.twitchReturnTo);
        delete req.session.twitchReturnTo;

        res.redirect(returnTo);

    } catch (error) {
        logger.error('[Twitch Auth] Error', { error: error.message });
        res.redirect('/schedule?error=auth_error');
    }
});

// Logout
router.get('/auth/twitch/logout', (req, res) => {
    if (req.session) {
        delete req.session.twitchUser;
    }
    res.redirect('/schedule');
});

// Middleware to check Twitch auth
export function requireTwitchAuth(req, res, next) {
    if (!req.session?.twitchUser) {
        return res.redirect(`/auth/twitch?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    next();
}

// API to get current Twitch user
router.get('/api/twitch/me', (req, res) => {
    if (req.session?.twitchUser) {
        res.json({ user: req.session.twitchUser });
    } else {
        res.json({ user: null });
    }
});

// ---------------------------------------------------------------------------
// Discord-account-link verification flow (Task 9)
//   GET /auth/twitch/link           — start: requires a logged-in Discord session
//   GET /auth/twitch/link/callback  — exchange code, verify the Twitch identity,
//                                      upsert twitch_oauth_accounts (tokens encrypted)
//                                      keyed by the logged-in Discord user id.
// This is distinct from the public schedule-site Twitch login above (which sets
// req.session.twitchUser / schedule_users). The verified twitch_user_id here
// enables trusted schedule imports for the Discord user.
// ---------------------------------------------------------------------------

// Callback registered before the start route — both are exact paths, but keeping
// the more specific path first avoids any future prefix-matching surprises.
router.get('/auth/twitch/link/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const expectedState = req.session?.twitchOwnershipState;
    const returnGuildId = req.session?.twitchOwnershipGuildId;

    if (req.session) {
        delete req.session.twitchOwnershipState;
        delete req.session.twitchOwnershipGuildId;
    }

    const failRedirect = returnGuildId
        ? `/manage/${returnGuildId}?page=event-schedule&twitch=error`
        : '/dashboard?twitch=error';
    const successRedirect = returnGuildId
        ? `/manage/${returnGuildId}?page=event-schedule&twitch=connected`
        : '/dashboard?twitch=connected';

    // Must have a logged-in Discord session to attribute the verified Twitch account.
    if (!req.user?.id) {
        return res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/auth/twitch/link'));
    }

    if (error || !code) {
        logger.error('[TwitchOwnership] OAuth error or missing code', { error, discordUser: req.user.id });
        return res.redirect(failRedirect);
    }

    if (!state || !expectedState || state !== expectedState) {
        logger.error('[TwitchOwnership] State mismatch', { discordUser: req.user.id });
        return res.redirect(failRedirect);
    }

    try {
        // Exchange code for an access token.
        const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: LINK_REDIRECT_URI
            })
        });
        const tokenData = await tokenResp.json();

        if (!tokenData.access_token) {
            logger.error('[TwitchOwnership] Token exchange failed', { tokenData, discordUser: req.user.id });
            return res.redirect(failRedirect);
        }

        // Identify the authed Twitch user with the user token.
        const userResp = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Client-Id': TWITCH_CLIENT_ID
            }
        });
        const userData = await userResp.json();
        const twitchUser = userData?.data?.[0];

        if (!twitchUser?.id) {
            logger.error('[TwitchOwnership] User fetch failed', { userData, discordUser: req.user.id });
            return res.redirect(failRedirect);
        }

        // Encrypt tokens — stored as TEXT (JSON string of the encrypted object).
        const encryptedAccess = JSON.stringify(encryption.encrypt(tokenData.access_token));
        const encryptedRefresh = tokenData.refresh_token
            ? JSON.stringify(encryption.encrypt(tokenData.refresh_token))
            : null;
        const expiresAt = tokenData.expires_in
            ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        await pool.execute(
            `INSERT INTO twitch_oauth_accounts
                (discord_user_id, twitch_user_id, twitch_username, access_token, refresh_token, expires_at, verified_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                twitch_user_id = VALUES(twitch_user_id),
                twitch_username = VALUES(twitch_username),
                access_token = VALUES(access_token),
                refresh_token = VALUES(refresh_token),
                expires_at = VALUES(expires_at),
                verified_at = NOW()`,
            [
                req.user.id,
                twitchUser.id,
                twitchUser.login,
                encryptedAccess,
                encryptedRefresh,
                expiresAt
            ]
        );

        logger.info(`[TwitchOwnership] Discord ${req.user.username} (${req.user.id}) verified Twitch ${twitchUser.login} (${twitchUser.id})`);
        res.redirect(successRedirect);
    } catch (err) {
        logger.error('[TwitchOwnership] callback error', { error: err.message, discordUser: req.user?.id });
        res.redirect(failRedirect);
    }
});

router.get('/auth/twitch/link', (req, res) => {
    // Require a logged-in Discord session so we can attribute the Twitch account.
    if (!req.user?.id) {
        return res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/auth/twitch/link'));
    }

    const state = crypto.randomBytes(16).toString('hex');
    req.session.twitchOwnershipState = state;
    if (req.query.guildId) {
        req.session.twitchOwnershipGuildId = String(req.query.guildId);
    }

    const params = new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        redirect_uri: LINK_REDIRECT_URI,
        response_type: 'code',
        // Identity-only link: no scope needed — Helix GET /users returns the authed user.
        scope: '',
        state,
        force_verify: 'true'  // let users pick/switch the Twitch account they own
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

export default router;
