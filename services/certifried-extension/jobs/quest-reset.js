/**
 * Quest Reset Job
 * Resets daily/weekly quests and assigns new ones
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { QUESTS } from '../config/game-constants.js';

/**
 * Reset quests of specified type
 * @param {'daily' | 'weekly'} type - Quest type to reset
 */
export async function questReset(type) {
    const start = Date.now();

    // Expire old quests
    await pool.execute(
        `UPDATE cfx_player_quests pq
         JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
         SET pq.status = 'expired'
         WHERE qd.quest_type = ? AND pq.status IN ('active', 'completed')`,
        [type]
    );

    // Get all active players (active in last 7 days)
    const [players] = await pool.execute(
        `SELECT id, level FROM cfx_players
         WHERE is_banned = 0 AND last_online_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    // Get available quests of this type
    const [quests] = await pool.execute(
        `SELECT id, objective_target, min_level FROM cfx_quest_definitions
         WHERE quest_type = ? AND is_active = 1`,
        [type]
    );

    if (quests.length === 0) {
        logger.warn('[QuestReset] No quests available for type', { type });
        return;
    }

    const questCount = type === 'daily' ? QUESTS.DAILY_QUEST_COUNT : QUESTS.WEEKLY_QUEST_COUNT;
    const expiresAt = type === 'daily'
        ? new Date(Date.now() + 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    let assigned = 0;

    for (const player of players) {
        // Filter quests by player level
        const eligible = quests.filter(q => q.min_level <= player.level);
        if (eligible.length === 0) continue;

        // Randomly select quests
        const shuffled = eligible.sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, Math.min(questCount, shuffled.length));

        for (const quest of selected) {
            await pool.execute(
                `INSERT INTO cfx_player_quests (player_id, quest_id, target, expires_at)
                 VALUES (?, ?, ?, ?)`,
                [player.id, quest.id, quest.objective_target, expiresAt]
            );
            assigned++;
        }
    }

    logger.info('[QuestReset] Complete', {
        type,
        players: players.length,
        questsAssigned: assigned,
        duration: Date.now() - start
    });
}

export default questReset;
