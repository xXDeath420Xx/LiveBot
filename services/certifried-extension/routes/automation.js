/**
 * Automation Routes
 * Configure auto-harvest, auto-plant, auto-sell settings
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { deductCash } from '../game/engine.js';

const router = Router();

/**
 * GET /automation
 * Get current automation settings
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get or create player settings
        let [[settings]] = await pool.execute(
            'SELECT * FROM cfx_player_settings WHERE player_id = ?',
            [playerId]
        );

        if (!settings) {
            await pool.execute(
                'INSERT INTO cfx_player_settings (player_id) VALUES (?)',
                [playerId]
            );
            [[settings]] = await pool.execute(
                'SELECT * FROM cfx_player_settings WHERE player_id = ?',
                [playerId]
            );
        }

        // Get slot configurations
        const [slots] = await pool.execute(
            `SELECT gs.slot_number, gs.preferred_strain_id, gs.use_slot_preference,
                    s.name as strain_name, s.rarity
             FROM cfx_grow_slots gs
             LEFT JOIN cfx_strains s ON gs.preferred_strain_id = s.id
             WHERE gs.player_id = ?
             ORDER BY gs.slot_number`,
            [playerId]
        );

        // Get available seeds for dropdown
        const [seeds] = await pool.execute(
            `SELECT si.strain_id, si.quantity, s.name, s.rarity
             FROM cfx_seed_inventory si
             JOIN cfx_strains s ON si.strain_id = s.id
             WHERE si.player_id = ? AND si.quantity > 0
             ORDER BY FIELD(s.rarity, 'legendary', 'epic', 'rare', 'uncommon', 'common'), s.name`,
            [playerId]
        );

        res.json({
            success: true,
            settings: {
                // Global auto-replant
                autoReplantEnabled: settings.auto_replant_enabled || false,
                autoReplantStrainId: settings.auto_replant_strain_id,
                autoReplantUseFavorite: settings.auto_replant_use_favorite || false,
                // Worker intervals (in milliseconds)
                workerHarvestIntervalMs: settings.worker_harvest_interval_ms || 300000,
                workerPlantIntervalMs: settings.worker_plant_interval_ms || 300000,
                workerSellIntervalMs: settings.worker_sell_interval_ms || 600000,
                // Auto-buy seeds
                autoBuySeedsEnabled: settings.auto_buy_seeds_enabled || false,
                autoBuySeedsThreshold: settings.auto_buy_seeds_threshold || 5,
                autoBuySeedsQuantity: settings.auto_buy_seeds_quantity || 10,
                autoBuySeedsMaxPrice: settings.auto_buy_seeds_max_price || 500,
                // Workflow settings (SMART AUTOMATION)
                workflowMode: settings.workflow_mode || 'balanced',
                minInventoryReserve: settings.min_inventory_reserve || 0,
                processBeforeSell: settings.process_before_sell !== false,
                sellQualityThreshold: settings.sell_quality_threshold || 0,
                reserveRareStrains: settings.reserve_rare_strains !== false,
                maxAutoSellPercent: settings.max_auto_sell_percent || 50
            },
            slotConfigs: slots.map(s => ({
                slotNumber: s.slot_number,
                preferredStrainId: s.preferred_strain_id,
                preferredStrainName: s.strain_name,
                preferredStrainRarity: s.rarity,
                useSlotPreference: s.use_slot_preference
            })),
            availableSeeds: seeds.map(s => ({
                strainId: s.strain_id,
                name: s.name,
                rarity: s.rarity,
                quantity: s.quantity
            }))
        });

    } catch (error) {
        logger.error('[Automation] Get settings failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /automation/settings
 * Update global automation settings
 */
router.post('/settings', async (req, res) => {
    try {
        const playerId = req.player.id;
        const {
            autoReplantEnabled,
            autoReplantStrainId,
            autoReplantUseFavorite,
            workerHarvestIntervalMs,
            workerPlantIntervalMs,
            workerSellIntervalMs,
            autoBuySeedsEnabled,
            autoBuySeedsThreshold,
            autoBuySeedsQuantity,
            autoBuySeedsMaxPrice
        } = req.body;

        // Validate intervals (minimum 30 seconds, max 30 minutes)
        const minInterval = 30000;
        const maxInterval = 1800000;

        const harvestInterval = Math.max(minInterval, Math.min(maxInterval, workerHarvestIntervalMs || 90000));
        const plantInterval = Math.max(minInterval, Math.min(maxInterval, workerPlantIntervalMs || 90000));
        const sellInterval = Math.max(minInterval, Math.min(maxInterval, workerSellIntervalMs || 120000));

        await pool.execute(
            `INSERT INTO cfx_player_settings (player_id, auto_replant_enabled, auto_replant_strain_id,
                auto_replant_use_favorite, worker_harvest_interval_ms, worker_plant_interval_ms,
                worker_sell_interval_ms, auto_buy_seeds_enabled, auto_buy_seeds_threshold,
                auto_buy_seeds_quantity, auto_buy_seeds_max_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                auto_replant_enabled = VALUES(auto_replant_enabled),
                auto_replant_strain_id = VALUES(auto_replant_strain_id),
                auto_replant_use_favorite = VALUES(auto_replant_use_favorite),
                worker_harvest_interval_ms = VALUES(worker_harvest_interval_ms),
                worker_plant_interval_ms = VALUES(worker_plant_interval_ms),
                worker_sell_interval_ms = VALUES(worker_sell_interval_ms),
                auto_buy_seeds_enabled = VALUES(auto_buy_seeds_enabled),
                auto_buy_seeds_threshold = VALUES(auto_buy_seeds_threshold),
                auto_buy_seeds_quantity = VALUES(auto_buy_seeds_quantity),
                auto_buy_seeds_max_price = VALUES(auto_buy_seeds_max_price),
                updated_at = NOW()`,
            [playerId, autoReplantEnabled || false, autoReplantStrainId || null,
             autoReplantUseFavorite || false, harvestInterval, plantInterval, sellInterval,
             autoBuySeedsEnabled || false, autoBuySeedsThreshold || 5,
             autoBuySeedsQuantity || 10, autoBuySeedsMaxPrice || 500]
        );

        logger.info('[Automation] Settings updated', { playerId });

        res.json({
            success: true,
            message: 'Automation settings saved'
        });

    } catch (error) {
        logger.error('[Automation] Update settings failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /automation/workflow
 * Configure smart workflow settings (CRITICAL for sensible automation)
 */
router.post('/workflow', async (req, res) => {
    try {
        const playerId = req.player.id;
        const {
            workflowMode,
            minInventoryReserve,
            processBeforeSell,
            sellQualityThreshold,
            reserveRareStrains,
            maxAutoSellPercent
        } = req.body;

        // Validate workflowMode
        const validModes = ['manual', 'sell_all', 'process_first', 'balanced'];
        const mode = validModes.includes(workflowMode) ? workflowMode : 'balanced';

        // Validate ranges
        const reserve = Math.max(0, Math.min(100, minInventoryReserve || 0));
        const qualityThreshold = Math.max(0, Math.min(100, sellQualityThreshold || 0));
        const maxSellPercent = Math.max(10, Math.min(100, maxAutoSellPercent || 50));

        await pool.execute(
            `UPDATE cfx_player_settings
             SET workflow_mode = ?,
                 min_inventory_reserve = ?,
                 process_before_sell = ?,
                 sell_quality_threshold = ?,
                 reserve_rare_strains = ?,
                 max_auto_sell_percent = ?,
                 updated_at = NOW()
             WHERE player_id = ?`,
            [
                mode,
                reserve,
                processBeforeSell !== false,
                qualityThreshold,
                reserveRareStrains !== false,
                maxSellPercent,
                playerId
            ]
        );

        // If player settings row doesn't exist, insert it
        const [[exists]] = await pool.execute(
            'SELECT id FROM cfx_player_settings WHERE player_id = ?',
            [playerId]
        );

        if (!exists) {
            await pool.execute(
                `INSERT INTO cfx_player_settings (player_id, workflow_mode, min_inventory_reserve,
                    process_before_sell, sell_quality_threshold, reserve_rare_strains, max_auto_sell_percent)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [playerId, mode, reserve, processBeforeSell !== false, qualityThreshold, reserveRareStrains !== false, maxSellPercent]
            );
        }

        logger.info('[Automation] Workflow settings updated', { playerId, mode });

        res.json({
            success: true,
            message: 'Workflow settings saved',
            settings: {
                workflowMode: mode,
                minInventoryReserve: reserve,
                processBeforeSell: processBeforeSell !== false,
                sellQualityThreshold: qualityThreshold,
                reserveRareStrains: reserveRareStrains !== false,
                maxAutoSellPercent: maxSellPercent
            }
        });

    } catch (error) {
        logger.error('[Automation] Update workflow failed', { error: error.message });
        res.status(500).json({ error: 'Failed to update workflow settings', code: 'ERROR' });
    }
});

/**
 * POST /automation/slot/:slotNumber
 * Configure per-slot seed preference
 */
router.post('/slot/:slotNumber', async (req, res) => {
    try {
        const playerId = req.player.id;
        const slotNumber = parseInt(req.params.slotNumber, 10);
        const { preferredStrainId, useSlotPreference } = req.body;

        // Verify slot exists and belongs to player
        const [[slot]] = await pool.execute(
            'SELECT id FROM cfx_grow_slots WHERE player_id = ? AND slot_number = ?',
            [playerId, slotNumber]
        );

        if (!slot) {
            return res.status(404).json({ error: 'Slot not found', code: 'NOT_FOUND' });
        }

        // Update slot configuration
        await pool.execute(
            `UPDATE cfx_grow_slots
             SET preferred_strain_id = ?, use_slot_preference = ?
             WHERE player_id = ? AND slot_number = ?`,
            [preferredStrainId || null, useSlotPreference || false, playerId, slotNumber]
        );

        logger.info('[Automation] Slot config updated', { playerId, slotNumber, preferredStrainId });

        res.json({
            success: true,
            message: `Slot ${slotNumber} configuration saved`
        });

    } catch (error) {
        logger.error('[Automation] Update slot config failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /automation/bulk-slots
 * Configure multiple slots at once
 */
router.post('/bulk-slots', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { slotConfigs } = req.body;

        if (!Array.isArray(slotConfigs)) {
            return res.status(400).json({ error: 'slotConfigs must be an array', code: 'INVALID_INPUT' });
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            for (const config of slotConfigs) {
                const { slotNumber, preferredStrainId, useSlotPreference } = config;

                await conn.execute(
                    `UPDATE cfx_grow_slots
                     SET preferred_strain_id = ?, use_slot_preference = ?
                     WHERE player_id = ? AND slot_number = ?`,
                    [preferredStrainId || null, useSlotPreference || false, playerId, slotNumber]
                );
            }

            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        logger.info('[Automation] Bulk slot config updated', { playerId, count: slotConfigs.length });

        res.json({
            success: true,
            message: `${slotConfigs.length} slot configurations saved`
        });

    } catch (error) {
        logger.error('[Automation] Bulk update failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * Helper: Auto-buy seeds if enabled and below threshold
 * Called by workers-tick when planting fails due to no seeds
 */
export async function autoBuySeeds(playerId, strainId) {
    try {
        // Get player settings
        const [[settings]] = await pool.execute(
            `SELECT auto_buy_seeds_enabled, auto_buy_seeds_threshold,
                    auto_buy_seeds_quantity, auto_buy_seeds_max_price
             FROM cfx_player_settings WHERE player_id = ?`,
            [playerId]
        );

        if (!settings || !settings.auto_buy_seeds_enabled) {
            return { purchased: false, reason: 'auto-buy disabled' };
        }

        // Check current seed count
        const [[seedCount]] = await pool.execute(
            'SELECT COALESCE(SUM(quantity), 0) as total FROM cfx_seed_inventory WHERE player_id = ?',
            [playerId]
        );

        if (seedCount.total >= settings.auto_buy_seeds_threshold) {
            return { purchased: false, reason: 'above threshold' };
        }

        // Get cheapest strain seeds to buy
        const [[strain]] = await pool.execute(
            `SELECT s.id, s.name, sp.price_per_seed
             FROM cfx_strains s
             LEFT JOIN (
                 SELECT strain_id, MIN(base_price / 3) as price_per_seed
                 FROM cfx_strains GROUP BY strain_id
             ) sp ON s.id = sp.strain_id
             WHERE s.id = ? OR ? IS NULL
             ORDER BY sp.price_per_seed ASC
             LIMIT 1`,
            [strainId, strainId]
        );

        if (!strain) {
            return { purchased: false, reason: 'no strain found' };
        }

        // Calculate cost (use base_price / 3 as seed price estimation)
        const [[strainData]] = await pool.execute(
            'SELECT base_price FROM cfx_strains WHERE id = ?',
            [strain.id || strainId]
        );

        const pricePerSeed = Math.floor((strainData?.base_price || 150) / 3);
        const quantity = settings.auto_buy_seeds_quantity;
        const totalCost = pricePerSeed * quantity;

        if (pricePerSeed > settings.auto_buy_seeds_max_price) {
            return { purchased: false, reason: 'price above max' };
        }

        // Attempt purchase
        const cashResult = await deductCash(playerId, totalCost);
        if (!cashResult.success) {
            return { purchased: false, reason: 'insufficient funds' };
        }

        // Add seeds
        await pool.execute(
            `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity, total_purchased)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                quantity = quantity + VALUES(quantity),
                total_purchased = total_purchased + VALUES(total_purchased)`,
            [playerId, strain.id || strainId, quantity, quantity]
        );

        logger.info('[Automation] Auto-bought seeds', {
            playerId,
            strainId: strain.id || strainId,
            quantity,
            cost: totalCost
        });

        return { purchased: true, quantity, cost: totalCost, strainId: strain.id || strainId };

    } catch (error) {
        logger.error('[Automation] Auto-buy seeds failed', { playerId, error: error.message });
        return { purchased: false, reason: error.message };
    }
}

export default router;
