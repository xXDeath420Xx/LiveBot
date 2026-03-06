/**
 * Market Tick Job
 * Recalculates market prices every 5 minutes
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { recalculatePrices } from '../game/market-engine.js';
import { broadcastMarketUpdate } from '../ws/broadcaster.js';

/**
 * Run market price tick
 */
export async function marketTick() {
    const start = Date.now();

    // Recalculate prices
    await recalculatePrices();

    // Get updated prices for broadcast
    const [prices] = await pool.execute(
        `SELECT mp.strain_id, mp.current_price, mp.previous_price, mp.price_change_pct,
                s.name as strain_name, s.rarity
         FROM cfx_market_prices mp
         JOIN cfx_strains s ON mp.strain_id = s.id
         WHERE ABS(mp.price_change_pct) > 1
         ORDER BY ABS(mp.price_change_pct) DESC
         LIMIT 10`
    );

    // Broadcast significant price changes
    if (prices.length > 0) {
        broadcastMarketUpdate({
            type: 'price_update',
            changes: prices.map(p => ({
                strainId: p.strain_id,
                strainName: p.strain_name,
                rarity: p.rarity,
                currentPrice: p.current_price,
                previousPrice: p.previous_price,
                changePercent: parseFloat(p.price_change_pct)
            }))
        });
    }

    // Reset 24h stats daily
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
        await pool.execute(
            `UPDATE cfx_market_prices
             SET high_24h = current_price, low_24h = current_price, volume_24h = 0`
        );
        logger.debug('[MarketTick] Reset 24h stats');
    }

    logger.debug('[MarketTick] Complete', { duration: Date.now() - start });
}

export default marketTick;
