/**
 * Breeding Routes
 * Strain crossbreeding and genetics
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { startBreeding, claimBreeding, previewBreeding } from '../game/breeding-engine.js';
import { awardXp } from '../game/engine.js';
import { validate, schemas } from '../middleware/validate.js';
import { breedCooldown } from '../middleware/rate-limit.js';
import { awardEventPoints } from './events.js';
import { trackStat } from './stats.js';
import { checkAchievements } from './achievements.js';
import { addHeat } from '../game/raid-system.js';
import { awardReputation } from './reputation.js';
import { updateTournamentScore } from './tournaments.js';

const router = Router();

/**
 * GET /breed/operations
 * Get active breeding operations
 */
router.get('/operations', async (req, res) => {
    try {
        const [operations] = await pool.execute(
            `SELECT bo.*, s1.name as parent1_name, s1.rarity as parent1_rarity,
                    s2.name as parent2_name, s2.rarity as parent2_rarity,
                    sr.name as result_name, sr.rarity as result_rarity
             FROM cfx_breeding_operations bo
             JOIN cfx_strains s1 ON bo.parent_1_strain_id = s1.id
             JOIN cfx_strains s2 ON bo.parent_2_strain_id = s2.id
             LEFT JOIN cfx_strains sr ON bo.result_strain_id = sr.id
             WHERE bo.player_id = ? AND bo.status IN ('breeding', 'ready')
             ORDER BY bo.started_at DESC`,
            [req.player.id]
        );

        const now = Date.now();

        res.json({
            success: true,
            operations: operations.map(o => {
                // Calculate duration from timestamps if duration_ms column doesn't exist
                const startedAt = new Date(o.started_at).getTime();
                const readyAt = new Date(o.ready_at).getTime();
                const durationMs = o.duration_ms || (readyAt - startedAt);

                return {
                    id: o.id,
                    parent1: { id: o.parent_1_strain_id, name: o.parent1_name, rarity: o.parent1_rarity },
                    parent2: { id: o.parent_2_strain_id, name: o.parent2_name, rarity: o.parent2_rarity },
                    status: o.status,
                    startedAt: o.started_at,
                    durationMs,
                    readyAt: o.ready_at,
                    progress: o.status === 'breeding'
                        ? Math.min(100, ((now - startedAt) / durationMs) * 100)
                        : 100,
                    result: o.result_strain_id ? {
                        id: o.result_strain_id,
                        name: o.result_name,
                        rarity: o.result_rarity,
                        isNew: (o.result_is_new || o.is_new_strain) === 1,
                        mutationOccurred: (o.mutation_occurred || 0) === 1
                    } : null
                };
            }),
            serverTime: now
        });

    } catch (error) {
        logger.error('[Breeding] Get operations failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /breed/start
 * Start a breeding operation
 */
router.post('/start', breedCooldown, validate(schemas.breed), async (req, res) => {
    try {
        const { parent1StrainId, parent2StrainId } = req.body;

        logger.info('[Breeding] Start attempt', {
            playerId: req.player.id,
            parent1StrainId,
            parent2StrainId
        });

        const result = await startBreeding(req.player.id, parent1StrainId, parent2StrainId);

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('[Breeding] Start failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found') || error.message.includes('not unlocked') ||
            error.message.includes('Maximum') || error.message.includes('discover') ||
            error.message.includes('skill required') || error.message.includes('seed') ||
            error.message.includes('Need at least') || error.message.includes('Legendary')) {
            return res.status(400).json({ error: error.message, code: 'BREED_ERROR' });
        }

        res.status(500).json({ error: error.message || 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /breed/claim
 * Claim a completed breeding operation
 */
router.post('/claim', async (req, res) => {
    try {
        const { operationId } = req.body;

        if (!operationId) {
            return res.status(400).json({ error: 'Operation ID required', code: 'NO_ID' });
        }

        const result = await claimBreeding(req.player.id, operationId);

        // Award XP based on rarity and whether it's new
        const rarityXp = { common: 50, uncommon: 100, rare: 250, epic: 500, legendary: 1000 };
        let xp = rarityXp[result.resultStrain.rarity] || 50;
        if (result.isNewStrain) xp *= 3; // Triple XP for new discoveries
        if (result.mutationOccurred) xp *= 1.5; // 50% bonus for mutations

        const xpResult = await awardXp(req.player.id, Math.floor(xp));

        // Track stats, event points, and achievements
        await trackStat(req.player.id, 'total_breeding_attempts', 1);
        await trackStat(req.player.id, 'total_breeding_successes', 1);
        await trackStat(req.player.id, 'total_xp_earned', Math.floor(xp));
        if (result.isNewStrain) {
            await trackStat(req.player.id, 'total_strains_discovered', 1);
        }
        await awardEventPoints(req.player.id, 25); // 25 points per breeding claim
        checkAchievements(req.player.id).catch(() => {}); // Fire and forget

        // Add heat for raid system (4 heat for breeding - genetics work draws attention)
        await addHeat(req.player.id, 4, 'breeding');

        // Award reputation and update tournament scores (fire-and-forget)
        awardReputation(req.player.id, 'research_collective', 10).catch(() => {});
        updateTournamentScore(req.player.id, 'quality', result.resultStrain?.quality || 50).catch(() => {});

        res.json({
            success: true,
            ...result,
            xpAwarded: xpResult.xpAwarded,
            leveledUp: xpResult.leveledUp,
            newLevel: xpResult.newLevel
        });

    } catch (error) {
        logger.error('[Breeding] Claim failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found') || error.message.includes('Already') ||
            error.message.includes('not complete')) {
            return res.status(400).json({ error: error.message, code: 'CLAIM_ERROR' });
        }

        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /breed/cancel
 * Cancel an active breeding operation
 */
router.post('/cancel', async (req, res) => {
    try {
        const { breedingId, operationId } = req.body;
        const opId = operationId || breedingId;

        if (!opId) {
            return res.status(400).json({ error: 'Breeding ID required', code: 'NO_ID' });
        }

        // Check if operation exists and belongs to player
        const [[operation]] = await pool.execute(
            `SELECT * FROM cfx_breeding_operations
             WHERE id = ? AND player_id = ? AND status IN ('breeding', 'ready')`,
            [opId, req.player.id]
        );

        if (!operation) {
            return res.status(404).json({ error: 'Breeding operation not found', code: 'NOT_FOUND' });
        }

        // Cancel the operation
        await pool.execute(
            `UPDATE cfx_breeding_operations SET status = 'cancelled' WHERE id = ?`,
            [opId]
        );

        logger.info('[Breeding] Cancelled', {
            playerId: req.player.id,
            operationId: opId
        });

        res.json({
            success: true,
            message: 'Breeding cancelled'
        });

    } catch (error) {
        logger.error('[Breeding] Cancel failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to cancel', code: 'ERROR' });
    }
});

/**
 * GET /breed/preview
 * Preview breeding outcome (requires skill)
 */
router.get('/preview', async (req, res) => {
    try {
        const { parent1Id, parent2Id } = req.query;

        if (!parent1Id || !parent2Id) {
            return res.status(400).json({ error: 'Both parent IDs required', code: 'NO_PARENTS' });
        }

        const result = await previewBreeding(
            req.player.id,
            parseInt(parent1Id),
            parseInt(parent2Id)
        );

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('[Breeding] Preview failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('skill required') || error.message.includes('not found')) {
            return res.status(400).json({ error: error.message, code: 'PREVIEW_ERROR' });
        }

        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /breed/history
 * Get breeding history (completed operations)
 */
router.get('/history', async (req, res) => {
    try {
        const [history] = await pool.execute(
            `SELECT bo.*,
                    s1.name as parent1_name, s1.rarity as parent1_rarity,
                    s2.name as parent2_name, s2.rarity as parent2_rarity,
                    sr.name as result_name, sr.rarity as result_rarity
             FROM cfx_breeding_operations bo
             JOIN cfx_strains s1 ON bo.parent_1_strain_id = s1.id
             JOIN cfx_strains s2 ON bo.parent_2_strain_id = s2.id
             LEFT JOIN cfx_strains sr ON bo.result_strain_id = sr.id
             WHERE bo.player_id = ? AND bo.status = 'claimed'
             ORDER BY bo.claimed_at DESC, bo.ready_at DESC
             LIMIT 50`,
            [req.player.id]
        );

        res.json({
            success: true,
            history: history.map(h => ({
                id: h.id,
                parent1Id: h.parent_1_strain_id,
                parent1Name: h.parent1_name,
                parent1Rarity: h.parent1_rarity,
                parent2Id: h.parent_2_strain_id,
                parent2Name: h.parent2_name,
                parent2Rarity: h.parent2_rarity,
                resultStrainId: h.result_strain_id,
                resultStrainName: h.result_name,
                resultRarity: h.result_rarity,
                hasMutation: (h.mutation_occurred || 0) === 1,
                isNewStrain: (h.result_is_new || h.is_new_strain || 0) === 1,
                startedAt: h.started_at,
                completedAt: h.claimed_at || h.ready_at
            }))
        });

    } catch (error) {
        logger.error('[Breeding] Get history failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to load history', code: 'ERROR' });
    }
});

/**
 * GET /breed/discoveries
 * Get player's strain discoveries
 */
router.get('/discoveries', async (req, res) => {
    try {
        const [discoveries] = await pool.execute(
            `SELECT s.*, d.discovered_at,
                    CASE WHEN s.bred_by_player_id = ? THEN 1 ELSE 0 END as created_by_me
             FROM cfx_strains s
             JOIN cfx_strain_discoveries d ON s.id = d.strain_id
             WHERE d.player_id = ?
             ORDER BY d.discovered_at DESC`,
            [req.player.id, req.player.id]
        );

        const [totalStrains] = await pool.execute('SELECT COUNT(*) as count FROM cfx_strains WHERE is_bred = 0');

        res.json({
            success: true,
            discoveries: discoveries.map(d => ({
                id: d.id,
                name: d.name,
                slug: d.slug,
                strainType: d.strain_type,
                rarity: d.rarity,
                isBred: d.is_bred === 1,
                createdByMe: d.created_by_me === 1,
                discoveredAt: d.discovered_at
            })),
            totalBaseStrains: totalStrains[0].count,
            discoveredCount: discoveries.filter(d => d.is_bred === 0).length
        });

    } catch (error) {
        logger.error('[Breeding] Get discoveries failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
