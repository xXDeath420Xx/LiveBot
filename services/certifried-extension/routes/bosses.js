/**
 * Bosses Routes
 * Challenge encounters with time-limited goals
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash, awardXp } from '../game/engine.js';

const router = Router();

/**
 * GET /bosses
 * Get available boss encounters
 */
router.get('/', async (req, res) => {
    try {
        if (!req.player?.id) {
            return res.status(401).json({ error: 'Authentication required', code: 'NO_AUTH' });
        }
        const playerId = req.player.id;

        // Get player info
        const [playerRows] = await pool.execute(`
            SELECT level FROM cfx_players WHERE id = ?
        `, [playerId]);
        const playerLevel = playerRows[0]?.level || 1;

        // Get all bosses
        const [bosses] = await pool.execute(`
            SELECT * FROM cfx_bosses WHERE is_active = TRUE ORDER BY min_level, difficulty
        `);

        // Get player's encounter history
        const [encounters] = await pool.execute(`
            SELECT * FROM cfx_boss_encounters
            WHERE player_id = ?
            ORDER BY started_at DESC
        `, [playerId]);

        // Map for quick lookup
        const encounterMap = new Map();
        for (const e of encounters) {
            if (!encounterMap.has(e.boss_id)) {
                encounterMap.set(e.boss_id, e);
            }
        }

        // Get active encounter
        const activeEncounter = encounters.find(e => e.status === 'active');

        const processedBosses = bosses.map(b => {
            const lastEncounter = encounterMap.get(b.id);
            const isUnlocked = playerLevel >= b.min_level;

            let cooldownEnds = null;
            if (lastEncounter && lastEncounter.completed_at) {
                cooldownEnds = new Date(
                    new Date(lastEncounter.completed_at).getTime() + b.cooldown_hours * 60 * 60 * 1000
                );
                if (cooldownEnds < new Date()) {
                    cooldownEnds = null;
                }
            }

            return {
                id: b.id,
                key: b.boss_key,
                name: b.name,
                description: b.description,
                difficulty: b.difficulty,
                challengeType: b.challenge_type,
                challengeGoal: b.challenge_goal,
                timeLimitMinutes: Math.floor((b.time_limit_ms || 3600000) / 60000),
                rewardCash: b.reward_cash,
                rewardXp: b.reward_xp,
                rewardItem: b.reward_item,
                minLevel: b.min_level,
                cooldownHours: b.cooldown_hours,
                icon: b.icon,
                isUnlocked,
                cooldownEnds,
                lastResult: lastEncounter ? {
                    status: lastEncounter.status,
                    score: lastEncounter.player_score,
                    completedAt: lastEncounter.completed_at
                } : null,
                canChallenge: isUnlocked && !cooldownEnds && (!activeEncounter || activeEncounter.boss_id !== b.id)
            };
        });

        res.json({
            success: true,
            bosses: processedBosses,
            activeEncounter: activeEncounter ? {
                bossId: activeEncounter.boss_id,
                bossName: bosses.find(b => b.id === activeEncounter.boss_id)?.name,
                currentScore: activeEncounter.player_score,
                endsAt: activeEncounter.ends_at,
                goal: bosses.find(b => b.id === activeEncounter.boss_id)?.challenge_goal
            } : null,
            playerLevel
        });
    } catch (error) {
        logger.error('[Bosses] Error loading:', error);
        res.status(500).json({ success: false, error: 'Failed to load bosses', code: 'ERROR' });
    }
});

/**
 * POST /bosses/:id/challenge
 * Start a boss encounter
 */
router.post('/:id/challenge', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const bossId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get boss
        const [bossRows] = await conn.execute(`
            SELECT * FROM cfx_bosses WHERE id = ? AND is_active = TRUE
        `, [bossId]);

        if (bossRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Boss not found' });
        }

        const boss = bossRows[0];

        // Check player level
        const [playerRows] = await conn.execute(`
            SELECT level FROM cfx_players WHERE id = ?
        `, [playerId]);

        if (playerRows[0].level < boss.min_level) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Requires level ${boss.min_level}`
            });
        }

        // Check for active encounter
        const [activeRows] = await conn.execute(`
            SELECT id FROM cfx_boss_encounters WHERE player_id = ? AND status = 'active'
        `, [playerId]);

        if (activeRows.length > 0) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: 'Already in a boss encounter'
            });
        }

        // Check cooldown
        const [lastEncounter] = await conn.execute(`
            SELECT completed_at FROM cfx_boss_encounters
            WHERE player_id = ? AND boss_id = ? AND status IN ('victory', 'defeat')
            ORDER BY completed_at DESC LIMIT 1
        `, [playerId, bossId]);

        if (lastEncounter.length > 0 && lastEncounter[0].completed_at) {
            const cooldownEnds = new Date(
                new Date(lastEncounter[0].completed_at).getTime() + boss.cooldown_hours * 60 * 60 * 1000
            );
            if (cooldownEnds > new Date()) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    error: 'On cooldown',
                    cooldownEnds
                });
            }
        }

        // Start encounter
        const endsAt = new Date(Date.now() + (boss.time_limit_ms || 3600000));

        await conn.execute(`
            INSERT INTO cfx_boss_encounters (player_id, boss_id, ends_at)
            VALUES (?, ?, ?)
        `, [playerId, bossId, endsAt]);

        await conn.commit();

        res.json({
            success: true,
            message: `Challenge started: ${boss.name}!`,
            encounter: {
                bossId: boss.id,
                bossName: boss.name,
                challengeType: boss.challenge_type,
                challengeGoal: boss.challenge_goal,
                endsAt
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Bosses] Error challenging:', error);
        res.status(500).json({ success: false, error: 'Failed to start challenge', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /bosses/update-score
 * Update active encounter score (called by game actions)
 */
router.post('/update-score', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { scoreType, amount } = req.body;

        // Validate amount to prevent score manipulation
        if (typeof amount !== 'number' || amount < 0 || amount > 100 || !Number.isFinite(amount)) {
            conn.release();
            return res.status(400).json({ error: 'Invalid score amount', code: 'INVALID_AMOUNT' });
        }

        await conn.beginTransaction();

        // Get active encounter with FOR UPDATE lock to prevent race conditions
        const [encounterRows] = await conn.execute(`
            SELECT be.*, b.challenge_type, b.challenge_goal
            FROM cfx_boss_encounters be
            JOIN cfx_bosses b ON be.boss_id = b.id
            WHERE be.player_id = ? AND be.status = 'active' AND be.ends_at > NOW()
            FOR UPDATE
        `, [playerId]);

        if (encounterRows.length === 0) {
            await conn.rollback();
            return res.json({ success: true, message: 'No active encounter' });
        }

        const encounter = encounterRows[0];

        // Only update if score type matches challenge type
        if (encounter.challenge_type !== scoreType) {
            await conn.rollback();
            return res.json({ success: true, message: 'Score type mismatch' });
        }

        const newScore = encounter.player_score + amount;

        // Update score
        await conn.execute(`
            UPDATE cfx_boss_encounters SET player_score = ? WHERE id = ?
        `, [newScore, encounter.id]);

        // Check for victory
        if (newScore >= encounter.challenge_goal) {
            await conn.execute(`
                UPDATE cfx_boss_encounters SET status = 'victory', completed_at = NOW() WHERE id = ?
            `, [encounter.id]);

            await conn.commit();

            return res.json({
                success: true,
                victory: true,
                message: 'Challenge completed!',
                newScore
            });
        }

        await conn.commit();

        res.json({
            success: true,
            newScore,
            goal: encounter.challenge_goal,
            progress: Math.round((newScore / encounter.challenge_goal) * 100)
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Bosses] Error updating score:', error);
        res.status(500).json({ success: false, error: 'Failed to update score', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /bosses/:id/claim
 * Claim boss rewards
 */
router.post('/:id/claim', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const bossId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get encounter with FOR UPDATE lock to prevent double-claim exploit
        const [encounterRows] = await conn.execute(`
            SELECT be.*, b.reward_cash, b.reward_xp, b.reward_item, b.name
            FROM cfx_boss_encounters be
            JOIN cfx_bosses b ON be.boss_id = b.id
            WHERE be.player_id = ? AND be.boss_id = ? AND be.status = 'victory' AND be.reward_claimed = FALSE
            FOR UPDATE
        `, [playerId, bossId]);

        if (encounterRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'No claimable reward' });
        }

        const encounter = encounterRows[0];

        // Mark as claimed
        await conn.execute(`
            UPDATE cfx_boss_encounters SET reward_claimed = TRUE WHERE id = ?
        `, [encounter.id]);

        await conn.commit();

        // Give rewards using proper engine functions (after transaction)
        const cashResult = await awardCash(playerId, parseFloat(encounter.reward_cash));
        const xpResult = await awardXp(playerId, encounter.reward_xp);

        res.json({
            success: true,
            message: `Victory! Claimed $${cashResult.cashAwarded.toLocaleString()} and ${xpResult.xpAwarded} XP`,
            rewards: {
                cash: cashResult.cashAwarded,
                xp: xpResult.xpAwarded,
                item: encounter.reward_item
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Bosses] Error claiming:', error);
        res.status(500).json({ success: false, error: 'Failed to claim reward', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /bosses/abandon
 * Abandon active encounter
 */
router.post('/abandon', async (req, res) => {
    try {
        const playerId = req.player.id;

        const result = await pool.execute(`
            UPDATE cfx_boss_encounters
            SET status = 'abandoned', completed_at = NOW()
            WHERE player_id = ? AND status = 'active'
        `, [playerId]);

        if (result[0].affectedRows === 0) {
            return res.status(400).json({ success: false, error: 'No active encounter' });
        }

        res.json({
            success: true,
            message: 'Challenge abandoned'
        });
    } catch (error) {
        logger.error('[Bosses] Error abandoning:', error);
        res.status(500).json({ success: false, error: 'Failed to abandon', code: 'ERROR' });
    }
});

export default router;
