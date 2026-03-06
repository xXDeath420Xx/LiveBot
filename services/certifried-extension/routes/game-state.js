/**
 * Game State Routes
 * Full state retrieval and delta updates
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getFullGameState, processOfflineCatchUp } from '../game/engine.js';
import { trackStat } from './stats.js';
import { checkAchievements } from './achievements.js';
import { recordOfflineProgress } from './offline-progress.js';

const router = Router();

/**
 * GET /game/state
 * Get full game state for the player
 * Called on initial load and reconnection
 */
router.get('/state', async (req, res) => {
    try {
        // Record offline progress before loading state
        try {
            const [[playerOnline]] = await pool.execute(
                'SELECT last_online_at FROM cfx_players WHERE id = ?', [req.player.id]
            );
            await recordOfflineProgress(req.player.id, playerOnline?.last_online_at);
            await pool.execute('UPDATE cfx_players SET last_online_at = NOW() WHERE id = ?', [req.player.id]);
        } catch (offlineErr) {
            logger.warn('[GameState] Offline progress failed', { error: offlineErr.message });
        }

        const state = await getFullGameState(req.player.id);

        // Track login and update last_login_at in stats
        try {
            await pool.execute(
                `INSERT INTO cfx_player_stats (player_id, last_login_at, total_login_days)
                 VALUES (?, NOW(), 1)
                 ON DUPLICATE KEY UPDATE
                 last_login_at = NOW(),
                 total_login_days = total_login_days + IF(DATE(last_login_at) < CURDATE(), 1, 0)`,
                [req.player.id]
            );
            // Check achievements on login
            checkAchievements(req.player.id).catch(() => {});
        } catch (statErr) {
            logger.warn('[GameState] Stats update failed', { error: statErr.message });
        }

        res.json({
            success: true,
            ...state
        });

    } catch (error) {
        logger.error('[GameState] Failed to get state', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to load game state', code: 'STATE_ERROR' });
    }
});

/**
 * GET /game/tick
 * Process offline catch-up and return delta updates
 * Lighter than full state, used for periodic syncs
 */
router.get('/tick', async (req, res) => {
    try {
        const catchUp = await processOfflineCatchUp(req.player.id);

        // Get updated slots and inventory counts
        const pool = (await import('../../../utils/db.js')).default;

        const [slots] = await pool.execute(
            `SELECT gs.*, s.name as strain_name
             FROM cfx_grow_slots gs
             LEFT JOIN cfx_strains s ON gs.strain_id = s.id
             WHERE gs.player_id = ?
             ORDER BY gs.slot_number`,
            [req.player.id]
        );

        const [[player]] = await pool.execute(
            'SELECT cash, xp, level FROM cfx_players WHERE id = ?',
            [req.player.id]
        );

        res.json({
            success: true,
            catchUp,
            player: {
                cash: player.cash,
                xp: player.xp,
                level: player.level
            },
            slots: slots.map(s => ({
                slotNumber: s.slot_number,
                status: s.status,
                strainId: s.strain_id,
                strainName: s.strain_name,
                readyAt: s.ready_at,
                witherAt: s.wither_at,
                accumulatedGrowthMs: s.accumulated_growth_ms,
                growDurationMs: s.grow_duration_ms
            })),
            serverTime: Date.now()
        });

    } catch (error) {
        logger.error('[GameState] Tick failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Tick failed', code: 'TICK_ERROR' });
    }
});

/**
 * POST /game/tutorial/complete
 * Mark tutorial as completed
 */
router.post('/tutorial/complete', async (req, res) => {
    try {
        const pool = (await import('../../../utils/db.js')).default;

        await pool.execute(
            'UPDATE cfx_players SET tutorial_completed = 1 WHERE id = ?',
            [req.player.id]
        );

        res.json({ success: true });

    } catch (error) {
        logger.error('[GameState] Tutorial complete failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
