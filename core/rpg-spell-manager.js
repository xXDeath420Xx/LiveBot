/**
 * RPG Spell Manager
 * Handles D&D 5e spellcasting, spell slots, and concentration
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import { RPGDiceEngine } from './rpg-dice-engine.js';

// Spell slot progression by class level (full casters)
const FULL_CASTER_SLOTS = {
    1: [2, 0, 0, 0, 0, 0, 0, 0, 0],
    2: [3, 0, 0, 0, 0, 0, 0, 0, 0],
    3: [4, 2, 0, 0, 0, 0, 0, 0, 0],
    4: [4, 3, 0, 0, 0, 0, 0, 0, 0],
    5: [4, 3, 2, 0, 0, 0, 0, 0, 0],
    6: [4, 3, 3, 0, 0, 0, 0, 0, 0],
    7: [4, 3, 3, 1, 0, 0, 0, 0, 0],
    8: [4, 3, 3, 2, 0, 0, 0, 0, 0],
    9: [4, 3, 3, 3, 1, 0, 0, 0, 0],
    10: [4, 3, 3, 3, 2, 0, 0, 0, 0],
    11: [4, 3, 3, 3, 2, 1, 0, 0, 0],
    12: [4, 3, 3, 3, 2, 1, 0, 0, 0],
    13: [4, 3, 3, 3, 2, 1, 1, 0, 0],
    14: [4, 3, 3, 3, 2, 1, 1, 0, 0],
    15: [4, 3, 3, 3, 2, 1, 1, 1, 0],
    16: [4, 3, 3, 3, 2, 1, 1, 1, 0],
    17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
    18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
    19: [4, 3, 3, 3, 3, 2, 1, 1, 1],
    20: [4, 3, 3, 3, 3, 2, 2, 1, 1]
};

// Half casters (Paladin, Ranger)
const HALF_CASTER_SLOTS = {
    1: [0, 0, 0, 0, 0],
    2: [2, 0, 0, 0, 0],
    3: [3, 0, 0, 0, 0],
    4: [3, 0, 0, 0, 0],
    5: [4, 2, 0, 0, 0],
    6: [4, 2, 0, 0, 0],
    7: [4, 3, 0, 0, 0],
    8: [4, 3, 0, 0, 0],
    9: [4, 3, 2, 0, 0],
    10: [4, 3, 2, 0, 0],
    11: [4, 3, 3, 0, 0],
    12: [4, 3, 3, 0, 0],
    13: [4, 3, 3, 1, 0],
    14: [4, 3, 3, 1, 0],
    15: [4, 3, 3, 2, 0],
    16: [4, 3, 3, 2, 0],
    17: [4, 3, 3, 3, 1],
    18: [4, 3, 3, 3, 1],
    19: [4, 3, 3, 3, 2],
    20: [4, 3, 3, 3, 2]
};

// Third casters (Eldritch Knight, Arcane Trickster)
const THIRD_CASTER_SLOTS = {
    1: [0, 0, 0, 0],
    2: [0, 0, 0, 0],
    3: [2, 0, 0, 0],
    4: [3, 0, 0, 0],
    5: [3, 0, 0, 0],
    6: [3, 0, 0, 0],
    7: [4, 2, 0, 0],
    8: [4, 2, 0, 0],
    9: [4, 2, 0, 0],
    10: [4, 3, 0, 0],
    11: [4, 3, 0, 0],
    12: [4, 3, 0, 0],
    13: [4, 3, 2, 0],
    14: [4, 3, 2, 0],
    15: [4, 3, 2, 0],
    16: [4, 3, 3, 0],
    17: [4, 3, 3, 0],
    18: [4, 3, 3, 0],
    19: [4, 3, 3, 1],
    20: [4, 3, 3, 1]
};

// Warlock pact slots
const WARLOCK_SLOTS = {
    1: { slots: 1, level: 1 },
    2: { slots: 2, level: 1 },
    3: { slots: 2, level: 2 },
    4: { slots: 2, level: 2 },
    5: { slots: 2, level: 3 },
    6: { slots: 2, level: 3 },
    7: { slots: 2, level: 4 },
    8: { slots: 2, level: 4 },
    9: { slots: 2, level: 5 },
    10: { slots: 2, level: 5 },
    11: { slots: 3, level: 5 },
    12: { slots: 3, level: 5 },
    13: { slots: 3, level: 5 },
    14: { slots: 3, level: 5 },
    15: { slots: 3, level: 5 },
    16: { slots: 3, level: 5 },
    17: { slots: 4, level: 5 },
    18: { slots: 4, level: 5 },
    19: { slots: 4, level: 5 },
    20: { slots: 4, level: 5 }
};

// Spellcasting ability by class
const SPELLCASTING_ABILITY = {
    'Wizard': 'intelligence',
    'Sorcerer': 'charisma',
    'Bard': 'charisma',
    'Cleric': 'wisdom',
    'Druid': 'wisdom',
    'Paladin': 'charisma',
    'Ranger': 'wisdom',
    'Warlock': 'charisma',
    'Fighter': 'intelligence', // Eldritch Knight
    'Rogue': 'intelligence'    // Arcane Trickster
};

const CASTER_TYPE = {
    'Wizard': 'full',
    'Sorcerer': 'full',
    'Bard': 'full',
    'Cleric': 'full',
    'Druid': 'full',
    'Paladin': 'half',
    'Ranger': 'half',
    'Warlock': 'pact',
    'Fighter': 'third',
    'Rogue': 'third'
};

class RPGSpellManager {
    static spellCache = null;

    /**
     * Load all spells into cache
     */
    static async loadSpells() {
        if (this.spellCache) return this.spellCache;

        const [spells] = await pool.execute('SELECT * FROM dnd_spells');
        this.spellCache = new Map();

        for (const spell of spells) {
            this.spellCache.set(spell.spell_name.toLowerCase(), {
                ...spell,
                components: typeof spell.components === 'string' ? JSON.parse(spell.components) : spell.components,
                damage_dice: typeof spell.damage_dice === 'string' ? JSON.parse(spell.damage_dice) : spell.damage_dice
            });
        }

        return this.spellCache;
    }

    /**
     * Get spell info
     * @param {string} spellName - Spell name
     * @returns {object|null} Spell data
     */
    static async getSpell(spellName) {
        await this.loadSpells();
        return this.spellCache.get(spellName.toLowerCase()) || null;
    }

    /**
     * Search spells by partial name
     * @param {string} query - Search query
     * @returns {array} Matching spells
     */
    static async searchSpells(query) {
        await this.loadSpells();
        const results = [];
        const lowerQuery = query.toLowerCase();

        for (const [name, spell] of this.spellCache) {
            if (name.includes(lowerQuery)) {
                results.push(spell);
            }
        }

        return results.slice(0, 25); // Limit for autocomplete
    }

    /**
     * Get spells by level
     * @param {number} level - Spell level (0 for cantrips)
     * @returns {array} Spells at that level
     */
    static async getSpellsByLevel(level) {
        await this.loadSpells();
        return Array.from(this.spellCache.values()).filter(s => s.spell_level === level);
    }

    /**
     * Get spells by school
     * @param {string} school - Magic school
     * @returns {array} Spells in that school
     */
    static async getSpellsBySchool(school) {
        await this.loadSpells();
        return Array.from(this.spellCache.values()).filter(
            s => s.school.toLowerCase() === school.toLowerCase()
        );
    }

    /**
     * Initialize spell slots for a character
     * @param {number} characterId - Character ID
     * @param {string} className - Character class
     * @param {number} level - Character level
     */
    static async initializeSpellSlots(characterId, className, level) {
        const casterType = CASTER_TYPE[className];
        if (!casterType) return; // Non-caster

        // Clear existing slots
        await pool.execute('DELETE FROM dnd_spell_slots WHERE character_id = ?', [characterId]);

        let slots;
        if (casterType === 'full') {
            slots = FULL_CASTER_SLOTS[level] || FULL_CASTER_SLOTS[1];
        } else if (casterType === 'half') {
            slots = HALF_CASTER_SLOTS[level] || HALF_CASTER_SLOTS[1];
        } else if (casterType === 'third') {
            slots = THIRD_CASTER_SLOTS[level] || THIRD_CASTER_SLOTS[1];
        } else if (casterType === 'pact') {
            const pact = WARLOCK_SLOTS[level] || WARLOCK_SLOTS[1];
            // Warlock uses special pact magic slots
            await pool.execute(
                `INSERT INTO dnd_spell_slots (character_id, slot_level, total_slots, used_slots)
                 VALUES (?, ?, ?, 0)`,
                [characterId, pact.level, pact.slots]
            );
            return;
        }

        // Insert slots for each level
        for (let i = 0; i < slots.length; i++) {
            if (slots[i] > 0) {
                await pool.execute(
                    `INSERT INTO dnd_spell_slots (character_id, slot_level, total_slots, used_slots)
                     VALUES (?, ?, ?, 0)`,
                    [characterId, i + 1, slots[i]]
                );
            }
        }
    }

    /**
     * Get character's spell slots
     * @param {number} characterId - Character ID
     * @returns {array} Spell slots
     */
    static async getSpellSlots(characterId) {
        const [slots] = await pool.execute(
            'SELECT * FROM dnd_spell_slots WHERE character_id = ? ORDER BY slot_level',
            [characterId]
        );

        return slots.map(s => ({
            level: s.slot_level,
            total: s.total_slots,
            used: s.used_slots,
            available: s.total_slots - s.used_slots
        }));
    }

    /**
     * Use a spell slot
     * @param {number} characterId - Character ID
     * @param {number} slotLevel - Slot level to use
     * @returns {boolean} Success
     */
    static async useSpellSlot(characterId, slotLevel) {
        const [slots] = await pool.execute(
            'SELECT * FROM dnd_spell_slots WHERE character_id = ? AND slot_level = ?',
            [characterId, slotLevel]
        );

        if (slots.length === 0) {
            throw new Error(`No level ${slotLevel} spell slots`);
        }

        const slot = slots[0];
        if (slot.used_slots >= slot.total_slots) {
            throw new Error(`No level ${slotLevel} spell slots remaining`);
        }

        await pool.execute(
            'UPDATE dnd_spell_slots SET used_slots = used_slots + 1 WHERE character_id = ? AND slot_level = ?',
            [characterId, slotLevel]
        );

        return true;
    }

    /**
     * Restore spell slots (long rest)
     * @param {number} characterId - Character ID
     */
    static async restoreAllSlots(characterId) {
        await pool.execute(
            'UPDATE dnd_spell_slots SET used_slots = 0 WHERE character_id = ?',
            [characterId]
        );
    }

    /**
     * Learn a spell
     * @param {number} characterId - Character ID
     * @param {string} spellName - Spell name
     * @param {string} source - How spell was learned
     */
    static async learnSpell(characterId, spellName, source = 'class') {
        const spell = await this.getSpell(spellName);
        if (!spell) {
            throw new Error(`Unknown spell: ${spellName}`);
        }

        // Check if already known
        const [existing] = await pool.execute(
            'SELECT id FROM dnd_character_spells WHERE character_id = ? AND spell_id = ?',
            [characterId, spell.spell_id]
        );

        if (existing.length > 0) {
            throw new Error('Spell already known');
        }

        await pool.execute(
            'INSERT INTO dnd_character_spells (character_id, spell_id, source) VALUES (?, ?, ?)',
            [characterId, spell.spell_id, source]
        );

        return spell;
    }

    /**
     * Get character's known spells
     * @param {number} characterId - Character ID
     * @returns {array} Known spells
     */
    static async getKnownSpells(characterId) {
        const [spells] = await pool.execute(
            `SELECT s.*, cs.source, cs.prepared
             FROM dnd_character_spells cs
             JOIN dnd_spells s ON cs.spell_id = s.spell_id
             WHERE cs.character_id = ?
             ORDER BY s.spell_level, s.spell_name`,
            [characterId]
        );

        return spells.map(s => ({
            ...s,
            components: typeof s.components === 'string' ? JSON.parse(s.components) : s.components,
            damage_dice: typeof s.damage_dice === 'string' ? JSON.parse(s.damage_dice) : s.damage_dice
        }));
    }

    /**
     * Prepare a spell (for prepared casters)
     * @param {number} characterId - Character ID
     * @param {string} spellName - Spell name
     * @param {boolean} prepared - Prepared or not
     */
    static async prepareSpell(characterId, spellName, prepared = true) {
        const spell = await this.getSpell(spellName);
        if (!spell) {
            throw new Error(`Unknown spell: ${spellName}`);
        }

        await pool.execute(
            'UPDATE dnd_character_spells SET prepared = ? WHERE character_id = ? AND spell_id = ?',
            [prepared, characterId, spell.spell_id]
        );
    }

    /**
     * Get prepared spells
     * @param {number} characterId - Character ID
     * @returns {array} Prepared spells
     */
    static async getPreparedSpells(characterId) {
        const spells = await this.getKnownSpells(characterId);
        return spells.filter(s => s.prepared || s.spell_level === 0); // Cantrips always prepared
    }

    /**
     * Cast a spell
     * @param {number} characterId - Character ID
     * @param {string} spellName - Spell name
     * @param {number} slotLevel - Slot level to use (null for cantrips)
     * @param {object} options - Cast options
     * @returns {object} Cast result
     */
    static async castSpell(characterId, spellName, slotLevel = null, options = {}) {
        const spell = await this.getSpell(spellName);
        if (!spell) {
            throw new Error(`Unknown spell: ${spellName}`);
        }

        // Check if known
        const known = await this.getKnownSpells(characterId);
        const knownSpell = known.find(s => s.spell_id === spell.spell_id);
        if (!knownSpell) {
            throw new Error('You don\'t know this spell');
        }

        // Cantrips don't use slots
        if (spell.spell_level === 0) {
            return this._resolveSpellEffect(characterId, spell, 0, options);
        }

        // Check slot level is valid
        if (slotLevel < spell.spell_level) {
            throw new Error(`${spell.spell_name} requires at least a level ${spell.spell_level} slot`);
        }

        // Use the slot
        await this.useSpellSlot(characterId, slotLevel);

        // Check concentration
        if (spell.concentration) {
            await this._setConcentration(characterId, spell.spell_id);
        }

        return this._resolveSpellEffect(characterId, spell, slotLevel, options);
    }

    /**
     * Resolve spell effect
     * @private
     */
    static async _resolveSpellEffect(characterId, spell, castLevel, options) {
        const result = {
            spell: spell.spell_name,
            level: spell.spell_level,
            castAt: castLevel,
            description: spell.description,
            school: spell.school
        };

        // Get caster info for DC and attack bonus
        const [characters] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (characters.length === 0) {
            throw new Error('Character not found');
        }

        const character = characters[0];
        const stats = typeof character.stats === 'string' ? JSON.parse(character.stats) : character.stats;
        const spellAbility = SPELLCASTING_ABILITY[character.class] || 'intelligence';
        const abilityMod = Math.floor((stats[spellAbility] - 10) / 2);
        const profBonus = Math.ceil(character.level / 4) + 1;
        const spellDC = 8 + profBonus + abilityMod;
        const spellAttack = profBonus + abilityMod;

        result.spellDC = spellDC;
        result.spellAttackBonus = spellAttack;

        // Handle damage spells
        if (spell.damage_dice) {
            let damageDice = spell.damage_dice;

            // Upcasting bonus
            if (castLevel > spell.spell_level && spell.damage_dice.upcast) {
                const extraLevels = castLevel - spell.spell_level;
                const extraDice = spell.damage_dice.upcast.dice * extraLevels;
                damageDice = {
                    ...damageDice,
                    count: (damageDice.count || 1) + extraDice
                };
            }

            // Roll damage
            const damageRoll = RPGDiceEngine.rollDice(
                damageDice.count || 1,
                damageDice.die || 6
            );

            result.damage = {
                roll: damageRoll,
                type: spell.damage_type,
                total: damageRoll.total
            };
        }

        // Handle healing spells
        if (spell.healing_dice) {
            let healDice = spell.healing_dice;

            if (castLevel > spell.spell_level && spell.healing_dice.upcast) {
                const extraLevels = castLevel - spell.spell_level;
                const extraDice = spell.healing_dice.upcast.dice * extraLevels;
                healDice = {
                    ...healDice,
                    count: (healDice.count || 1) + extraDice
                };
            }

            const healRoll = RPGDiceEngine.rollDice(
                healDice.count || 1,
                healDice.die || 8
            );

            result.healing = {
                roll: healRoll,
                total: healRoll.total + (healDice.modifier || 0) + abilityMod
            };
        }

        // Spell attack roll
        if (spell.attack_type === 'ranged' || spell.attack_type === 'melee') {
            const attackRoll = RPGDiceEngine.rollDice(1, 20);
            result.attackRoll = {
                natural: attackRoll.rolls[0],
                total: attackRoll.total + spellAttack,
                critical: attackRoll.rolls[0] === 20,
                fumble: attackRoll.rolls[0] === 1
            };
        }

        // Save type
        if (spell.save_type) {
            result.saveType = spell.save_type;
            result.saveDC = spellDC;
        }

        logger.info('[Spell] Cast spell', {
            characterId,
            spell: spell.spell_name,
            castLevel
        });

        return result;
    }

    /**
     * Set concentration on a spell
     * @private
     */
    static async _setConcentration(characterId, spellId) {
        // Break existing concentration
        await this.breakConcentration(characterId);

        // Set new concentration
        await pool.execute(
            `UPDATE dnd_characters
             SET concentration_spell_id = ?, concentration_started = NOW()
             WHERE character_id = ?`,
            [spellId, characterId]
        );
    }

    /**
     * Break concentration
     * @param {number} characterId - Character ID
     */
    static async breakConcentration(characterId) {
        await pool.execute(
            'UPDATE dnd_characters SET concentration_spell_id = NULL, concentration_started = NULL WHERE character_id = ?',
            [characterId]
        );
    }

    /**
     * Check concentration (on damage)
     * @param {number} characterId - Character ID
     * @param {number} damage - Damage taken
     * @returns {object} Concentration check result
     */
    static async concentrationCheck(characterId, damage) {
        const [characters] = await pool.execute(
            `SELECT c.*, s.spell_name
             FROM dnd_characters c
             LEFT JOIN dnd_spells s ON c.concentration_spell_id = s.spell_id
             WHERE c.character_id = ?`,
            [characterId]
        );

        if (characters.length === 0 || !characters[0].concentration_spell_id) {
            return { concentrating: false };
        }

        const character = characters[0];
        const stats = typeof character.stats === 'string' ? JSON.parse(character.stats) : character.stats;
        const conMod = Math.floor((stats.constitution - 10) / 2);
        const profBonus = Math.ceil(character.level / 4) + 1;

        // DC is 10 or half damage, whichever is higher
        const dc = Math.max(10, Math.floor(damage / 2));

        // Constitution saving throw
        const roll = RPGDiceEngine.rollDice(1, 20);
        const total = roll.total + conMod; // Add proficiency if they have it

        const success = total >= dc;

        if (!success) {
            await this.breakConcentration(characterId);
        }

        return {
            concentrating: true,
            spell: character.spell_name,
            roll: roll.total,
            modifier: conMod,
            total,
            dc,
            success,
            message: success
                ? `Maintained concentration on ${character.spell_name}!`
                : `Lost concentration on ${character.spell_name}!`
        };
    }

    /**
     * Get cantrip damage scaling
     * @param {number} level - Character level
     * @returns {number} Number of damage dice
     */
    static getCantripDice(level) {
        if (level >= 17) return 4;
        if (level >= 11) return 3;
        if (level >= 5) return 2;
        return 1;
    }
}

export default RPGSpellManager;
export { RPGSpellManager, SPELLCASTING_ABILITY, CASTER_TYPE };
