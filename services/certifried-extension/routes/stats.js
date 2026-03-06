/**
 * Statistics Routes
 * Player lifetime stats and achievements
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /stats
 * Get player's lifetime statistics
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get or create player stats
        let [[stats]] = await pool.execute(
            'SELECT * FROM cfx_player_stats WHERE player_id = ?',
            [playerId]
        );

        if (!stats) {
            await pool.execute(
                'INSERT INTO cfx_player_stats (player_id) VALUES (?)',
                [playerId]
            );
            [[stats]] = await pool.execute(
                'SELECT * FROM cfx_player_stats WHERE player_id = ?',
                [playerId]
            );
        }

        // Get additional computed stats
        const [[inventoryStats]] = await pool.execute(
            `SELECT
                COUNT(DISTINCT strain_id) as unique_strains_in_inventory,
                SUM(quantity) as total_inventory_items
             FROM cfx_inventory WHERE player_id = ?`,
            [playerId]
        );

        const [[discoveryCount]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_strain_discoveries WHERE player_id = ?',
            [playerId]
        );

        const [[totalStrains]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_strains'
        );

        const [[activeQuests]] = await pool.execute(
            `SELECT COUNT(*) as count FROM cfx_player_quests
             WHERE player_id = ? AND status = 'active'`,
            [playerId]
        );

        const [[unlockedAchievements]] = await pool.execute(
            `SELECT COUNT(*) as count FROM cfx_player_achievements
             WHERE player_id = ? AND unlocked_at IS NOT NULL`,
            [playerId]
        );

        const [[totalAchievements]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_achievements'
        );

        res.json({
            success: true,
            stats: {
                // Growing stats
                totalHarvests: stats.total_harvests || 0,
                totalPlantsGrown: stats.total_plants_grown || 0,
                highestQualityGrown: stats.highest_quality_grown || 0,

                // Economy stats
                totalCashEarned: parseFloat(stats.total_cash_earned) || 0,
                totalCashSpent: parseFloat(stats.total_cash_spent) || 0,
                netProfit: parseFloat(stats.total_cash_earned) - parseFloat(stats.total_cash_spent) || 0,

                // XP stats
                totalXpEarned: parseInt(stats.total_xp_earned) || 0,

                // Trading stats
                totalTradesCompleted: stats.total_trades_completed || 0,

                // Breeding stats
                totalBreedingAttempts: stats.total_breeding_attempts || 0,
                totalBreedingSuccesses: stats.total_breeding_successes || 0,
                breedingSuccessRate: stats.total_breeding_attempts > 0
                    ? Math.round((stats.total_breeding_successes / stats.total_breeding_attempts) * 100)
                    : 0,

                // Collection stats
                strainsDiscovered: discoveryCount?.count || 0,
                totalStrains: totalStrains?.count || 0,
                collectionProgress: totalStrains?.count > 0
                    ? Math.round((discoveryCount?.count / totalStrains?.count) * 100)
                    : 0,

                // Inventory stats
                uniqueStrainsInInventory: inventoryStats?.unique_strains_in_inventory || 0,
                totalInventoryItems: inventoryStats?.total_inventory_items || 0,

                // Progress stats
                achievementsUnlocked: unlockedAchievements?.count || 0,
                totalAchievements: totalAchievements?.count || 0,
                questsCompleted: stats.total_quests_completed || 0,
                activeQuests: activeQuests?.count || 0,

                // Prestige stats
                totalPrestigeResets: stats.total_prestige_resets || 0,

                // Engagement stats
                totalLoginDays: stats.total_login_days || 0,
                highestStreak: stats.highest_streak_achieved || 0,
                firstLoginAt: stats.first_login_at,
                lastLoginAt: stats.last_login_at,
                totalPlaytimeHours: Math.round((stats.total_playtime_seconds || 0) / 3600)
            }
        });

    } catch (error) {
        logger.error('[Stats] Get stats failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /stats/track
 * Internal endpoint to track a stat increment
 * Called by other routes when actions happen
 */
router.post('/track', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { stat, value = 1 } = req.body;

        const validStats = [
            'total_harvests', 'total_plants_grown', 'total_cash_earned',
            'total_cash_spent', 'total_xp_earned', 'total_trades_completed',
            'total_breeding_attempts', 'total_breeding_successes',
            'total_strains_discovered', 'total_prestige_resets',
            'total_quests_completed', 'total_achievements_unlocked'
        ];

        if (!validStats.includes(stat)) {
            return res.status(400).json({ error: 'Invalid stat', code: 'INVALID_STAT' });
        }

        // Special handling for highest_quality_grown (max, not increment)
        if (stat === 'highest_quality_grown') {
            await pool.execute(
                `INSERT INTO cfx_player_stats (player_id, highest_quality_grown)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE
                 highest_quality_grown = GREATEST(highest_quality_grown, ?)`,
                [playerId, value, value]
            );
        } else {
            // Regular increment
            await pool.execute(
                `INSERT INTO cfx_player_stats (player_id, ${stat})
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE
                 ${stat} = ${stat} + ?`,
                [playerId, value, value]
            );
        }

        res.json({ success: true });

    } catch (error) {
        logger.error('[Stats] Track failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * Helper function to track stats from other routes
 */
export async function trackStat(playerId, stat, value = 1) {
    try {
        const validStats = [
            'total_harvests', 'total_plants_grown', 'total_cash_earned',
            'total_cash_spent', 'total_xp_earned', 'total_trades_completed',
            'total_breeding_attempts', 'total_breeding_successes',
            'total_strains_discovered', 'total_prestige_resets',
            'total_quests_completed', 'total_achievements_unlocked',
            'highest_quality_grown'
        ];

        if (!validStats.includes(stat)) return;

        if (stat === 'highest_quality_grown') {
            await pool.execute(
                `INSERT INTO cfx_player_stats (player_id, highest_quality_grown)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE
                 highest_quality_grown = GREATEST(highest_quality_grown, ?)`,
                [playerId, value, value]
            );
        } else {
            await pool.execute(
                `INSERT INTO cfx_player_stats (player_id, ${stat})
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE
                 ${stat} = ${stat} + ?`,
                [playerId, value, value]
            );
        }
    } catch (error) {
        logger.warn('[Stats] Track stat failed', { playerId, stat, error: error.message });
    }
}

export default router;
