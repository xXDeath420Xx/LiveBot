import express from 'express';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import fetch from 'node-fetch';
import logger from '../../utils/logger.js';
import { encryptToken, decryptToken, hashForLogging } from '../../utils/token-encryption.js';
import { logSessionEvent, getSessionStore } from '../config/session.js';

const router = express.Router();

// Environment config
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');

// Twitch OAuth config
const TWITCH_CLIENT_ID = process.env.TWITCH_BOT_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_BOT_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REDIRECT_URI = `${BASE_URL}/tokes-bot/auth/twitch/callback`;
const TWITCH_SCOPES = ['user:read:email', 'chat:read', 'chat:edit'].join(' ');

// Kick OAuth config (PKCE)
const KICK_CLIENT_ID = process.env.KICK_BOT_CLIENT_ID || process.env.KICK_CLIENT_ID;
const KICK_CLIENT_SECRET = process.env.KICK_BOT_CLIENT_SECRET || process.env.KICK_CLIENT_SECRET;
const KICK_REDIRECT_URI = `${BASE_URL}/tokes-bot/auth/kick/callback`;
const KICK_SCOPES = ['user:read', 'chat:write', 'events:subscribe', 'channel:read'].join(' ');

// Allowed return paths (prevent open redirect)
const ALLOWED_RETURN_PATHS = ['/tokes-bot', '/tokes-bot/dashboard', '/tokes-bot/channels', '/tokes-bot/profile'];
const DEFAULT_RETURN_PATH = '/tokes-bot/dashboard';

/**
 * Generate PKCE code verifier and challenge for Kick OAuth
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/**
 * Validate and sanitize returnTo parameter
 */
function sanitizeReturnTo(returnTo) {
    if (!returnTo || typeof returnTo !== 'string') {
        return DEFAULT_RETURN_PATH;
    }

    try {
        const dummyBase = 'http://localhost';
        const parsed = new URL(returnTo, dummyBase);

        if (parsed.origin !== dummyBase) {
            logger.warn('[Tokes Bot Auth] Blocked absolute URL redirect', { returnTo });
            return DEFAULT_RETURN_PATH;
        }

        const normalizedPath = parsed.pathname;
        const isAllowed = ALLOWED_RETURN_PATHS.some(allowed =>
            normalizedPath === allowed || normalizedPath.startsWith(allowed + '/')
        );

        if (!isAllowed) {
            logger.warn('[Tokes Bot Auth] Blocked disallowed return path', { returnTo, normalizedPath });
            return DEFAULT_RETURN_PATH;
        }

        return normalizedPath + parsed.search;
    } catch (error) {
        logger.warn('[Tokes Bot Auth] Failed to parse returnTo', { returnTo, error: error.message });
        return DEFAULT_RETURN_PATH;
    }
}

// ============================================================
// TWITCH OAUTH
// ============================================================

/**
 * GET /tokes-bot/auth/twitch
 * Initiate Twitch OAuth flow
 */
router.get('/tokes-bot/auth/twitch', (req, res) => {
    const returnTo = sanitizeReturnTo(req.query.returnTo);

    if (req.session) {
        req.session.tokesReturnTo = returnTo;
        if (req.session.tokesUser?.id) {
            req.session.tokesLinkUserId = req.session.tokesUser.id;
            logger.info('[Tokes Bot Auth] Linking Twitch to existing user', { userId: req.session.tokesUser.id });
        }
    }

    const state = crypto.randomBytes(16).toString('hex');
    req.session.twitchOAuthState = state;

    const params = new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        redirect_uri: TWITCH_REDIRECT_URI,
        response_type: 'code',
        scope: TWITCH_SCOPES,
        state: state,
        force_verify: 'false'
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

/**
 * GET /tokes-bot/auth/twitch/callback
 * Handle Twitch OAuth callback
 */
router.get('/tokes-bot/auth/twitch/callback', async (req, res) => {
    const { code, error, state } = req.query;

    if (!state || state !== req.session?.twitchOAuthState) {
        logger.warn('[Tokes Bot Auth] Invalid OAuth state', { state });
        return res.redirect('/tokes-bot?error=invalid_state');
    }
    delete req.session.twitchOAuthState;

    if (error) {
        logger.error('[Tokes Bot Auth] Twitch OAuth error', { error });
        return res.redirect('/tokes-bot?error=twitch_auth_denied');
    }

    if (!code) {
        return res.redirect('/tokes-bot?error=no_code');
    }

    try {
        // Exchange code for tokens
        const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: TWITCH_REDIRECT_URI
            })
        });

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            // Log only non-sensitive error info, never the full token response
            logger.error('[Tokes Bot Auth] Token exchange failed', {
                error: tokenData.error || 'unknown',
                errorDescription: tokenData.error_description || 'No access token returned'
            });
            return res.redirect('/tokes-bot?error=token_failed');
        }

        // Fetch user info
        const userResponse = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Client-Id': TWITCH_CLIENT_ID
            }
        });

        const userData = await userResponse.json();

        if (!userData.data?.[0]) {
            logger.error('[Tokes Bot Auth] Failed to get Twitch user', { error: userData });
            return res.redirect('/tokes-bot?error=user_fetch_failed');
        }

        const twitchUser = userData.data[0];

        // Calculate token expiry
        let expiresAt = null;
        if (tokenData.expires_in) {
            const d = new Date(Date.now() + tokenData.expires_in * 1000);
            expiresAt = d.toISOString().slice(0, 19).replace('T', ' ');
        }

        const linkToUserId = req.session.tokesLinkUserId || null;
        delete req.session.tokesLinkUserId;

        // Upsert user and connection
        const userId = await upsertUser('twitch', twitchUser, tokenData, expiresAt, linkToUserId);

        // Set session
        req.session.tokesUser = {
            id: userId,
            platform: 'twitch',
            platformId: twitchUser.id,
            name: twitchUser.display_name,
            login: twitchUser.login,
            avatar: twitchUser.profile_image_url
        };

        // Initialize session activity tracking
        req.session.lastActivity = Date.now();
        req.session.loginTime = Date.now();

        // Log the login event
        const ipAddress = req.ip || req.connection?.remoteAddress;
        const userAgent = req.headers['user-agent'];
        await logSessionEvent(userId, req.sessionID, 'login', ipAddress, userAgent, `Twitch login: ${twitchUser.login}`);

        const returnTo = sanitizeReturnTo(req.session.tokesReturnTo);
        delete req.session.tokesReturnTo;

        logger.info('[Tokes Bot Auth] Twitch login successful', { user: twitchUser.login });
        res.redirect(returnTo);

    } catch (error) {
        logger.error('[Tokes Bot Auth] Twitch auth error', { error: error.message, stack: error.stack });
        res.redirect('/tokes-bot?error=auth_error');
    }
});

// ============================================================
// KICK OAUTH (PKCE)
// ============================================================

/**
 * GET /tokes-bot/auth/kick
 * Initiate Kick OAuth flow with PKCE
 */
router.get('/tokes-bot/auth/kick', (req, res) => {
    if (!KICK_CLIENT_ID) {
        return res.redirect('/tokes-bot?error=kick_not_configured');
    }

    const returnTo = sanitizeReturnTo(req.query.returnTo);

    if (req.session) {
        req.session.tokesReturnTo = returnTo;
        if (req.session.tokesUser?.id) {
            req.session.tokesLinkUserId = req.session.tokesUser.id;
            logger.info('[Tokes Bot Auth] Linking Kick to existing user', { userId: req.session.tokesUser.id });
        }
    }

    const pkce = generatePKCE();
    req.session.kickPKCE = pkce.verifier;

    const state = crypto.randomBytes(16).toString('hex');
    req.session.kickOAuthState = state;

    const params = new URLSearchParams({
        client_id: KICK_CLIENT_ID,
        redirect_uri: KICK_REDIRECT_URI,
        response_type: 'code',
        scope: KICK_SCOPES,
        state: state,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256'
    });

    res.redirect(`https://id.kick.com/oauth/authorize?${params}`);
});

/**
 * GET /tokes-bot/auth/kick/callback
 * Handle Kick OAuth callback
 */
router.get('/tokes-bot/auth/kick/callback', async (req, res) => {
    const { code, error, state } = req.query;

    if (!state || state !== req.session?.kickOAuthState) {
        logger.warn('[Tokes Bot Auth] Invalid Kick OAuth state');
        return res.redirect('/tokes-bot?error=invalid_state');
    }
    delete req.session.kickOAuthState;

    if (error) {
        logger.error('[Tokes Bot Auth] Kick OAuth error', { error });
        return res.redirect('/tokes-bot?error=kick_auth_denied');
    }

    if (!code) {
        return res.redirect('/tokes-bot?error=no_code');
    }

    const codeVerifier = req.session.kickPKCE;
    delete req.session.kickPKCE;

    if (!codeVerifier) {
        return res.redirect('/tokes-bot?error=missing_pkce');
    }

    try {
        // Exchange code for tokens with PKCE verifier
        const tokenResponse = await fetch('https://id.kick.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: KICK_CLIENT_ID,
                client_secret: KICK_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: KICK_REDIRECT_URI,
                code_verifier: codeVerifier
            })
        });

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            // Log only non-sensitive error info, never the full token response
            logger.error('[Tokes Bot Auth] Kick token exchange failed', {
                error: tokenData.error || 'unknown',
                errorDescription: tokenData.error_description || 'No access token returned'
            });
            return res.redirect('/tokes-bot?error=token_failed');
        }

        // Fetch user info from Kick official API
        const userResponse = await fetch('https://api.kick.com/public/v1/users', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/json'
            }
        });

        if (!userResponse.ok) {
            const errorText = await userResponse.text();
            logger.error('[Tokes Bot Auth] Kick user API failed', { status: userResponse.status, error: errorText.substring(0, 500) });
            return res.redirect('/tokes-bot?error=user_fetch_failed');
        }

        const userData = await userResponse.json();
        const kickUser = Array.isArray(userData?.data) ? userData.data[0] : (userData?.data || userData);

        if (!kickUser || !kickUser.user_id) {
            logger.error('[Tokes Bot Auth] Failed to get Kick user - no valid user data');
            return res.redirect('/tokes-bot?error=user_fetch_failed');
        }

        // Calculate token expiry
        let expiresAt = null;
        if (tokenData.expires_in) {
            const d = new Date(Date.now() + tokenData.expires_in * 1000);
            expiresAt = d.toISOString().slice(0, 19).replace('T', ' ');
        }

        const linkToUserId = req.session.tokesLinkUserId || null;
        delete req.session.tokesLinkUserId;

        // Upsert user and connection
        const userId = await upsertUser('kick', kickUser, tokenData, expiresAt, linkToUserId);

        // Set session
        req.session.tokesUser = {
            id: userId,
            platform: 'kick',
            platformId: kickUser.user_id,
            name: kickUser.name,
            avatar: kickUser.profile_picture
        };

        // Initialize session activity tracking
        req.session.lastActivity = Date.now();
        req.session.loginTime = Date.now();

        // Log the login event
        const ipAddress = req.ip || req.connection?.remoteAddress;
        const userAgent = req.headers['user-agent'];
        await logSessionEvent(userId, req.sessionID, 'login', ipAddress, userAgent, `Kick login: ${kickUser.name}`);

        const returnTo = sanitizeReturnTo(req.session.tokesReturnTo);
        delete req.session.tokesReturnTo;

        logger.info('[Tokes Bot Auth] Kick login successful', { user: kickUser.name });
        res.redirect(returnTo);

    } catch (error) {
        logger.error('[Tokes Bot Auth] Kick auth error', { error: error.message, stack: error.stack });
        res.redirect('/tokes-bot?error=auth_error');
    }
});

// ============================================================
// LOGOUT & UTILITIES
// ============================================================

/**
 * GET /tokes-bot/auth/logout
 * Clear session and logout
 */
router.get('/tokes-bot/auth/logout', async (req, res) => {
    try {
        if (req.session?.tokesUser) {
            const userId = req.session.tokesUser.id;
            const ipAddress = req.ip || req.connection?.remoteAddress;
            const userAgent = req.headers['user-agent'];

            // Log the logout event before destroying session
            await logSessionEvent(userId, req.sessionID, 'logout', ipAddress, userAgent, 'User initiated logout');
        }

        // Destroy the entire session (properly removes from store)
        req.session.destroy((err) => {
            if (err) {
                logger.error('[Tokes Bot Auth] Logout session destroy error', { error: err.message });
            }
            // Clear the cookie
            res.clearCookie('certifried.sid');
            res.redirect('/tokes-bot');
        });
    } catch (error) {
        logger.error('[Tokes Bot Auth] Logout error', { error: error.message });
        res.redirect('/tokes-bot');
    }
});

/**
 * GET /tokes-bot/api/me
 * Get current logged in user
 */
router.get('/tokes-bot/api/me', (req, res) => {
    if (req.session?.tokesUser) {
        res.json({ user: req.session.tokesUser });
    } else {
        res.json({ user: null });
    }
});

/**
 * Middleware to require Tokes Bot authentication
 */
export function requireTokesAuth(req, res, next) {
    if (!req.session?.tokesUser) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect(`/tokes-bot/auth/twitch?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    next();
}

// ============================================================
// DATABASE HELPERS
// ============================================================

/**
 * Upsert user and platform connection
 */
async function upsertUser(platform, platformUser, tokenData, expiresAt, linkToUserId = null) {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Normalize platform user data
        const platformId = platform === 'twitch' ? platformUser.id : platformUser.user_id;
        const platformName = platform === 'twitch' ? platformUser.display_name : platformUser.name;
        const platformAvatar = platform === 'twitch' ? platformUser.profile_image_url : platformUser.profile_picture;
        const email = platformUser.email || null;

        // Normalize scopes
        let scopesStr = null;
        if (tokenData.scope) {
            scopesStr = Array.isArray(tokenData.scope) ? tokenData.scope.join(' ') : String(tokenData.scope);
        }

        // Check if platform connection exists
        const [existingConnections] = await connection.execute(
            'SELECT id, user_id FROM tokes_platform_connections WHERE platform = ? AND platform_id = ?',
            [platform, platformId]
        );

        let userId;

        if (existingConnections.length > 0) {
            const existingUserId = existingConnections[0].user_id;

            if (linkToUserId && linkToUserId !== existingUserId) {
                // Merge accounts
                logger.info('[upsertUser] Merging accounts', { fromUserId: existingUserId, toUserId: linkToUserId });

                await connection.query('UPDATE tokes_platform_connections SET user_id = ? WHERE id = ?', [linkToUserId, existingConnections[0].id]);
                await connection.query('UPDATE tokes_platform_connections SET user_id = ? WHERE user_id = ?', [linkToUserId, existingUserId]);
                await connection.query('UPDATE tokes_channels SET owner_id = ? WHERE owner_id = ?', [linkToUserId, existingUserId]);
                await connection.query('DELETE FROM tokes_users WHERE id = ?', [existingUserId]);

                userId = linkToUserId;
            } else {
                userId = existingUserId;
            }

            // Encrypt tokens before storing
            const encryptedAccessToken = encryptToken(tokenData.access_token);
            const encryptedRefreshToken = tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null;

            // Update platform connection tokens
            await connection.query(
                `UPDATE tokes_platform_connections SET
                    platform_name = ?, platform_avatar = ?, access_token = ?,
                    refresh_token = ?, expires_at = ?, scopes = ?, token_updated_at = NOW()
                WHERE platform = ? AND platform_id = ?`,
                [platformName || 'Unknown', platformAvatar || null, encryptedAccessToken,
                 encryptedRefreshToken, expiresAt, scopesStr, platform, platformId]
            );

            logger.info('[upsertUser] Updated tokens (encrypted)', {
                platform,
                platformId,
                tokenHash: hashForLogging(tokenData.access_token)
            });

            await connection.query('UPDATE tokes_users SET last_seen = NOW(), primary_name = ? WHERE id = ?', [platformName || 'Unknown', userId]);

        } else {
            if (linkToUserId) {
                userId = linkToUserId;
                await connection.query('UPDATE tokes_users SET last_seen = NOW() WHERE id = ?', [userId]);
            } else {
                const [userResult] = await connection.query(
                    'INSERT INTO tokes_users (primary_name, email) VALUES (?, ?)',
                    [platformName || 'Unknown', email || null]
                );
                userId = userResult.insertId;
            }

            // Encrypt tokens before storing
            const encryptedAccessToken = encryptToken(tokenData.access_token);
            const encryptedRefreshToken = tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null;

            // Create platform connection
            await connection.query(
                `INSERT INTO tokes_platform_connections
                    (user_id, platform, platform_id, platform_name, platform_avatar, access_token, refresh_token, expires_at, scopes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, platform, platformId, platformName || 'Unknown', platformAvatar || null,
                 encryptedAccessToken, encryptedRefreshToken, expiresAt, scopesStr]
            );

            logger.info('[upsertUser] Created connection (encrypted)', {
                platform,
                platformId,
                tokenHash: hashForLogging(tokenData.access_token)
            });
        }

        await connection.commit();

        // Claim legacy profiles
        await claimLegacyProfiles(platform, platformId, platformName, userId);

        return userId;

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Claim legacy/migrated profiles when a user authenticates
 */
async function claimLegacyProfiles(platform, platformId, displayName, userId) {
    try {
        const normalizedName = displayName.toLowerCase().replace(/[^a-z0-9_]/g, '');

        const [legacyProfiles] = await pool.execute(`
            SELECT id, platform_user_id, display_name, lifetime_tokes, xp, level, current_streak, best_streak
            FROM tokes_profiles
            WHERE platform = ? AND is_claimed = 0
              AND (LOWER(platform_user_id) = ? OR LOWER(display_name) = ? OR LOWER(REPLACE(display_name, '_', '')) = ?)
        `, [platform, normalizedName, normalizedName, normalizedName.replace(/_/g, '')]);

        if (legacyProfiles.length === 0) return;

        logger.info('[ClaimLegacy] Found legacy profiles', { userId, platform, displayName, count: legacyProfiles.length });

        let [currentProfile] = await pool.execute(
            `SELECT * FROM tokes_profiles WHERE platform = ? AND platform_user_id = ? AND is_claimed = 1`,
            [platform, platformId]
        );

        if (currentProfile.length === 0) {
            await pool.execute(
                `INSERT INTO tokes_profiles (platform, platform_user_id, display_name, is_claimed, claimed_by_user_id) VALUES (?, ?, ?, 1, ?)`,
                [platform, platformId, displayName, userId]
            );
            [currentProfile] = await pool.execute(`SELECT * FROM tokes_profiles WHERE platform = ? AND platform_user_id = ?`, [platform, platformId]);
        }

        const profile = currentProfile[0];
        let totalTokes = profile.lifetime_tokes || 0;
        let totalXp = profile.xp || 0;
        let maxLevel = profile.level || 1;
        let bestStreak = profile.best_streak || 0;

        for (const legacy of legacyProfiles) {
            totalTokes += legacy.lifetime_tokes || 0;
            totalXp += legacy.xp || 0;
            maxLevel = Math.max(maxLevel, legacy.level || 1);
            bestStreak = Math.max(bestStreak, legacy.best_streak || 0);

            await pool.execute(`UPDATE tokes_profiles SET is_claimed = 1, claimed_by_user_id = ? WHERE id = ?`, [userId, legacy.id]);
        }

        await pool.execute(
            `UPDATE tokes_profiles SET lifetime_tokes = ?, xp = ?, level = ?, best_streak = GREATEST(best_streak, ?), is_claimed = 1, claimed_by_user_id = ? WHERE id = ?`,
            [totalTokes, totalXp, maxLevel, bestStreak, userId, profile.id]
        );

        logger.info('[ClaimLegacy] Merged profiles', { userId, merged: legacyProfiles.length, totalTokes });

    } catch (error) {
        logger.error('[ClaimLegacy] Error', { error: error.message, platform, displayName });
    }
}

// ============================================================
// PROFILE & PLATFORM MANAGEMENT API
// ============================================================

/**
 * GET /tokes-bot/api/profile
 * Get current user's profile with all connected platforms
 */
router.get('/tokes-bot/api/profile', async (req, res) => {
    if (!req.session?.tokesUser?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const userId = req.session.tokesUser.id;

        const [users] = await pool.execute(
            'SELECT id, primary_name, email, role, created_at FROM tokes_users WHERE id = ?',
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [platforms] = await pool.execute(
            `SELECT platform, platform_id, platform_name, platform_avatar, connected_at, token_updated_at, scopes
             FROM tokes_platform_connections WHERE user_id = ?`,
            [userId]
        );

        res.json({
            user: users[0],
            platforms: platforms,
            currentPlatform: req.session.tokesUser.platform
        });

    } catch (error) {
        logger.error('[Tokes Bot API] Error getting profile', { error: error.message });
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

/**
 * DELETE /tokes-bot/api/platforms/:platform
 * Disconnect a platform from the user's account
 */
router.delete('/tokes-bot/api/platforms/:platform', async (req, res) => {
    if (!req.session?.tokesUser?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { platform } = req.params;
    if (!['twitch', 'kick'].includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
    }

    try {
        const userId = req.session.tokesUser.id;

        const [platforms] = await pool.execute(
            'SELECT platform FROM tokes_platform_connections WHERE user_id = ?',
            [userId]
        );

        if (platforms.length <= 1) {
            return res.status(400).json({ error: 'Cannot disconnect your only platform' });
        }

        const [result] = await pool.execute(
            'DELETE FROM tokes_platform_connections WHERE user_id = ? AND platform = ?',
            [userId, platform]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Platform not connected' });
        }

        if (req.session.tokesUser.platform === platform) {
            const [remaining] = await pool.execute(
                `SELECT platform, platform_id, platform_name, platform_avatar FROM tokes_platform_connections WHERE user_id = ? LIMIT 1`,
                [userId]
            );

            if (remaining.length > 0) {
                req.session.tokesUser.platform = remaining[0].platform;
                req.session.tokesUser.platformId = remaining[0].platform_id;
                req.session.tokesUser.name = remaining[0].platform_name;
                req.session.tokesUser.avatar = remaining[0].platform_avatar;
            }
        }

        logger.info('[Tokes Bot API] Platform disconnected', { userId, platform });
        res.json({ success: true, message: `${platform} disconnected` });

    } catch (error) {
        logger.error('[Tokes Bot API] Error disconnecting platform', { error: error.message });
        res.status(500).json({ error: 'Failed to disconnect platform' });
    }
});

/**
 * POST /tokes-bot/api/platforms/:platform/activate
 * Switch the active platform for the current session
 */
router.post('/tokes-bot/api/platforms/:platform/activate', async (req, res) => {
    if (!req.session?.tokesUser?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { platform } = req.params;
    if (!['twitch', 'kick'].includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
    }

    try {
        const userId = req.session.tokesUser.id;

        // Check if user has this platform connected
        const [connections] = await pool.execute(
            `SELECT platform, platform_id, platform_name, platform_avatar
             FROM tokes_platform_connections
             WHERE user_id = ? AND platform = ?`,
            [userId, platform]
        );

        if (connections.length === 0) {
            return res.status(404).json({
                error: 'Platform not connected',
                message: `You haven't connected your ${platform} account yet`
            });
        }

        const conn = connections[0];

        // Update session with new active platform
        req.session.tokesUser.platform = conn.platform;
        req.session.tokesUser.platformId = conn.platform_id;
        req.session.tokesUser.name = conn.platform_name;
        req.session.tokesUser.avatar = conn.platform_avatar;

        logger.info('[Tokes Bot API] Platform switched', { userId, platform });
        res.json({
            success: true,
            message: `Switched to ${platform}`,
            user: {
                platform: conn.platform,
                platformId: conn.platform_id,
                name: conn.platform_name,
                avatar: conn.platform_avatar
            }
        });

    } catch (error) {
        logger.error('[Tokes Bot API] Error switching platform', { error: error.message });
        res.status(500).json({ error: 'Failed to switch platform' });
    }
});

/**
 * PATCH /tokes-bot/api/platforms/:platform/bot-status
 * Toggle whether a platform connection is marked as a bot account
 */
router.patch('/tokes-bot/api/platforms/:platform/bot-status', async (req, res) => {
    if (!req.session?.tokesUser?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { platform } = req.params;
    const { is_bot_account } = req.body;

    if (!['twitch', 'kick'].includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
    }

    if (typeof is_bot_account !== 'boolean') {
        return res.status(400).json({ error: 'is_bot_account must be a boolean' });
    }

    try {
        const userId = req.session.tokesUser.id;

        const [result] = await pool.execute(
            `UPDATE tokes_platform_connections
             SET is_bot_account = ?
             WHERE user_id = ? AND platform = ?`,
            [is_bot_account ? 1 : 0, userId, platform]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Platform connection not found' });
        }

        logger.info('[Tokes Bot API] Bot status updated', { userId, platform, is_bot_account });
        res.json({
            success: true,
            message: is_bot_account ? 'Account marked as bot' : 'Account unmarked as bot'
        });

    } catch (error) {
        logger.error('[Tokes Bot API] Error updating bot status', { error: error.message });
        res.status(500).json({ error: 'Failed to update bot status' });
    }
});

/**
 * GET /tokes-bot/api/bot-accounts
 * Get all bot accounts for the current user
 */
router.get('/tokes-bot/api/bot-accounts', async (req, res) => {
    if (!req.session?.tokesUser?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const userId = req.session.tokesUser.id;

        const [bots] = await pool.execute(
            `SELECT id, platform, platform_id, platform_name, platform_avatar
             FROM tokes_platform_connections
             WHERE user_id = ? AND is_bot_account = 1`,
            [userId]
        );

        res.json({ bots });

    } catch (error) {
        logger.error('[Tokes Bot API] Error getting bot accounts', { error: error.message });
        res.status(500).json({ error: 'Failed to get bot accounts' });
    }
});

/**
 * POST /tokes-bot/api/admin/make-admin
 * Make a user admin (requires authentication)
 * Bootstrap mode requires TOKES_BOOTSTRAP_SECRET environment variable
 */
router.post('/tokes-bot/api/admin/make-admin', async (req, res) => {
    try {
        const { userId, role, bootstrapSecret } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const [owners] = await pool.execute("SELECT id FROM tokes_users WHERE role = 'owner' LIMIT 1");

        // Bootstrap mode - only allowed if no owners exist AND correct secret provided
        if (owners.length === 0) {
            const expectedSecret = process.env.TOKES_BOOTSTRAP_SECRET;

            // Require bootstrap secret in production
            if (!expectedSecret) {
                logger.warn('[Tokes Bot] Bootstrap attempted but TOKES_BOOTSTRAP_SECRET not set');
                return res.status(403).json({
                    error: 'Bootstrap disabled. Set TOKES_BOOTSTRAP_SECRET in environment and provide it in request.'
                });
            }

            // Timing-safe comparison of bootstrap secret
            if (!bootstrapSecret || bootstrapSecret.length !== expectedSecret.length ||
                !crypto.timingSafeEqual(Buffer.from(bootstrapSecret), Buffer.from(expectedSecret))) {
                logger.warn('[Tokes Bot] Invalid bootstrap secret attempt', {
                    ip: req.ip,
                    userId
                });
                return res.status(403).json({ error: 'Invalid bootstrap secret' });
            }

            // Verify user exists before promoting
            const [targetUser] = await pool.execute("SELECT id, primary_name FROM tokes_users WHERE id = ?", [userId]);
            if (targetUser.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            await pool.execute("UPDATE tokes_users SET role = 'owner' WHERE id = ?", [userId]);

            logger.info('[Tokes Bot] Owner bootstrapped successfully', {
                userId,
                userName: targetUser[0].primary_name,
                ip: req.ip
            });

            return res.json({ success: true, message: 'User set as owner (bootstrap complete)' });
        }

        // Normal mode - require authentication
        if (!req.session?.tokesUser?.id) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const [currentUser] = await pool.execute("SELECT role FROM tokes_users WHERE id = ?", [req.session.tokesUser.id]);

        if (currentUser[0]?.role !== 'owner') {
            logger.warn('[Tokes Bot] Unauthorized role change attempt', {
                attemptedBy: req.session.tokesUser.id,
                targetUser: userId
            });
            return res.status(403).json({ error: 'Only owner can manage roles' });
        }

        const validRoles = ['user', 'mod', 'admin'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: 'Invalid role. Must be: user, mod, or admin' });
        }

        // Verify target user exists
        const [targetUser] = await pool.execute("SELECT id, primary_name FROM tokes_users WHERE id = ?", [userId]);
        if (targetUser.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        await pool.execute("UPDATE tokes_users SET role = ? WHERE id = ?", [role, userId]);

        logger.info('[Tokes Bot] User role updated', {
            updatedBy: req.session.tokesUser.id,
            targetUser: userId,
            newRole: role
        });

        res.json({ success: true, message: `User role set to ${role}` });

    } catch (error) {
        logger.error('[Tokes Bot] Role update error', { error: error.message });
        res.status(500).json({ error: 'Failed to update role' });
    }
});

// Legacy redirect for old URLs
router.get('/twitch-bot/auth/*', (req, res) => {
    const newPath = req.originalUrl.replace('/twitch-bot', '/tokes-bot');
    res.redirect(301, newPath);
});

export default router;
