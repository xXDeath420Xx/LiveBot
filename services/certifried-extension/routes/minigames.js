/**
 * Minigames Routes
 * Skill-based mini-games for rewards
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash, awardXp } from '../game/engine.js';

const router = Router();

/**
 * GET /minigames
 * Get all minigames with player stats
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get player level
        const [playerRows] = await pool.execute(`
            SELECT level FROM cfx_players WHERE id = ?
        `, [playerId]);
        const playerLevel = playerRows[0]?.level || 1;

        // Get all minigames with player stats
        const [minigames] = await pool.execute(`
            SELECT
                m.*,
                pm.high_score,
                pm.play_count,
                pm.total_rewards,
                pm.last_played_at
            FROM cfx_minigames m
            LEFT JOIN cfx_player_minigames pm ON m.id = pm.minigame_id AND pm.player_id = ?
            WHERE m.is_active = TRUE
            ORDER BY m.min_level, m.name
        `, [playerId]);

        const processedGames = minigames.map(g => {
            const isUnlocked = playerLevel >= g.min_level;
            const cooldownEnds = g.last_played_at
                ? new Date(new Date(g.last_played_at).getTime() + g.cooldown_minutes * 60 * 1000)
                : null;
            const isOnCooldown = cooldownEnds && cooldownEnds > new Date();

            return {
                id: g.id,
                key: g.minigame_key,
                name: g.name,
                description: g.description,
                instructions: g.instructions,
                rewardType: g.reward_type,
                baseRewardValue: g.base_reward_value,
                maxScore: g.max_score,
                cooldownMinutes: g.cooldown_minutes,
                minLevel: g.min_level,
                icon: g.icon,
                isUnlocked,
                highScore: g.high_score || 0,
                playCount: g.play_count || 0,
                totalRewards: g.total_rewards || 0,
                lastPlayedAt: g.last_played_at,
                cooldownEnds: isOnCooldown ? cooldownEnds : null,
                canPlay: isUnlocked && !isOnCooldown
            };
        });

        res.json({
            success: true,
            minigames: processedGames,
            playerLevel
        });
    } catch (error) {
        logger.error('[Minigames] Error loading:', error);
        res.status(500).json({ success: false, error: 'Failed to load minigames' });
    }
});

/**
 * POST /minigames/:key/start
 * Start a minigame session
 */
router.post('/:key/start', async (req, res) => {
    try {
        const playerId = req.player.id;
        const minigameKey = req.params.key;

        // Get minigame
        const [gameRows] = await pool.execute(`
            SELECT * FROM cfx_minigames WHERE minigame_key = ? AND is_active = TRUE
        `, [minigameKey]);

        if (gameRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Minigame not found' });
        }

        const game = gameRows[0];

        // Check level
        const [playerRows] = await pool.execute(`
            SELECT level FROM cfx_players WHERE id = ?
        `, [playerId]);

        if (playerRows[0].level < game.min_level) {
            return res.status(400).json({
                success: false,
                error: `Requires level ${game.min_level}`
            });
        }

        // Check cooldown
        const [statsRows] = await pool.execute(`
            SELECT last_played_at FROM cfx_player_minigames
            WHERE player_id = ? AND minigame_id = ?
        `, [playerId, game.id]);

        if (statsRows.length > 0 && statsRows[0].last_played_at) {
            const cooldownEnds = new Date(
                new Date(statsRows[0].last_played_at).getTime() + game.cooldown_minutes * 60 * 1000
            );
            if (cooldownEnds > new Date()) {
                return res.status(400).json({
                    success: false,
                    error: 'On cooldown',
                    cooldownEnds
                });
            }
        }

        // Generate session token (simple implementation)
        const sessionToken = `${playerId}-${game.id}-${Date.now()}`;

        res.json({
            success: true,
            game: {
                id: game.id,
                key: game.minigame_key,
                name: game.name,
                instructions: game.instructions,
                maxScore: game.max_score,
                rewardType: game.reward_type,
                baseRewardValue: game.base_reward_value
            },
            sessionToken
        });
    } catch (error) {
        logger.error('[Minigames] Error starting:', error);
        res.status(500).json({ success: false, error: 'Failed to start minigame' });
    }
});

/**
 * POST /minigames/:key/submit
 * Submit minigame score
 */
router.post('/:key/submit', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const minigameKey = req.params.key;
        const { score, sessionToken } = req.body;

        if (typeof score !== 'number' || score < 0 || !Number.isFinite(score)) {
            return res.status(400).json({ success: false, error: 'Invalid score' });
        }

        await conn.beginTransaction();

        // Get minigame
        const [gameRows] = await conn.execute(`
            SELECT * FROM cfx_minigames WHERE minigame_key = ? AND is_active = TRUE
        `, [minigameKey]);

        if (gameRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Minigame not found' });
        }

        const game = gameRows[0];

        // Clamp score to max
        const clampedScore = Math.min(score, game.max_score);

        // Calculate reward based on score percentage
        const scorePercent = clampedScore / game.max_score;
        let rewardValue = Math.floor(game.base_reward_value * scorePercent);

        // Get current high score
        const [statsRows] = await conn.execute(`
            SELECT * FROM cfx_player_minigames WHERE player_id = ? AND minigame_id = ?
        `, [playerId, game.id]);

        const currentHighScore = statsRows[0]?.high_score || 0;
        const isNewHighScore = clampedScore > currentHighScore;

        // Bonus for new high score
        if (isNewHighScore) {
            rewardValue = Math.floor(rewardValue * 1.5);
        }

        // Commit the transaction before awarding cash/xp (awardCash/awardXp use their own mutex)
        await conn.commit();

        // Apply reward using proper engine functions for bonus application
        let rewardMessage = '';
        let actualReward = rewardValue;
        switch (game.reward_type) {
            case 'cash':
                const cashResult = await awardCash(playerId, rewardValue);
                actualReward = cashResult.cashAwarded;
                rewardMessage = `+$${actualReward.toLocaleString()}`;
                break;

            case 'xp':
                const xpResult = await awardXp(playerId, rewardValue);
                actualReward = xpResult.xpAwarded;
                rewardMessage = `+${actualReward} XP`;
                break;

            case 'quality_boost':
                // Quality boost applies to next harvest
                // Store in player settings or a separate table
                rewardMessage = `+${rewardValue} quality boost to next harvest`;
                break;
        }

        // Update player minigame stats (in a separate query since transaction already committed)
        await pool.execute(`
            INSERT INTO cfx_player_minigames (player_id, minigame_id, high_score, play_count, total_rewards, last_played_at)
            VALUES (?, ?, ?, 1, ?, NOW())
            ON DUPLICATE KEY UPDATE
                high_score = GREATEST(high_score, ?),
                play_count = play_count + 1,
                total_rewards = total_rewards + ?,
                last_played_at = NOW()
        `, [playerId, game.id, clampedScore, actualReward, clampedScore, actualReward]);

        res.json({
            success: true,
            message: isNewHighScore ? `New High Score! ${rewardMessage}` : rewardMessage,
            score: clampedScore,
            isNewHighScore,
            previousHighScore: currentHighScore,
            reward: {
                type: game.reward_type,
                value: actualReward
            }
        });
        return; // Early return since we committed successfully
    } catch (error) {
        try { await conn.rollback(); } catch (e) { /* already committed or errored */ }
        logger.error('[Minigames] Error submitting:', error);
        res.status(500).json({ success: false, error: 'Failed to submit score' });
    } finally {
        conn.release();
    }
});

/**
 * GET /minigames/:key/leaderboard
 * Get minigame leaderboard
 */
router.get('/:key/leaderboard', async (req, res) => {
    try {
        const minigameKey = req.params.key;

        const [rows] = await pool.execute(`
            SELECT pm.high_score, pm.play_count, p.display_name, p.level
            FROM cfx_player_minigames pm
            JOIN cfx_players p ON pm.player_id = p.id
            JOIN cfx_minigames m ON pm.minigame_id = m.id
            WHERE m.minigame_key = ?
            ORDER BY pm.high_score DESC
            LIMIT 50
        `, [minigameKey]);

        res.json({
            success: true,
            leaderboard: rows.map((r, idx) => ({
                rank: idx + 1,
                displayName: r.display_name,
                level: r.level,
                highScore: r.high_score,
                playCount: r.play_count
            }))
        });
    } catch (error) {
        logger.error('[Minigames] Error loading leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
    }
});

export default router;
