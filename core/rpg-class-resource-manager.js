/**
 * RPG Class Resource Manager
 * Handles class-specific resources like Ki, Rage, Bardic Inspiration, etc.
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import RPGConditionManager from './rpg-condition-manager.js';
import { normalizeClassName } from './rpg-spell-manager.js';

// Resources that put the character under a named dnd_conditions entry when used.
// Rage lasts 1 minute = 10 combat rounds.
const RESOURCE_CONDITIONS = {
    'rage': { condition: 'raging', durationRounds: 10 }
};

/** Stable per-resource key for dnd_class_resources.resource_type (unique per character). */
function resourceTypeKey(name) {
    return String(name || 'class').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'class';
}

// Class resource definitions
const CLASS_RESOURCES = {
    'Barbarian': {
        name: 'Rage',
        levels: {
            1: 2, 2: 2, 3: 3, 4: 3, 5: 3, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4,
            11: 4, 12: 5, 13: 5, 14: 5, 15: 5, 16: 5, 17: 6, 18: 6, 19: 6, 20: -1 // -1 = unlimited
        },
        restoreOn: 'long',
        description: 'Enter a rage for extra damage and resistance'
    },
    'Bard': {
        name: 'Bardic Inspiration',
        levels: 'charisma_mod', // Uses ability modifier
        minimumMod: 1,
        restoreOn: 'long', // short at level 5+
        shortRestLevel: 5,
        description: 'Inspire allies with bonus dice'
    },
    'Cleric': {
        name: 'Channel Divinity',
        levels: {
            1: 0, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 2, 10: 2,
            11: 2, 12: 2, 13: 2, 14: 2, 15: 2, 16: 2, 17: 2, 18: 3, 19: 3, 20: 3
        },
        restoreOn: 'short',
        description: 'Channel divine energy'
    },
    'Druid': {
        name: 'Wild Shape',
        levels: {
            1: 0, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 2,
            11: 2, 12: 2, 13: 2, 14: 2, 15: 2, 16: 2, 17: 2, 18: 2, 19: 2, 20: -1
        },
        restoreOn: 'short',
        description: 'Transform into beasts'
    },
    'Fighter': {
        name: 'Action Surge',
        levels: {
            1: 0, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1,
            11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1, 17: 2, 18: 2, 19: 2, 20: 2
        },
        restoreOn: 'short',
        description: 'Take an additional action'
    },
    'Fighter_Second': {
        name: 'Second Wind',
        levels: { all: 1 },
        restoreOn: 'short',
        description: 'Heal yourself as a bonus action'
    },
    'Monk': {
        name: 'Ki',
        levels: 'level', // Equal to level
        minimumLevel: 2,
        restoreOn: 'short',
        description: 'Martial arts energy for special abilities'
    },
    'Paladin': {
        name: 'Lay on Hands',
        levels: 'level_x5', // Level × 5
        restoreOn: 'long',
        description: 'Healing pool'
    },
    'Paladin_Smite': {
        name: 'Divine Sense',
        levels: 'charisma_mod_plus_1',
        minimumMod: 1,
        restoreOn: 'long',
        description: 'Detect celestials, fiends, and undead'
    },
    'Ranger': {
        name: 'Favored Foe',
        levels: 'proficiency',
        minimumLevel: 1,
        restoreOn: 'long',
        description: 'Mark creatures as favored foes'
    },
    'Rogue': {
        name: 'Sneak Attack',
        levels: 'always', // Always available, no charges
        description: 'Extra damage once per turn'
    },
    'Sorcerer': {
        name: 'Sorcery Points',
        levels: 'level',
        minimumLevel: 2,
        restoreOn: 'long',
        description: 'Fuel metamagic and create spell slots'
    },
    'Warlock': {
        name: 'Eldritch Invocations',
        levels: 'always',
        description: 'Passive abilities'
    },
    'Wizard': {
        name: 'Arcane Recovery',
        levels: 'half_level_rounded_up',
        restoreOn: 'long', // Once per long rest, used during short rest
        description: 'Recover spell slots during short rest'
    }
};

// Subclass resources
const SUBCLASS_RESOURCES = {
    'Battle Master': {
        name: 'Superiority Dice',
        levels: {
            3: 4, 4: 4, 5: 4, 6: 4, 7: 5, 8: 5, 9: 5, 10: 5, 11: 5, 12: 5,
            13: 5, 14: 5, 15: 6, 16: 6, 17: 6, 18: 6, 19: 6, 20: 6
        },
        restoreOn: 'short',
        description: 'Fuel combat maneuvers'
    },
    'Way of Shadow': {
        name: 'Shadow Arts',
        levels: 'ki', // Uses Ki points
        description: 'Cast spells using Ki'
    },
    'Totem Warrior': {
        name: 'Spirit Totem',
        levels: 'rage', // Uses Rage
        description: 'Channel totem spirits'
    }
};

class RPGClassResourceManager {
    /**
     * Initialize class resources for a character
     * @param {number} characterId - Character ID
     * @param {string} className - Character class
     * @param {number} level - Character level
     * @param {object} stats - Character stats
     */
    static async initializeResources(characterId, className, level, stats) {
        // Clear existing resources
        await pool.execute('DELETE FROM dnd_class_resources WHERE character_id = ?', [characterId]);

        const lvl = Math.min(20, Math.max(1, parseInt(level, 10) || 1));
        const resources = this._getClassResources(normalizeClassName(className), lvl, stats || {});

        for (const resource of resources) {
            // resource_type is part of the (character_id, resource_type) unique key, so each
            // resource needs its own key (Fighter has Action Surge + Second Wind).
            // ON DUPLICATE KEY keeps concurrent initialisations from colliding.
            await pool.execute(
                `INSERT INTO dnd_class_resources
                 (character_id, resource_type, resource_name, max_value, current_value, recharge_on)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE resource_name = VALUES(resource_name), max_value = VALUES(max_value),
                     current_value = VALUES(current_value), recharge_on = VALUES(recharge_on)`,
                [characterId, resource.type || resourceTypeKey(resource.name), resource.name, resource.max, resource.max, this._normalizeRecharge(resource.restoreOn)]
            );
        }

        logger.info('[ClassResources] Initialized resources', { characterId, className, resources: resources.map(r => r.name) });
        return resources;
    }

    /**
     * Re-derive a character's class resources from their current class/level/stats
     * (used on creation and level-up). Never throws.
     * @param {number} characterId - Character ID
     */
    static async syncResourcesForCharacter(characterId) {
        try {
            const [rows] = await pool.execute(
                'SELECT class, level, charisma, wisdom FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );
            if (rows.length === 0) return [];
            const c = rows[0];
            return await this.initializeResources(characterId, c.class, c.level, { charisma: c.charisma, wisdom: c.wisdom });
        } catch (err) {
            logger.error('[ClassResources] Failed to sync resources', { characterId, error: err.message });
            return [];
        }
    }

    /**
     * Lazily create resource rows for characters that predate resource
     * initialisation (no rows at all).
     * @private
     */
    static async _ensureResources(characterId) {
        const [existing] = await pool.execute(
            'SELECT COUNT(*) AS n FROM dnd_class_resources WHERE character_id = ?',
            [characterId]
        );
        if (Number(existing[0].n) > 0) return;
        await this.syncResourcesForCharacter(characterId);
    }

    /**
     * Get class resources configuration
     * @private
     */
    static _getClassResources(className, level, stats = {}) {
        const resources = [];
        const classRes = CLASS_RESOURCES[className];

        if (!classRes) return resources;

        // Handle main resource
        if (classRes.levels !== 'always') {
            const max = this._calculateMaxUses(classRes, level, stats);
            if (max > 0 || max === -1) { // -1 = unlimited (e.g. level 20 Rage)
                resources.push({
                    name: classRes.name,
                    max,
                    restoreOn: this._getRestoreType(classRes, level),
                    description: classRes.description
                });
            }
        }

        // Check for secondary resources
        const secondaryKey = `${className}_Second`;
        if (CLASS_RESOURCES[secondaryKey]) {
            const secondary = CLASS_RESOURCES[secondaryKey];
            const max = this._calculateMaxUses(secondary, level, stats);
            if (max > 0 || max === -1) { // -1 = unlimited (e.g. level 20 Rage)
                resources.push({
                    name: secondary.name,
                    max,
                    restoreOn: secondary.restoreOn,
                    description: secondary.description
                });
            }
        }

        return resources;
    }

    /**
     * Calculate max uses for a resource
     * @private
     */
    static _calculateMaxUses(resource, level, stats) {
        if (resource.levels === 'always') return -1;

        if (resource.minimumLevel && level < resource.minimumLevel) return 0;

        if (typeof resource.levels === 'object') {
            if (resource.levels.all) return resource.levels.all;
            return resource.levels[level] || 0;
        }

        const chaMod = Math.floor(((Number(stats?.charisma) || 10) - 10) / 2);
        const wisMod = Math.floor(((Number(stats?.wisdom) || 10) - 10) / 2);
        const profBonus = Math.ceil(level / 4) + 1;

        switch (resource.levels) {
            case 'level':
                return level;
            case 'level_x5':
                return level * 5;
            case 'half_level_rounded_up':
                return Math.ceil(level / 2);
            case 'charisma_mod':
                return Math.max(resource.minimumMod || 1, chaMod);
            case 'charisma_mod_plus_1':
                return Math.max(resource.minimumMod || 1, chaMod) + 1;
            case 'wisdom_mod':
                return Math.max(resource.minimumMod || 1, wisMod);
            case 'proficiency':
                return profBonus;
            default:
                return 0;
        }
    }

    /**
     * Get restore type considering level
     * @private
     */
    static _getRestoreType(resource, level) {
        if (resource.shortRestLevel && level >= resource.shortRestLevel) {
            return 'short';
        }
        return resource.restoreOn;
    }

    /**
     * Get character's current resources
     * @param {number} characterId - Character ID
     * @returns {array} Resources
     */
    static async getResources(characterId) {
        await this._ensureResources(characterId);

        const [resources] = await pool.execute(
            'SELECT * FROM dnd_class_resources WHERE character_id = ?',
            [characterId]
        );

        return resources.map(r => ({
            name: r.resource_name,
            current: r.current_value,
            max: r.max_value,
            restoreOn: r.recharge_on,
            isUnlimited: r.max_value === -1
        }));
    }

    /**
     * Normalize a restore keyword to the recharge_on enum
     * @private
     */
    static _normalizeRecharge(value) {
        if (!value) return 'long_rest';
        const v = String(value).toLowerCase();
        if (v === 'short' || v === 'short_rest') return 'short_rest';
        if (v === 'long' || v === 'long_rest') return 'long_rest';
        if (['dawn', 'turn', 'manual'].includes(v)) return v;
        return 'long_rest';
    }

    /**
     * Use a class resource
     * @param {number} characterId - Character ID
     * @param {string} resourceName - Resource name
     * @param {number} amount - Amount to use
     * @returns {object} Result
     */
    static async useResource(characterId, resourceName, amount = 1) {
        amount = parseInt(amount, 10);
        if (!Number.isFinite(amount) || amount < 1) {
            throw new Error('Amount must be at least 1');
        }

        await this._ensureResources(characterId);

        const [resources] = await pool.execute(
            'SELECT * FROM dnd_class_resources WHERE character_id = ? AND resource_name = ?',
            [characterId, resourceName]
        );

        if (resources.length === 0) {
            const [all] = await pool.execute(
                'SELECT resource_name FROM dnd_class_resources WHERE character_id = ?',
                [characterId]
            );
            const available = all.map(r => r.resource_name);
            throw new Error(available.length
                ? `Resource not found: ${resourceName}. Your resources: ${available.join(', ')}`
                : `Resource not found: ${resourceName}. Your class has no trackable resources at this level.`);
        }

        const resource = resources[0];
        const canonicalName = resource.resource_name;

        // Unlimited resources
        if (resource.max_value === -1) {
            const condition = await this._applyResourceCondition(characterId, canonicalName);
            return {
                used: amount,
                remaining: 'unlimited',
                resourceName: canonicalName,
                condition
            };
        }

        if (resource.current_value < amount) {
            throw new Error(`Not enough ${canonicalName}. Have ${resource.current_value}, need ${amount}`);
        }

        // Guarded decrement so concurrent uses can't drive the pool negative
        const [res] = await pool.execute(
            `UPDATE dnd_class_resources SET current_value = current_value - ?
             WHERE id = ? AND current_value >= ?`,
            [amount, resource.id, amount]
        );
        if (!res.affectedRows) {
            throw new Error(`Not enough ${canonicalName} remaining`);
        }

        const condition = await this._applyResourceCondition(characterId, canonicalName);

        return {
            used: amount,
            remaining: resource.current_value - amount,
            max: resource.max_value,
            resourceName: canonicalName,
            condition
        };
    }

    /**
     * Apply the condition a resource puts the character under (e.g. Rage -> raging).
     * Bound to the character's ongoing PvE battle when there is one so it is cleared
     * when that battle ends. Never throws; returns the condition name or null.
     * @private
     */
    static async _applyResourceCondition(characterId, resourceName) {
        const mapping = RESOURCE_CONDITIONS[String(resourceName || '').toLowerCase()];
        if (!mapping) return null;
        try {
            const [battles] = await pool.execute(
                `SELECT battle_id FROM dnd_battles WHERE character_id = ? AND status = 'ongoing' LIMIT 1`,
                [characterId]
            );
            await RPGConditionManager.applyToCharacter(characterId, mapping.condition, {
                duration: mapping.durationRounds,
                source: resourceName,
                combatId: battles[0]?.battle_id || null
            });
            return mapping.condition;
        } catch (err) {
            logger.error('[ClassResources] Failed to apply resource condition', { characterId, resourceName, error: err.message });
            return null;
        }
    }

    /**
     * Restore resources on rest
     * @param {number} characterId - Character ID
     * @param {string} restType - 'short' or 'long'
     * @returns {array} Restored resources
     */
    static async restoreOnRest(characterId, restType) {
        const restored = [];

        await this._ensureResources(characterId);

        if (restType === 'long') {
            // Long rest restores all resources
            await pool.execute(
                `UPDATE dnd_class_resources
                 SET current_value = max_value
                 WHERE character_id = ? AND max_value != -1`,
                [characterId]
            );

            const [resources] = await pool.execute(
                'SELECT resource_name, max_value FROM dnd_class_resources WHERE character_id = ? AND max_value != -1',
                [characterId]
            );

            for (const r of resources) {
                restored.push({ name: r.resource_name, restored: r.max_value });
            }
        } else {
            // Short rest only restores resources that recharge on a short rest
            await pool.execute(
                `UPDATE dnd_class_resources
                 SET current_value = max_value
                 WHERE character_id = ? AND recharge_on = 'short_rest' AND max_value != -1`,
                [characterId]
            );

            const [resources] = await pool.execute(
                `SELECT resource_name, max_value FROM dnd_class_resources
                 WHERE character_id = ? AND recharge_on = 'short_rest' AND max_value != -1`,
                [characterId]
            );

            for (const r of resources) {
                restored.push({ name: r.resource_name, restored: r.max_value });
            }
        }

        return restored;
    }

    /**
     * Add uses to a resource (for partial restoration)
     * @param {number} characterId - Character ID
     * @param {string} resourceName - Resource name
     * @param {number} amount - Amount to add
     */
    static async addUses(characterId, resourceName, amount) {
        await pool.execute(
            `UPDATE dnd_class_resources
             SET current_value = LEAST(current_value + ?, max_value)
             WHERE character_id = ? AND resource_name = ?`,
            [amount, characterId, resourceName]
        );
    }

    /**
     * Update max uses (for level up or stat changes)
     * @param {number} characterId - Character ID
     * @param {string} resourceName - Resource name
     * @param {number} newMax - New max uses
     */
    static async updateMaxUses(characterId, resourceName, newMax) {
        await pool.execute(
            `UPDATE dnd_class_resources
             SET max_value = ?, current_value = LEAST(current_value, ?)
             WHERE character_id = ? AND resource_name = ?`,
            [newMax, newMax, characterId, resourceName]
        );
    }

    /**
     * Get resource info by class
     * @param {string} className - Class name
     * @returns {object} Resource info
     */
    static getResourceInfo(className) {
        return CLASS_RESOURCES[normalizeClassName(className)] || null;
    }

    /**
     * Check if character can use a resource
     * @param {number} characterId - Character ID
     * @param {string} resourceName - Resource name
     * @param {number} amount - Amount needed
     * @returns {boolean} Can use
     */
    static async canUseResource(characterId, resourceName, amount = 1) {
        await this._ensureResources(characterId);

        const [resources] = await pool.execute(
            'SELECT current_value, max_value FROM dnd_class_resources WHERE character_id = ? AND resource_name = ?',
            [characterId, resourceName]
        );

        if (resources.length === 0) return false;

        const resource = resources[0];

        // Unlimited
        if (resource.max_value === -1) return true;

        return resource.current_value >= amount;
    }
}

export default RPGClassResourceManager;
export { RPGClassResourceManager, CLASS_RESOURCES, SUBCLASS_RESOURCES };
