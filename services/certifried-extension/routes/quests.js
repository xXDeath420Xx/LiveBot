/**
 * Quests Routes
 * Daily, weekly, and milestone quests
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash, awardXp } from '../game/engine.js';
import { awardEventPoints } from './events.js';
import { trackStat } from './stats.js';
import { checkAchievements } from './achievements.js';

const router = Router();

/**
 * GET /quests
 * Get player's active quests
 */
router.get('/', async (req, res) => {
    try {
        const [quests] = await pool.execute(
            `SELECT pq.*, qd.name, qd.description, qd.quest_type, qd.objective_type,
                    qd.objective_target, qd.objective_params,
                    qd.reward_cash, qd.reward_xp, qd.reward_prestige_tokens,
                    qd.reward_strain_id, s.name as reward_strain_name
             FROM cfx_player_quests pq
             JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
             LEFT JOIN cfx_strains s ON qd.reward_strain_id = s.id
             WHERE pq.player_id = ? AND pq.status IN ('active', 'completed')
             ORDER BY qd.quest_type, pq.assigned_at`,
            [req.player.id]
        );

        res.json({
            success: true,
            quests: quests.map(q => ({
                id: q.id,
                questId: q.quest_id,
                name: q.name,
                description: q.description,
                questType: q.quest_type,
                objectiveType: q.objective_type,
                progress: q.progress,
                target: q.target || q.objective_target,
                status: q.status,
                assignedAt: q.assigned_at,
                expiresAt: q.expires_at,
                rewards: {
                    cash: parseFloat(q.reward_cash) || 0,
                    xp: q.reward_xp || 0,
                    prestigeTokens: q.reward_prestige_tokens || 0,
                    item: q.reward_strain_id ? {
                        strainId: q.reward_strain_id,
                        strainName: q.reward_strain_name,
                        quantity: 1
                    } : null
                }
            }))
        });

    } catch (error) {
        logger.error('[Quests] Get failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /quests/claim
 * Claim a completed quest reward
 */
router.post('/claim', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { questId } = req.body;

        if (!questId) {
            return res.status(400).json({ error: 'Quest ID required', code: 'NO_ID' });
        }

        await conn.beginTransaction();

        // Get quest with FOR UPDATE lock to prevent double-claim exploit
        const [[quest]] = await conn.execute(
            `SELECT pq.*, qd.reward_cash, qd.reward_xp, qd.reward_prestige_tokens,
                    qd.reward_strain_id
             FROM cfx_player_quests pq
             JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
             WHERE pq.id = ? AND pq.player_id = ? AND pq.status = 'completed'
             FOR UPDATE`,
            [questId, req.player.id]
        );

        if (!quest) {
            await conn.rollback();
            return res.status(404).json({ error: 'Quest not found or not completed', code: 'NOT_FOUND' });
        }

        // Mark as claimed immediately to prevent race conditions
        await conn.execute(
            `UPDATE cfx_player_quests SET status = 'claimed', claimed_at = NOW() WHERE id = ?`,
            [questId]
        );

        // Award prestige tokens (inside transaction)
        if (quest.reward_prestige_tokens > 0) {
            await conn.execute(
                'UPDATE cfx_players SET prestige_tokens = prestige_tokens + ? WHERE id = ?',
                [quest.reward_prestige_tokens, req.player.id]
            );
        }

        // Award items (seeds) - inside transaction
        if (quest.reward_strain_id) {
            // Add to seed inventory (quest rewards give seeds, not product)
            await conn.execute(
                `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity)
                 VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
                [req.player.id, quest.reward_strain_id]
            );

            // Also add discovery if not already discovered
            await conn.execute(
                'INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id, discovery_method) VALUES (?, ?, ?)',
                [req.player.id, quest.reward_strain_id, 'quest_reward']
            );
        }

        await conn.commit();

        // Award cash and XP using engine functions (after transaction, they manage their own locks)
        const rewards = {
            cash: 0,
            xp: 0,
            prestigeTokens: quest.reward_prestige_tokens || 0,
            items: []
        };

        if (quest.reward_cash > 0) {
            const cashResult = await awardCash(req.player.id, quest.reward_cash);
            rewards.cash = cashResult.cashAwarded;
        }

        if (quest.reward_xp > 0) {
            const xpResult = await awardXp(req.player.id, quest.reward_xp);
            rewards.xp = xpResult.xpAwarded;
            rewards.leveledUp = xpResult.leveledUp;
            rewards.newLevel = xpResult.newLevel;
        }

        if (quest.reward_strain_id) {
            rewards.items.push({
                strainId: quest.reward_strain_id,
                quantity: 1,
                type: 'seed'
            });
        }

        // Track stats, event points, and achievements
        await trackStat(req.player.id, 'total_quests_completed', 1);
        if (rewards.xp > 0) await trackStat(req.player.id, 'total_xp_earned', rewards.xp);
        if (rewards.cash > 0) await trackStat(req.player.id, 'total_cash_earned', rewards.cash);
        await awardEventPoints(req.player.id, 50); // 50 points per quest completion
        checkAchievements(req.player.id).catch(() => {});

        // Get updated player state for live UI updates
        const [[player]] = await pool.execute(
            'SELECT cash, xp, level FROM cfx_players WHERE id = ?',
            [req.player.id]
        );

        res.json({
            success: true,
            rewards,
            newCash: parseFloat(player.cash),
            newXp: player.xp,
            newLevel: player.level
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Quests] Claim failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

export default router;
