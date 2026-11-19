/**
 * Unified Authentication Middleware
 * Handles both Twitch Extension JWT and OAuth game JWT
 * Sets req.player with the authenticated player data
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { verifyTwitchJWT } from './twitch-jwt.js';
import { verifyGameJWT } from './oauth-auth.js';
import { getOrCreatePlayer as createOrFindPlayer } from '../game/player-factory.js';
import { isFrozen } from '../freeze.js';

/**
 * Twitch display name + avatar for an extension viewer (the extension token
 * only carries the numeric user id). Cached for 6 hours; null when Helix is
 * unreachable, in which case the player keeps "Twitch User <id>" until a
 * later request succeeds.
 */
const twitchProfiles = new Map();
async function twitchProfile(userId) {
    const hit = twitchProfiles.get(userId);
    if (hit && hit.expires > Date.now()) return hit.profile;
    let profile = null;
    try {
        const { getAccessToken } = await import('../../../utils/platforms/twitch.js');
        const appToken = await getAccessToken();
        const r = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`, {
            headers: { 'Authorization': `Bearer ${appToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID },
            signal: AbortSignal.timeout(4000)
        });
        if (r.ok) {
            const u = (await r.json())?.data?.[0];
            if (u) profile = { name: u.display_name || u.login, avatar: u.profile_image_url || null };
        }
    } catch (error) {
        logger.debug('[UnifiedAuth] Twitch profile lookup failed', { error: error.message });
    }
    if (twitchProfiles.size > 5000) twitchProfiles.clear();
    twitchProfiles.set(userId, { profile, expires: Date.now() + (profile ? 6 * 3600e3 : 10 * 60e3) });
    return profile;
}

/**
 * Get or create player by platform credentials (shared factory, H-406)
 */
async function getOrCreatePlayer(platform, platformUserId, displayName, avatarUrl = null) {
    // Frozen (H-636): sign-in still works, but requests no longer count as visits
    const { player } = await createOrFindPlayer(platform, platformUserId, displayName, avatarUrl, { touch: !isFrozen() });
    return player;
}

/**
 * Unified authentication middleware
 * Checks X-Extension-JWT first (Twitch extension mode)
 * Falls back to Authorization Bearer (standalone mode)
 */
export async function unifiedAuth(req, res, next) {
    try {
        // Check for Twitch Extension JWT first
        const extensionJWT = req.headers['x-extension-jwt'];
        if (extensionJWT) {
            const twitchData = verifyTwitchJWT(extensionJWT);

            if (!twitchData) {
                return res.status(401).json({
                    error: 'Invalid Twitch extension token',
                    code: 'INVALID_TWITCH_TOKEN'
                });
            }

            // Check if user is unlinked (anonymous)
            if (twitchData.isUnlinked) {
                return res.status(401).json({
                    error: 'Please share your identity with the extension',
                    code: 'UNLINKED_USER'
                });
            }

            const profile = await twitchProfile(twitchData.userId);
            const player = await getOrCreatePlayer(
                'twitch',
                twitchData.userId,
                profile?.name || `Twitch User ${twitchData.userId}`,
                profile?.avatar || null
            );

            if (player.is_banned) {
                return res.status(403).json({
                    error: 'Account is banned',
                    code: 'BANNED',
                    reason: player.ban_reason
                });
            }

            req.player = player;
            req.authMode = 'twitch_extension';
            req.twitchData = twitchData;

            return next();
        }

        // Check for game JWT (standalone mode)
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const gameData = verifyGameJWT(token);

            if (!gameData) {
                return res.status(401).json({
                    error: 'Invalid or expired token',
                    code: 'INVALID_TOKEN'
                });
            }

            // Get player by ID
            const [players] = await pool.execute(
                'SELECT * FROM cfx_players WHERE id = ?',
                [gameData.playerId]
            );

            if (players.length === 0) {
                return res.status(401).json({
                    error: 'Player not found',
                    code: 'PLAYER_NOT_FOUND'
                });
            }

            const player = players[0];

            // Check if banned
            if (player.is_banned) {
                return res.status(403).json({
                    error: 'Account is banned',
                    code: 'BANNED',
                    reason: player.ban_reason
                });
            }

            // Update last online (not while frozen, H-636)
            if (!isFrozen()) await pool.execute(
                'UPDATE cfx_players SET last_online_at = NOW() WHERE id = ?',
                [player.id]
            );

            req.player = player;
            req.authMode = 'oauth';

            return next();
        }

        // No auth provided
        return res.status(401).json({
            error: 'Authentication required',
            code: 'NO_AUTH'
        });

    } catch (error) {
        logger.error('[UnifiedAuth] Authentication error', {
            error: error.message,
            stack: error.stack
        });

        return res.status(500).json({
            error: 'Authentication error',
            code: 'AUTH_ERROR'
        });
    }
}

export default unifiedAuth;
