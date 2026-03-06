/**
 * RPG Class Resource Manager
 * Handles class-specific resources like Ki, Rage, Bardic Inspiration, etc.
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';

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

        const resources = this._getClassResources(className, level, stats);

        for (const resource of resources) {
            await pool.execute(
                `INSERT INTO dnd_class_resources
                 (character_id, resource_name, max_uses, current_uses, restore_on)
                 VALUES (?, ?, ?, ?, ?)`,
                [characterId, resource.name, resource.max, resource.max, resource.restoreOn]
            );
        }

        logger.info('[ClassResources] Initialized resources', { characterId, className, resources });
        return resources;
    }

    /**
     * Get class resources configuration
     * @private
     */
    static _getClassResources(className, level, stats) {
        const resources = [];
        const classRes = CLASS_RESOURCES[className];

        if (!classRes) return resources;

        // Handle main resource
        if (classRes.levels !== 'always') {
            const max = this._calculateMaxUses(classRes, level, stats);
            if (max > 0) {
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
            if (max > 0) {
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

        const chaMod = Math.floor((stats.charisma - 10) / 2);
        const wisMod = Math.floor((stats.wisdom - 10) / 2);
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
        const [resources] = await pool.execute(
            'SELECT * FROM dnd_class_resources WHERE character_id = ?',
            [characterId]
        );

        return resources.map(r => ({
            name: r.resource_name,
            current: r.current_uses,
            max: r.max_uses,
            restoreOn: r.restore_on,
            isUnlimited: r.max_uses === -1
        }));
    }

    /**
     * Use a class resource
     * @param {number} characterId - Character ID
     * @param {string} resourceName - Resource name
     * @param {number} amount - Amount to use
     * @returns {object} Result
     */
    static async useResource(characterId, resourceName, amount = 1) {
        const [resources] = await pool.execute(
            'SELECT * FROM dnd_class_resources WHERE character_id = ? AND resource_name = ?',
            [characterId, resourceName]
        );

        if (resources.length === 0) {
            throw new Error(`Resource not found: ${resourceName}`);
        }

        const resource = resources[0];

        // Unlimited resources
        if (resource.max_uses === -1) {
            return {
                used: amount,
                remaining: 'unlimited',
                resourceName
            };
        }

        if (resource.current_uses < amount) {
            throw new Error(`Not enough ${resourceName}. Have ${resource.current_uses}, need ${amount}`);
        }

        await pool.execute(
            'UPDATE dnd_class_resources SET current_uses = current_uses - ? WHERE character_id = ? AND resource_name = ?',
            [amount, characterId, resourceName]
        );

        return {
            used: amount,
            remaining: resource.current_uses - amount,
            max: resource.max_uses,
            resourceName
        };
    }

    /**
     * Restore resources on rest
     * @param {number} characterId - Character ID
     * @param {string} restType - 'short' or 'long'
     * @returns {array} Restored resources
     */
    static async restoreOnRest(characterId, restType) {
        const restored = [];

        if (restType === 'long') {
            // Long rest restores all resources
            const [result] = await pool.execute(
                `UPDATE dnd_class_resources
                 SET current_uses = max_uses
                 WHERE character_id = ? AND max_uses != -1`,
                [characterId]
            );

            const [resources] = await pool.execute(
                'SELECT resource_name, max_uses FROM dnd_class_resources WHERE character_id = ? AND max_uses != -1',
                [characterId]
            );

            for (const r of resources) {
                restored.push({ name: r.resource_name, restored: r.max_uses });
            }
        } else {
            // Short rest only restores specific resources
            const [result] = await pool.execute(
                `UPDATE dnd_class_resources
                 SET current_uses = max_uses
                 WHERE character_id = ? AND restore_on = 'short' AND max_uses != -1`,
                [characterId]
            );

            const [resources] = await pool.execute(
                `SELECT resource_name, max_uses FROM dnd_class_resources
                 WHERE character_id = ? AND restore_on = 'short' AND max_uses != -1`,
                [characterId]
            );

            for (const r of resources) {
                restored.push({ name: r.resource_name, restored: r.max_uses });
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
             SET current_uses = LEAST(current_uses + ?, max_uses)
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
             SET max_uses = ?, current_uses = LEAST(current_uses, ?)
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
        return CLASS_RESOURCES[className] || null;
    }

    /**
     * Check if character can use a resource
     * @param {number} characterId - Character ID
     * @param {string} resourceName - Resource name
     * @param {number} amount - Amount needed
     * @returns {boolean} Can use
     */
    static async canUseResource(characterId, resourceName, amount = 1) {
        const [resources] = await pool.execute(
            'SELECT current_uses, max_uses FROM dnd_class_resources WHERE character_id = ? AND resource_name = ?',
            [characterId, resourceName]
        );

        if (resources.length === 0) return false;

        const resource = resources[0];

        // Unlimited
        if (resource.max_uses === -1) return true;

        return resource.current_uses >= amount;
    }
}

export default RPGClassResourceManager;
export { RPGClassResourceManager, CLASS_RESOURCES, SUBCLASS_RESOURCES };
