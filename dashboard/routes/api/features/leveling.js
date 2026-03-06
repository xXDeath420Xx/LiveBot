/**
 * Leveling API
 * Handles leveling system configuration and leaderboards
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/leveling/config
 * Get leveling configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM level_config WHERE guild_id = ?',
            [guildId]
        );

        const [rewards] = await pool.execute(
            'SELECT * FROM level_rewards WHERE guild_id = ? ORDER BY level ASC',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                xp_per_message: 15,
                xp_cooldown_seconds: 60,
                level_up_channel_id: null,
                level_up_message: 'Congratulations {user}! You reached level {level}!',
                ignored_channels: [],
                ignored_roles: [],
                multiplier_roles: {}
            },
            rewards
        });
    } catch (error) {
        logger.error('[API Leveling Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch leveling config' });
    }
});

/**
 * PUT /api/guilds/:guildId/leveling/config
 * Update leveling configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            xp_per_message,
            xp_cooldown_seconds,
            level_up_channel_id,
            level_up_message,
            ignored_channels,
            ignored_roles,
            multiplier_roles,
            stack_rewards
        } = req.body;

        await pool.execute(`
            INSERT INTO level_config
                (guild_id, enabled, xp_per_message, xp_cooldown_seconds, level_up_channel_id,
                 level_up_message, ignored_channels, ignored_roles, multiplier_roles, stack_rewards)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                xp_per_message = VALUES(xp_per_message),
                xp_cooldown_seconds = VALUES(xp_cooldown_seconds),
                level_up_channel_id = VALUES(level_up_channel_id),
                level_up_message = VALUES(level_up_message),
                ignored_channels = VALUES(ignored_channels),
                ignored_roles = VALUES(ignored_roles),
                multiplier_roles = VALUES(multiplier_roles),
                stack_rewards = VALUES(stack_rewards)
        `, [
            guildId,
            enabled ? 1 : 0,
            xp_per_message || 15,
            xp_cooldown_seconds || 60,
            level_up_channel_id || null,
            level_up_message || 'Congratulations {user}! You reached level {level}!',
            JSON.stringify(ignored_channels || []),
            JSON.stringify(ignored_roles || []),
            JSON.stringify(multiplier_roles || {}),
            stack_rewards ? 1 : 0
        ]);

        socketService.configSaved(guildId, 'leveling', req.body);

        res.json({ success: true, message: 'Leveling config updated' });
    } catch (error) {
        logger.error('[API Leveling Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update leveling config' });
    }
});

/**
 * GET /api/guilds/:guildId/leveling/leaderboard
 * Get server leaderboard
 */
router.get('/leaderboard', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { page = 1, limit = 25 } = req.query;
        const offset = (page - 1) * limit;

        const [users] = await pool.execute(`
            SELECT user_id, xp, level, messages
            FROM user_levels
            WHERE guild_id = ?
            ORDER BY level DESC, xp DESC
            LIMIT ? OFFSET ?
        `, [guildId, parseInt(limit), parseInt(offset)]);

        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM user_levels WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            leaderboard: users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / limit)
            }
        });
    } catch (error) {
        logger.error('[API Leveling Leaderboard GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

/**
 * POST /api/guilds/:guildId/leveling/rewards
 * Add a level reward
 */
router.post('/rewards', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { level, role_id, message } = req.body;

        if (!level || !role_id) {
            return res.status(400).json({ error: 'Level and role_id are required' });
        }

        await pool.execute(`
            INSERT INTO level_rewards (guild_id, level, role_id, message)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                role_id = VALUES(role_id),
                message = VALUES(message)
        `, [guildId, level, role_id, message || null]);

        res.json({ success: true, message: 'Level reward added' });
    } catch (error) {
        logger.error('[API Leveling Rewards POST] Error:', error);
        res.status(500).json({ error: 'Failed to add level reward' });
    }
});

/**
 * DELETE /api/guilds/:guildId/leveling/rewards/:level
 * Delete a level reward
 */
router.delete('/rewards/:level', async (req, res) => {
    try {
        const { guildId, level } = req.params;

        await pool.execute(
            'DELETE FROM level_rewards WHERE guild_id = ? AND level = ?',
            [guildId, level]
        );

        res.json({ success: true, message: 'Level reward deleted' });
    } catch (error) {
        logger.error('[API Leveling Rewards DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete level reward' });
    }
});

/**
 * PUT /api/guilds/:guildId/leveling/user/:userId
 * Modify user XP/level
 */
router.put('/user/:userId', async (req, res) => {
    try {
        const { guildId, userId } = req.params;
        const { xp, level } = req.body;

        if (xp !== undefined) {
            await pool.execute(
                'UPDATE user_levels SET xp = ? WHERE guild_id = ? AND user_id = ?',
                [xp, guildId, userId]
            );
        }

        if (level !== undefined) {
            // Calculate XP for level
            const xpForLevel = Math.floor(100 * Math.pow(level, 1.5));
            await pool.execute(
                'UPDATE user_levels SET level = ?, xp = ? WHERE guild_id = ? AND user_id = ?',
                [level, xpForLevel, guildId, userId]
            );
        }

        res.json({ success: true, message: 'User level updated' });
    } catch (error) {
        logger.error('[API Leveling User PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update user level' });
    }
});

/**
 * DELETE /api/guilds/:guildId/leveling/user/:userId
 * Reset user level data
 */
router.delete('/user/:userId', async (req, res) => {
    try {
        const { guildId, userId } = req.params;

        await pool.execute(
            'DELETE FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );

        res.json({ success: true, message: 'User level data reset' });
    } catch (error) {
        logger.error('[API Leveling User DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to reset user level' });
    }
});

export default router;
