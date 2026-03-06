/**
 * Black Market Routes
 * High-risk, high-reward selling channel
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { hasFeatureUnlock } from '../game/research-helper.js';
import { awardCash } from '../game/engine.js';
import { addHeat } from '../game/raid-system.js';
import { awardReputation } from './reputation.js';

const router = Router();

/**
 * Helper to get player's "street" reputation for black market access
 */
async function getBlackMarketReputation(playerId) {
    try {
        // Get reputation from the "street" faction (or "underground" if that exists)
        const [[rep]] = await pool.execute(
            `SELECT pr.reputation FROM cfx_player_reputation pr
             JOIN cfx_factions f ON pr.faction_id = f.id
             WHERE pr.player_id = ? AND f.faction_key = 'shadow_syndicate'
             ORDER BY pr.reputation DESC LIMIT 1`,
            [playerId]
        );
        return rep?.reputation || 0;
    } catch (e) {
        // Reputation system may not be initialized
        return 0;
    }
}

/**
 * GET /black-market
 * Get available contacts and sale history
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Check if black market is unlocked via research
        const hasBlackMarket = await hasFeatureUnlock(playerId, 'black_market');
        if (!hasBlackMarket) {
            return res.json({
                success: true,
                locked: true,
                message: 'Black Market requires research: "Underground Contacts"',
                requiredResearch: 'black_market',
                contacts: [],
                sales: []
            });
        }

        // Get player's street reputation for black market access
        const playerReputation = await getBlackMarketReputation(playerId);

        // Get all contacts
        const [contacts] = await pool.execute(
            `SELECT bmc.*, pbm.last_sale_at, pbm.total_sales, pbm.total_revenue
             FROM cfx_black_market_contacts bmc
             LEFT JOIN cfx_player_black_market pbm ON bmc.id = pbm.contact_id AND pbm.player_id = ?
             WHERE bmc.is_active = TRUE
             ORDER BY bmc.reputation_required ASC`,
            [playerId]
        );

        // Get recent sales
        const [sales] = await pool.execute(
            `SELECT bms.*, bmc.name as contact_name, s.name as strain_name
             FROM cfx_black_market_sales bms
             JOIN cfx_black_market_contacts bmc ON bms.contact_id = bmc.id
             LEFT JOIN cfx_strains s ON bms.strain_id = s.id
             WHERE bms.player_id = ?
             ORDER BY bms.sold_at DESC
             LIMIT 20`,
            [playerId]
        );

        res.json({
            success: true,
            playerReputation,
            contacts: contacts.map(c => {
                const isUnlocked = playerReputation >= c.reputation_required;
                const cooldownEnds = c.last_sale_at
                    ? new Date(new Date(c.last_sale_at).getTime() + c.cooldown_minutes * 60 * 1000)
                    : null;
                const isOnCooldown = cooldownEnds && cooldownEnds > new Date();

                return {
                    id: c.id,
                    key: c.contact_key,
                    name: c.name,
                    description: c.description,
                    reputationRequired: c.reputation_required,
                    priceMultiplier: parseFloat(c.price_multiplier),
                    heatMultiplier: parseFloat(c.heat_multiplier),
                    minQuality: c.min_quality,
                    maxQuantity: c.max_quantity_per_sale,
                    cooldownMinutes: c.cooldown_minutes,
                    isUnlocked,
                    isOnCooldown,
                    cooldownEnds: isOnCooldown ? cooldownEnds : null,
                    totalSales: c.total_sales || 0,
                    totalRevenue: parseFloat(c.total_revenue) || 0
                };
            }),
            recentSales: sales.map(s => ({
                id: s.id,
                contactName: s.contact_name,
                strainName: s.strain_name,
                quality: s.quality,
                quantity: s.quantity,
                basePrice: parseFloat(s.sale_price),
                finalPrice: parseFloat(s.sale_price),
                heatGenerated: s.heat_generated,
                soldAt: s.sold_at
            }))
        });

    } catch (error) {
        logger.error('[BlackMarket] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed to get black market', code: 'ERROR' });
    }
});

/**
 * POST /black-market/sell
 * Sell to a black market contact
 */
router.post('/sell', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { contactId, inventoryId, quantity } = req.body;

        // Check if black market is unlocked via research
        const hasBlackMarket = await hasFeatureUnlock(playerId, 'black_market');
        if (!hasBlackMarket) {
            return res.status(403).json({
                error: 'Black Market requires research: "Underground Contacts"',
                code: 'FEATURE_LOCKED'
            });
        }

        if (!contactId || !inventoryId || !quantity || quantity < 1) {
            return res.status(400).json({
                error: 'Contact, inventory item, and quantity required',
                code: 'MISSING_FIELDS'
            });
        }

        // Get contact
        const [[contact]] = await pool.execute(
            `SELECT * FROM cfx_black_market_contacts WHERE id = ? AND is_active = TRUE`,
            [contactId]
        );

        if (!contact) {
            return res.status(404).json({ error: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
        }

        // Check reputation from reputation system
        const playerReputation = await getBlackMarketReputation(playerId);
        if (playerReputation < contact.reputation_required) {
            return res.status(400).json({
                error: `Need ${contact.reputation_required} reputation`,
                code: 'REPUTATION_TOO_LOW'
            });
        }

        // Check cooldown
        const [[playerContact]] = await pool.execute(
            `SELECT * FROM cfx_player_black_market WHERE player_id = ? AND contact_id = ?`,
            [playerId, contactId]
        );

        if (playerContact && playerContact.last_sale_at) {
            const cooldownEnds = new Date(playerContact.last_sale_at).getTime() + contact.cooldown_minutes * 60 * 1000;
            if (cooldownEnds > Date.now()) {
                return res.status(400).json({
                    error: 'Contact is on cooldown',
                    code: 'ON_COOLDOWN',
                    cooldownEnds: new Date(cooldownEnds)
                });
            }
        }

        // Get inventory item
        const [[invItem]] = await pool.execute(
            `SELECT i.*, s.name as strain_name, s.base_price
             FROM cfx_inventory i
             LEFT JOIN cfx_strains s ON i.strain_id = s.id
             WHERE i.id = ? AND i.player_id = ?`,
            [inventoryId, playerId]
        );

        if (!invItem) {
            return res.status(404).json({ error: 'Inventory item not found', code: 'ITEM_NOT_FOUND' });
        }

        // Check quality requirement
        if (invItem.quality < contact.min_quality) {
            return res.status(400).json({
                error: `Quality must be at least ${contact.min_quality}`,
                code: 'QUALITY_TOO_LOW'
            });
        }

        // Check quantity limits
        const sellQty = Math.min(quantity, invItem.quantity, contact.max_quantity_per_sale);
        if (sellQty < 1) {
            return res.status(400).json({ error: 'Invalid quantity', code: 'INVALID_QUANTITY' });
        }

        // Calculate price and heat
        const basePrice = (parseFloat(invItem.base_price) || 100) * ((invItem.quality || 50) / 50);
        const finalPrice = basePrice * sellQty * contact.price_multiplier;
        const heatGenerated = Math.ceil(sellQty * contact.heat_multiplier * 2);

        // Transaction
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Deduct from inventory
            if (invItem.quantity <= sellQty) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
            } else {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                    [sellQty, inventoryId]
                );
            }

            // Commit transaction first, then add heat via proper system
            // (heat is tracked in cfx_player_heat, not cfx_player_raid_status)

            // Record sale
            await conn.execute(
                `INSERT INTO cfx_black_market_sales
                 (player_id, contact_id, strain_id, quality, quantity, sale_price, heat_generated, sold_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [playerId, contactId, invItem.strain_id, invItem.quality, sellQty, finalPrice, heatGenerated]
            );

            // Update player-contact relationship
            await conn.execute(
                `INSERT INTO cfx_player_black_market (player_id, contact_id, last_sale_at, total_sales, total_revenue)
                 VALUES (?, ?, NOW(), 1, ?)
                 ON DUPLICATE KEY UPDATE
                     last_sale_at = NOW(),
                     total_sales = total_sales + 1,
                     total_revenue = total_revenue + ?`,
                [playerId, contactId, finalPrice, finalPrice]
            );

            await conn.commit();

            // Award cash using proper engine function (applies bonuses)
            const cashResult = await awardCash(playerId, finalPrice);

            // Add heat via proper raid system (not the broken cfx_player_raid_status table)
            try {
                await addHeat(playerId, heatGenerated, 'black_market_sale');
            } catch (heatErr) {
                logger.warn('[BlackMarket] Failed to add heat', { error: heatErr.message });
            }

            // Award reputation for black market dealings (fire-and-forget)
            awardReputation(playerId, 'shadow_syndicate', 5).catch(() => {});

            logger.info('[BlackMarket] Sale', {
                playerId,
                contactId,
                quantity: sellQty,
                finalPrice,
                actualEarned: cashResult.cashAwarded,
                heatGenerated
            });

            res.json({
                success: true,
                sold: sellQty,
                earned: cashResult.cashAwarded,
                heatGenerated,
                newCash: cashResult.newCash,
                message: `Sold ${sellQty}x ${invItem.strain_name || 'product'} to ${contact.name} for $${cashResult.cashAwarded.toLocaleString()}. +${heatGenerated} heat!`
            });

        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

    } catch (error) {
        logger.error('[BlackMarket] Sell failed', { error: error.message });
        res.status(500).json({ error: 'Failed to sell', code: 'ERROR' });
    }
});

export default router;
