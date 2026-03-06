/**
 * Quest Assignment System
 * Handles assigning daily/weekly quests to players and tracking progress
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Assign quests to a player
 * Called on login/reconnect to ensure player has active quests
 * @param {number} playerId - Player ID
 * @returns {object} Quest assignment results
 */
export async function assignQuests(playerId) {
    const results = {
        dailyAssigned: [],
        weeklyAssigned: [],
        achievementAssigned: []
    };

    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date(startOfDay);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sunday start

        // Get player level
        const [[player]] = await pool.execute(
            'SELECT level FROM cfx_players WHERE id = ?',
            [playerId]
        );

        if (!player) return results;

        // === DAILY QUESTS ===
        // Check if player already has daily quests assigned today
        const [existingDaily] = await pool.execute(
            `SELECT pq.id FROM cfx_player_quests pq
             JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
             WHERE pq.player_id = ? AND qd.quest_type = 'daily'
             AND DATE(pq.assigned_at) = CURDATE()
             AND pq.status IN ('active', 'completed')`,
            [playerId]
        );

        if (existingDaily.length === 0) {
            // Assign new daily quests (pick 3 random ones player qualifies for)
            const [dailyQuests] = await pool.execute(
                `SELECT id FROM cfx_quest_definitions
                 WHERE quest_type = 'daily' AND is_active = 1 AND min_level <= ?
                 ORDER BY RAND() LIMIT 3`,
                [player.level]
            );

            for (const quest of dailyQuests) {
                // Get target from quest definition
                const [[questDef]] = await pool.execute(
                    'SELECT objective_target FROM cfx_quest_definitions WHERE id = ?',
                    [quest.id]
                );

                const expiresAt = new Date(startOfDay);
                expiresAt.setDate(expiresAt.getDate() + 1); // Expires at midnight

                await pool.execute(
                    `INSERT INTO cfx_player_quests (player_id, quest_id, target, expires_at)
                     VALUES (?, ?, ?, ?)`,
                    [playerId, quest.id, questDef.objective_target, expiresAt]
                );
                results.dailyAssigned.push(quest.id);
            }

            if (dailyQuests.length > 0) {
                logger.info('[Quests] Assigned daily quests', {
                    playerId,
                    count: dailyQuests.length
                });
            }
        }

        // === WEEKLY QUESTS ===
        // Check if player already has weekly quests this week
        const [existingWeekly] = await pool.execute(
            `SELECT pq.id FROM cfx_player_quests pq
             JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
             WHERE pq.player_id = ? AND qd.quest_type = 'weekly'
             AND pq.assigned_at >= ?
             AND pq.status IN ('active', 'completed')`,
            [playerId, startOfWeek]
        );

        if (existingWeekly.length === 0) {
            // Assign new weekly quests (pick 2 random ones)
            const [weeklyQuests] = await pool.execute(
                `SELECT id FROM cfx_quest_definitions
                 WHERE quest_type = 'weekly' AND is_active = 1 AND min_level <= ?
                 ORDER BY RAND() LIMIT 2`,
                [player.level]
            );

            for (const quest of weeklyQuests) {
                const [[questDef]] = await pool.execute(
                    'SELECT objective_target FROM cfx_quest_definitions WHERE id = ?',
                    [quest.id]
                );

                const expiresAt = new Date(startOfWeek);
                expiresAt.setDate(expiresAt.getDate() + 7); // Expires in 7 days

                await pool.execute(
                    `INSERT INTO cfx_player_quests (player_id, quest_id, target, expires_at)
                     VALUES (?, ?, ?, ?)`,
                    [playerId, quest.id, questDef.objective_target, expiresAt]
                );
                results.weeklyAssigned.push(quest.id);
            }

            if (weeklyQuests.length > 0) {
                logger.info('[Quests] Assigned weekly quests', {
                    playerId,
                    count: weeklyQuests.length
                });
            }
        }

        // === ACHIEVEMENT QUESTS (one-time) ===
        // Assign any achievement quests the player hasn't started yet
        const [unassignedAchievements] = await pool.execute(
            `SELECT qd.id FROM cfx_quest_definitions qd
             WHERE qd.quest_type = 'achievement' AND qd.is_active = 1 AND qd.min_level <= ?
             AND qd.id NOT IN (
                SELECT quest_id FROM cfx_player_quests WHERE player_id = ?
             )`,
            [player.level, playerId]
        );

        for (const quest of unassignedAchievements) {
            const [[questDef]] = await pool.execute(
                'SELECT objective_target FROM cfx_quest_definitions WHERE id = ?',
                [quest.id]
            );

            await pool.execute(
                `INSERT INTO cfx_player_quests (player_id, quest_id, target)
                 VALUES (?, ?, ?)`,
                [playerId, quest.id, questDef.objective_target]
            );
            results.achievementAssigned.push(quest.id);
        }

        if (unassignedAchievements.length > 0) {
            logger.info('[Quests] Assigned achievement quests', {
                playerId,
                count: unassignedAchievements.length
            });
        }

        // Expire old quests
        await pool.execute(
            `UPDATE cfx_player_quests
             SET status = 'expired'
             WHERE player_id = ?
             AND status = 'active'
             AND expires_at IS NOT NULL
             AND expires_at < NOW()`,
            [playerId]
        );

    } catch (error) {
        logger.error('[Quests] Assignment failed', {
            playerId,
            error: error.message
        });
    }

    return results;
}

/**
 * Update quest progress for a player
 * @param {number} playerId - Player ID
 * @param {string} objectiveType - Type of objective ('harvest_count', 'sell_value', etc.)
 * @param {number} amount - Amount to add to progress
 * @param {object} params - Additional params (strain_rarity, quality, etc.)
 */
export async function updateQuestProgress(playerId, objectiveType, amount, params = {}) {
    try {
        // Get all active quests matching this objective type
        const [quests] = await pool.execute(
            `SELECT pq.id, pq.progress, pq.target, qd.objective_type, qd.objective_params
             FROM cfx_player_quests pq
             JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
             WHERE pq.player_id = ?
             AND pq.status = 'active'
             AND qd.objective_type = ?`,
            [playerId, objectiveType]
        );

        for (const quest of quests) {
            // Check if quest params match (for filtered objectives)
            if (quest.objective_params) {
                const questParams = typeof quest.objective_params === 'string'
                    ? JSON.parse(quest.objective_params)
                    : quest.objective_params;

                // Check strain_rarity
                if (questParams.strain_rarity && params.rarity) {
                    const rarityOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
                    const requiredRarity = rarityOrder.indexOf(questParams.strain_rarity);
                    const actualRarity = rarityOrder.indexOf(params.rarity);
                    if (actualRarity < requiredRarity) continue;
                }

                // Check min_quality
                if (questParams.min_quality && params.quality) {
                    if (params.quality < questParams.min_quality) continue;
                }
            }

            // Update progress
            const newProgress = Math.min(quest.progress + amount, quest.target);

            await pool.execute(
                `UPDATE cfx_player_quests SET progress = ? WHERE id = ?`,
                [newProgress, quest.id]
            );

            // Check if completed
            if (newProgress >= quest.target) {
                await pool.execute(
                    `UPDATE cfx_player_quests SET status = 'completed', completed_at = NOW() WHERE id = ?`,
                    [quest.id]
                );

                logger.info('[Quests] Quest completed', {
                    playerId,
                    questId: quest.id
                });
            }
        }

    } catch (error) {
        logger.error('[Quests] Progress update failed', {
            playerId,
            objectiveType,
            error: error.message
        });
    }
}

export default { assignQuests, updateQuestProgress };
