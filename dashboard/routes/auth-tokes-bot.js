import express from 'express';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import fetch from 'node-fetch';
import logger from '../../utils/logger.js';
import { encryptToken, hashForLogging } from '../../utils/token-encryption.js';
import { logSessionEvent } from '../config/session.js';
import { KICK_CHANNEL_BOT_SCOPES } from '../../core/stream-bot/kick-scopes.js';

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
// The list lives in core/stream-bot/kick-scopes.js so Stream bot > Connections can say which are missing (H-787).
// channel:write: stream bot title/category (H-749; enabled on the Kick app 2026-11-19)
const KICK_SCOPES = KICK_CHANNEL_BOT_SCOPES.join(' ');

// Allowed return paths (prevent open redirect)
// /stream/bot/connections: its "Kick channel bot" row signs in here (H-787). Same-origin paths only (sanitizeReturnTo).
const ALLOWED_RETURN_PATHS = ['/kick', '/stream/bot/connections'];
// The legacy /tokes-bot dashboard is hidden; the Kick bot lives at /kick.
const DEFAULT_RETURN_PATH = '/kick';

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
export function sanitizeReturnTo(returnTo) {
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
        return res.redirect('/kick?error=invalid_state');
    }
    delete req.session.twitchOAuthState;

    if (error) {
        logger.error('[Tokes Bot Auth] Twitch OAuth error', { error });
        return res.redirect('/kick?error=twitch_auth_denied');
    }

    if (!code) {
        return res.redirect('/kick?error=no_code');
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
            return res.redirect('/kick?error=token_failed');
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
            return res.redirect('/kick?error=user_fetch_failed');
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
        if (await isTokesUserBanned(userId)) return renderBanned(res);

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
        res.redirect('/kick?error=auth_error');
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
        return res.redirect('/kick?error=kick_not_configured');
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

    // Auth errors go back to /kick, or to Stream bot > Connections when the sign-in started there (its "Kick channel
    // bot" row; dashboard/services/stream-bot-view.js CONNECTION_MESSAGES explains these codes there).
    const errorBase = sanitizeReturnTo(req.session?.tokesReturnTo).startsWith('/stream/bot/connections') ? '/stream/bot/connections' : '/kick';

    if (!state || state !== req.session?.kickOAuthState) {
        logger.warn('[Tokes Bot Auth] Invalid Kick OAuth state');
        return res.redirect(`${errorBase}?error=invalid_state`);
    }
    delete req.session.kickOAuthState;

    if (error) {
        logger.error('[Tokes Bot Auth] Kick OAuth error', { error });
        return res.redirect(`${errorBase}?error=kick_auth_denied`);
    }

    if (!code) {
        return res.redirect(`${errorBase}?error=no_code`);
    }

    const codeVerifier = req.session.kickPKCE;
    delete req.session.kickPKCE;

    if (!codeVerifier) {
        return res.redirect(`${errorBase}?error=missing_pkce`);
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
            return res.redirect(`${errorBase}?error=token_failed`);
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
            return res.redirect(`${errorBase}?error=user_fetch_failed`);
        }

        const userData = await userResponse.json();
        const kickUser = Array.isArray(userData?.data) ? userData.data[0] : (userData?.data || userData);

        if (!kickUser || !kickUser.user_id) {
            logger.error('[Tokes Bot Auth] Failed to get Kick user - no valid user data');
            return res.redirect(`${errorBase}?error=user_fetch_failed`);
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
        if (await isTokesUserBanned(userId)) return renderBanned(res);

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

        // Auto-provision the streamer's own Kick channel so the /kick (Defender)
        // panel has something to show. The Kick user IS their channel, so
        // channel_id = kick user_id and channel_name = kick username. This
        // replaces the old "add channel" step that lived on the now-hidden
        // tokes dashboard — without it, brand-new users land on an empty panel
        // with no way to enroll. Idempotent and best-effort: a failure here must
        // never block login.
        await ensureKickChannel(userId, kickUser);

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
        res.redirect(`${errorBase}?error=auth_error`);
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
            res.redirect('/kick');
        });
    } catch (error) {
        logger.error('[Tokes Bot Auth] Logout error', { error: error.message });
        res.redirect('/kick');
    }
});

/*
 * Bans (tokes_users.is_banned, with the expiry of a temporary ban on its
 * tokes_moderation_actions row) were stored but never enforced. Checked at sign-in and on every
 * authenticated request; cached briefly so requests don't each cost a query. An expired temporary
 * ban is lifted here, since nothing else lifts it.
 */
const BAN_CACHE_MS = 60 * 1000;
const banCache = new Map(); // tokes user id -> { at, banned }

export async function isTokesUserBanned(userId) {
    if (!userId) return false;
    const cached = banCache.get(userId);
    if (cached && Date.now() - cached.at < BAN_CACHE_MS) return cached.banned;

    let banned = false;
    try {
        const [[user]] = await pool.execute('SELECT is_banned FROM tokes_users WHERE id = ?', [userId]);
        banned = !!user?.is_banned;
        if (banned) {
            // Lift it when every active ban record has an expiry that has passed.
            const [[ban]] = await pool.execute(
                `SELECT COUNT(*) AS active, SUM(expires_at IS NOT NULL AND expires_at <= NOW()) AS expired
                   FROM tokes_moderation_actions WHERE user_id = ? AND action_type = 'ban' AND is_active = 1`,
                [userId]);
            if (Number(ban.active) > 0 && Number(ban.expired) === Number(ban.active)) {
                await pool.execute('UPDATE tokes_users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [userId]);
                await pool.execute(
                    `UPDATE tokes_moderation_actions SET is_active = 0
                      WHERE user_id = ? AND action_type = 'ban' AND is_active = 1`, [userId]);
                logger.info('[Tokes Auth] Temporary ban expired and was lifted', { userId });
                banned = false;
            }
        }
    } catch (error) {
        logger.error('[Tokes Auth] Ban check failed', { userId, error: error.message });
        return false;   // fail open: a DB hiccup must not lock everyone out
    }
    if (banCache.size > 10000) banCache.clear();
    banCache.set(userId, { at: Date.now(), banned });
    return banned;
}

/** Forget the cached ban status (after a ban or unban from /kick/admin), so it applies on the next request. */
export function forgetTokesBanStatus(userId) {
    if (userId == null) banCache.clear();
    else { banCache.delete(Number(userId)); banCache.delete(String(userId)); }
}

async function refuseIfBanned(req, res) {
    if (!(await isTokesUserBanned(req.session?.tokesUser?.id))) return false;
    req.session.tokesUser = null;
    if (req.xhr || req.headers.accept?.includes('application/json')) {
        res.status(403).json({ error: 'This account is banned' });
    } else {
        renderBanned(res);
    }
    return true;
}

function renderBanned(res) {
    return res.status(403).render('kick/message', {
        heading: 'This account is banned',
        message: "This account can't sign in to Kick Defender. If you think that's a mistake, ask in the support server.",
        kickUser: null,
        actionHref: 'https://certifriedmultitool.com/discord', actionLabel: 'Support server'
    });
}

// Why a Kick/Twitch sign-in came back to /kick?error=... (codes set by the callbacks above).
const SIGN_IN_ERRORS = {
    invalid_state: 'The sign-in took too long or was opened in another tab.',
    kick_auth_denied: 'Kick sign-in was cancelled.',
    twitch_auth_denied: 'Twitch sign-in was cancelled.',
    no_code: 'Kick did not send a sign-in code back.',
    missing_pkce: 'The sign-in session expired.',
    token_failed: 'Kick did not accept the sign-in.',
    user_fetch_failed: 'Kick did not return your account details.',
    auth_error: 'Something went wrong while signing in.',
    kick_not_configured: 'Kick sign-in is not set up on this server.'
};

/**
 * Middleware to require Tokes Bot authentication
 */
export async function requireTokesAuth(req, res, next) {
    if (!req.session?.tokesUser) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect(`/tokes-bot/auth/twitch?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    if (await refuseIfBanned(req, res)) return;
    next();
}

/**
 * Same as requireTokesAuth but, for the Kick Defender (/kick) product, sends
 * logged-out users to KICK OAuth (not Twitch) and returns them to where they
 * were. Same tokesUser session + same OAuth app — just the right login surface
 * for a Kick product, and Kick login is what grants the moderation scopes the
 * defender needs.
 */
export async function requireKickAuth(req, res, next) {
    if (!req.session?.tokesUser) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        // A sign-in that failed comes back here with ?error=: say what happened instead of sending the
        // visitor straight back to Kick (which looped them through the consent screen with no message).
        if (req.method === 'GET' && typeof req.query?.error === 'string') {
            return res.status(401).render('kick/message', {
                heading: 'Sign in with Kick',
                message: (SIGN_IN_ERRORS[req.query.error] || 'Signing in did not finish.') + ' Try again to continue.',
                kickUser: null,
                actionHref: `/tokes-bot/auth/kick?returnTo=${encodeURIComponent(req.path)}`,
                actionLabel: 'Sign in with Kick'
            });
        }
        return res.redirect(`/tokes-bot/auth/kick?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    if (await refuseIfBanned(req, res)) return;
    next();
}

// ============================================================
// DATABASE HELPERS
// ============================================================

/**
 * Ensure a Kick streamer has a tokes_channels row for their own channel.
 *
 * On Kick the authenticated user IS their channel, so we register
 * channel_id = kick user_id and channel_name = kick username. This is what the
 * old /tokes-bot/api/channels "add channel" endpoint did, but that UI is now
 * hidden — so we provision here on login instead. Idempotent (keyed on the
 * existing channel_id) and best-effort: any failure is logged and swallowed so
 * it can never block the login redirect.
 *
 * @param {number} userId   tokes_users.id (owner)
 * @param {object} kickUser Kick API user object ({ user_id, name })
 */
// Fire-and-forget: subscribe a channel to the Kick webhook events (chat, follows, subs, stream).
function subscribeKickChat(channelId) {
    import('../../services/certifried-bot/kick-event-subscriptions.js')
        .then(m => m.ensureSubscribed(channelId))
        .then(r => { if (r && !r.ok) logger.warn('[Tokes Bot Auth] Kick event subscription failed (non-fatal)', { channelId, error: r.error }); })
        .catch(err => logger.warn('[Tokes Bot Auth] Kick event subscription error (non-fatal)', { channelId, error: err.message }));
}

async function ensureKickChannel(userId, kickUser) {
    try {
        const channelId = String(kickUser.user_id);
        const channelName = String(kickUser.name || '').toLowerCase();
        if (!channelId || !channelName) return;

        // Look up the user's Kick connection id (FK required by tokes_channels).
        const [[conn]] = await pool.execute(
            "SELECT id FROM tokes_platform_connections WHERE user_id = ? AND platform = 'kick' AND platform_id = ? LIMIT 1",
            [userId, channelId]
        );
        if (!conn) {
            logger.warn('[Tokes Bot Auth] ensureKickChannel: no kick connection found', { userId, channelId });
            return;
        }

        // Already provisioned? (Match on channel_id — the stable identifier.)
        const [[existing]] = await pool.execute(
            "SELECT id FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? LIMIT 1",
            [channelId]
        );
        if (existing) {
            // Keep ownership/name fresh in case the user reconnected or renamed.
            await pool.execute(
                "UPDATE tokes_channels SET owner_id = ?, connection_id = ?, channel_name = ? WHERE id = ?",
                [userId, conn.id, channelName, existing.id]
            );
            subscribeKickChat(channelId);
            return;
        }

        // Auto-enable the defender on first add. The Kick OAuth grant already
        // includes moderation:ban + moderation:chat_message:manage, so a brand-new
        // channel is immediately protected without a second manual step. This only
        // fires on INSERT — a later manual "disable" is never overridden (the
        // UPDATE branch above leaves defender_enabled untouched).
        await pool.execute(
            `INSERT INTO tokes_channels
                (owner_id, connection_id, platform, channel_id, channel_name, is_enabled, defender_enabled, command_prefix)
             VALUES (?, ?, 'kick', ?, ?, 1, 1, '!')`,
            [userId, conn.id, channelId, channelName]
        );
        logger.info('[Tokes Bot Auth] Auto-provisioned + enrolled Kick channel', { userId, channelName });

        // Chat reaches the bot through Kick's webhook, one subscription per channel.
        subscribeKickChat(channelId);
    } catch (error) {
        logger.error('[Tokes Bot Auth] ensureKickChannel failed (non-fatal)', { userId, error: error.message });
    }
}

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
                // needs_relink = 0: logging in again IS the re-link, so clear the flag
                // that the refresh scheduler uses to skip this connection.
                `UPDATE tokes_platform_connections SET
                    platform_name = ?, platform_avatar = ?, access_token = ?,
                    refresh_token = ?, expires_at = ?, scopes = ?, token_updated_at = NOW(),
                    needs_relink = 0
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

// Legacy redirect for old URLs
router.get('/twitch-bot/auth/*', (req, res) => {
    const newPath = req.originalUrl.replace('/twitch-bot', '/tokes-bot');
    res.redirect(301, newPath);
});

/**
 * True if the given space-separated OAuth scope string grants at least one
 * moderation capability (ban or message-delete). Used by the /kick dashboard
 * to decide whether to show the "re-authorize to enable moderation" banner.
 */
export function hasModerationScopes(scopesStr) {
    const s = scopesStr ? String(scopesStr).split(/\s+/) : [];
    return s.includes('moderation:ban') || s.includes('moderation:chat_message:manage');
}

export default router;
