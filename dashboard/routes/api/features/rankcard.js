/**
 * Rank Card Customization API
 * Handles rank card settings, background uploads, preview generation, and presets
 */

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { generateRankCard } from '../../../../utils/rank-card-generator.js';
import { processBackgroundUpload, deleteCustomBackground } from '../../../../utils/image-processing.js';

const router = express.Router({ mergeParams: true });

// Multer config for background image uploads (memory storage, 5MB limit)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are accepted'));
        }
    }
});

// Valid hex color regex: exactly 7 chars, starts with #, followed by 6 hex digits
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

// All color fields that can be updated
const COLOR_FIELDS = [
    'progress_bar_color_start',
    'progress_bar_color_end',
    'username_color',
    'xp_text_color',
    'level_color',
    'rank_color',
    'avatar_border_color'
];

// Default settings returned when no row exists
const DEFAULT_SETTINGS = {
    background_type: 'gradient',
    background_value: null,
    overlay_opacity: 0.6,
    progress_bar_color_start: '#667eea',
    progress_bar_color_end: '#764ba2',
    username_color: '#ffffff',
    xp_text_color: '#b9bbbe',
    level_color: '#ffffff',
    rank_color: '#ffd700',
    avatar_border_color: '#3498db',
    avatar_border_enabled: 1
};

/**
 * XP calculation helpers (mirroring leveling-manager.js logic)
 */
function getXPForLevel(level) {
    return 5 * (level ** 2) + 50 * level + 100;
}

function getTotalXP(level, currentXP) {
    let total = currentXP;
    for (let i = 1; i <= level; i++) {
        total += getXPForLevel(i);
    }
    return total;
}

/**
 * GET /api/guilds/:guildId/rank-card/settings
 * Get a user's rank card settings
 */
router.get('/settings', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'userId query parameter is required' });
        }

        const [rows] = await pool.execute(
            'SELECT * FROM rank_card_settings WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );

        res.json({
            success: true,
            settings: rows[0] || { ...DEFAULT_SETTINGS, guild_id: guildId, user_id: userId }
        });
    } catch (error) {
        logger.error('[API RankCard Settings GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch rank card settings' });
    }
});

/**
 * PUT /api/guilds/:guildId/rank-card/settings
 * Update rank card settings (upsert)
 */
router.put('/settings', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'userId query parameter is required' });
        }

        const {
            background_type,
            background_value,
            overlay_opacity,
            progress_bar_color_start,
            progress_bar_color_end,
            username_color,
            xp_text_color,
            level_color,
            rank_color,
            avatar_border_color,
            avatar_border_enabled
        } = req.body;

        // Validate hex colors
        const colorValues = {
            progress_bar_color_start,
            progress_bar_color_end,
            username_color,
            xp_text_color,
            level_color,
            rank_color,
            avatar_border_color
        };

        for (const [field, value] of Object.entries(colorValues)) {
            if (value !== undefined && !HEX_COLOR_REGEX.test(value)) {
                return res.status(400).json({
                    error: `Invalid hex color for ${field}: must be 7 characters starting with # (e.g. #ff0000)`
                });
            }
        }

        // Validate overlay_opacity if provided
        if (overlay_opacity !== undefined) {
            const opacity = parseFloat(overlay_opacity);
            if (isNaN(opacity) || opacity < 0 || opacity > 1) {
                return res.status(400).json({ error: 'overlay_opacity must be between 0 and 1' });
            }
        }

        // Validate background_type if provided
        const validBgTypes = ['gradient', 'solid', 'image', 'preset'];
        if (background_type !== undefined && !validBgTypes.includes(background_type)) {
            return res.status(400).json({ error: `Invalid background_type: must be one of ${validBgTypes.join(', ')}` });
        }

        // Validate avatar_border_enabled if provided
        if (avatar_border_enabled !== undefined && ![0, 1, true, false].includes(avatar_border_enabled)) {
            return res.status(400).json({ error: 'avatar_border_enabled must be 0, 1, true, or false' });
        }

        // Build the upsert - use provided values or defaults
        const finalValues = {
            background_type: background_type || DEFAULT_SETTINGS.background_type,
            background_value: background_value !== undefined ? background_value : DEFAULT_SETTINGS.background_value,
            overlay_opacity: overlay_opacity !== undefined ? parseFloat(overlay_opacity) : DEFAULT_SETTINGS.overlay_opacity,
            progress_bar_color_start: progress_bar_color_start || DEFAULT_SETTINGS.progress_bar_color_start,
            progress_bar_color_end: progress_bar_color_end || DEFAULT_SETTINGS.progress_bar_color_end,
            username_color: username_color || DEFAULT_SETTINGS.username_color,
            xp_text_color: xp_text_color || DEFAULT_SETTINGS.xp_text_color,
            level_color: level_color || DEFAULT_SETTINGS.level_color,
            rank_color: rank_color || DEFAULT_SETTINGS.rank_color,
            avatar_border_color: avatar_border_color || DEFAULT_SETTINGS.avatar_border_color,
            avatar_border_enabled: avatar_border_enabled !== undefined ? (avatar_border_enabled ? 1 : 0) : DEFAULT_SETTINGS.avatar_border_enabled
        };

        await pool.execute(`
            INSERT INTO rank_card_settings
                (guild_id, user_id, background_type, background_value, overlay_opacity,
                 progress_bar_color_start, progress_bar_color_end, username_color,
                 xp_text_color, level_color, rank_color, avatar_border_color, avatar_border_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                background_type = VALUES(background_type),
                background_value = VALUES(background_value),
                overlay_opacity = VALUES(overlay_opacity),
                progress_bar_color_start = VALUES(progress_bar_color_start),
                progress_bar_color_end = VALUES(progress_bar_color_end),
                username_color = VALUES(username_color),
                xp_text_color = VALUES(xp_text_color),
                level_color = VALUES(level_color),
                rank_color = VALUES(rank_color),
                avatar_border_color = VALUES(avatar_border_color),
                avatar_border_enabled = VALUES(avatar_border_enabled)
        `, [
            guildId,
            userId,
            finalValues.background_type,
            finalValues.background_value,
            finalValues.overlay_opacity,
            finalValues.progress_bar_color_start,
            finalValues.progress_bar_color_end,
            finalValues.username_color,
            finalValues.xp_text_color,
            finalValues.level_color,
            finalValues.rank_color,
            finalValues.avatar_border_color,
            finalValues.avatar_border_enabled
        ]);

        res.json({ success: true });
    } catch (error) {
        logger.error('[API RankCard Settings PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update rank card settings' });
    }
});

/**
 * POST /api/guilds/:guildId/rank-card/background
 * Upload a custom background image
 */
router.post('/background', upload.single('background'), async (req, res) => {
    try {
        const { guildId } = req.params;
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'userId query parameter is required' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }

        // Process and save the background image (resizes/crops to card dimensions)
        await processBackgroundUpload(req.file.buffer, guildId, userId);

        // Upsert settings to set background_type to 'image'
        await pool.execute(`
            INSERT INTO rank_card_settings (guild_id, user_id, background_type)
            VALUES (?, ?, 'image')
            ON DUPLICATE KEY UPDATE
                background_type = 'image',
                background_value = NULL
        `, [guildId, userId]);

        res.json({ success: true });
    } catch (error) {
        logger.error('[API RankCard Background POST] Error:', error);
        res.status(500).json({ error: 'Failed to upload background image' });
    }
});

/**
 * DELETE /api/guilds/:guildId/rank-card/settings
 * Reset all rank card settings to defaults
 */
router.delete('/settings', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'userId query parameter is required' });
        }

        // Delete the settings row
        await pool.execute(
            'DELETE FROM rank_card_settings WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );

        // Delete custom background file if it exists
        deleteCustomBackground(guildId, userId);

        res.json({ success: true });
    } catch (error) {
        logger.error('[API RankCard Settings DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to reset rank card settings' });
    }
});

/**
 * GET /api/guilds/:guildId/rank-card/preview
 * Generate a preview PNG of the rank card
 */
router.get('/preview', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'userId query parameter is required' });
        }

        // Get user level data
        const [levelRows] = await pool.execute(
            'SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );

        let rankData;
        if (levelRows.length === 0) {
            // No level data, use sample data for preview
            rankData = {
                xp: 350,
                level: 5,
                rank: 1,
                totalXP: 2100,
                xpForNextLevel: getXPForLevel(6),
                voiceXP: 0,
                totalVoiceMinutes: 0
            };
        } else {
            const userData = levelRows[0];
            const totalXP = getTotalXP(userData.level, userData.xp);

            // Calculate rank position
            const [rankRows] = await pool.execute(
                `SELECT COUNT(*) as rank FROM user_levels
                 WHERE guild_id = ? AND (level > ? OR (level = ? AND xp > ?))`,
                [guildId, userData.level, userData.level, userData.xp]
            );

            rankData = {
                xp: userData.xp,
                level: userData.level,
                rank: (rankRows[0]?.rank || 0) + 1,
                totalXP,
                xpForNextLevel: getXPForLevel(userData.level + 1),
                voiceXP: userData.voice_xp || 0,
                totalVoiceMinutes: userData.total_voice_minutes || 0
            };
        }

        // Get customization settings
        const [settingsRows] = await pool.execute(
            'SELECT * FROM rank_card_settings WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );
        const customization = settingsRows[0] || null;

        // Try to get the Discord user object from the bot client
        let discordUser = null;
        let member = null;
        const botClient = req.botClient;

        if (botClient) {
            try {
                const guild = botClient.guilds.cache.get(guildId);
                if (guild) {
                    member = await guild.members.fetch(userId).catch(() => null);
                    if (member) {
                        discordUser = member.user;
                    }
                }
                // If member fetch failed, try fetching user directly
                if (!discordUser) {
                    discordUser = await botClient.users.fetch(userId).catch(() => null);
                }
            } catch (err) {
                logger.warn('[API RankCard Preview] Could not fetch Discord user, using placeholder', { error: err.message });
            }
        }

        // If we could not get a real Discord user, create a mock object
        if (!discordUser) {
            discordUser = {
                username: req.user?.username || 'Preview User',
                discriminator: '0',
                displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        }

        // Generate the rank card image
        const imageBuffer = await generateRankCard(discordUser, rankData, member, customization);

        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(imageBuffer);
    } catch (error) {
        logger.error('[API RankCard Preview GET] Error:', error);
        res.status(500).json({ error: 'Failed to generate rank card preview' });
    }
});

/**
 * GET /api/guilds/:guildId/rank-card/presets
 * List available preset backgrounds
 */
router.get('/presets', async (req, res) => {
    try {
        const presetsPath = path.resolve('./assets/rank-presets/presets.json');
        const presetsData = fs.readFileSync(presetsPath, 'utf-8');
        const presets = JSON.parse(presetsData);

        res.json({
            success: true,
            presets
        });
    } catch (error) {
        logger.error('[API RankCard Presets GET] Error:', error);
        res.status(500).json({ error: 'Failed to load rank card presets' });
    }
});

export default router;
