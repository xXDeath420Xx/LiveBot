/**
 * RPG Spell Manager
 * Handles D&D 5e spellcasting, spell slots, and concentration
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import { RPGDiceEngine } from './rpg-dice-engine.js';
import RPGConditionManager from './rpg-condition-manager.js';
import RPGLeaderboardManager from './rpg-leaderboard-manager.js';

/**
 * Normalise a stored class value to the capitalised keys used by the tables
 * below. Characters created via /rpg character create store the class
 * lowercased ('wizard'); D&D Beyond imports may store 'Wizard' or 'Wizard 5'.
 * @param {string} className
 * @returns {string} e.g. 'Wizard' ('' when empty)
 */
export function normalizeClassName(className) {
    const first = String(className || '').trim().split(/[\s/(,]+/)[0] || '';
    if (!first) return '';
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Subclasses that turn Fighter / Rogue into third-casters.
const THIRD_CASTER_SUBCLASSES = ['eldritch knight', 'arcane trickster'];

/**
 * Parse a dice spec as stored in dnd_spells.damage_dice / healing_dice.
 * Accepts '3d4+3', { dice: '3d4+3' }, { count, die, modifier } or a bare
 * number (extra dice of the base die, used by some upcast entries).
 * @returns {{count:number, sides:number|null, modifier:number}|null}
 */
function parseDiceSpec(spec) {
    if (spec == null) return null;
    if (typeof spec === 'number') return { count: spec, sides: null, modifier: 0 };
    if (typeof spec === 'object') {
        if (spec.dice != null) return parseDiceSpec(spec.dice);
        if (spec.count != null || spec.die != null) {
            return { count: Number(spec.count) || 1, sides: Number(spec.die) || null, modifier: Number(spec.modifier) || 0 };
        }
        return null;
    }
    const m = String(spec).replace(/\s+/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/i);
    if (!m) return null;
    return { count: m[1] ? parseInt(m[1], 10) : 1, sides: parseInt(m[2], 10), modifier: m[3] ? parseInt(m[3], 10) : 0 };
}

function parseJsonField(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
}

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
                components: parseJsonField(spell.components),
                damage_dice: parseJsonField(spell.damage_dice),
                healing_dice: parseJsonField(spell.healing_dice)
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
    static async initializeSpellSlots(characterId, className, level, subclass = null) {
        const normalizedClass = normalizeClassName(className);
        let casterType = CASTER_TYPE[normalizedClass];

        // Fighter / Rogue only cast as Eldritch Knight / Arcane Trickster.
        if (casterType === 'third' && !THIRD_CASTER_SUBCLASSES.includes(String(subclass || '').trim().toLowerCase())) {
            casterType = null;
        }

        // Clear existing slots (also wipes stale rows if the class stopped casting)
        await pool.execute('DELETE FROM dnd_spell_slots WHERE character_id = ?', [characterId]);

        if (!casterType) return []; // Non-caster

        const lvl = Math.min(20, Math.max(1, parseInt(level, 10) || 1));

        // [slot_level, total] pairs to write
        const rows = [];
        if (casterType === 'pact') {
            // Warlock uses special pact magic slots (all at one level)
            const pact = WARLOCK_SLOTS[lvl] || WARLOCK_SLOTS[1];
            rows.push([pact.level, pact.slots]);
        } else {
            let slots;
            if (casterType === 'full') slots = FULL_CASTER_SLOTS[lvl] || FULL_CASTER_SLOTS[1];
            else if (casterType === 'half') slots = HALF_CASTER_SLOTS[lvl] || HALF_CASTER_SLOTS[1];
            else slots = THIRD_CASTER_SLOTS[lvl] || THIRD_CASTER_SLOTS[1];
            for (let i = 0; i < slots.length; i++) {
                if (slots[i] > 0) rows.push([i + 1, slots[i]]);
            }
        }

        // ON DUPLICATE KEY keeps two concurrent initialisations from colliding on uk_char_level
        for (const [slotLevel, total] of rows) {
            await pool.execute(
                `INSERT INTO dnd_spell_slots (character_id, slot_level, total_slots, used_slots)
                 VALUES (?, ?, ?, 0)
                 ON DUPLICATE KEY UPDATE total_slots = VALUES(total_slots), used_slots = 0`,
                [characterId, slotLevel, total]
            );
        }

        return rows.map(([slotLevel, total]) => ({ level: slotLevel, total }));
    }

    /**
     * Re-derive a character's spell slots from their current class/level
     * (used on creation and level-up). Never throws.
     * @param {number} characterId - Character ID
     */
    static async syncSpellSlotsForCharacter(characterId) {
        try {
            const [rows] = await pool.execute(
                'SELECT class, subclass, level FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );
            if (rows.length === 0) return [];
            return await this.initializeSpellSlots(characterId, rows[0].class, rows[0].level, rows[0].subclass);
        } catch (err) {
            logger.error('[Spell] Failed to sync spell slots', { characterId, error: err.message });
            return [];
        }
    }

    /**
     * Lazily create spell slot rows for characters that predate slot
     * initialisation (no rows at all). Non-casters simply stay empty.
     * @private
     */
    static async _ensureSpellSlots(characterId) {
        const [existing] = await pool.execute(
            'SELECT COUNT(*) AS n FROM dnd_spell_slots WHERE character_id = ?',
            [characterId]
        );
        if (Number(existing[0].n) > 0) return;
        await this.syncSpellSlotsForCharacter(characterId);
    }

    /**
     * Get character's spell slots
     * @param {number} characterId - Character ID
     * @returns {array} Spell slots
     */
    static async getSpellSlots(characterId) {
        await this._ensureSpellSlots(characterId);

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
        await this._ensureSpellSlots(characterId);

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

        // Guarded decrement so two concurrent casts can't overspend the last slot
        const [res] = await pool.execute(
            `UPDATE dnd_spell_slots SET used_slots = used_slots + 1
             WHERE character_id = ? AND slot_level = ? AND used_slots < total_slots`,
            [characterId, slotLevel]
        );
        if (!res.affectedRows) {
            throw new Error(`No level ${slotLevel} spell slots remaining`);
        }

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
            'INSERT INTO dnd_character_spells (character_id, spell_id, spell_source) VALUES (?, ?, ?)',
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
            `SELECT s.*, cs.spell_source AS source, cs.is_prepared AS prepared
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
            'UPDATE dnd_character_spells SET is_prepared = ? WHERE character_id = ? AND spell_id = ?',
            [prepared ? 1 : 0, characterId, spell.spell_id]
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
            const cantrip = await this._resolveSpellEffect(characterId, spell, 0, options);
            RPGLeaderboardManager.trackStat(characterId, 'spells_cast', 1); // Spellslinger
            return cantrip;
        }

        // No slot level given: cast at the spell's own level
        if (slotLevel == null) slotLevel = spell.spell_level;

        // Check slot level is valid
        if (slotLevel < spell.spell_level) {
            throw new Error(`${spell.spell_name} requires at least a level ${spell.spell_level} slot`);
        }
        if (slotLevel > 9) {
            throw new Error('Spell slots only go up to level 9');
        }

        // Use the slot
        await this.useSpellSlot(characterId, slotLevel);

        // Check concentration
        if (spell.concentration) {
            await this._setConcentration(characterId, spell.spell_id);
        }

        const cast = await this._resolveSpellEffect(characterId, spell, slotLevel, options);
        RPGLeaderboardManager.trackStat(characterId, 'spells_cast', 1); // Spellslinger
        return cast;
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
        const spellAbility = SPELLCASTING_ABILITY[normalizeClassName(character.class)] || 'intelligence';
        const abilityScore = character[spellAbility] ?? 10;
        const abilityMod = Math.floor((abilityScore - 10) / 2);
        const profBonus = Math.ceil(character.level / 4) + 1;
        const spellDC = 8 + profBonus + abilityMod;
        const spellAttack = profBonus + abilityMod;

        result.spellDC = spellDC;
        result.spellAttackBonus = spellAttack;

        // Build the dice notation for a damage/healing spec incl. upcasting.
        // dnd_spells stores e.g. {"dice":"3d4+3","upcast":{"dice":"1d4+1"}} or {"upcast":{"dice":1}}.
        const buildNotation = (spec, defaultSides) => {
            const base = parseDiceSpec(spec) || { count: 1, sides: defaultSides, modifier: 0 };
            const sides = base.sides || defaultSides;
            let count = base.count;
            let modifier = base.modifier;
            const upcast = spec && typeof spec === 'object' ? parseDiceSpec(spec.upcast) : null;
            if (upcast && castLevel > spell.spell_level) {
                const extraLevels = castLevel - spell.spell_level;
                count += upcast.count * extraLevels;
                modifier += upcast.modifier * extraLevels;
            }
            return `${Math.max(1, count)}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : ''}`;
        };

        // Handle damage spells (cantrips scale with character level instead of slots)
        if (spell.damage_dice) {
            let notation = buildNotation(spell.damage_dice, 6);
            if (spell.spell_level === 0) {
                const base = parseDiceSpec(spell.damage_dice);
                if (base && base.sides) {
                    notation = `${this.getCantripDice(character.level || 1) * base.count}d${base.sides}${base.modifier ? (base.modifier > 0 ? `+${base.modifier}` : `${base.modifier}`) : ''}`;
                }
            }
            const damageRoll = RPGDiceEngine.roll(notation);

            result.damage = {
                roll: damageRoll,
                type: spell.damage_type,
                total: damageRoll.total
            };
        }

        // Handle healing spells
        if (spell.healing_dice) {
            const healRoll = RPGDiceEngine.roll(buildNotation(spell.healing_dice, 8));

            result.healing = {
                roll: healRoll,
                total: Math.max(1, healRoll.total + abilityMod)
            };
        }

        // Spell attack roll
        if (spell.attack_type === 'ranged' || spell.attack_type === 'melee') {
            const attackRoll = RPGDiceEngine.roll('1d20');
            const natural = attackRoll.rolls[0];
            result.attackRoll = {
                natural,
                total: attackRoll.total + spellAttack,
                critical: natural === 20,
                fumble: natural === 1
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
             SET concentration_spell_id = ?
             WHERE character_id = ?`,
            [spellId, characterId]
        );

        // Mirror it as the 'concentrating' condition so it shows in /rpg condition active
        try {
            const spell = Array.from((await this.loadSpells()).values()).find(s => s.spell_id === spellId);
            await RPGConditionManager.applyToCharacter(characterId, 'concentrating', {
                source: spell ? spell.spell_name : 'spell'
            });
        } catch (err) {
            logger.error('[Spell] Failed to apply concentrating condition', { characterId, error: err.message });
        }
    }

    /**
     * Break concentration
     * @param {number} characterId - Character ID
     */
    static async breakConcentration(characterId) {
        await pool.execute(
            'UPDATE dnd_characters SET concentration_spell_id = NULL WHERE character_id = ?',
            [characterId]
        );

        try {
            await RPGConditionManager.removeFromCharacter(characterId, 'concentrating');
        } catch (err) {
            logger.error('[Spell] Failed to clear concentrating condition', { characterId, error: err.message });
        }
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
        const conMod = Math.floor(((character.constitution ?? 10) - 10) / 2);
        const profBonus = Math.ceil(character.level / 4) + 1;

        // DC is 10 or half damage, whichever is higher
        const dc = Math.max(10, Math.floor(damage / 2));

        // Constitution saving throw
        const roll = RPGDiceEngine.roll('1d20');
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
export { RPGSpellManager, SPELLCASTING_ABILITY, CASTER_TYPE, parseDiceSpec };
