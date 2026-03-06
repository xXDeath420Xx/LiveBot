/**
 * Shop Rotation Job
 * Creates new daily/weekly deals when old ones expire
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Rotate shop deals - create new ones when old expire
 */
export async function rotateShopDeals() {
    const now = new Date();

    // Check if we need a new daily deal
    const [[existingDaily]] = await pool.execute(
        `SELECT id FROM cfx_shop_rotation
         WHERE rotation_type = 'daily_deal' AND is_active = TRUE AND ends_at > ?`,
        [now]
    );

    if (!existingDaily) {
        // Create a new daily deal
        const [strains] = await pool.execute(
            `SELECT id, name, rarity FROM cfx_strains
             WHERE rarity IN ('uncommon', 'rare')
             ORDER BY RAND() LIMIT 1`
        );

        if (strains.length > 0) {
            const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const discount = 15 + Math.floor(Math.random() * 15); // 15-30% off
            const bonusSeeds = Math.floor(Math.random() * 2) + 1; // 1-2 bonus

            await pool.execute(
                `INSERT INTO cfx_shop_rotation
                 (rotation_type, strain_id, discount_percent, bonus_seeds, starts_at, ends_at)
                 VALUES ('daily_deal', ?, ?, ?, ?, ?)`,
                [strains[0].id, discount, bonusSeeds, now, tomorrow]
            );

            logger.info('[ShopRotation] New daily deal', {
                strain: strains[0].name,
                discount: `${discount}%`,
                bonusSeeds
            });
        }
    }

    // Check if we need a new weekly special
    const [[existingWeekly]] = await pool.execute(
        `SELECT id FROM cfx_shop_rotation
         WHERE rotation_type = 'weekly_special' AND is_active = TRUE AND ends_at > ?`,
        [now]
    );

    if (!existingWeekly) {
        // Create a new weekly special (rarer strains)
        const [strains] = await pool.execute(
            `SELECT id, name, rarity FROM cfx_strains
             WHERE rarity IN ('rare', 'epic')
             ORDER BY RAND() LIMIT 1`
        );

        if (strains.length > 0) {
            const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            const discount = 25 + Math.floor(Math.random() * 15); // 25-40% off
            const bonusSeeds = Math.floor(Math.random() * 3) + 2; // 2-4 bonus

            await pool.execute(
                `INSERT INTO cfx_shop_rotation
                 (rotation_type, strain_id, discount_percent, bonus_seeds, starts_at, ends_at)
                 VALUES ('weekly_special', ?, ?, ?, ?, ?)`,
                [strains[0].id, discount, bonusSeeds, now, nextWeek]
            );

            logger.info('[ShopRotation] New weekly special', {
                strain: strains[0].name,
                discount: `${discount}%`,
                bonusSeeds
            });
        }
    }

    // Random flash sale (5% chance per hour during active hours)
    if (Math.random() < 0.05) {
        const [strains] = await pool.execute(
            `SELECT id, name, rarity FROM cfx_strains
             WHERE rarity IN ('epic', 'legendary')
             ORDER BY RAND() LIMIT 1`
        );

        if (strains.length > 0) {
            // Flash sales last 2-4 hours
            const duration = (2 + Math.floor(Math.random() * 3)) * 60 * 60 * 1000;
            const endsAt = new Date(now.getTime() + duration);
            const discount = 35 + Math.floor(Math.random() * 20); // 35-55% off
            const maxPurchases = 10 + Math.floor(Math.random() * 20); // Limited stock

            await pool.execute(
                `INSERT INTO cfx_shop_rotation
                 (rotation_type, strain_id, discount_percent, bonus_seeds, starts_at, ends_at, max_purchases)
                 VALUES ('flash_sale', ?, ?, 3, ?, ?, ?)`,
                [strains[0].id, discount, now, endsAt, maxPurchases]
            );

            logger.info('[ShopRotation] Flash sale started!', {
                strain: strains[0].name,
                discount: `${discount}%`,
                duration: `${duration / 3600000}h`,
                stock: maxPurchases
            });
        }
    }

    // Expire old deals
    await pool.execute(
        `UPDATE cfx_shop_rotation SET is_active = FALSE WHERE ends_at < ? AND is_active = TRUE`,
        [now]
    );
}

export default { rotateShopDeals };
