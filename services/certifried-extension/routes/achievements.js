/**
 * Achievements Routes
 * Get and claim achievements
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash, awardXp } from '../game/engine.js';

const router = Router();

/**
 * GET /achievements
 * Get all achievements with player progress
 */
router.get('/', async (req, res) => {
    try {
        // Get all achievements
        const [achievements] = await pool.execute(
            'SELECT * FROM cfx_achievements ORDER BY requirement_value ASC'
        );

        // Get player's unlocked achievements
        const [playerAchievements] = await pool.execute(
            'SELECT achievement_id, unlocked_at, claimed FROM cfx_player_achievements WHERE player_id = ?',
            [req.player.id]
        );

        const unlockedMap = {};
        playerAchievements.forEach(pa => {
            unlockedMap[pa.achievement_id] = {
                unlockedAt: pa.unlocked_at,
                claimed: pa.claimed === 1
            };
        });

        // Get player stats for progress tracking
        const [[stats]] = await pool.execute(
            `SELECT
                COALESCE(ps.total_harvests, p.lifetime_sales) as totalHarvests,
                p.level,
                p.cash,
                p.lifetime_earnings as totalEarnings
             FROM cfx_players p
             LEFT JOIN cfx_player_stats ps ON ps.player_id = p.id
             WHERE p.id = ?`,
            [req.player.id]
        );

        // Calculate progress for each achievement
        const achievementsWithProgress = achievements.map(a => {
            const unlocked = unlockedMap[a.id];
            let progress = 0;
            let currentValue = 0;

            // Get requirement type and value
            const conditionType = a.requirement_type || 'unknown';
            const conditionValue = a.requirement_value || 1;

            // Get current value based on condition type
            switch (conditionType) {
                case 'harvests':
                case 'plants':  // Also handle 'plants' for new schema
                    currentValue = stats.totalHarvests || 0;
                    break;
                case 'level':
                    currentValue = stats.level || 1;
                    break;
                case 'cash':
                    currentValue = parseFloat(stats.cash) || 0;
                    break;
                case 'earnings':
                    currentValue = parseFloat(stats.totalEarnings) || 0;
                    break;
                default:
                    currentValue = 0;
            }

            progress = Math.min(100, Math.floor((currentValue / conditionValue) * 100));

            return {
                id: a.id,
                key: a.achievement_key,
                name: a.name,
                description: a.description,
                icon: a.icon,
                category: a.category,
                rarity: a.rarity,
                conditionType,
                conditionValue,
                currentValue,
                progress,
                rewardCash: parseFloat(a.reward_cash) || 0,
                rewardXp: a.reward_xp || 0,
                rewardPrestigeTokens: a.reward_prestige_tokens || 0,
                unlocked: !!unlocked,
                unlockedAt: unlocked?.unlockedAt || null,
                claimed: unlocked?.claimed || false
            };
        });

        res.json({
            success: true,
            achievements: achievementsWithProgress,
            totalUnlocked: playerAchievements.length,
            totalAchievements: achievements.length
        });

    } catch (error) {
        logger.error('[Achievements] Get failed', { playerId: req.player.id, error: error.message });
        res.status(500).json({ error: 'Failed to load achievements', code: 'ERROR' });
    }
});

/**
 * POST /achievements/claim
 * Claim rewards for an unlocked achievement
 */
router.post('/claim', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { achievementId } = req.body;

        if (!achievementId) {
            return res.status(400).json({ error: 'Achievement ID required', code: 'NO_ID' });
        }

        await conn.beginTransaction();

        // Check if achievement exists and is unlocked by player with FOR UPDATE lock to prevent double-claim
        const [[playerAchievement]] = await conn.execute(
            `SELECT pa.*, a.name, a.reward_cash, a.reward_xp, a.reward_prestige_tokens
             FROM cfx_player_achievements pa
             JOIN cfx_achievements a ON pa.achievement_id = a.id
             WHERE pa.player_id = ? AND pa.achievement_id = ?
             FOR UPDATE`,
            [req.player.id, achievementId]
        );

        if (!playerAchievement) {
            await conn.rollback();
            return res.status(400).json({ error: 'Achievement not unlocked', code: 'NOT_UNLOCKED' });
        }

        if (playerAchievement.claimed) {
            await conn.rollback();
            return res.status(400).json({ error: 'Already claimed', code: 'ALREADY_CLAIMED' });
        }

        // Mark as claimed immediately inside transaction
        await conn.execute(
            'UPDATE cfx_player_achievements SET claimed = 1 WHERE player_id = ? AND achievement_id = ?',
            [req.player.id, achievementId]
        );

        // Award prestige tokens (inside transaction)
        const rewards = {
            cash: parseFloat(playerAchievement.reward_cash) || 0,
            xp: playerAchievement.reward_xp || 0,
            prestigeTokens: playerAchievement.reward_prestige_tokens || 0
        };

        if (rewards.prestigeTokens > 0) {
            await conn.execute(
                'UPDATE cfx_players SET prestige_tokens = prestige_tokens + ? WHERE id = ?',
                [rewards.prestigeTokens, req.player.id]
            );
        }

        await conn.commit();

        // Award cash and XP using engine functions (after transaction, they manage their own locks)
        if (rewards.cash > 0) {
            await awardCash(req.player.id, rewards.cash);
        }

        if (rewards.xp > 0) {
            await awardXp(req.player.id, rewards.xp);
        }

        // Get updated player state for live UI updates
        const [[player]] = await pool.execute(
            'SELECT cash, xp, level FROM cfx_players WHERE id = ?',
            [req.player.id]
        );

        logger.info('[Achievements] Claimed', {
            playerId: req.player.id,
            achievementId,
            achievementName: playerAchievement.name,
            rewards
        });

        res.json({
            success: true,
            message: `Claimed rewards for "${playerAchievement.name}"!`,
            rewards,
            newCash: parseFloat(player.cash),
            newXp: player.xp,
            newLevel: player.level
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Achievements] Claim failed', { playerId: req.player.id, error: error.message });
        res.status(500).json({ error: 'Failed to claim achievement', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * Check and unlock achievements for a player
 * Called internally after actions (harvest, level up, etc.)
 */
export async function checkAchievements(playerId) {
    try {
        // Get player stats
        const [[stats]] = await pool.execute(
            `SELECT
                lifetime_sales as totalHarvests,
                level,
                cash,
                lifetime_earnings as totalEarnings
             FROM cfx_players WHERE id = ?`,
            [playerId]
        );

        // Get all achievements not yet unlocked by player
        const [lockedAchievements] = await pool.execute(
            `SELECT a.* FROM cfx_achievements a
             WHERE a.id NOT IN (
                SELECT achievement_id FROM cfx_player_achievements WHERE player_id = ?
             )`,
            [playerId]
        );

        const newlyUnlocked = [];

        for (const achievement of lockedAchievements) {
            let currentValue = 0;

            // Get requirement type and value
            const conditionType = achievement.requirement_type || 'unknown';
            const conditionValue = achievement.requirement_value || 1;

            switch (conditionType) {
                case 'harvests':
                case 'plants':
                    currentValue = stats.totalHarvests || 0;
                    break;
                case 'level':
                    currentValue = stats.level || 1;
                    break;
                case 'cash':
                    currentValue = parseFloat(stats.cash) || 0;
                    break;
                case 'earnings':
                    currentValue = parseFloat(stats.totalEarnings) || 0;
                    break;
                default:
                    continue;
            }

            if (currentValue >= conditionValue) {
                // Unlock achievement
                await pool.execute(
                    'INSERT INTO cfx_player_achievements (player_id, achievement_id) VALUES (?, ?)',
                    [playerId, achievement.id]
                );

                newlyUnlocked.push({
                    id: achievement.id,
                    name: achievement.name,
                    description: achievement.description
                });

                logger.info('[Achievements] Unlocked', {
                    playerId,
                    achievementId: achievement.id,
                    achievementName: achievement.name
                });
            }
        }

        return newlyUnlocked;

    } catch (error) {
        logger.error('[Achievements] Check failed', { playerId, error: error.message });
        return [];
    }
}

export default router;
