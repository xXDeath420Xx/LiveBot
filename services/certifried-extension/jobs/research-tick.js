/**
 * Research Tick Job
 * Auto-completes research that has finished
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { invalidateBonusCache } from '../game/bonus-resolver.js';

/**
 * Check and auto-complete research that is done
 */
export async function researchTick() {
    const startTime = Date.now();
    let completedCount = 0;

    try {
        // Find all research that has passed its completion time but is still 'researching'
        const [readyResearch] = await pool.execute(`
            SELECT pr.id, pr.player_id, pr.research_id, pr.completes_at,
                   rn.name as research_name, rn.unlock_type, rn.unlock_key, rn.unlock_value
            FROM cfx_player_research pr
            JOIN cfx_research_nodes rn ON pr.research_id = rn.id
            WHERE pr.status = 'researching' AND pr.completes_at <= NOW()
        `);

        if (readyResearch.length > 0) {
            logger.info('[ResearchTick] Found completed research', { count: readyResearch.length });

            for (const research of readyResearch) {
                try {
                    // Mark as completed
                    await pool.execute(`
                        UPDATE cfx_player_research
                        SET status = 'completed', completed_at = NOW()
                        WHERE id = ?
                    `, [research.id]);

                    completedCount++;

                    logger.info('[ResearchTick] Auto-completed research', {
                        playerId: research.player_id,
                        researchName: research.research_name
                    });

                    // Invalidate bonus cache so new research bonuses apply immediately
                    invalidateBonusCache(research.player_id);
                } catch (err) {
                    logger.error('[ResearchTick] Failed to complete research', {
                        researchId: research.id,
                        error: err.message
                    });
                }
            }
        }

        // Also check for and auto-complete worker training
        const [readyTraining] = await pool.execute(`
            SELECT wtr.id, wtr.player_id, wtr.worker_id, wtr.trait_id, wtr.target_level,
                   wt.name as trait_name, wt.effect_type, wt.effect_value_per_level,
                   pw.name as worker_name
            FROM cfx_worker_training wtr
            JOIN cfx_worker_traits wt ON wtr.trait_id = wt.id
            JOIN cfx_player_workers pw ON wtr.worker_id = pw.id
            WHERE wtr.status = 'in_progress' AND wtr.completes_at <= NOW()
        `);

        if (readyTraining.length > 0) {
            logger.info('[ResearchTick] Found completed training', { count: readyTraining.length });

            for (const training of readyTraining) {
                const conn = await pool.getConnection();
                try {
                    await conn.beginTransaction();

                    // Update trait level
                    await conn.execute(`
                        UPDATE cfx_worker_trait_levels
                        SET current_level = ?, training_progress = 0
                        WHERE worker_id = ? AND trait_id = ?
                    `, [training.target_level, training.worker_id, training.trait_id]);

                    // Mark training complete
                    await conn.execute(`
                        UPDATE cfx_worker_training SET status = 'completed' WHERE id = ?
                    `, [training.id]);

                    // Update worker - clear training flag
                    await conn.execute(`
                        UPDATE cfx_player_workers SET is_training = FALSE, training_completes_at = NULL WHERE id = ?
                    `, [training.worker_id]);

                    // Apply trait effects to worker stats
                    const effectValue = parseFloat(training.effect_value_per_level);
                    switch (training.effect_type) {
                        case 'interval_reduction':
                            await conn.execute(`
                                UPDATE cfx_player_workers
                                SET current_interval_ms = FLOOR(current_interval_ms * (1 - ?))
                                WHERE id = ?
                            `, [effectValue, training.worker_id]);
                            break;
                        case 'capacity_bonus':
                            await conn.execute(`
                                UPDATE cfx_player_workers
                                SET current_capacity = current_capacity + ?
                                WHERE id = ?
                            `, [Math.floor(effectValue), training.worker_id]);
                            break;
                        case 'efficiency_bonus':
                            await conn.execute(`
                                UPDATE cfx_player_workers
                                SET current_efficiency = current_efficiency + ?
                                WHERE id = ?
                            `, [effectValue, training.worker_id]);
                            break;
                        case 'quality_bonus':
                            await conn.execute(`
                                UPDATE cfx_player_workers
                                SET current_quality_bonus = current_quality_bonus + ?
                                WHERE id = ?
                            `, [effectValue, training.worker_id]);
                            break;
                    }

                    await conn.commit();

                    // Invalidate bonus cache so new worker bonuses apply immediately
                    invalidateBonusCache(training.player_id);

                    logger.info('[ResearchTick] Auto-completed worker training', {
                        playerId: training.player_id,
                        workerName: training.worker_name,
                        traitName: training.trait_name,
                        level: training.target_level
                    });
                } catch (err) {
                    await conn.rollback();
                    logger.error('[ResearchTick] Failed to complete training', {
                        trainingId: training.id,
                        error: err.message
                    });
                } finally {
                    conn.release();
                }
            }
        }

        const duration = Date.now() - startTime;
        if (completedCount > 0 || readyTraining.length > 0) {
            logger.info('[ResearchTick] Completed', {
                researchCompleted: completedCount,
                trainingCompleted: readyTraining.length,
                durationMs: duration
            });
        }

    } catch (error) {
        logger.error('[ResearchTick] Error', { error: error.message });
    }
}

export default researchTick;
