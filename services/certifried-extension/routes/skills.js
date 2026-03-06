/**
 * Skills Routes
 * Skill tree management
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getBonuses, invalidateBonusCache } from '../game/bonus-resolver.js';
import { deductCash } from '../game/engine.js';

const router = Router();

/**
 * GET /skills/tree
 * Get full skill tree with player progress
 */
router.get('/tree', async (req, res) => {
    try {
        // Get all skill nodes
        const [nodes] = await pool.execute(
            'SELECT * FROM cfx_skill_nodes ORDER BY category, tree_y, tree_x'
        );

        // Get player's unlocked skills
        const [unlocked] = await pool.execute(
            'SELECT skill_id, current_rank FROM cfx_player_skills WHERE player_id = ?',
            [req.player.id]
        );

        const unlockedMap = new Map(unlocked.map(u => [u.skill_id, u.current_rank]));

        // Get player's current skill points and cash
        const [[player]] = await pool.execute(
            'SELECT skill_points, cash FROM cfx_players WHERE id = ?',
            [req.player.id]
        );

        res.json({
            success: true,
            playerLevel: req.player.level,
            playerCash: parseFloat(player?.cash || 0),
            skillPoints: player?.skill_points || 0,
            nodes: nodes.map(n => {
                // Handle both old and new column names for backwards compatibility
                const requiredLevel = n.required_level ?? n.requires_level ?? 1;
                // Safe cost calculation - avoid NaN from undefined cost_per_rank
                const perRankCost = typeof n.cost_per_rank === 'number' ? n.cost_per_rank * 500 : 500;
                const costCash = n.cost_cash ?? perRankCost;
                let prereqs = [];
                if (n.prerequisites) {
                    try {
                        prereqs = typeof n.prerequisites === 'string'
                            ? JSON.parse(n.prerequisites)
                            : n.prerequisites;
                    } catch (e) {
                        prereqs = [];
                    }
                }

                return {
                    id: n.id,
                    skillKey: n.skill_key,
                    name: n.name,
                    description: n.description,
                    category: n.category,
                    treeX: n.tree_x,
                    treeY: n.tree_y,
                    requiredLevel,
                    costCash,
                    maxRank: n.max_rank,
                    effectType: n.effect_type,
                    effectValuePerRank: parseFloat(n.effect_value_per_rank),
                    prerequisites: prereqs,
                    icon: n.icon || null,
                    currentRank: unlockedMap.get(n.id) || 0,
                    isUnlocked: unlockedMap.has(n.id),
                    canUnlock: req.player.level >= requiredLevel
                };
            })
        });

    } catch (error) {
        logger.error('[Skills] Get tree failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /skills/unlock
 * Unlock or upgrade a skill
 */
router.post('/unlock', async (req, res) => {
    try {
        const { skillId } = req.body;

        if (!skillId) {
            return res.status(400).json({ error: 'Skill ID required', code: 'NO_ID' });
        }

        // Get skill node
        const [[skill]] = await pool.execute(
            'SELECT * FROM cfx_skill_nodes WHERE id = ?',
            [skillId]
        );

        if (!skill) {
            return res.status(404).json({ error: 'Skill not found', code: 'NOT_FOUND' });
        }

        // Handle both old and new column names
        const requiredLevel = skill.required_level ?? skill.requires_level ?? 1;
        // Safe cost calculation - avoid NaN from undefined cost_per_rank
        const perRankCost = typeof skill.cost_per_rank === 'number' ? skill.cost_per_rank * 500 : 500;
        const costCash = skill.cost_cash ?? perRankCost;

        // Check level requirement
        if (req.player.level < requiredLevel) {
            return res.status(400).json({
                error: `Requires level ${requiredLevel}`,
                code: 'LEVEL_REQUIRED'
            });
        }

        // Check current rank
        const [[current]] = await pool.execute(
            'SELECT current_rank FROM cfx_player_skills WHERE player_id = ? AND skill_id = ?',
            [req.player.id, skillId]
        );

        const currentRank = current ? current.current_rank : 0;

        if (currentRank >= skill.max_rank) {
            return res.status(400).json({ error: 'Already at max rank', code: 'MAX_RANK' });
        }

        // Check prerequisites
        let prereqs = [];
        if (skill.prerequisites) {
            try {
                prereqs = typeof skill.prerequisites === 'string'
                    ? JSON.parse(skill.prerequisites)
                    : skill.prerequisites;
            } catch (e) {
                prereqs = [];
            }
        }

        if (prereqs.length > 0) {
            for (const prereqKey of prereqs) {
                const [[prereqSkill]] = await pool.execute(
                    'SELECT id FROM cfx_skill_nodes WHERE skill_key = ?',
                    [prereqKey]
                );

                if (!prereqSkill) continue;

                const [[prereqUnlocked]] = await pool.execute(
                    'SELECT current_rank FROM cfx_player_skills WHERE player_id = ? AND skill_id = ?',
                    [req.player.id, prereqSkill.id]
                );

                if (!prereqUnlocked || prereqUnlocked.current_rank === 0) {
                    return res.status(400).json({
                        error: `Prerequisite skill not unlocked`,
                        code: 'PREREQ_MISSING',
                        missing: prereqKey
                    });
                }
            }
        }

        // Also check requires_skill_id (old schema) if no prerequisites JSON
        if (prereqs.length === 0 && skill.requires_skill_id) {
            const [[prereqUnlocked]] = await pool.execute(
                'SELECT current_rank FROM cfx_player_skills WHERE player_id = ? AND skill_id = ?',
                [req.player.id, skill.requires_skill_id]
            );

            if (!prereqUnlocked || prereqUnlocked.current_rank === 0) {
                const [[prereqSkill]] = await pool.execute(
                    'SELECT name FROM cfx_skill_nodes WHERE id = ?',
                    [skill.requires_skill_id]
                );
                return res.status(400).json({
                    error: `Prerequisite skill not unlocked`,
                    code: 'PREREQ_MISSING',
                    missing: prereqSkill?.name || 'required skill'
                });
            }
        }

        // Calculate cost (scales with rank)
        const rankMultiplier = Math.pow(1.5, currentRank);
        const cost = Math.floor(costCash * rankMultiplier);

        // Deduct cash
        const cashResult = await deductCash(req.player.id, cost);

        if (!cashResult.success) {
            return res.status(400).json({
                error: `Insufficient funds (need $${cost.toLocaleString()})`,
                code: 'INSUFFICIENT_CASH'
            });
        }

        // Unlock or upgrade skill
        if (currentRank === 0) {
            await pool.execute(
                'INSERT INTO cfx_player_skills (player_id, skill_id, current_rank) VALUES (?, ?, 1)',
                [req.player.id, skillId]
            );
        } else {
            await pool.execute(
                'UPDATE cfx_player_skills SET current_rank = current_rank + 1 WHERE player_id = ? AND skill_id = ?',
                [req.player.id, skillId]
            );
        }

        const newRank = currentRank + 1;

        // Invalidate bonus cache since skills changed
        invalidateBonusCache(req.player.id);

        res.json({
            success: true,
            skillId,
            skillName: skill.name,
            newRank,
            maxRank: skill.max_rank,
            costPaid: cost,
            newCash: cashResult.newCash,
            effectValue: (parseFloat(skill.effect_value_per_rank) || 0) * newRank
        });

    } catch (error) {
        logger.error('[Skills] Unlock failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /skills/bonuses
 * Get current active bonuses from all sources
 */
router.get('/bonuses', async (req, res) => {
    try {
        const bonuses = await getBonuses(req.player.id);

        res.json({
            success: true,
            bonuses
        });

    } catch (error) {
        logger.error('[Skills] Get bonuses failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
