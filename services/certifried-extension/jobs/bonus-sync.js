/**
 * Bonus Sync Job
 * Syncs bot stats from tokes_profiles to cfx_player_bot_bonuses
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { calculateBotBonuses } from '../game/bonus-resolver.js';

/**
 * Sync bot bonuses from tokes_profiles
 */
export async function bonusSync() {
    const start = Date.now();
    let synced = 0;

    try {
        // Get all cfx_players with their platform IDs
        const [players] = await pool.execute(
            `SELECT id, platform, platform_user_id FROM cfx_players
             WHERE platform = 'twitch' AND is_banned = 0
             AND last_online_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`
        );

        for (const player of players) {
            // Look up tokes profile by Twitch user ID
            const [[tokesProfile]] = await pool.execute(
                `SELECT cbus.* FROM cf_bot_user_stats cbus
                 WHERE cbus.platform = 'twitch' AND cbus.user_id = ?`,
                [player.platform_user_id]
            );

            if (!tokesProfile) continue;

            // Calculate bonuses
            const bonuses = calculateBotBonuses({
                level: tokesProfile.level || 1,
                daily_streak: tokesProfile.daily_streak || 0,
                total_tokes: tokesProfile.total_tokes || 0
            });

            // Upsert into cfx_player_bot_bonuses
            await pool.execute(
                `INSERT INTO cfx_player_bot_bonuses
                 (player_id, bot_level, bot_lifetime_tokes, bot_current_streak, bot_best_streak,
                  growth_speed_bonus, yield_bonus, xp_bonus, sell_price_bonus, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                  bot_level = VALUES(bot_level),
                  bot_lifetime_tokes = VALUES(bot_lifetime_tokes),
                  bot_current_streak = VALUES(bot_current_streak),
                  bot_best_streak = VALUES(bot_best_streak),
                  growth_speed_bonus = VALUES(growth_speed_bonus),
                  yield_bonus = VALUES(yield_bonus),
                  xp_bonus = VALUES(xp_bonus),
                  sell_price_bonus = VALUES(sell_price_bonus),
                  synced_at = NOW()`,
                [
                    player.id,
                    tokesProfile.level || 1,
                    tokesProfile.total_tokes || 0,
                    tokesProfile.daily_streak || 0,
                    tokesProfile.longest_streak || 0,
                    bonuses.growth_speed_bonus,
                    bonuses.yield_bonus,
                    bonuses.xp_bonus,
                    bonuses.sell_price_bonus
                ]
            );

            synced++;
        }

        if (synced > 0) {
            logger.debug('[BonusSync] Complete', {
                synced,
                duration: Date.now() - start
            });
        }

    } catch (error) {
        // Table might not exist, log and continue
        if (!error.message.includes('doesn\'t exist')) {
            throw error;
        }
        logger.debug('[BonusSync] Tokes tables not available');
    }
}

export default bonusSync;
