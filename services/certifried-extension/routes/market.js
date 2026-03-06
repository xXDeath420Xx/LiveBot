/**
 * Market Routes
 * Player-to-player marketplace
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getMarketPrices, createListing, buyListing, cancelListing } from '../game/market-engine.js';
import { validate, schemas } from '../middleware/validate.js';
import { awardEventPoints } from './events.js';
import { trackStat } from './stats.js';
import { checkAchievements } from './achievements.js';
import { addHeat } from '../game/raid-system.js';

const router = Router();

/**
 * GET /market/prices
 * Get current market prices for all strains
 */
router.get('/prices', async (req, res) => {
    try {
        const prices = await getMarketPrices();
        res.json({ success: true, prices });
    } catch (error) {
        logger.error('[Market] Get prices failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /market/listings
 * Get active marketplace listings
 */
router.get('/listings', async (req, res) => {
    try {
        const { strainId, rarity, sortBy = 'price', limit = 50 } = req.query;

        let query = `
            SELECT ml.*, s.name as strain_name, s.slug, s.rarity,
                   p.display_name as seller_name
            FROM cfx_market_listings ml
            JOIN cfx_strains s ON ml.strain_id = s.id
            JOIN cfx_players p ON ml.player_id = p.id
            WHERE ml.status = 'active' AND ml.expires_at > NOW()
        `;
        const params = [];

        if (strainId) {
            query += ' AND ml.strain_id = ?';
            params.push(strainId);
        }

        if (rarity) {
            query += ' AND s.rarity = ?';
            params.push(rarity);
        }

        // Sorting
        switch (sortBy) {
            case 'price_asc':
                query += ' ORDER BY ml.price_per_unit ASC';
                break;
            case 'price_desc':
                query += ' ORDER BY ml.price_per_unit DESC';
                break;
            case 'quality':
                query += ' ORDER BY ml.quality DESC, ml.price_per_unit ASC';
                break;
            case 'newest':
                query += ' ORDER BY ml.listed_at DESC';
                break;
            default:
                query += ' ORDER BY ml.price_per_unit ASC';
        }

        query += ` LIMIT ?`;
        params.push(parseInt(limit));

        const [listings] = await pool.execute(query, params);

        res.json({
            success: true,
            listings: listings.map(l => ({
                id: l.id,
                sellerId: l.player_id,
                sellerName: l.seller_name,
                strainId: l.strain_id,
                strainName: l.strain_name,
                strainSlug: l.slug,
                rarity: l.rarity,
                quantity: l.quantity,
                quality: l.quality,
                pricePerUnit: l.price_per_unit,
                totalPrice: l.price_per_unit * l.quantity,
                listedAt: l.listed_at,
                expiresAt: l.expires_at
            }))
        });

    } catch (error) {
        logger.error('[Market] Get listings failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /market/my-listings
 * Get player's own listings
 */
router.get('/my-listings', async (req, res) => {
    try {
        const [listings] = await pool.execute(
            `SELECT ml.*, s.name as strain_name, s.slug, s.rarity
             FROM cfx_market_listings ml
             JOIN cfx_strains s ON ml.strain_id = s.id
             WHERE ml.player_id = ? AND ml.status = 'active'
             ORDER BY ml.listed_at DESC`,
            [req.player.id]
        );

        res.json({
            success: true,
            listings: listings.map(l => ({
                id: l.id,
                strainId: l.strain_id,
                strainName: l.strain_name,
                strainSlug: l.slug,
                rarity: l.rarity,
                quantity: l.quantity,
                quality: l.quality,
                pricePerUnit: l.price_per_unit,
                listedAt: l.listed_at,
                expiresAt: l.expires_at
            }))
        });

    } catch (error) {
        logger.error('[Market] Get my listings failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /market/list
 * Create a new listing
 */
router.post('/list', validate(schemas.marketList), async (req, res) => {
    try {
        const { inventoryId, quantity, pricePerUnit } = req.body;

        const result = await createListing(req.player.id, inventoryId, quantity, pricePerUnit);

        // Add heat for raid system (5 heat for market listing - P2P is riskier)
        await addHeat(req.player.id, 5, 'market_sale');

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('[Market] Create listing failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found') || error.message.includes('Insufficient') ||
            error.message.includes('Maximum')) {
            return res.status(400).json({ error: error.message, code: 'LIST_ERROR' });
        }

        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /market/buy
 * Buy from a listing
 */
router.post('/buy', validate(schemas.marketBuy), async (req, res) => {
    try {
        const { listingId, quantity } = req.body;

        const result = await buyListing(req.player.id, listingId, quantity);

        // Track stats, event points, and achievements
        await trackStat(req.player.id, 'total_trades_completed', 1);
        await trackStat(req.player.id, 'total_cash_spent', result.totalPrice || 0);
        await awardEventPoints(req.player.id, 5); // 5 points per market purchase
        checkAchievements(req.player.id).catch(() => {}); // Fire and forget

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('[Market] Buy failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found') || error.message.includes('Insufficient') ||
            error.message.includes('own listing')) {
            return res.status(400).json({ error: error.message, code: 'BUY_ERROR' });
        }

        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /market/cancel
 * Cancel a listing
 */
router.post('/cancel', async (req, res) => {
    try {
        const { listingId } = req.body;

        if (!listingId) {
            return res.status(400).json({ error: 'Listing ID required', code: 'NO_ID' });
        }

        const result = await cancelListing(req.player.id, listingId);

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('[Market] Cancel failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found')) {
            return res.status(400).json({ error: error.message, code: 'CANCEL_ERROR' });
        }

        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /market/history
 * Get price history for a strain
 */
router.get('/history/:strainId', async (req, res) => {
    try {
        const { strainId } = req.params;
        const { hours = 24 } = req.query;

        const [history] = await pool.execute(
            `SELECT price, volume, supply, recorded_at
             FROM cfx_market_price_history
             WHERE strain_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
             ORDER BY recorded_at ASC`,
            [strainId, parseInt(hours)]
        );

        res.json({
            success: true,
            history: history.map(h => ({
                price: h.price,
                volume: h.volume,
                supply: h.supply,
                timestamp: h.recorded_at
            }))
        });

    } catch (error) {
        logger.error('[Market] Get history failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
