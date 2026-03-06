/**
 * Cleanup Job
 * Expires stale listings, trades, and cleans up old data
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Run cleanup tasks
 */
export async function cleanup() {
    const start = Date.now();
    const results = {
        expiredListings: 0,
        expiredTrades: 0,
        expiredBoosts: 0,
        oldPriceHistory: 0
    };

    // Expire old market listings and return items
    const [expiredListings] = await pool.execute(
        `SELECT id, player_id, strain_id, quantity, quality
         FROM cfx_market_listings
         WHERE status = 'active' AND expires_at < NOW()`
    );

    for (const listing of expiredListings) {
        // Return items to player
        const [[existing]] = await pool.execute(
            `SELECT id FROM cfx_inventory
             WHERE player_id = ? AND strain_id = ? AND quality = ?`,
            [listing.player_id, listing.strain_id, listing.quality]
        );

        if (existing) {
            await pool.execute(
                'UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?',
                [listing.quantity, existing.id]
            );
        } else {
            await pool.execute(
                `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality)
                 VALUES (?, ?, ?, ?)`,
                [listing.player_id, listing.strain_id, listing.quantity, listing.quality]
            );
        }

        // Update supply
        await pool.execute(
            `UPDATE cfx_market_prices SET supply_volume = GREATEST(0, supply_volume - ?)
             WHERE strain_id = ?`,
            [listing.quantity, listing.strain_id]
        );

        results.expiredListings++;
    }

    // Mark listings as expired
    await pool.execute(
        `UPDATE cfx_market_listings SET status = 'expired'
         WHERE status = 'active' AND expires_at < NOW()`
    );

    // Expire old trades
    const [expiredTradesResult] = await pool.execute(
        `UPDATE cfx_trades SET status = 'expired', resolved_at = NOW()
         WHERE status = 'pending' AND expires_at < NOW()`
    );
    results.expiredTrades = expiredTradesResult.affectedRows;

    // Clean up expired boosts
    const [expiredBoostsResult] = await pool.execute(
        `DELETE FROM cfx_active_boosts WHERE expires_at < NOW()`
    );
    results.expiredBoosts = expiredBoostsResult.affectedRows;

    // Clean up old price history (keep 7 days)
    const [oldHistoryResult] = await pool.execute(
        `DELETE FROM cfx_market_price_history
         WHERE recorded_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    results.oldPriceHistory = oldHistoryResult.affectedRows;

    // Clean up claimed quests older than 30 days
    await pool.execute(
        `DELETE FROM cfx_player_quests
         WHERE status = 'claimed' AND claimed_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );

    // Clean up expired quests older than 7 days
    await pool.execute(
        `DELETE FROM cfx_player_quests
         WHERE status = 'expired' AND expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    const totalCleaned = Object.values(results).reduce((a, b) => a + b, 0);

    if (totalCleaned > 0) {
        logger.info('[Cleanup] Complete', {
            ...results,
            duration: Date.now() - start
        });
    }
}

export default cleanup;
