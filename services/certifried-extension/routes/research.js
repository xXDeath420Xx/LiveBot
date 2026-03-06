/**
 * Research Routes
 * Tech tree progression system
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { hasResearch, getResearchBonuses } from '../game/research-helper.js';
import { getWorkerBonuses } from './workers-enhanced.js';

const router = Router();

/**
 * GET /research/tree
 * Get full research tree with player progress
 */
router.get('/tree', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get all research nodes
        const [nodes] = await pool.execute(`
            SELECT
                rn.*,
                pr.status,
                pr.started_at,
                pr.completes_at,
                pr.completed_at
            FROM cfx_research_nodes rn
            LEFT JOIN cfx_player_research pr ON rn.id = pr.research_id AND pr.player_id = ?
            WHERE rn.is_active = TRUE
            ORDER BY rn.category, rn.tier, rn.name
        `, [playerId]);

        // Get player stats for requirements checking
        const [playerRows] = await pool.execute(`
            SELECT cash, xp, level FROM cfx_players WHERE id = ?
        `, [playerId]);
        const player = playerRows[0] || { cash: 0, xp: 0, level: 1 };

        // Get completed research keys for prerequisite checking
        const completedKeys = new Set(
            nodes.filter(n => n.status === 'completed').map(n => n.research_key)
        );

        // Process nodes with availability
        const processedNodes = nodes.map(node => {
            let prerequisites = [];
            try {
                prerequisites = node.prerequisites ? JSON.parse(node.prerequisites) : [];
            } catch (e) {
                prerequisites = [];
            }

            const prereqsMet = prerequisites.every(key => completedKeys.has(key));
            const canAfford = player.cash >= node.cost_cash && player.xp >= node.cost_xp;

            let status = node.status || 'locked';
            if (!status || status === 'locked') {
                if (prereqsMet) {
                    status = 'available';
                }
            }

            return {
                id: node.id,
                key: node.research_key,
                name: node.name,
                description: node.description,
                category: node.category,
                tier: node.tier,
                costCash: node.cost_cash,
                costXp: node.cost_xp,
                researchTimeHours: node.research_time_hours,
                prerequisites,
                prereqsMet,
                canAfford,
                unlockType: node.unlock_type,
                unlockKey: node.unlock_key,
                unlockValue: parseFloat(node.unlock_value) || 0,
                icon: node.icon,
                status,
                startedAt: node.started_at,
                completesAt: node.completes_at,
                completedAt: node.completed_at
            };
        });

        // Group by category
        const byCategory = {
            cultivation: [],
            processing: [],
            business: [],
            expansion: []
        };

        for (const node of processedNodes) {
            if (byCategory[node.category]) {
                byCategory[node.category].push(node);
            }
        }

        // Calculate stats
        const totalNodes = processedNodes.length;
        const completedNodes = processedNodes.filter(n => n.status === 'completed').length;
        const inProgress = processedNodes.find(n => n.status === 'researching');

        res.json({
            success: true,
            tree: byCategory,
            allNodes: processedNodes,
            stats: {
                total: totalNodes,
                completed: completedNodes,
                completion: totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0
            },
            inProgress: inProgress ? {
                id: inProgress.id,
                name: inProgress.name,
                completesAt: inProgress.completesAt
            } : null,
            player: {
                cash: player.cash,
                xp: player.xp,
                level: player.level
            }
        });
    } catch (error) {
        logger.error('[Research] Error loading tree:', error);
        res.status(500).json({ success: false, error: 'Failed to load research tree' });
    }
});

/**
 * POST /research/start
 * Start researching a node
 */
router.post('/start', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { researchId } = req.body;

        if (!researchId) {
            return res.status(400).json({ success: false, error: 'Research ID required' });
        }

        await conn.beginTransaction();

        // Check if already researching something
        const [existing] = await conn.execute(`
            SELECT pr.id, rn.name FROM cfx_player_research pr
            JOIN cfx_research_nodes rn ON pr.research_id = rn.id
            WHERE pr.player_id = ? AND pr.status = 'researching'
        `, [playerId]);

        if (existing.length > 0) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Already researching "${existing[0].name}"`
            });
        }

        // Get research node
        const [nodeRows] = await conn.execute(`
            SELECT * FROM cfx_research_nodes WHERE id = ? AND is_active = TRUE
        `, [researchId]);

        if (nodeRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Research not found' });
        }

        const node = nodeRows[0];

        // Check prerequisites
        let prerequisites = [];
        try {
            prerequisites = node.prerequisites ? JSON.parse(node.prerequisites) : [];
        } catch (e) {
            prerequisites = [];
        }

        if (prerequisites.length > 0) {
            const placeholders = prerequisites.map(() => '?').join(',');
            const [completed] = await conn.execute(`
                SELECT rn.research_key FROM cfx_player_research pr
                JOIN cfx_research_nodes rn ON pr.research_id = rn.id
                WHERE pr.player_id = ? AND pr.status = 'completed'
                AND rn.research_key IN (${placeholders})
            `, [playerId, ...prerequisites]);

            if (completed.length < prerequisites.length) {
                await conn.rollback();
                return res.status(400).json({ success: false, error: 'Prerequisites not met' });
            }
        }

        // Check player resources
        const [playerRows] = await conn.execute(`
            SELECT cash, xp FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        if (playerRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Player not found' });
        }

        const player = playerRows[0];

        if (player.cash < node.cost_cash) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        if (player.xp < node.cost_xp) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough XP' });
        }

        // Deduct costs
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ?, xp = xp - ? WHERE id = ?
        `, [node.cost_cash, node.cost_xp, playerId]);

        // Get Research Assistant speed bonus directly (avoid circular dependency with bonus-resolver)
        const workerBonuses = await getWorkerBonuses(playerId);
        const researchSpeedMultiplier = 1 + (workerBonuses.researchSpeed || 0);

        // Calculate completion time (reduced by research speed bonus)
        const baseTimeMs = node.research_time_hours * 60 * 60 * 1000;
        const actualTimeMs = baseTimeMs / researchSpeedMultiplier;
        const completesAt = new Date(Date.now() + actualTimeMs);

        // Create or update research record
        await conn.execute(`
            INSERT INTO cfx_player_research (player_id, research_id, status, started_at, completes_at)
            VALUES (?, ?, 'researching', NOW(), ?)
            ON DUPLICATE KEY UPDATE status = 'researching', started_at = NOW(), completes_at = ?
        `, [playerId, researchId, completesAt, completesAt]);

        await conn.commit();

        res.json({
            success: true,
            message: `Started researching "${node.name}"`,
            research: {
                id: node.id,
                name: node.name,
                completesAt,
                baseTimeHours: node.research_time_hours,
                actualTimeHours: actualTimeMs / (60 * 60 * 1000),
                speedBonus: researchSpeedMultiplier > 1 ? researchSpeedMultiplier : null
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Research] Error starting research:', error);
        res.status(500).json({ success: false, error: 'Failed to start research' });
    } finally {
        conn.release();
    }
});

/**
 * POST /research/claim
 * Claim completed research
 */
router.post('/claim', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { researchId } = req.body;

        if (!researchId) {
            return res.status(400).json({ success: false, error: 'Research ID required' });
        }

        await conn.beginTransaction();

        // Get research status
        const [researchRows] = await conn.execute(`
            SELECT pr.*, rn.name, rn.unlock_type, rn.unlock_key, rn.unlock_value
            FROM cfx_player_research pr
            JOIN cfx_research_nodes rn ON pr.research_id = rn.id
            WHERE pr.player_id = ? AND pr.research_id = ? AND pr.status = 'researching'
        `, [playerId, researchId]);

        if (researchRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Research not in progress' });
        }

        const research = researchRows[0];

        // Check if completed
        if (new Date(research.completes_at) > new Date()) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Research not yet complete' });
        }

        // Mark as completed
        await conn.execute(`
            UPDATE cfx_player_research
            SET status = 'completed', completed_at = NOW()
            WHERE player_id = ? AND research_id = ?
        `, [playerId, researchId]);

        // Apply unlock effects based on type
        let unlockMessage = '';
        switch (research.unlock_type) {
            case 'bonus':
                // Bonuses are applied dynamically via getBonuses()
                unlockMessage = `Unlocked ${research.unlock_key} bonus: +${Math.round(research.unlock_value * 100)}%`;
                break;
            case 'feature':
                unlockMessage = `Unlocked feature: ${research.unlock_key}`;
                break;
            case 'equipment':
                unlockMessage = `New equipment available: ${research.unlock_key}`;
                break;
            case 'recipe':
                unlockMessage = `New recipe unlocked: ${research.unlock_key}`;
                break;
            case 'location':
                unlockMessage = `New location available: ${research.unlock_key}`;
                break;
        }

        await conn.commit();

        res.json({
            success: true,
            message: `Completed research: "${research.name}"`,
            unlock: unlockMessage,
            research: {
                id: researchId,
                name: research.name,
                unlockType: research.unlock_type,
                unlockKey: research.unlock_key,
                unlockValue: parseFloat(research.unlock_value) || 0
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Research] Error claiming research:', error);
        res.status(500).json({ success: false, error: 'Failed to claim research' });
    } finally {
        conn.release();
    }
});

/**
 * POST /research/cancel
 * Cancel in-progress research (refunds 50%)
 */
router.post('/cancel', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { researchId } = req.body;

        if (!researchId) {
            return res.status(400).json({ success: false, error: 'Research ID required' });
        }

        await conn.beginTransaction();

        // Get research in progress
        const [researchRows] = await conn.execute(`
            SELECT pr.*, rn.name, rn.cost_cash, rn.cost_xp
            FROM cfx_player_research pr
            JOIN cfx_research_nodes rn ON pr.research_id = rn.id
            WHERE pr.player_id = ? AND pr.research_id = ? AND pr.status = 'researching'
        `, [playerId, researchId]);

        if (researchRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'No research in progress' });
        }

        const research = researchRows[0];

        // Refund 50%
        const refundCash = Math.floor(research.cost_cash / 2);
        const refundXp = Math.floor(research.cost_xp / 2);

        await conn.execute(`
            UPDATE cfx_players SET cash = cash + ?, xp = xp + ? WHERE id = ?
        `, [refundCash, refundXp, playerId]);

        // Reset research status
        await conn.execute(`
            UPDATE cfx_player_research
            SET status = 'available', started_at = NULL, completes_at = NULL
            WHERE player_id = ? AND research_id = ?
        `, [playerId, researchId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Cancelled "${research.name}". Refunded $${refundCash.toLocaleString()} and ${refundXp} XP`,
            refund: {
                cash: refundCash,
                xp: refundXp
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Research] Error cancelling research:', error);
        res.status(500).json({ success: false, error: 'Failed to cancel research' });
    } finally {
        conn.release();
    }
});

// Re-export helper functions for backwards compatibility
export { hasResearch, getResearchBonuses };

export default router;
