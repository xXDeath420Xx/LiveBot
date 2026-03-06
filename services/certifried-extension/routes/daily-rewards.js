/**
 * Daily Rewards Routes
 * Login streak tracking and daily reward claiming
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash, awardXp } from '../game/engine.js';

const router = Router();

// Daily reward tiers (7-day cycle, resets after day 7)
const REWARD_TIERS = [
    { day: 1, type: 'cash', amount: 100, label: '$100' },
    { day: 2, type: 'cash', amount: 200, label: '$200' },
    { day: 3, type: 'seeds', amount: 3, rarity: 'common', label: '3 Seeds' },
    { day: 4, type: 'cash', amount: 500, label: '$500' },
    { day: 5, type: 'xp', amount: 250, label: '250 XP' },
    { day: 6, type: 'seeds', amount: 2, rarity: 'uncommon', label: '2 Rare Seeds' },
    { day: 7, type: 'premium', amount: 1000, label: '$1000 + Mystery Box' }
];

/**
 * GET /daily-rewards/status
 * Get current streak and today's reward status
 */
router.get('/status', async (req, res) => {
    try {
        const playerId = req.player.id;
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        // Check if already claimed today
        const [[todayRecord]] = await pool.execute(
            'SELECT * FROM cfx_daily_rewards WHERE player_id = ? AND login_date = ?',
            [playerId, today]
        );

        // Get yesterday's record to determine streak
        const [[yesterdayRecord]] = await pool.execute(
            'SELECT streak_count FROM cfx_daily_rewards WHERE player_id = ? AND login_date = ?',
            [playerId, yesterday]
        );

        // Calculate current streak
        let currentStreak = 1;
        if (todayRecord) {
            currentStreak = todayRecord.streak_count;
        } else if (yesterdayRecord) {
            currentStreak = yesterdayRecord.streak_count + 1;
        }

        // Get the reward tier (1-7 cycle)
        const rewardDay = ((currentStreak - 1) % 7) + 1;
        const todayReward = REWARD_TIERS[rewardDay - 1];

        // Get highest streak ever
        const [[stats]] = await pool.execute(
            'SELECT highest_streak_achieved FROM cfx_player_stats WHERE player_id = ?',
            [playerId]
        );

        res.json({
            success: true,
            currentStreak,
            highestStreak: stats?.highest_streak_achieved || currentStreak,
            canClaim: !todayRecord || !todayRecord.reward_claimed,
            alreadyClaimed: todayRecord?.reward_claimed === 1,
            todayReward: {
                day: rewardDay,
                ...todayReward
            },
            upcomingRewards: REWARD_TIERS.map((r, i) => ({
                ...r,
                isToday: i + 1 === rewardDay,
                isClaimed: todayRecord?.reward_claimed && i + 1 === rewardDay
            }))
        });

    } catch (error) {
        logger.error('[DailyRewards] Get status failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /daily-rewards/claim
 * Claim today's daily reward
 */
router.post('/claim', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const playerId = req.player.id;
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        // Check if already claimed today
        const [[existing]] = await conn.execute(
            'SELECT * FROM cfx_daily_rewards WHERE player_id = ? AND login_date = ? FOR UPDATE',
            [playerId, today]
        );

        if (existing?.reward_claimed) {
            await conn.rollback();
            return res.status(400).json({ error: 'Already claimed today', code: 'ALREADY_CLAIMED' });
        }

        // Get yesterday's streak
        const [[yesterdayRecord]] = await conn.execute(
            'SELECT streak_count FROM cfx_daily_rewards WHERE player_id = ? AND login_date = ?',
            [playerId, yesterday]
        );

        const newStreak = yesterdayRecord ? yesterdayRecord.streak_count + 1 : 1;
        const rewardDay = ((newStreak - 1) % 7) + 1;
        const reward = REWARD_TIERS[rewardDay - 1];

        // Insert or update today's record
        if (existing) {
            await conn.execute(
                `UPDATE cfx_daily_rewards
                 SET reward_claimed = 1, streak_count = ?, reward_type = ?, reward_amount = ?
                 WHERE player_id = ? AND login_date = ?`,
                [newStreak, reward.type, reward.amount, playerId, today]
            );
        } else {
            await conn.execute(
                `INSERT INTO cfx_daily_rewards (player_id, login_date, streak_count, reward_claimed, reward_type, reward_amount)
                 VALUES (?, ?, ?, 1, ?, ?)`,
                [playerId, today, newStreak, reward.type, reward.amount]
            );
        }

        // Apply the reward
        let rewardDetails = {};

        switch (reward.type) {
            case 'cash':
            case 'premium':
                // Commit transaction before using awardCash (uses its own mutex)
                await conn.commit();
                const cashResult = await awardCash(playerId, reward.amount);
                rewardDetails.cashAwarded = cashResult.cashAwarded;
                // Re-open connection for remaining queries
                await conn.beginTransaction();
                break;

            case 'xp':
                // Commit transaction before using awardXp (uses its own mutex)
                await conn.commit();
                const xpResult = await awardXp(playerId, reward.amount);
                rewardDetails.xpAwarded = xpResult.xpAwarded;
                // Re-open connection for remaining queries
                await conn.beginTransaction();
                break;

            case 'seeds':
                // Give random seeds of the specified rarity
                const [strains] = await conn.execute(
                    'SELECT id FROM cfx_strains WHERE rarity = ? ORDER BY RAND() LIMIT ?',
                    [reward.rarity || 'common', reward.amount]
                );

                for (const strain of strains) {
                    await conn.execute(
                        `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity)
                         VALUES (?, ?, 1)
                         ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
                        [playerId, strain.id]
                    );
                }
                rewardDetails.seedsAwarded = strains.length;
                rewardDetails.strainIds = strains.map(s => s.id);
                break;
        }

        // Update player stats
        await conn.execute(
            `INSERT INTO cfx_player_stats (player_id, total_login_days, highest_streak_achieved)
             VALUES (?, 1, ?)
             ON DUPLICATE KEY UPDATE
             total_login_days = total_login_days + 1,
             highest_streak_achieved = GREATEST(highest_streak_achieved, ?),
             last_login_at = NOW()`,
            [playerId, newStreak, newStreak]
        );

        // Get updated cash
        const [[player]] = await conn.execute(
            'SELECT cash FROM cfx_players WHERE id = ?',
            [playerId]
        );

        await conn.commit();

        logger.info('[DailyRewards] Claimed', {
            playerId,
            streak: newStreak,
            rewardType: reward.type,
            rewardAmount: reward.amount
        });

        res.json({
            success: true,
            streak: newStreak,
            reward: {
                type: reward.type,
                amount: reward.amount,
                label: reward.label
            },
            details: rewardDetails,
            newCash: player?.cash
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[DailyRewards] Claim failed', { error: error.message });
        res.status(500).json({ error: 'Failed to claim reward', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

export default router;
