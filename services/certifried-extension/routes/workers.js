/**
 * Workers Routes
 * NPC Worker management and status
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

const WORKER_TYPES = {
    trimmer: {
        name: 'Trimmer',
        description: 'Auto-harvests ready plants',
        effect: 'auto_harvest',
        interval: 90000 // 1.5 minutes
    },
    propagation_tech: {
        name: 'Propagation Tech',
        description: 'Auto-plants seeds in empty slots',
        effect: 'auto_plant',
        interval: 90000 // 1.5 minutes
    },
    sales_rep: {
        name: 'Sales Rep',
        description: 'Auto-sells harvested product',
        effect: 'auto_sell',
        interval: 120000 // 2 minutes
    }
};

/**
 * GET /workers/status
 * Get player's workers and their status
 */
router.get('/status', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get owned workers from shop items
        // Note: workers-tick.js uses 'last_worker_run' column for tracking
        const [workers] = await pool.execute(
            `SELECT id, item_id, item_name, effect_type, worker_interval,
                    last_worker_run, is_enabled, purchased_at
             FROM cfx_player_shop_items
             WHERE player_id = ? AND item_type = 'worker'`,
            [playerId]
        );

        // Map to response format
        const workerStatus = workers.map(w => {
            const workerType = w.item_id?.replace('worker_', '') || w.effect_type?.replace('auto_', '');
            const info = WORKER_TYPES[workerType] || {};

            return {
                id: w.id,
                type: workerType,
                itemId: w.item_id,
                name: w.item_name || info.name,
                description: info.description,
                effect: w.effect_type,
                interval: w.worker_interval,
                enabled: w.is_enabled === 1 || w.is_enabled === true,
                lastRun: w.last_worker_run,
                purchasedAt: w.purchased_at,
                nextRunAt: w.last_worker_run
                    ? new Date(new Date(w.last_worker_run).getTime() + w.worker_interval)
                    : null
            };
        });

        res.json({
            success: true,
            workers: workerStatus
        });

    } catch (error) {
        logger.error('[Workers] Get status failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /workers/logs
 * Get worker activity logs
 */
router.get('/logs', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { limit = 50, workerType } = req.query;

        let query = `
            SELECT id, worker_type, action, items_processed, cash_earned,
                   details, performed_at
            FROM cfx_worker_logs
            WHERE player_id = ?
        `;
        const params = [playerId];

        if (workerType) {
            query += ' AND worker_type = ?';
            params.push(workerType);
        }

        query += ' ORDER BY performed_at DESC LIMIT ?';
        params.push(parseInt(limit));

        const [logs] = await pool.execute(query, params);

        // Calculate stats (ensure numeric parsing to avoid string concatenation)
        let totalEarned = 0;
        let totalHarvested = 0;
        let totalPlanted = 0;
        let totalSold = 0;

        for (const log of logs) {
            totalEarned += parseFloat(log.cash_earned) || 0;
            if (log.worker_type === 'trimmer') totalHarvested += parseInt(log.items_processed) || 0;
            if (log.worker_type === 'propagation_tech') totalPlanted += parseInt(log.items_processed) || 0;
            if (log.worker_type === 'sales_rep') totalSold += parseInt(log.items_processed) || 0;
        }

        res.json({
            success: true,
            logs: logs.map(l => ({
                id: l.id,
                workerType: l.worker_type,
                action: l.action,
                itemsProcessed: l.items_processed,
                cashEarned: parseFloat(l.cash_earned) || 0,
                details: l.details ? JSON.parse(l.details) : null,
                performedAt: l.performed_at
            })),
            stats: {
                totalEarned,
                totalHarvested,
                totalPlanted,
                totalSold
            }
        });

    } catch (error) {
        logger.error('[Workers] Get logs failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * Helper: Log worker action
 */
export async function logWorkerAction(playerId, workerType, action, itemsProcessed = 0, cashEarned = 0, details = null) {
    try {
        await pool.execute(
            `INSERT INTO cfx_worker_logs (player_id, worker_type, action, items_processed, cash_earned, details)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [playerId, workerType, action, itemsProcessed, cashEarned, details ? JSON.stringify(details) : null]
        );
    } catch (error) {
        logger.error('[Workers] Log action failed', { error: error.message });
    }
}

/**
 * GET /workers/config
 * Get worker configuration including auto-replant settings
 */
router.get('/config', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get player settings (create if not exists)
        let [[settings]] = await pool.execute(
            `SELECT auto_replant_enabled, auto_replant_strain_id, auto_replant_use_favorite
             FROM cfx_player_settings WHERE player_id = ?`,
            [playerId]
        );

        if (!settings) {
            // Create default settings
            await pool.execute(
                `INSERT INTO cfx_player_settings (player_id) VALUES (?)
                 ON DUPLICATE KEY UPDATE player_id = player_id`,
                [playerId]
            );
            settings = {
                auto_replant_enabled: false,
                auto_replant_strain_id: null,
                auto_replant_use_favorite: false
            };
        }

        // Get strain info if a specific strain is selected
        let selectedStrain = null;
        if (settings.auto_replant_strain_id) {
            const [[strain]] = await pool.execute(
                'SELECT id, name, slug, rarity FROM cfx_strains WHERE id = ?',
                [settings.auto_replant_strain_id]
            );
            selectedStrain = strain || null;
        }

        res.json({
            success: true,
            config: {
                autoReplantEnabled: !!settings.auto_replant_enabled,
                autoReplantStrainId: settings.auto_replant_strain_id,
                autoReplantUseFavorite: !!settings.auto_replant_use_favorite,
                selectedStrain
            }
        });

    } catch (error) {
        logger.error('[Workers] Get config failed', { error: error.message });
        res.status(500).json({ error: 'Failed to get config', code: 'ERROR' });
    }
});

/**
 * PUT /workers/config
 * Update worker configuration
 */
router.put('/config', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { autoReplantEnabled, autoReplantStrainId, autoReplantUseFavorite } = req.body;

        // Validate strain exists if specified
        if (autoReplantStrainId && !autoReplantUseFavorite) {
            const [[strain]] = await pool.execute(
                'SELECT id FROM cfx_strains WHERE id = ?',
                [autoReplantStrainId]
            );
            if (!strain) {
                return res.status(400).json({ error: 'Invalid strain', code: 'INVALID_STRAIN' });
            }
        }

        // Upsert settings
        await pool.execute(
            `INSERT INTO cfx_player_settings (player_id, auto_replant_enabled, auto_replant_strain_id, auto_replant_use_favorite)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                auto_replant_enabled = VALUES(auto_replant_enabled),
                auto_replant_strain_id = VALUES(auto_replant_strain_id),
                auto_replant_use_favorite = VALUES(auto_replant_use_favorite)`,
            [
                playerId,
                autoReplantEnabled ? 1 : 0,
                autoReplantUseFavorite ? null : (autoReplantStrainId || null),
                autoReplantUseFavorite ? 1 : 0
            ]
        );

        logger.info('[Workers] Config updated', {
            playerId,
            autoReplantEnabled,
            autoReplantStrainId,
            autoReplantUseFavorite
        });

        res.json({
            success: true,
            message: 'Configuration saved'
        });

    } catch (error) {
        logger.error('[Workers] Update config failed', { error: error.message });
        res.status(500).json({ error: 'Failed to update config', code: 'ERROR' });
    }
});

/**
 * POST /workers/toggle
 * Enable or disable a worker
 */
router.post('/toggle', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { workerType, enabled } = req.body;

        if (!workerType) {
            return res.status(400).json({ error: 'Worker type required', code: 'INVALID_INPUT' });
        }

        // Map worker type to item_id pattern
        const itemId = `worker_${workerType}`;

        // Update worker status
        const [result] = await pool.execute(
            `UPDATE cfx_player_shop_items
             SET is_enabled = ?
             WHERE player_id = ? AND (item_id = ? OR item_id LIKE ?)`,
            [enabled ? 1 : 0, playerId, itemId, `%${workerType}%`]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Worker not found', code: 'NOT_FOUND' });
        }

        logger.info('[Workers] Toggle', {
            playerId,
            workerType,
            enabled
        });

        res.json({
            success: true,
            workerType,
            enabled
        });

    } catch (error) {
        logger.error('[Workers] Toggle failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
