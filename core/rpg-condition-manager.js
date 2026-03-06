/**
 * RPG Condition Manager
 * Handles D&D 5e conditions and status effects
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';

class RPGConditionManager {
    // Cache conditions on load
    static conditionsCache = null;

    /**
     * Load all conditions into cache
     */
    static async loadConditions() {
        if (this.conditionsCache) return this.conditionsCache;

        const [conditions] = await pool.execute('SELECT * FROM dnd_conditions');
        this.conditionsCache = new Map();

        for (const c of conditions) {
            this.conditionsCache.set(c.condition_name.toLowerCase(), {
                ...c,
                effects: typeof c.mechanical_effects === 'string' ? JSON.parse(c.mechanical_effects) : c.mechanical_effects
            });
        }

        return this.conditionsCache;
    }

    /**
     * Get condition info
     * @param {string} conditionName - Condition name
     * @returns {object|null} Condition data
     */
    static async getCondition(conditionName) {
        await this.loadConditions();
        return this.conditionsCache.get(conditionName.toLowerCase()) || null;
    }

    /**
     * Get all conditions
     * @returns {array} All conditions
     */
    static async getAllConditions() {
        await this.loadConditions();
        return Array.from(this.conditionsCache.values());
    }

    /**
     * Apply condition to character
     * @param {number} characterId - Character ID
     * @param {string} conditionName - Condition name
     * @param {object} options - Duration, source, etc.
     */
    static async applyToCharacter(characterId, conditionName, options = {}) {
        const { duration, source, saveDC, saveType, combatId } = options;

        const condition = await this.getCondition(conditionName);
        if (!condition) {
            throw new Error(`Unknown condition: ${conditionName}`);
        }

        // Check if already has condition
        const [existing] = await pool.execute(
            `SELECT id FROM dnd_active_conditions
             WHERE character_id = ? AND condition_id = ? AND (combat_id = ? OR combat_id IS NULL)`,
            [characterId, condition.condition_id, combatId || null]
        );

        if (existing.length > 0) {
            // Refresh duration
            await pool.execute(
                'UPDATE dnd_active_conditions SET duration_rounds = ?, applied_at = NOW() WHERE id = ?',
                [duration || null, existing[0].id]
            );
            return { refreshed: true, condition: conditionName };
        }

        await pool.execute(
            `INSERT INTO dnd_active_conditions
             (character_id, condition_id, combat_id, source, duration_rounds, save_dc, save_type)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [characterId, condition.condition_id, combatId || null, source || null, duration || null, saveDC || null, saveType || null]
        );

        logger.info('[Conditions] Applied condition', { characterId, condition: conditionName });
        return { applied: true, condition: conditionName, effects: condition.effects };
    }

    /**
     * Remove condition from character
     * @param {number} characterId - Character ID
     * @param {string} conditionName - Condition name
     */
    static async removeFromCharacter(characterId, conditionName) {
        const condition = await this.getCondition(conditionName);
        if (!condition) {
            throw new Error(`Unknown condition: ${conditionName}`);
        }

        await pool.execute(
            'DELETE FROM dnd_active_conditions WHERE character_id = ? AND condition_id = ?',
            [characterId, condition.condition_id]
        );

        return { removed: conditionName };
    }

    /**
     * Get all active conditions for character
     * @param {number} characterId - Character ID
     * @returns {array} Active conditions
     */
    static async getCharacterConditions(characterId) {
        const [conditions] = await pool.execute(
            `SELECT ac.*, c.condition_name, c.description, c.mechanical_effects, c.icon_emoji
             FROM dnd_active_conditions ac
             JOIN dnd_conditions c ON ac.condition_id = c.condition_id
             WHERE ac.character_id = ?`,
            [characterId]
        );

        return conditions.map(c => ({
            name: c.condition_name,
            description: c.description,
            emoji: c.icon_emoji,
            effects: typeof c.mechanical_effects === 'string' ? JSON.parse(c.mechanical_effects) : c.mechanical_effects,
            source: c.source,
            durationRemaining: c.duration_rounds,
            saveDC: c.save_dc,
            saveType: c.save_type
        }));
    }

    /**
     * Check if character has a specific condition effect
     * @param {number} characterId - Character ID
     * @param {string} effectKey - Effect to check for
     * @returns {boolean} Has effect
     */
    static async hasEffect(characterId, effectKey) {
        const conditions = await this.getCharacterConditions(characterId);

        for (const c of conditions) {
            if (c.effects && c.effects[effectKey]) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get all effects currently affecting character
     * @param {number} characterId - Character ID
     * @returns {object} Combined effects
     */
    static async getActiveEffects(characterId) {
        const conditions = await this.getCharacterConditions(characterId);
        const combinedEffects = {};

        for (const c of conditions) {
            if (c.effects) {
                for (const [key, value] of Object.entries(c.effects)) {
                    if (typeof value === 'boolean' && value) {
                        combinedEffects[key] = true;
                    } else if (typeof value === 'number') {
                        combinedEffects[key] = (combinedEffects[key] || 0) + value;
                    }
                }
            }
        }

        return combinedEffects;
    }

    /**
     * Process end of turn - decrement durations
     * @param {number} characterId - Character ID
     * @param {number} combatId - Combat ID (optional)
     * @returns {array} Expired conditions
     */
    static async processEndOfTurn(characterId, combatId = null) {
        // Decrement durations
        await pool.execute(
            `UPDATE dnd_active_conditions
             SET duration_rounds = duration_rounds - 1
             WHERE character_id = ? AND duration_rounds IS NOT NULL
             ${combatId ? 'AND combat_id = ?' : ''}`,
            combatId ? [characterId, combatId] : [characterId]
        );

        // Get and remove expired conditions
        const [expired] = await pool.execute(
            `SELECT ac.*, c.condition_name FROM dnd_active_conditions ac
             JOIN dnd_conditions c ON ac.condition_id = c.condition_id
             WHERE ac.character_id = ? AND ac.duration_rounds IS NOT NULL AND ac.duration_rounds <= 0`,
            [characterId]
        );

        if (expired.length > 0) {
            await pool.execute(
                'DELETE FROM dnd_active_conditions WHERE character_id = ? AND duration_rounds IS NOT NULL AND duration_rounds <= 0',
                [characterId]
            );
        }

        return expired.map(e => e.condition_name);
    }

    /**
     * Clear all combat conditions for character
     * @param {number} characterId - Character ID
     * @param {number} combatId - Combat ID
     */
    static async clearCombatConditions(characterId, combatId) {
        await pool.execute(
            'DELETE FROM dnd_active_conditions WHERE character_id = ? AND combat_id = ?',
            [characterId, combatId]
        );
    }
}

export default RPGConditionManager;
export { RPGConditionManager };
