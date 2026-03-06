/**
 * Unified Authentication Middleware
 * Handles both Twitch Extension JWT and OAuth game JWT
 * Sets req.player with the authenticated player data
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { verifyTwitchJWT } from './twitch-jwt.js';
import { verifyGameJWT } from './oauth-auth.js';

/**
 * Get or create player by platform credentials
 * @param {string} platform - 'twitch' or 'kick'
 * @param {string} platformUserId - Platform user ID
 * @param {string} displayName - Display name
 * @param {string} avatarUrl - Avatar URL (optional)
 * @returns {object} Player record
 */
async function getOrCreatePlayer(platform, platformUserId, displayName, avatarUrl = null) {
    // Try to find existing player
    const [existing] = await pool.execute(
        'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
        [platform, platformUserId]
    );

    if (existing.length > 0) {
        const player = existing[0];

        // Update display name and avatar if changed
        if (player.display_name !== displayName || (avatarUrl && player.avatar_url !== avatarUrl)) {
            await pool.execute(
                'UPDATE cfx_players SET display_name = ?, avatar_url = COALESCE(?, avatar_url), last_online_at = NOW() WHERE id = ?',
                [displayName, avatarUrl, player.id]
            );
        } else {
            // Just update last online
            await pool.execute(
                'UPDATE cfx_players SET last_online_at = NOW() WHERE id = ?',
                [player.id]
            );
        }

        return { ...player, display_name: displayName };
    }

    // Create new player
    const [result] = await pool.execute(
        `INSERT INTO cfx_players (platform, platform_user_id, display_name, avatar_url)
         VALUES (?, ?, ?, ?)`,
        [platform, platformUserId, displayName, avatarUrl]
    );

    const playerId = result.insertId;

    // Create initial grow slots
    await pool.execute(
        `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, 1), (?, 2)`,
        [playerId, playerId]
    );

    // Grant starter strains (discoveries) and STARTER SEEDS
    // Story: "You found these seeds in a dusty box left behind by the previous tenant..."
    const [starters] = await pool.execute(
        'SELECT id FROM cfx_strains WHERE is_starter = 1'
    );

    for (const strain of starters) {
        // Mark strain as discovered
        await pool.execute(
            `INSERT INTO cfx_strain_discoveries (player_id, strain_id, discovery_method)
             VALUES (?, ?, 'starter')`,
            [playerId, strain.id]
        );

        // Give 5 starter seeds of each strain (found in abandoned warehouse)
        await pool.execute(
            `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity, total_gifted)
             VALUES (?, ?, 5, 5)`,
            [playerId, strain.id]
        );
    }

    // Assign initial quests
    const [dailyQuests] = await pool.execute(
        `SELECT id, objective_target FROM cfx_quest_definitions
         WHERE quest_type = 'daily' AND is_active = 1 AND min_level <= 1
         ORDER BY RAND() LIMIT 3`
    );

    for (const quest of dailyQuests) {
        await pool.execute(
            `INSERT INTO cfx_player_quests (player_id, quest_id, target, expires_at)
             VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
            [playerId, quest.id, quest.objective_target]
        );
    }

    logger.info('[UnifiedAuth] Created new player', {
        playerId,
        platform,
        displayName
    });

    // Return new player data
    const [newPlayer] = await pool.execute(
        'SELECT * FROM cfx_players WHERE id = ?',
        [playerId]
    );

    return newPlayer[0];
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

            // Get or create player
            const player = await getOrCreatePlayer(
                'twitch',
                twitchData.userId,
                `Twitch User ${twitchData.userId}` // Will be updated with real name via API
            );

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

            // Update last online
            await pool.execute(
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
