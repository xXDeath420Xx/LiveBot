/*
 * A server's quiz questions: the built-in bank with that server's changes (digimon_quiz_questions, edited on
 * the dashboard's Digimon quiz questions page). Shared by /digimon today and the dashboard.
 */
import pool from '../utils/db.js';
import { buildBank } from './digimon-quiz.js';

export async function quizRows(guildId) {
    const [rows] = await pool.execute(
        'SELECT id, builtin_index, cat, q, options, enabled, updated_at FROM digimon_quiz_questions WHERE guild_id = ? ORDER BY id', [guildId]);
    return rows;
}

/** The questions /digimon today draws from in this server. */
export async function loadQuizBank(guildId) {
    return buildBank(await quizRows(guildId));
}
