/**
 * Inventory Routes
 * View and manage harvested product
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { sellToNpc } from '../game/market-engine.js';
import { awardCash } from '../game/engine.js';
import { validate, schemas } from '../middleware/validate.js';
import { sellCooldown } from '../middleware/rate-limit.js';
import { awardEventPoints } from './events.js';
import { trackStat } from './stats.js';
import { checkAchievements } from './achievements.js';
import { addHeat } from '../game/raid-system.js';

const router = Router();

/**
 * GET /inventory
 * Get player's inventory
 */
router.get('/', async (req, res) => {
    try {
        const [items] = await pool.execute(
            `SELECT i.*, s.name as strain_name, s.slug, s.rarity, s.base_price,
                    mp.current_price as market_price
             FROM cfx_inventory i
             JOIN cfx_strains s ON i.strain_id = s.id
             LEFT JOIN cfx_market_prices mp ON s.id = mp.strain_id
             WHERE i.player_id = ? AND i.quantity > 0
             ORDER BY i.harvested_at DESC`,
            [req.player.id]
        );

        res.json({
            success: true,
            items: items.map(i => ({
                id: i.id,
                strainId: i.strain_id,
                strainName: i.strain_name,
                strainSlug: i.slug,
                rarity: i.rarity,
                quantity: i.quantity,
                quality: i.quality,
                source: i.source,
                harvestedAt: i.harvested_at,
                basePrice: i.base_price,
                marketPrice: i.market_price
            })),
            totalItems: items.reduce((sum, i) => sum + i.quantity, 0)
        });

    } catch (error) {
        logger.error('[Inventory] Get failed', { playerId: req.player.id, error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /inventory/sell
 * Quick-sell to NPC
 */
router.post('/sell', sellCooldown, validate(schemas.sellNpc), async (req, res) => {
    try {
        const { inventoryId, quantity } = req.body;

        const result = await sellToNpc(req.player.id, inventoryId, quantity);

        // Track stats, event points, and achievements
        await trackStat(req.player.id, 'total_trades_completed', 1);
        await trackStat(req.player.id, 'total_cash_earned', result.cashEarned || 0);
        await awardEventPoints(req.player.id, 5); // 5 points per sale
        checkAchievements(req.player.id).catch(() => {}); // Fire and forget

        // Add heat for raid system (2 heat per $100 earned)
        const heatAmount = Math.max(1, Math.floor((result.cashEarned || 0) / 100) * 2);
        await addHeat(req.player.id, heatAmount, 'npc_sale');

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('[Inventory] Sell failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found') || error.message.includes('Insufficient')) {
            return res.status(400).json({ error: error.message, code: 'SELL_ERROR' });
        }

        res.status(500).json({ error: 'Failed to sell', code: 'ERROR' });
    }
});

/**
 * POST /inventory/sell-all
 * Batch sell all inventory items (optionally filtered by quality tier)
 */
router.post('/sell-all', sellCooldown, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { qualityMin, qualityMax } = req.body;
        const playerId = req.player.id;

        await conn.beginTransaction();

        // Get all items matching criteria
        let query = `
            SELECT i.*, s.name as strain_name, s.base_price, mp.current_price
            FROM cfx_inventory i
            JOIN cfx_strains s ON i.strain_id = s.id
            LEFT JOIN cfx_market_prices mp ON s.id = mp.strain_id
            WHERE i.player_id = ? AND i.quantity > 0
        `;
        const params = [playerId];

        if (qualityMin !== undefined) {
            query += ' AND i.quality >= ?';
            params.push(qualityMin);
        }
        if (qualityMax !== undefined) {
            query += ' AND i.quality <= ?';
            params.push(qualityMax);
        }

        const [items] = await conn.execute(query, params);

        if (items.length === 0) {
            await conn.rollback();
            return res.json({
                success: true,
                itemsSold: 0,
                totalQuantity: 0,
                totalCash: 0,
                message: 'No items to sell'
            });
        }

        // Calculate total value and sell
        let totalCash = 0;
        let totalQuantity = 0;
        let itemsSold = 0;

        // Get player's bonuses
        const { getBonuses } = await import('../game/bonus-resolver.js');
        const bonuses = await getBonuses(playerId);
        const sellMultiplier = 1 + (bonuses.sellPriceBonus || 0);

        for (const item of items) {
            // Use market price if available, otherwise base price
            const basePrice = item.current_price || item.base_price;
            // Apply quality modifier (0.5x to 1.5x based on quality 1-100)
            const qualityMod = 0.5 + (item.quality / 100);
            const pricePerUnit = Math.floor(basePrice * qualityMod * sellMultiplier);
            const itemTotal = pricePerUnit * item.quantity;

            totalCash += itemTotal;
            totalQuantity += item.quantity;
            itemsSold++;

            // Delete the inventory item
            await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
        }

        await conn.commit();

        // Award cash using engine function AFTER transaction (applies incomeBonus)
        // Note: sellPriceBonus is already applied to price calculation above
        const cashResult = await awardCash(playerId, totalCash);

        // Track stats and add heat in parallel
        const heatAmount = Math.max(1, Math.floor(cashResult.cashAwarded / 100) * 2);
        await Promise.all([
            trackStat(playerId, 'total_trades_completed', itemsSold),
            trackStat(playerId, 'total_cash_earned', cashResult.cashAwarded),
            awardEventPoints(playerId, itemsSold * 5),
            addHeat(playerId, heatAmount, 'batch_sale')
        ]);

        checkAchievements(playerId).catch(() => {});

        res.json({
            success: true,
            itemsSold,
            totalQuantity,
            totalCash: cashResult.cashAwarded,
            message: `Sold ${totalQuantity} items for $${cashResult.cashAwarded.toLocaleString()}`
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Inventory] Batch sell failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to sell items', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /inventory/discard
 * Discard items from inventory
 */
router.post('/discard', async (req, res) => {
    try {
        const { inventoryId, quantity } = req.body;

        if (!inventoryId) {
            return res.status(400).json({ error: 'Inventory ID required', code: 'NO_ID' });
        }

        const [[item]] = await pool.execute(
            'SELECT * FROM cfx_inventory WHERE id = ? AND player_id = ?',
            [inventoryId, req.player.id]
        );

        if (!item) {
            return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });
        }

        const discardQty = quantity || item.quantity;

        if (discardQty > item.quantity) {
            return res.status(400).json({ error: 'Insufficient quantity', code: 'INSUFFICIENT' });
        }

        if (discardQty >= item.quantity) {
            await pool.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
        } else {
            await pool.execute(
                'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                [discardQty, inventoryId]
            );
        }

        res.json({
            success: true,
            discarded: discardQty
        });

    } catch (error) {
        logger.error('[Inventory] Discard failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
