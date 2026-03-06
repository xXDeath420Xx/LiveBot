/**
 * Giveaways API
 * Handles giveaway management via the GiveawayManager
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/giveaways
 * Get all giveaways
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { status = 'all' } = req.query;

        let query = 'SELECT * FROM giveaways WHERE guild_id = ?';
        const params = [guildId];

        if (status === 'active') {
            query += ' AND is_active = 1';
        } else if (status === 'ended') {
            query += ' AND is_active = 0';
        }

        query += ' ORDER BY ends_at DESC';

        const [giveaways] = await pool.execute(query, params);

        res.json({ success: true, giveaways });
    } catch (error) {
        logger.error('[API Giveaways GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch giveaways' });
    }
});

/**
 * POST /api/guilds/:guildId/giveaways
 * Create a giveaway via the bot's GiveawayManager
 */
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            channel_id,
            prize,
            winner_count,
            duration_seconds
        } = req.body;

        if (!channel_id || !prize || !duration_seconds) {
            return res.status(400).json({ error: 'Channel, prize, and duration are required' });
        }

        if (!/^\d{17,20}$/.test(channel_id)) {
            return res.status(400).json({ error: 'Invalid channel_id format' });
        }

        if (typeof prize !== 'string' || prize.length < 1 || prize.length > 256) {
            return res.status(400).json({ error: 'Prize must be 1-256 characters' });
        }

        const durationNum = parseInt(duration_seconds);
        if (isNaN(durationNum) || durationNum < 10 || durationNum > 15552000) {
            return res.status(400).json({ error: 'Duration must be between 10 seconds and 6 months' });
        }

        const winnerNum = parseInt(winner_count) || 1;
        if (winnerNum < 1 || winnerNum > 100) {
            return res.status(400).json({ error: 'Winner count must be between 1 and 100' });
        }

        // Use the bot client's GiveawayManager to create the giveaway
        // This sends the embed, reacts, and inserts into DB
        const botClient = req.botClient;
        if (!botClient?.giveawayManager) {
            return res.status(500).json({ error: 'Giveaway manager not available for this bot' });
        }

        const result = await botClient.giveawayManager.createGiveaway(
            guildId,
            channel_id,
            req.user.id,
            prize.trim(),
            winnerNum,
            durationNum
        );

        res.json({
            success: true,
            message: 'Giveaway created',
            giveawayId: result.giveawayId,
            messageId: result.messageId
        });
    } catch (error) {
        logger.error('[API Giveaways POST] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to create giveaway' });
    }
});

/**
 * DELETE /api/guilds/:guildId/giveaways/:giveawayId
 * Delete/cancel a giveaway
 */
router.delete('/:giveawayId', async (req, res) => {
    try {
        const { guildId, giveawayId } = req.params;

        // Fetch giveaway first so we can delete the Discord message
        const [[giveaway]] = await pool.execute(
            'SELECT * FROM giveaways WHERE id = ? AND guild_id = ?',
            [giveawayId, guildId]
        );

        if (!giveaway) {
            return res.status(404).json({ error: 'Giveaway not found' });
        }

        // Try to delete the giveaway message from Discord
        const botClient = req.botClient;
        if (botClient && giveaway.channel_id && giveaway.message_id) {
            try {
                const guild = botClient.guilds.cache.get(guildId);
                if (guild) {
                    const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);
                    if (channel) {
                        const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
                        if (message) {
                            await message.delete();
                        }
                    }
                }
            } catch (discordErr) {
                logger.warn(`[API Giveaways DELETE] Could not delete Discord message for giveaway ${giveawayId}:`, discordErr.message);
            }
        }

        await pool.execute(
            'DELETE FROM giveaways WHERE id = ? AND guild_id = ?',
            [giveawayId, guildId]
        );

        res.json({ success: true, message: 'Giveaway deleted' });
    } catch (error) {
        logger.error('[API Giveaways DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete giveaway' });
    }
});

/**
 * POST /api/guilds/:guildId/giveaways/:giveawayId/end
 * End a giveaway early
 */
router.post('/:giveawayId/end', async (req, res) => {
    try {
        const { guildId, giveawayId } = req.params;

        const [[giveaway]] = await pool.execute(
            'SELECT * FROM giveaways WHERE id = ? AND guild_id = ? AND is_active = 1',
            [giveawayId, guildId]
        );

        if (!giveaway) {
            // Check if it exists but already ended
            const [[ended]] = await pool.execute(
                'SELECT id FROM giveaways WHERE id = ? AND guild_id = ?',
                [giveawayId, guildId]
            );
            if (ended) {
                return res.status(409).json({ error: 'This giveaway has already ended' });
            }
            return res.status(404).json({ error: 'Giveaway not found' });
        }

        const botClient = req.botClient;
        if (botClient?.giveawayManager) {
            await botClient.giveawayManager.endGiveaway(giveaway, false);
        } else {
            await pool.execute(
                'UPDATE giveaways SET is_active = 0, ends_at = NOW() WHERE id = ?',
                [giveawayId]
            );
        }

        res.json({ success: true, message: 'Giveaway ended' });
    } catch (error) {
        logger.error('[API Giveaways End POST] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to end giveaway' });
    }
});

/**
 * POST /api/guilds/:guildId/giveaways/:giveawayId/reroll
 * Reroll giveaway winners
 */
router.post('/:giveawayId/reroll', async (req, res) => {
    try {
        const { guildId, giveawayId } = req.params;

        const [[giveaway]] = await pool.execute(
            'SELECT * FROM giveaways WHERE id = ? AND guild_id = ?',
            [giveawayId, guildId]
        );

        if (!giveaway) {
            return res.status(404).json({ error: 'Giveaway not found' });
        }

        const botClient = req.botClient;
        if (botClient?.giveawayManager) {
            await botClient.giveawayManager.endGiveaway(giveaway, true);
            res.json({ success: true, message: 'Winners rerolled' });
        } else {
            res.status(500).json({ error: 'Giveaway manager not available' });
        }
    } catch (error) {
        logger.error('[API Giveaways Reroll POST] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to reroll giveaway' });
    }
});

export default router;
