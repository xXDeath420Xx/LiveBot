/**
 * Economy API
 * Handles economy system configuration and management
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/economy/config
 * Get economy configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM economy_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                currency_name: 'coins',
                currency_symbol: ':coin:',
                daily_amount: 100,
                work_min: 50,
                work_max: 200,
                work_cooldown: 3600
            }
        });
    } catch (error) {
        logger.error('[API Economy Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch economy config' });
    }
});

/**
 * PUT /api/guilds/:guildId/economy/config
 * Update economy configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            currency_name,
            currency_symbol,
            daily_amount,
            work_min,
            work_max,
            work_cooldown,
            starting_balance
        } = req.body;

        await pool.execute(`
            INSERT INTO economy_config
                (guild_id, enabled, currency_name, currency_symbol, daily_amount,
                 work_min, work_max, work_cooldown, starting_balance)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                currency_name = VALUES(currency_name),
                currency_symbol = VALUES(currency_symbol),
                daily_amount = VALUES(daily_amount),
                work_min = VALUES(work_min),
                work_max = VALUES(work_max),
                work_cooldown = VALUES(work_cooldown),
                starting_balance = VALUES(starting_balance)
        `, [
            guildId,
            enabled ? 1 : 0,
            currency_name || 'coins',
            currency_symbol || ':coin:',
            daily_amount || 100,
            work_min || 50,
            work_max || 200,
            work_cooldown || 3600,
            starting_balance || 0
        ]);

        socketService.configSaved(guildId, 'economy', req.body);

        res.json({ success: true, message: 'Economy config updated' });
    } catch (error) {
        logger.error('[API Economy Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update economy config' });
    }
});

/**
 * GET /api/guilds/:guildId/economy/leaderboard
 * Get economy leaderboard
 */
router.get('/leaderboard', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { page = 1, limit = 25 } = req.query;
        const offset = (page - 1) * limit;

        const [users] = await pool.execute(`
            SELECT user_id, balance, bank, total_earned
            FROM economy_users
            WHERE guild_id = ?
            ORDER BY (balance + bank) DESC
            LIMIT ? OFFSET ?
        `, [guildId, parseInt(limit), parseInt(offset)]);

        res.json({ success: true, leaderboard: users });
    } catch (error) {
        logger.error('[API Economy Leaderboard GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

/**
 * GET /api/guilds/:guildId/economy/shop
 * Get shop items
 */
router.get('/shop', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [items] = await pool.execute(
            'SELECT * FROM shop_items WHERE guild_id = ? ORDER BY price ASC',
            [guildId]
        );

        res.json({ success: true, items });
    } catch (error) {
        logger.error('[API Economy Shop GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch shop items' });
    }
});

/**
 * POST /api/guilds/:guildId/economy/shop
 * Add shop item
 */
router.post('/shop', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { name, description, price, role_id, stock, category } = req.body;

        if (!name || !price) {
            return res.status(400).json({ error: 'Name and price are required' });
        }

        await pool.execute(`
            INSERT INTO shop_items
                (guild_id, name, description, price, role_id, stock, category)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [guildId, name, description || null, price, role_id || null, stock || -1, category || 'general']);

        res.json({ success: true, message: 'Shop item added' });
    } catch (error) {
        logger.error('[API Economy Shop POST] Error:', error);
        res.status(500).json({ error: 'Failed to add shop item' });
    }
});

/**
 * DELETE /api/guilds/:guildId/economy/shop/:itemId
 * Delete shop item
 */
router.delete('/shop/:itemId', async (req, res) => {
    try {
        const { guildId, itemId } = req.params;

        await pool.execute(
            'DELETE FROM shop_items WHERE id = ? AND guild_id = ?',
            [itemId, guildId]
        );

        res.json({ success: true, message: 'Shop item deleted' });
    } catch (error) {
        logger.error('[API Economy Shop DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete shop item' });
    }
});

export default router;
