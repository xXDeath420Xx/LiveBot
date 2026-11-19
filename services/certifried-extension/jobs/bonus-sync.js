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
        // CFX players whose game account is a Twitch/Kick identity the Tokes chat bot also tracks
        const [players] = await pool.execute(
            `SELECT id, platform, platform_user_id FROM cfx_players
             WHERE platform IN ('twitch', 'kick') AND is_banned = 0
             AND last_online_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`
        );

        for (const player of players) {
            // Look up the Tokes bot profile for the same platform identity
            const [[profile]] = await pool.execute(
                `SELECT level, lifetime_tokes, current_streak, best_streak
                 FROM tokes_profiles
                 WHERE platform = ? AND platform_user_id = ?`,
                [player.platform, player.platform_user_id]
            );

            if (!profile) continue;

            // Map tokes_profiles onto the bot-stats shape the bonus resolver expects
            const tokesProfile = {
                level: profile.level || 1,
                total_tokes: profile.lifetime_tokes || 0,
                daily_streak: profile.current_streak || 0,
                longest_streak: profile.best_streak || 0
            };

            // Calculate bonuses
            const bonuses = calculateBotBonuses({
                level: tokesProfile.level,
                daily_streak: tokesProfile.daily_streak,
                total_tokes: tokesProfile.total_tokes
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
        logger.error('[BonusSync] Sync failed', { synced, error: error.message });
    }
}

export default bonusSync;
