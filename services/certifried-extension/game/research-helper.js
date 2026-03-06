/**
 * Research Helper Functions
 * Shared functions to avoid circular dependencies
 */

import pool from '../../../utils/db.js';

/**
 * Check if player has completed a specific research
 * @param {number} playerId
 * @param {string} researchKey
 * @returns {Promise<boolean>}
 */
export async function hasResearch(playerId, researchKey) {
    const [rows] = await pool.execute(`
        SELECT 1 FROM cfx_player_research pr
        JOIN cfx_research_nodes rn ON pr.research_id = rn.id
        WHERE pr.player_id = ? AND rn.research_key = ? AND pr.status = 'completed'
        LIMIT 1
    `, [playerId, researchKey]);

    return rows.length > 0;
}

/**
 * Get all research bonuses for a player
 * @param {number} playerId
 * @returns {Promise<Object>} Object with bonus keys and values
 */
/**
 * Check if player has unlocked a feature via research OR skill
 * @param {number} playerId
 * @param {string} featureKey - The feature key (e.g., 'extraction', 'breeding', 'black_market')
 * @returns {Promise<boolean>}
 */
export async function hasFeatureUnlock(playerId, featureKey) {
    // First check research nodes with feature unlock
    const [researchRows] = await pool.execute(`
        SELECT 1 FROM cfx_player_research pr
        JOIN cfx_research_nodes rn ON pr.research_id = rn.id
        WHERE pr.player_id = ?
          AND rn.unlock_type = 'feature'
          AND rn.unlock_key = ?
          AND pr.status = 'completed'
        LIMIT 1
    `, [playerId, featureKey]);

    if (researchRows.length > 0) return true;

    // Also check for research with unlock_type matching the feature pattern
    const [altResearchRows] = await pool.execute(`
        SELECT 1 FROM cfx_player_research pr
        JOIN cfx_research_nodes rn ON pr.research_id = rn.id
        WHERE pr.player_id = ?
          AND (rn.unlock_type = ? OR rn.unlock_type = ?)
          AND pr.status = 'completed'
        LIMIT 1
    `, [playerId, `unlock_${featureKey}`, `${featureKey}_unlock`]);

    return altResearchRows.length > 0;
}

/**
 * Get all research bonuses for a player
 * @param {number} playerId
 * @returns {Promise<Object>} Object with bonus keys and values
 */
export async function getResearchBonuses(playerId) {
    const [rows] = await pool.execute(`
        SELECT rn.unlock_type, rn.unlock_key, rn.unlock_value
        FROM cfx_player_research pr
        JOIN cfx_research_nodes rn ON pr.research_id = rn.id
        WHERE pr.player_id = ? AND pr.status = 'completed' AND rn.unlock_type = 'bonus'
    `, [playerId]);

    const bonuses = {};
    for (const row of rows) {
        if (!bonuses[row.unlock_key]) {
            bonuses[row.unlock_key] = 0;
        }
        bonuses[row.unlock_key] += parseFloat(row.unlock_value) || 0;
    }

    return bonuses;
}

export default { hasResearch, hasFeatureUnlock, getResearchBonuses };
