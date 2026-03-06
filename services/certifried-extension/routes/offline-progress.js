/**
 * Offline Progress Routes
 * Shows what happened while the player was away
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /offline-progress
 * Get unshown offline progress summaries
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get unshown offline progress records
        const [records] = await pool.execute(
            `SELECT * FROM cfx_offline_progress
             WHERE player_id = ? AND shown_to_player = 0
             ORDER BY created_at DESC
             LIMIT 5`,
            [playerId]
        );

        if (records.length === 0) {
            return res.json({
                success: true,
                hasOfflineProgress: false,
                summary: null
            });
        }

        // Aggregate all unshown records
        let totalCashEarned = 0;
        let totalPlantsHarvested = 0;
        let totalSeedsPlanted = 0;
        let totalWithered = 0;
        let totalReady = 0;
        let totalOfflineMinutes = 0;

        for (const record of records) {
            totalCashEarned += parseFloat(record.workers_cash_earned) || 0;
            totalPlantsHarvested += record.workers_plants_harvested || 0;
            totalSeedsPlanted += record.workers_seeds_planted || 0;
            totalWithered += record.plants_withered || 0;
            totalReady += record.plants_ready || 0;

            const start = new Date(record.session_start);
            const end = new Date(record.session_end);
            totalOfflineMinutes += Math.round((end - start) / 60000);
        }

        res.json({
            success: true,
            hasOfflineProgress: true,
            summary: {
                offlineMinutes: totalOfflineMinutes,
                offlineHours: Math.round(totalOfflineMinutes / 60 * 10) / 10,
                workersCashEarned: totalCashEarned,
                workersPlantsHarvested: totalPlantsHarvested,
                workersSeedsPlanted: totalSeedsPlanted,
                plantsWithered: totalWithered,
                plantsReady: totalReady,
                recordIds: records.map(r => r.id)
            }
        });

    } catch (error) {
        logger.error('[OfflineProgress] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /offline-progress/dismiss
 * Mark offline progress as shown
 */
router.post('/dismiss', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { recordIds } = req.body;

        if (recordIds && recordIds.length > 0) {
            // Mark specific records as shown
            await pool.execute(
                `UPDATE cfx_offline_progress
                 SET shown_to_player = 1
                 WHERE player_id = ? AND id IN (${recordIds.map(() => '?').join(',')})`,
                [playerId, ...recordIds]
            );
        } else {
            // Mark all as shown
            await pool.execute(
                `UPDATE cfx_offline_progress
                 SET shown_to_player = 1
                 WHERE player_id = ? AND shown_to_player = 0`,
                [playerId]
            );
        }

        res.json({ success: true });

    } catch (error) {
        logger.error('[OfflineProgress] Dismiss failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * Helper: Record offline progress when player comes online
 * Called by game-state.js when loading
 */
export async function recordOfflineProgress(playerId, lastOnline) {
    try {
        if (!lastOnline) return null;

        const lastOnlineTime = new Date(lastOnline);
        const now = new Date();
        const offlineMs = now - lastOnlineTime;

        // Only record if offline for at least 5 minutes
        if (offlineMs < 5 * 60 * 1000) return null;

        // Check for plants that became ready or withered
        const [[plantStatus]] = await pool.execute(
            `SELECT
                SUM(CASE WHEN status = 'ready' OR (ready_at IS NOT NULL AND ready_at <= NOW()) THEN 1 ELSE 0 END) as ready_count,
                SUM(CASE WHEN status = 'withered' OR status = 'withering' THEN 1 ELSE 0 END) as withered_count
             FROM cfx_grow_slots
             WHERE player_id = ? AND status != 'empty'`,
            [playerId]
        );

        // Get worker earnings from BOTH legacy worker logs and enhanced worker action logs
        const [[legacyWorkerStats]] = await pool.execute(
            `SELECT
                SUM(cash_earned) as total_cash,
                SUM(CASE WHEN worker_type = 'trimmer' THEN items_processed ELSE 0 END) as harvested,
                SUM(CASE WHEN worker_type = 'propagation_tech' THEN items_processed ELSE 0 END) as planted
             FROM cfx_worker_logs
             WHERE player_id = ? AND performed_at >= ?`,
            [playerId, lastOnlineTime]
        );

        const [[enhancedWorkerStats]] = await pool.execute(
            `SELECT
                SUM(cash_earned) as total_cash,
                SUM(CASE WHEN action_type = 'auto_harvest' THEN items_processed ELSE 0 END) as harvested,
                SUM(CASE WHEN action_type = 'auto_plant' THEN items_processed ELSE 0 END) as planted
             FROM cfx_worker_action_log
             WHERE player_id = ? AND performed_at >= ?`,
            [playerId, lastOnlineTime]
        );

        // Combine both worker systems
        const cashEarned = (parseFloat(legacyWorkerStats?.total_cash) || 0) +
                          (parseFloat(enhancedWorkerStats?.total_cash) || 0);
        const harvested = (legacyWorkerStats?.harvested || 0) + (enhancedWorkerStats?.harvested || 0);
        const planted = (legacyWorkerStats?.planted || 0) + (enhancedWorkerStats?.planted || 0);
        const ready = plantStatus?.ready_count || 0;
        const withered = plantStatus?.withered_count || 0;

        // Only create record if something happened
        if (cashEarned > 0 || harvested > 0 || planted > 0 || ready > 0 || withered > 0) {
            await pool.execute(
                `INSERT INTO cfx_offline_progress
                 (player_id, session_start, session_end, workers_cash_earned, workers_plants_harvested,
                  workers_seeds_planted, plants_withered, plants_ready)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [playerId, lastOnlineTime, now, cashEarned, harvested, planted, withered, ready]
            );

            return {
                offlineMinutes: Math.round(offlineMs / 60000),
                cashEarned,
                harvested,
                planted,
                ready,
                withered
            };
        }

        return null;

    } catch (error) {
        logger.error('[OfflineProgress] Record failed', { playerId, error: error.message });
        return null;
    }
}

export default router;
