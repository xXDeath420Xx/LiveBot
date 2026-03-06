/**
 * Market Engine
 * Handles supply/demand pricing, NPC sales, and player listings
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { MARKET } from '../config/game-constants.js';
import { getBonuses } from './bonus-resolver.js';
import { awardCash, awardXp } from './engine.js';
import { updateQuestProgress } from './quest-system.js';

/**
 * Calculate NPC quick-sell price
 * Formula: base_price * (0.5 + quality/100 * 1.5)
 * @param {number} basePrice - Strain base price
 * @param {number} quality - Item quality (0-100)
 * @returns {number} Price per unit
 */
export function calculateNpcPrice(basePrice, quality) {
    // Default quality to 50 if not provided or invalid
    const safeQuality = (quality == null || isNaN(quality)) ? 50 : Math.max(0, Math.min(100, quality));
    const qualityMultiplier = MARKET.NPC_PRICE_FLOOR_MULTIPLIER +
        (safeQuality / 100) * MARKET.NPC_PRICE_QUALITY_MULTIPLIER;
    return Math.floor(basePrice * qualityMultiplier);
}

/**
 * Calculate market price with demand
 * @param {number} npcBasePrice - NPC base price
 * @param {number} demandScore - Demand score (50-300)
 * @param {number} quality - Item quality
 * @returns {number} Market price per unit
 */
export function calculateMarketPrice(npcBasePrice, demandScore, quality) {
    // Default quality to 50 if not provided or invalid
    const safeQuality = (quality == null || isNaN(quality)) ? 50 : Math.max(0, Math.min(100, quality));
    const safeDemand = (demandScore == null || isNaN(demandScore)) ? 100 : demandScore;
    const demandMultiplier = safeDemand / 100;
    const qualityWeight = 0.5 + (safeQuality / 100) * 0.5;
    return Math.floor(npcBasePrice * demandMultiplier * qualityWeight);
}

/**
 * Sell items to NPC (instant sale)
 * @param {number} playerId - Player ID
 * @param {number} inventoryId - Inventory item ID
 * @param {number} quantity - Quantity to sell
 * @returns {object} Sale result
 */
export async function sellToNpc(playerId, inventoryId, quantity) {
    // Use transaction with FOR UPDATE to prevent double-sell exploit
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Get inventory item with FOR UPDATE lock
        const [[item]] = await conn.execute(
            `SELECT i.*, s.base_price, s.name as strain_name
             FROM cfx_inventory i
             JOIN cfx_strains s ON i.strain_id = s.id
             WHERE i.id = ? AND i.player_id = ?
             FOR UPDATE`,
            [inventoryId, playerId]
        );

        if (!item) {
            await conn.rollback();
            throw new Error('Item not found');
        }

        // Default quantity to all items if not specified
        quantity = quantity || item.quantity;

        if (item.quantity < quantity) {
            await conn.rollback();
            throw new Error('Insufficient quantity');
        }

        // Get bonuses
        const bonuses = await getBonuses(playerId);

        // Calculate price with bonuses
        const pricePerUnit = calculateNpcPrice(item.base_price, item.quality);
        const sellMultiplier = 1 + (bonuses.sellPriceBonus || 0);
        const finalPricePerUnit = Math.floor(pricePerUnit * sellMultiplier);
        const totalPrice = finalPricePerUnit * quantity;

        // Calculate XP (1 XP per $10 earned)
        const xpEarned = Math.floor(totalPrice / 10);

        // Update inventory (inside transaction)
        if (item.quantity === quantity) {
            await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
        } else {
            await conn.execute(
                'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                [quantity, inventoryId]
            );
        }

        // Log the sale (inside transaction)
        await conn.execute(
            `INSERT INTO cfx_npc_sales (player_id, strain_id, quantity, quality, price_per_unit, total_price)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [playerId, item.strain_id, quantity, item.quality, finalPricePerUnit, totalPrice]
        );

        // Update market supply tracking (inside transaction)
        await conn.execute(
            `UPDATE cfx_market_prices
             SET volume_24h = volume_24h + ?, supply_volume = GREATEST(0, supply_volume - ?)
             WHERE strain_id = ?`,
            [quantity, quantity, item.strain_id]
        );

        await conn.commit();

        // Award cash and XP (after transaction, they manage their own locks)
        const cashResult = await awardCash(playerId, totalPrice);
        const xpResult = await awardXp(playerId, xpEarned);

        // Update quest progress for selling (non-critical, after transaction)
        await updateQuestProgress(playerId, 'sell_count', 1);
        await updateQuestProgress(playerId, 'sell_value', totalPrice);

        return {
            strainId: item.strain_id,
            strainName: item.strain_name,
            quantity,
            quality: item.quality,
            pricePerUnit: finalPricePerUnit,
            totalPrice,
            bonusApplied: sellMultiplier - 1,
            xpEarned: xpResult.xpAwarded,
            newCash: cashResult.newCash
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Create a market listing
 * @param {number} playerId - Player ID
 * @param {number} inventoryId - Inventory item ID
 * @param {number} quantity - Quantity to list
 * @param {number} pricePerUnit - Asking price per unit
 * @returns {object} Listing result
 */
export async function createListing(playerId, inventoryId, quantity, pricePerUnit) {
    // Use transaction with FOR UPDATE to prevent duplicate listing exploit
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Get inventory item with FOR UPDATE lock
        const [[item]] = await conn.execute(
            `SELECT i.*, s.name as strain_name
             FROM cfx_inventory i
             JOIN cfx_strains s ON i.strain_id = s.id
             WHERE i.id = ? AND i.player_id = ?
             FOR UPDATE`,
            [inventoryId, playerId]
        );

        if (!item) {
            await conn.rollback();
            throw new Error('Item not found');
        }

        if (item.quantity < quantity) {
            await conn.rollback();
            throw new Error('Insufficient quantity');
        }

        // Get bonuses to check listing limit
        const bonuses = await getBonuses(playerId);
        const maxListings = MARKET.MAX_LISTINGS_BASE + (bonuses.extraListings || 0);

        // Count current active listings
        const [[{ count }]] = await conn.execute(
            `SELECT COUNT(*) as count FROM cfx_market_listings
             WHERE player_id = ? AND status = 'active'`,
            [playerId]
        );

        if (count >= maxListings) {
            await conn.rollback();
            throw new Error(`Maximum ${maxListings} listings allowed`);
        }

        // Deduct from inventory (inside transaction)
        if (item.quantity === quantity) {
            await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
        } else {
            await conn.execute(
                'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                [quantity, inventoryId]
            );
        }

        // Create listing (inside transaction)
        const expiresAt = new Date(Date.now() + MARKET.LISTING_DURATION_HOURS * 60 * 60 * 1000);

        const [result] = await conn.execute(
            `INSERT INTO cfx_market_listings
             (player_id, inventory_id, strain_id, quantity, price_per_unit, quality, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [playerId, inventoryId, item.strain_id, quantity, pricePerUnit, item.quality, expiresAt]
        );

        // Update market supply (inside transaction)
        await conn.execute(
            `UPDATE cfx_market_prices SET supply_volume = supply_volume + ? WHERE strain_id = ?`,
            [quantity, item.strain_id]
        );

        await conn.commit();

        return {
            listingId: result.insertId,
            strainId: item.strain_id,
            strainName: item.strain_name,
            quantity,
            quality: item.quality,
            pricePerUnit,
            expiresAt
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Buy from a market listing
 * @param {number} buyerId - Buyer player ID
 * @param {number} listingId - Listing ID
 * @param {number} quantity - Quantity to buy (optional, defaults to all)
 * @returns {object} Purchase result
 */
export async function buyListing(buyerId, listingId, quantity = null) {
    // Use transaction with FOR UPDATE locks to prevent double-buy exploit
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Get listing with FOR UPDATE lock
        const [[listing]] = await conn.execute(
            `SELECT ml.*, s.name as strain_name, p.display_name as seller_name
             FROM cfx_market_listings ml
             JOIN cfx_strains s ON ml.strain_id = s.id
             JOIN cfx_players p ON ml.player_id = p.id
             WHERE ml.id = ? AND ml.status = 'active'
             FOR UPDATE`,
            [listingId]
        );

        if (!listing) {
            await conn.rollback();
            throw new Error('Listing not found or no longer available');
        }

        if (listing.player_id === buyerId) {
            await conn.rollback();
            throw new Error('Cannot buy your own listing');
        }

        // Default to full quantity
        const buyQuantity = quantity || listing.quantity;

        if (buyQuantity > listing.quantity) {
            await conn.rollback();
            throw new Error('Insufficient quantity available');
        }

        const totalPrice = listing.price_per_unit * buyQuantity;

        // Check buyer has enough cash with FOR UPDATE lock
        const [[buyer]] = await conn.execute(
            'SELECT cash FROM cfx_players WHERE id = ? FOR UPDATE',
            [buyerId]
        );

        if (!buyer || buyer.cash < totalPrice) {
            await conn.rollback();
            throw new Error('Insufficient funds');
        }

        // Get bonuses for fee calculation
        const bonuses = await getBonuses(listing.player_id);
        const feeMultiplier = Math.max(0, MARKET.LISTING_FEE_PERCENT - (bonuses.feeReduction || 0));
        const fee = Math.floor(totalPrice * feeMultiplier);
        const sellerProceeds = totalPrice - fee;

        // Deduct from buyer (inside transaction)
        await conn.execute(
            'UPDATE cfx_players SET cash = cash - ? WHERE id = ?',
            [totalPrice, buyerId]
        );

        // Add to seller (inside transaction)
        await conn.execute(
            'UPDATE cfx_players SET cash = cash + ?, lifetime_earnings = lifetime_earnings + ? WHERE id = ?',
            [sellerProceeds, sellerProceeds, listing.player_id]
        );

        // Add item to buyer's inventory with FOR UPDATE lock
        const [[existingStack]] = await conn.execute(
            `SELECT id FROM cfx_inventory
             WHERE player_id = ? AND strain_id = ? AND quality = ? AND source = 'market_buy'
             FOR UPDATE`,
            [buyerId, listing.strain_id, listing.quality]
        );

        if (existingStack) {
            await conn.execute(
                'UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?',
                [buyQuantity, existingStack.id]
            );
        } else {
            await conn.execute(
                `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality, source)
                 VALUES (?, ?, ?, ?, 'market_buy')`,
                [buyerId, listing.strain_id, buyQuantity, listing.quality]
            );
        }

        // Update or close listing (inside transaction)
        if (buyQuantity >= listing.quantity) {
            await conn.execute(
                `UPDATE cfx_market_listings
                 SET status = 'sold', quantity = 0, sold_at = NOW(), buyer_id = ?
                 WHERE id = ?`,
                [buyerId, listingId]
            );
        } else {
            await conn.execute(
                'UPDATE cfx_market_listings SET quantity = quantity - ? WHERE id = ?',
                [buyQuantity, listingId]
            );
        }

        // Update market stats (inside transaction)
        await conn.execute(
            `UPDATE cfx_market_prices
             SET volume_24h = volume_24h + ?, supply_volume = GREATEST(0, supply_volume - ?)
             WHERE strain_id = ?`,
            [buyQuantity, buyQuantity, listing.strain_id]
        );

        // Get buyer's new cash before commit
        const [[buyerUpdated]] = await conn.execute(
            'SELECT cash FROM cfx_players WHERE id = ?',
            [buyerId]
        );

        await conn.commit();

        return {
            listingId,
            strainId: listing.strain_id,
            strainName: listing.strain_name,
            sellerName: listing.seller_name,
            quantity: buyQuantity,
            quality: listing.quality,
            pricePerUnit: listing.price_per_unit,
            totalPrice,
            fee,
            sellerProceeds,
            newCash: parseFloat(buyerUpdated.cash)
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Cancel a market listing
 * @param {number} playerId - Player ID
 * @param {number} listingId - Listing ID
 * @returns {object} Cancel result
 */
export async function cancelListing(playerId, listingId) {
    // Use transaction with FOR UPDATE to prevent race with buy operations
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Get listing with FOR UPDATE lock
        const [[listing]] = await conn.execute(
            `SELECT * FROM cfx_market_listings
             WHERE id = ? AND player_id = ? AND status = 'active'
             FOR UPDATE`,
            [listingId, playerId]
        );

        if (!listing) {
            await conn.rollback();
            throw new Error('Listing not found');
        }

        // Return items to inventory with FOR UPDATE lock
        const [[existingStack]] = await conn.execute(
            `SELECT id FROM cfx_inventory
             WHERE player_id = ? AND strain_id = ? AND quality = ?
             FOR UPDATE`,
            [playerId, listing.strain_id, listing.quality]
        );

        if (existingStack) {
            await conn.execute(
                'UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?',
                [listing.quantity, existingStack.id]
            );
        } else {
            await conn.execute(
                `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality, source)
                 VALUES (?, ?, ?, ?, 'grown')`,
                [playerId, listing.strain_id, listing.quantity, listing.quality]
            );
        }

        // Mark as cancelled (inside transaction)
        await conn.execute(
            "UPDATE cfx_market_listings SET status = 'cancelled' WHERE id = ?",
            [listingId]
        );

        // Update supply (inside transaction)
        await conn.execute(
            `UPDATE cfx_market_prices SET supply_volume = GREATEST(0, supply_volume - ?) WHERE strain_id = ?`,
            [listing.quantity, listing.strain_id]
        );

        await conn.commit();

        return {
            listingId,
            quantityReturned: listing.quantity
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Get current market prices for all strains
 * @returns {object[]} Price data
 */
export async function getMarketPrices() {
    const [prices] = await pool.execute(
        `SELECT mp.*, s.name as strain_name, s.rarity
         FROM cfx_market_prices mp
         JOIN cfx_strains s ON mp.strain_id = s.id
         ORDER BY s.rarity DESC, s.name`
    );

    return prices.map(p => ({
        strainId: p.strain_id,
        strainName: p.strain_name,
        rarity: p.rarity,
        currentPrice: p.current_price,
        previousPrice: p.previous_price,
        changePercent: parseFloat(p.price_change_pct),
        high24h: p.high_24h,
        low24h: p.low_24h,
        volume24h: p.volume_24h,
        supplyVolume: p.supply_volume,
        demandScore: parseFloat(p.demand_score)
    }));
}

/**
 * Recalculate market prices (called by cron job)
 * Creates stock-like price movements with volatility and trends
 */
export async function recalculatePrices() {
    const [strains] = await pool.execute('SELECT id, base_price, demand_weight FROM cfx_strains');

    for (const strain of strains) {
        const [[priceData]] = await pool.execute(
            'SELECT * FROM cfx_market_prices WHERE strain_id = ?',
            [strain.id]
        );

        if (!priceData) continue;

        const currentPrice = priceData.current_price || strain.base_price;
        const volatility = parseFloat(priceData.volatility) || 0.05;
        const currentTrend = priceData.trend || 'stable';

        // Calculate supply/demand pressure
        const supplyPressure = (priceData.supply_volume || 0) / MARKET.DEMAND_SUPPLY_FACTOR;
        const volumeBoost = (priceData.volume_24h || 0) * MARKET.DEMAND_VELOCITY_FACTOR / 100;

        // Base demand calculation
        let newDemand = MARKET.DEMAND_BASE - supplyPressure + volumeBoost;
        newDemand *= (strain.demand_weight || 1);
        newDemand = Math.max(MARKET.DEMAND_MIN, Math.min(MARKET.DEMAND_MAX, newDemand));

        // STOCK-LIKE FLUCTUATION: Add random walk with trend bias
        // Random component: -volatility to +volatility
        const randomWalk = (Math.random() - 0.5) * 2 * volatility;

        // Trend bias: increases probability of continuing current trend
        let trendBias = 0;
        if (currentTrend === 'rising') trendBias = 0.02;
        else if (currentTrend === 'falling') trendBias = -0.02;

        // Reversion to mean: prices tend to return to base price over time
        const meanReversion = ((strain.base_price - currentPrice) / strain.base_price) * 0.03;

        // Combined price change factor
        const priceChangeFactor = 1 + randomWalk + trendBias + meanReversion;

        // Calculate new price with demand influence
        const demandMultiplier = newDemand / 100;
        let newPrice = Math.floor(currentPrice * priceChangeFactor * (0.8 + demandMultiplier * 0.4));

        // Enforce min/max bounds (50% to 300% of base price)
        const minPrice = Math.floor(strain.base_price * 0.5);
        const maxPrice = Math.floor(strain.base_price * 3.0);
        newPrice = Math.max(minPrice, Math.min(maxPrice, newPrice));

        const changePercent = ((newPrice - currentPrice) / currentPrice) * 100;

        // Determine new trend based on recent movement
        let newTrend = 'stable';
        if (changePercent > 2) newTrend = 'rising';
        else if (changePercent < -2) newTrend = 'falling';

        // Random trend reversal chance (5%)
        if (Math.random() < 0.05) {
            newTrend = ['rising', 'falling', 'stable'][Math.floor(Math.random() * 3)];
        }

        // Adjust volatility based on volume (more volume = more volatile)
        let newVolatility = 0.05 + ((priceData.volume_24h || 0) / 1000) * 0.02;
        newVolatility = Math.max(0.02, Math.min(0.15, newVolatility));

        // Update prices
        await pool.execute(
            `UPDATE cfx_market_prices
             SET previous_price = current_price, current_price = ?,
                 price_change_pct = ?, demand_score = ?,
                 high_24h = GREATEST(COALESCE(high_24h, ?), ?),
                 low_24h = LEAST(COALESCE(low_24h, ?), ?),
                 trend = ?, volatility = ?
             WHERE strain_id = ?`,
            [newPrice, changePercent.toFixed(3), newDemand.toFixed(3),
             newPrice, newPrice, newPrice, newPrice,
             newTrend, newVolatility.toFixed(3), strain.id]
        );

        // Record history for charts
        try {
            await pool.execute(
                `INSERT INTO cfx_market_price_history (strain_id, price, volume, supply)
                 VALUES (?, ?, ?, ?)`,
                [strain.id, newPrice, priceData.volume_24h || 0, priceData.supply_volume || 0]
            );
        } catch (e) {
            // History table may have different columns, ignore errors
        }
    }

    logger.info('[MarketEngine] Prices recalculated with stock-like fluctuations');
}

/**
 * Trigger a market event (price spike/crash for specific strain)
 * @param {number} strainId - Strain ID
 * @param {string} eventType - 'spike' or 'crash'
 * @param {number} magnitude - 0.1 to 0.5 (10-50% change)
 */
export async function triggerMarketEvent(strainId, eventType, magnitude = 0.2) {
    const [[priceData]] = await pool.execute(
        'SELECT current_price FROM cfx_market_prices WHERE strain_id = ?',
        [strainId]
    );

    if (!priceData) return null;

    const multiplier = eventType === 'spike' ? (1 + magnitude) : (1 - magnitude);
    const newPrice = Math.floor(priceData.current_price * multiplier);
    const newTrend = eventType === 'spike' ? 'rising' : 'falling';
    const newVolatility = 0.10 + magnitude; // Increased volatility during events

    await pool.execute(
        `UPDATE cfx_market_prices
         SET previous_price = current_price, current_price = ?,
             trend = ?, volatility = ?,
             price_change_pct = ?
         WHERE strain_id = ?`,
        [newPrice, newTrend, newVolatility, (multiplier - 1) * 100, strainId]
    );

    logger.info(`[MarketEngine] Market event: ${eventType} on strain ${strainId}, ${(magnitude * 100).toFixed(0)}% change`);

    return { strainId, eventType, oldPrice: priceData.current_price, newPrice };
}

export default {
    calculateNpcPrice,
    calculateMarketPrice,
    sellToNpc,
    createListing,
    buyListing,
    cancelListing,
    getMarketPrices,
    recalculatePrices,
    triggerMarketEvent
};
