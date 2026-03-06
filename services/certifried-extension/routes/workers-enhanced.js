/**
 * Enhanced Workers Routes
 * Worker upgrades, traits, training, and management
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { hasResearch } from '../game/research-helper.js';

const router = Router();

// =====================================================
// GET /workers/enhanced
// Get full enhanced worker data for player
// =====================================================
router.get('/enhanced', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get all worker types
        const [workerTypes] = await pool.execute(`
            SELECT * FROM cfx_worker_types WHERE is_active = TRUE ORDER BY unlock_level, name
        `);

        // Get player's workers with type info
        const [playerWorkers] = await pool.execute(`
            SELECT pw.*, wt.worker_key, wt.name as type_name, wt.description as type_description,
                   wt.base_effect_type, wt.max_tier, wt.icon as type_icon
            FROM cfx_player_workers pw
            JOIN cfx_worker_types wt ON pw.worker_type_id = wt.id
            WHERE pw.player_id = ?
            ORDER BY pw.hired_at
        `, [playerId]);

        // Get traits for each worker
        const workerIds = playerWorkers.map(w => w.id);
        let workerTraits = [];
        if (workerIds.length > 0) {
            const placeholders = workerIds.map(() => '?').join(',');
            [workerTraits] = await pool.execute(`
                SELECT wtl.*, wt.trait_key, wt.name, wt.description, wt.trait_category,
                       wt.effect_type, wt.effect_value_per_level, wt.max_level
                FROM cfx_worker_trait_levels wtl
                JOIN cfx_worker_traits wt ON wtl.trait_id = wt.id
                WHERE wtl.worker_id IN (${placeholders})
            `, workerIds);
        }

        // Group traits by worker
        const traitsByWorker = {};
        for (const trait of workerTraits) {
            if (!traitsByWorker[trait.worker_id]) {
                traitsByWorker[trait.worker_id] = [];
            }
            traitsByWorker[trait.worker_id].push({
                id: trait.trait_id,
                key: trait.trait_key,
                name: trait.name,
                description: trait.description,
                category: trait.trait_category,
                effectType: trait.effect_type,
                effectValuePerLevel: parseFloat(trait.effect_value_per_level),
                maxLevel: trait.max_level,
                currentLevel: trait.current_level,
                trainingProgress: parseFloat(trait.training_progress)
            });
        }

        // Auto-complete expired training: clear stuck workers that have no training record
        // or whose training has completed
        const [stuckWorkers] = await pool.execute(`
            SELECT pw.id, pw.training_completes_at
            FROM cfx_player_workers pw
            WHERE pw.player_id = ? AND pw.is_training = TRUE
            AND (pw.training_completes_at IS NULL OR pw.training_completes_at <= NOW())
        `, [playerId]);

        for (const stuck of stuckWorkers) {
            // Check if there's a matching training record
            const [[trainingRecord]] = await pool.execute(`
                SELECT wtr.id, wtr.trait_id, wtr.target_level, wt.effect_type, wt.effect_value_per_level, wt.name as trait_name
                FROM cfx_worker_training wtr
                JOIN cfx_worker_traits wt ON wtr.trait_id = wt.id
                WHERE wtr.worker_id = ? AND wtr.player_id = ? AND wtr.status = 'in_progress'
            `, [stuck.id, playerId]);

            if (trainingRecord) {
                // Auto-claim completed training
                try {
                    await pool.execute(`
                        UPDATE cfx_worker_trait_levels SET current_level = ?, training_progress = 0
                        WHERE worker_id = ? AND trait_id = ?
                    `, [trainingRecord.target_level, stuck.id, trainingRecord.trait_id]);

                    await pool.execute(`UPDATE cfx_worker_training SET status = 'completed' WHERE id = ?`, [trainingRecord.id]);

                    // Apply trait effect
                    const ev = parseFloat(trainingRecord.effect_value_per_level) || 0;
                    if (trainingRecord.effect_type === 'interval_reduction') {
                        await pool.execute(`UPDATE cfx_player_workers SET current_interval_ms = FLOOR(current_interval_ms * (1 - ?)) WHERE id = ?`, [ev, stuck.id]);
                    } else if (trainingRecord.effect_type === 'capacity_bonus') {
                        await pool.execute(`UPDATE cfx_player_workers SET current_capacity = current_capacity + ? WHERE id = ?`, [Math.floor(ev), stuck.id]);
                    } else if (trainingRecord.effect_type === 'efficiency_bonus') {
                        await pool.execute(`UPDATE cfx_player_workers SET current_efficiency = current_efficiency + ? WHERE id = ?`, [ev, stuck.id]);
                    } else if (trainingRecord.effect_type === 'quality_bonus') {
                        await pool.execute(`UPDATE cfx_player_workers SET current_quality_bonus = current_quality_bonus + ? WHERE id = ?`, [ev, stuck.id]);
                    }

                    logger.info('[Workers] Auto-claimed completed training', { workerId: stuck.id, trait: trainingRecord.trait_name });
                } catch (claimErr) {
                    logger.warn('[Workers] Auto-claim failed', { workerId: stuck.id, error: claimErr.message });
                }
            }

            // Clear the training flag regardless
            await pool.execute(`
                UPDATE cfx_player_workers SET is_training = FALSE, training_completes_at = NULL WHERE id = ?
            `, [stuck.id]);
        }

        // Get active training
        const [activeTraining] = await pool.execute(`
            SELECT wtr.*, wt.name as trait_name, pw.name as worker_name
            FROM cfx_worker_training wtr
            JOIN cfx_worker_traits wt ON wtr.trait_id = wt.id
            JOIN cfx_player_workers pw ON wtr.worker_id = pw.id
            WHERE wtr.player_id = ? AND wtr.status = 'in_progress'
        `, [playerId]);

        // Get player level for unlock checking
        const [[player]] = await pool.execute(`
            SELECT level FROM cfx_players WHERE id = ?
        `, [playerId]);

        // Process workers
        const workers = playerWorkers.map(w => ({
            id: w.id,
            typeId: w.worker_type_id,
            typeKey: w.worker_key,
            typeName: w.type_name,
            typeDescription: w.type_description,
            icon: w.type_icon,
            name: w.name || w.type_name,
            tier: w.tier,
            maxTier: w.max_tier,
            experience: w.experience,
            totalActions: w.total_actions,
            intervalMs: w.current_interval_ms,
            capacity: w.current_capacity,
            efficiency: parseFloat(w.current_efficiency),
            qualityBonus: parseFloat(w.current_quality_bonus),
            isEnabled: !!w.is_enabled,
            isTraining: !!w.is_training,
            trainingCompletesAt: w.training_completes_at,
            lastActionAt: w.last_action_at,
            hiredAt: w.hired_at,
            traits: traitsByWorker[w.id] || [],
            effectType: w.base_effect_type
        }));

        // Process available worker types
        const availableTypes = await Promise.all(workerTypes.map(async (wt) => {
            const isUnlocked = player.level >= wt.unlock_level;
            let researchUnlocked = true;
            if (wt.unlock_research) {
                researchUnlocked = await hasResearch(playerId, wt.unlock_research);
            }
            const owned = workers.filter(w => w.typeKey === wt.worker_key);

            return {
                id: wt.id,
                key: wt.worker_key,
                name: wt.name,
                description: wt.description,
                effectType: wt.base_effect_type,
                baseIntervalMs: wt.base_interval_ms,
                maxTier: wt.max_tier,
                baseCapacity: wt.base_capacity,
                baseEfficiency: parseFloat(wt.base_efficiency),
                baseQualityBonus: parseFloat(wt.base_quality_bonus),
                unlockLevel: wt.unlock_level,
                unlockResearch: wt.unlock_research,
                baseCost: wt.base_cost,
                icon: wt.icon,
                isUnlocked: isUnlocked && researchUnlocked,
                ownedCount: owned.length
            };
        }));

        res.json({
            success: true,
            workers,
            workerTypes: availableTypes,
            activeTraining: activeTraining.map(t => ({
                id: t.id,
                workerId: t.worker_id,
                workerName: t.worker_name,
                traitId: t.trait_id,
                traitName: t.trait_name,
                targetLevel: t.target_level,
                startedAt: t.started_at,
                completesAt: t.completes_at,
                status: t.status
            })),
            playerLevel: player.level
        });
    } catch (error) {
        logger.error('[Workers] Error loading enhanced data:', error);
        res.status(500).json({ success: false, error: 'Failed to load workers' });
    }
});

// =====================================================
// POST /workers/hire
// Hire a new worker
// =====================================================
router.post('/hire', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { workerTypeId, name } = req.body;

        if (!workerTypeId) {
            return res.status(400).json({ success: false, error: 'Worker type required' });
        }

        await conn.beginTransaction();

        // Get worker type
        const [[workerType]] = await conn.execute(`
            SELECT * FROM cfx_worker_types WHERE id = ? AND is_active = TRUE
        `, [workerTypeId]);

        if (!workerType) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Worker type not found' });
        }

        // Check unlock requirements
        const [[player]] = await conn.execute(`
            SELECT level, cash FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        if (player.level < workerType.unlock_level) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Requires level ${workerType.unlock_level}`
            });
        }

        // Check research unlock if required
        if (workerType.unlock_research) {
            const unlocked = await hasResearch(playerId, workerType.unlock_research);
            if (!unlocked) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    error: `Requires research: ${workerType.unlock_research}`
                });
            }
        }

        // Check cost
        if (player.cash < workerType.base_cost) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        // Deduct cost
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ? WHERE id = ?
        `, [workerType.base_cost, playerId]);

        // Create worker
        const [result] = await conn.execute(`
            INSERT INTO cfx_player_workers
            (player_id, worker_type_id, name, tier, current_interval_ms, current_capacity, current_efficiency, current_quality_bonus)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        `, [
            playerId,
            workerTypeId,
            name || workerType.name,
            workerType.base_interval_ms,
            workerType.base_capacity,
            workerType.base_efficiency,
            workerType.base_quality_bonus
        ]);

        await conn.commit();

        res.json({
            success: true,
            message: `Hired ${workerType.name}!`,
            worker: {
                id: result.insertId,
                typeKey: workerType.worker_key,
                name: name || workerType.name,
                tier: 1
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Workers] Error hiring:', error);
        res.status(500).json({ success: false, error: 'Failed to hire worker' });
    } finally {
        conn.release();
    }
});

// =====================================================
// POST /workers/:id/upgrade
// Upgrade a worker to the next tier
// =====================================================
router.post('/:id/upgrade', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const workerId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get worker
        const [[worker]] = await conn.execute(`
            SELECT pw.*, wt.max_tier, wt.worker_key
            FROM cfx_player_workers pw
            JOIN cfx_worker_types wt ON pw.worker_type_id = wt.id
            WHERE pw.id = ? AND pw.player_id = ?
        `, [workerId, playerId]);

        if (!worker) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Worker not found' });
        }

        if (worker.tier >= worker.max_tier) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Worker is at max tier' });
        }

        // Get upgrade cost
        const [[upgradeCost]] = await conn.execute(`
            SELECT * FROM cfx_worker_tier_costs
            WHERE worker_type_id = ? AND from_tier = ? AND to_tier = ?
        `, [worker.worker_type_id, worker.tier, worker.tier + 1]);

        if (!upgradeCost) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Upgrade path not found' });
        }

        // Check action requirement
        if (worker.total_actions < upgradeCost.required_actions) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Worker needs ${upgradeCost.required_actions} actions (has ${worker.total_actions})`
            });
        }

        // Check research requirement
        if (upgradeCost.required_research) {
            const unlocked = await hasResearch(playerId, upgradeCost.required_research);
            if (!unlocked) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    error: `Requires research: ${upgradeCost.required_research}`
                });
            }
        }

        // Check player resources
        const [[player]] = await conn.execute(`
            SELECT cash, xp FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        if (player.cash < upgradeCost.cost_cash) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        if (player.xp < upgradeCost.cost_xp) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough XP' });
        }

        // Deduct costs
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ?, xp = xp - ? WHERE id = ?
        `, [upgradeCost.cost_cash, upgradeCost.cost_xp, playerId]);

        // Calculate new stats
        const newInterval = Math.floor(worker.current_interval_ms * (1 - upgradeCost.interval_reduction_percent / 100));
        const newEfficiency = parseFloat(worker.current_efficiency) + parseFloat(upgradeCost.efficiency_bonus);
        const newCapacity = worker.current_capacity + upgradeCost.capacity_bonus;
        const newQuality = parseFloat(worker.current_quality_bonus) + parseFloat(upgradeCost.quality_bonus);

        // Upgrade worker
        await conn.execute(`
            UPDATE cfx_player_workers
            SET tier = tier + 1,
                current_interval_ms = ?,
                current_efficiency = ?,
                current_capacity = ?,
                current_quality_bonus = ?
            WHERE id = ?
        `, [newInterval, newEfficiency, newCapacity, newQuality, workerId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Worker upgraded to Tier ${worker.tier + 1}!`,
            newStats: {
                tier: worker.tier + 1,
                intervalMs: newInterval,
                efficiency: newEfficiency,
                capacity: newCapacity,
                qualityBonus: newQuality
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Workers] Error upgrading:', error);
        res.status(500).json({ success: false, error: 'Failed to upgrade worker' });
    } finally {
        conn.release();
    }
});

// =====================================================
// GET /workers/traits
// Get all available traits
// =====================================================
router.get('/traits', async (req, res) => {
    try {
        const playerId = req.player.id;

        const [traits] = await pool.execute(`
            SELECT * FROM cfx_worker_traits WHERE is_active = TRUE ORDER BY trait_category, name
        `);

        // Check research unlocks
        const processedTraits = await Promise.all(traits.map(async (trait) => {
            let isUnlocked = true;
            if (trait.unlock_research) {
                isUnlocked = await hasResearch(playerId, trait.unlock_research);
            }

            return {
                id: trait.id,
                key: trait.trait_key,
                name: trait.name,
                description: trait.description,
                category: trait.trait_category,
                effectType: trait.effect_type,
                effectValuePerLevel: parseFloat(trait.effect_value_per_level),
                maxLevel: trait.max_level,
                trainingTimeBaseHours: parseFloat(trait.training_time_base_hours),
                trainingCostBase: trait.training_cost_base,
                compatibleWorkers: (() => { try { return trait.compatible_workers ? JSON.parse(trait.compatible_workers) : null; } catch { return null; } })(),
                unlockResearch: trait.unlock_research,
                isUnlocked
            };
        }));

        res.json({
            success: true,
            traits: processedTraits
        });
    } catch (error) {
        logger.error('[Workers] Error loading traits:', error);
        res.status(500).json({ success: false, error: 'Failed to load traits' });
    }
});

// =====================================================
// POST /workers/:id/train
// Start training a worker trait
// =====================================================
router.post('/:id/train', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const workerId = parseInt(req.params.id, 10);
        const { traitId } = req.body;

        if (!traitId) {
            return res.status(400).json({ success: false, error: 'Trait ID required' });
        }

        await conn.beginTransaction();

        // Check if training feature is unlocked
        const hasTrainingFeature = await hasResearch(playerId, 'worker_efficiency_1');
        if (!hasTrainingFeature) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: 'Worker training requires "Basic Workforce Training" research'
            });
        }

        // Get worker
        const [[worker]] = await conn.execute(`
            SELECT pw.*, wt.worker_key
            FROM cfx_player_workers pw
            JOIN cfx_worker_types wt ON pw.worker_type_id = wt.id
            WHERE pw.id = ? AND pw.player_id = ?
        `, [workerId, playerId]);

        if (!worker) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Worker not found' });
        }

        if (worker.is_training) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Worker is already training' });
        }

        // Get trait
        const [[trait]] = await conn.execute(`
            SELECT * FROM cfx_worker_traits WHERE id = ? AND is_active = TRUE
        `, [traitId]);

        if (!trait) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Trait not found' });
        }

        // Check compatibility
        if (trait.compatible_workers) {
            let compatible;
            try {
                compatible = JSON.parse(trait.compatible_workers);
            } catch {
                compatible = [];
            }
            if (!compatible.includes(worker.worker_key)) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    error: 'This trait is not compatible with this worker type'
                });
            }
        }

        // Check research unlock
        if (trait.unlock_research) {
            const unlocked = await hasResearch(playerId, trait.unlock_research);
            if (!unlocked) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    error: `Requires research: ${trait.unlock_research}`
                });
            }
        }

        // Get current trait level (table created by migration, graceful fallback)
        let traitLevel;
        try {
            const [[row]] = await conn.execute(`
                SELECT * FROM cfx_worker_trait_levels WHERE worker_id = ? AND trait_id = ?
            `, [workerId, traitId]);
            traitLevel = row;
        } catch (tableErr) {
            // Table may not exist yet if migration hasn't run
            logger.warn('[Workers] cfx_worker_trait_levels query failed, table may not exist', { error: tableErr.message });
            traitLevel = null;
        }

        const currentLevel = traitLevel?.current_level || 0;
        const targetLevel = currentLevel + 1;

        if (currentLevel >= trait.max_level) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Trait is at max level' });
        }

        // Calculate training time and cost (scales with level)
        let trainingHours = trait.training_time_base_hours * targetLevel;
        let cost = trait.training_cost_base * targetLevel;

        // Apply research bonuses
        const hasAdvancedTraining = await hasResearch(playerId, 'worker_efficiency_2');
        if (hasAdvancedTraining) {
            trainingHours *= 0.75; // 25% faster
        }

        // Apply Master Trainer trait bonus (from any worker with this trait)
        const workerBonuses = await getWorkerBonuses(playerId);
        if (workerBonuses.trainingSpeed > 0) {
            trainingHours *= (1 - workerBonuses.trainingSpeed); // e.g., 0.1 = 10% faster
        }

        // Check cost
        const [[player]] = await conn.execute(`
            SELECT cash FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        if (player.cash < cost) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        // Deduct cost
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ? WHERE id = ?
        `, [cost, playerId]);

        // Calculate completion time
        const completesAt = new Date(Date.now() + trainingHours * 60 * 60 * 1000);

        // Create or update trait level record
        if (!traitLevel) {
            await conn.execute(`
                INSERT INTO cfx_worker_trait_levels (worker_id, trait_id, current_level, training_progress)
                VALUES (?, ?, 0, 0)
            `, [workerId, traitId]);
        }

        // Create training record
        await conn.execute(`
            INSERT INTO cfx_worker_training (player_id, worker_id, trait_id, target_level, completes_at, cost_paid)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [playerId, workerId, traitId, targetLevel, completesAt, cost]);

        // Mark worker as training
        await conn.execute(`
            UPDATE cfx_player_workers SET is_training = TRUE, training_completes_at = ? WHERE id = ?
        `, [completesAt, workerId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Training "${trait.name}" to level ${targetLevel}`,
            training: {
                traitName: trait.name,
                targetLevel,
                completesAt,
                cost
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Workers] Error starting training:', error);
        res.status(500).json({ success: false, error: 'Failed to start training' });
    } finally {
        conn.release();
    }
});

// =====================================================
// POST /workers/:id/claim-training
// Claim completed training
// =====================================================
router.post('/:id/claim-training', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const workerId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get training record
        const [[training]] = await conn.execute(`
            SELECT wtr.*, wt.name as trait_name, wt.effect_type, wt.effect_value_per_level
            FROM cfx_worker_training wtr
            JOIN cfx_worker_traits wt ON wtr.trait_id = wt.id
            WHERE wtr.worker_id = ? AND wtr.player_id = ? AND wtr.status = 'in_progress'
        `, [workerId, playerId]);

        if (!training) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'No training in progress' });
        }

        // Check if complete
        if (new Date(training.completes_at) > new Date()) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Training not yet complete' });
        }

        // Update trait level
        await conn.execute(`
            UPDATE cfx_worker_trait_levels
            SET current_level = ?, training_progress = 0
            WHERE worker_id = ? AND trait_id = ?
        `, [training.target_level, workerId, training.trait_id]);

        // Mark training complete
        await conn.execute(`
            UPDATE cfx_worker_training SET status = 'completed' WHERE id = ?
        `, [training.id]);

        // Update worker - clear training flag
        await conn.execute(`
            UPDATE cfx_player_workers SET is_training = FALSE, training_completes_at = NULL WHERE id = ?
        `, [workerId]);

        // Apply trait effects to worker stats
        const effectValue = parseFloat(training.effect_value_per_level);
        switch (training.effect_type) {
            case 'interval_reduction':
                await conn.execute(`
                    UPDATE cfx_player_workers
                    SET current_interval_ms = FLOOR(current_interval_ms * (1 - ?))
                    WHERE id = ?
                `, [effectValue, workerId]);
                break;
            case 'capacity_bonus':
                await conn.execute(`
                    UPDATE cfx_player_workers
                    SET current_capacity = current_capacity + ?
                    WHERE id = ?
                `, [Math.floor(effectValue), workerId]);
                break;
            case 'efficiency_bonus':
                await conn.execute(`
                    UPDATE cfx_player_workers
                    SET current_efficiency = current_efficiency + ?
                    WHERE id = ?
                `, [effectValue, workerId]);
                break;
            case 'quality_bonus':
                await conn.execute(`
                    UPDATE cfx_player_workers
                    SET current_quality_bonus = current_quality_bonus + ?
                    WHERE id = ?
                `, [effectValue, workerId]);
                break;
        }

        await conn.commit();

        res.json({
            success: true,
            message: `Training complete! "${training.trait_name}" is now level ${training.target_level}`,
            trait: {
                name: training.trait_name,
                level: training.target_level
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Workers] Error claiming training:', error);
        res.status(500).json({ success: false, error: 'Failed to claim training' });
    } finally {
        conn.release();
    }
});

// =====================================================
// POST /workers/:id/toggle
// Enable/disable a worker
// =====================================================
router.post('/:id/toggle', async (req, res) => {
    try {
        const playerId = req.player.id;
        const workerId = parseInt(req.params.id, 10);
        const { enabled } = req.body;

        const [result] = await pool.execute(`
            UPDATE cfx_player_workers SET is_enabled = ? WHERE id = ? AND player_id = ?
        `, [enabled ? 1 : 0, workerId, playerId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Worker not found' });
        }

        res.json({
            success: true,
            message: enabled ? 'Worker enabled' : 'Worker disabled',
            enabled
        });
    } catch (error) {
        logger.error('[Workers] Error toggling:', error);
        res.status(500).json({ success: false, error: 'Failed to toggle worker' });
    }
});

// =====================================================
// POST /workers/:id/rename
// Rename a worker
// =====================================================
router.post('/:id/rename', async (req, res) => {
    try {
        const playerId = req.player.id;
        const workerId = parseInt(req.params.id, 10);
        const { name } = req.body;

        if (!name || name.length > 50) {
            return res.status(400).json({ success: false, error: 'Invalid name' });
        }

        const [result] = await pool.execute(`
            UPDATE cfx_player_workers SET name = ? WHERE id = ? AND player_id = ?
        `, [name, workerId, playerId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Worker not found' });
        }

        res.json({
            success: true,
            message: 'Worker renamed',
            name
        });
    } catch (error) {
        logger.error('[Workers] Error renaming:', error);
        res.status(500).json({ success: false, error: 'Failed to rename worker' });
    }
});

// =====================================================
// GET /workers/:id/upgrade-info
// Get upgrade requirements for a worker
// =====================================================
router.get('/:id/upgrade-info', async (req, res) => {
    try {
        const playerId = req.player.id;
        const workerId = parseInt(req.params.id, 10);

        // Get worker
        const [[worker]] = await pool.execute(`
            SELECT pw.*, wt.max_tier, wt.worker_key
            FROM cfx_player_workers pw
            JOIN cfx_worker_types wt ON pw.worker_type_id = wt.id
            WHERE pw.id = ? AND pw.player_id = ?
        `, [workerId, playerId]);

        if (!worker) {
            return res.status(404).json({ success: false, error: 'Worker not found' });
        }

        if (worker.tier >= worker.max_tier) {
            return res.json({
                success: true,
                isMaxTier: true,
                message: 'Worker is at maximum tier'
            });
        }

        // Get upgrade cost
        const [[upgradeCost]] = await pool.execute(`
            SELECT * FROM cfx_worker_tier_costs
            WHERE worker_type_id = ? AND from_tier = ? AND to_tier = ?
        `, [worker.worker_type_id, worker.tier, worker.tier + 1]);

        if (!upgradeCost) {
            return res.json({
                success: true,
                isMaxTier: true,
                message: 'No upgrade path available'
            });
        }

        // Check requirements
        const [[player]] = await pool.execute(`
            SELECT cash, xp FROM cfx_players WHERE id = ?
        `, [playerId]);

        let researchMet = true;
        if (upgradeCost.required_research) {
            researchMet = await hasResearch(playerId, upgradeCost.required_research);
        }

        res.json({
            success: true,
            isMaxTier: false,
            currentTier: worker.tier,
            nextTier: worker.tier + 1,
            requirements: {
                cash: upgradeCost.cost_cash,
                xp: upgradeCost.cost_xp,
                actions: upgradeCost.required_actions,
                research: upgradeCost.required_research
            },
            playerHas: {
                cash: player.cash,
                xp: player.xp,
                actions: worker.total_actions,
                researchMet
            },
            canUpgrade: player.cash >= upgradeCost.cost_cash &&
                       player.xp >= upgradeCost.cost_xp &&
                       worker.total_actions >= upgradeCost.required_actions &&
                       researchMet,
            improvements: {
                intervalReduction: `${upgradeCost.interval_reduction_percent}%`,
                efficiencyBonus: `+${Math.round(upgradeCost.efficiency_bonus * 100)}%`,
                capacityBonus: `+${upgradeCost.capacity_bonus}`,
                qualityBonus: `+${Math.round(upgradeCost.quality_bonus * 100)}%`
            }
        });
    } catch (error) {
        logger.error('[Workers] Error getting upgrade info:', error);
        res.status(500).json({ success: false, error: 'Failed to get upgrade info' });
    }
});

// =====================================================
// Helper: Get worker bonuses for a player
// Aggregates both worker stats and trained trait effects
// =====================================================
export async function getWorkerBonuses(playerId) {
    // Get all active workers with their base stats
    const [workers] = await pool.execute(`
        SELECT pw.*, wt.worker_key, wt.base_effect_type
        FROM cfx_player_workers pw
        JOIN cfx_worker_types wt ON pw.worker_type_id = wt.id
        WHERE pw.player_id = ? AND pw.is_enabled = TRUE
    `, [playerId]);

    const bonuses = {
        qualityBonus: 0,
        efficiencyBonus: 0,
        researchSpeed: 0,
        extractionBonus: 0,
        dispensaryBonus: 0,
        storageBonus: 0,
        // Trait-based bonuses
        growthSpeed: 0,
        priceBonus: 0,
        tipBonus: 0,
        processSpeed: 0,
        exceptionalChance: 0,
        workerSynergy: 0,
        trainingSpeed: 0
    };

    // Get worker IDs for trait query
    const workerIds = workers.map(w => w.id);

    // Get all trained traits for these workers
    let traitBonuses = [];
    if (workerIds.length > 0) {
        const placeholders = workerIds.map(() => '?').join(',');
        [traitBonuses] = await pool.execute(`
            SELECT wtl.worker_id, wtl.current_level, wt.effect_type, wt.effect_value_per_level
            FROM cfx_worker_trait_levels wtl
            JOIN cfx_worker_traits wt ON wtl.trait_id = wt.id
            WHERE wtl.worker_id IN (${placeholders}) AND wtl.current_level > 0
        `, workerIds);
    }

    // Apply base worker bonuses
    for (const worker of workers) {
        bonuses.qualityBonus += parseFloat(worker.current_quality_bonus) || 0;
        bonuses.efficiencyBonus += (parseFloat(worker.current_efficiency) - 1) || 0;

        // Apply type-specific bonuses
        if (worker.worker_key === 'research_assistant') {
            bonuses.researchSpeed += parseFloat(worker.current_efficiency) || 0;
        }
        if (worker.worker_key === 'extraction_specialist') {
            bonuses.extractionBonus += parseFloat(worker.current_quality_bonus) || 0;
        }
        if (worker.worker_key === 'dispensary_manager') {
            bonuses.dispensaryBonus += parseFloat(worker.current_efficiency) || 0;
        }
        if (worker.worker_key === 'logistics_coordinator') {
            bonuses.storageBonus += worker.current_capacity || 0;
        }
    }

    // Apply trait-based bonuses (special effect types)
    for (const trait of traitBonuses) {
        const bonus = parseFloat(trait.effect_value_per_level) * trait.current_level;

        switch (trait.effect_type) {
            case 'growth_speed':
                bonuses.growthSpeed += bonus;
                break;
            case 'price_bonus':
                bonuses.priceBonus += bonus;
                break;
            case 'tip_bonus':
                bonuses.tipBonus += bonus;
                break;
            case 'process_speed':
                bonuses.processSpeed += bonus;
                break;
            case 'exceptional_chance':
                bonuses.exceptionalChance += bonus;
                break;
            case 'sync_bonus':
                bonuses.workerSynergy += bonus;
                break;
            case 'training_speed':
                bonuses.trainingSpeed += bonus;
                break;
            case 'storage_bonus':
                bonuses.storageBonus += bonus;
                break;
        }
    }

    // Apply worker synergy bonus (each active worker boosts others)
    if (bonuses.workerSynergy > 0 && workers.length > 1) {
        const synergyMultiplier = 1 + (bonuses.workerSynergy * (workers.length - 1));
        bonuses.efficiencyBonus *= synergyMultiplier;
    }

    return bonuses;
}

export default router;
