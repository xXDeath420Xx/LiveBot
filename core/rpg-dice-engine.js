/**
 * RPG Dice Engine
 * Core dice rolling system for D&D mechanics
 * Handles: dice rolls, skill checks, saving throws, attack rolls, advantage/disadvantage
 */

import { pool } from '../utils/db.js';
import { executeRoll, rollDie, getDieEmoji } from '../utils/rpg/dice-parser.js';
import logger from '../utils/logger.js';

// D&D 5e Skills mapped to abilities
export const SKILLS = {
    // Strength
    athletics: { ability: 'strength', name: 'Athletics' },
    // Dexterity
    acrobatics: { ability: 'dexterity', name: 'Acrobatics' },
    sleight_of_hand: { ability: 'dexterity', name: 'Sleight of Hand' },
    stealth: { ability: 'dexterity', name: 'Stealth' },
    // Intelligence
    arcana: { ability: 'intelligence', name: 'Arcana' },
    history: { ability: 'intelligence', name: 'History' },
    investigation: { ability: 'intelligence', name: 'Investigation' },
    nature: { ability: 'intelligence', name: 'Nature' },
    religion: { ability: 'intelligence', name: 'Religion' },
    // Wisdom
    animal_handling: { ability: 'wisdom', name: 'Animal Handling' },
    insight: { ability: 'wisdom', name: 'Insight' },
    medicine: { ability: 'wisdom', name: 'Medicine' },
    perception: { ability: 'wisdom', name: 'Perception' },
    survival: { ability: 'wisdom', name: 'Survival' },
    // Charisma
    deception: { ability: 'charisma', name: 'Deception' },
    intimidation: { ability: 'charisma', name: 'Intimidation' },
    performance: { ability: 'charisma', name: 'Performance' },
    persuasion: { ability: 'charisma', name: 'Persuasion' }
};

// Ability names
export const ABILITIES = {
    strength: 'Strength',
    dexterity: 'Dexterity',
    constitution: 'Constitution',
    intelligence: 'Intelligence',
    wisdom: 'Wisdom',
    charisma: 'Charisma'
};

// Short ability codes
export const ABILITY_CODES = {
    str: 'strength',
    dex: 'dexterity',
    con: 'constitution',
    int: 'intelligence',
    wis: 'wisdom',
    cha: 'charisma'
};

class RPGDiceEngine {
    /**
     * Calculate ability modifier from score
     * @param {number} score - Ability score (1-30)
     * @returns {number} Modifier
     */
    static getModifier(score) {
        return Math.floor((score - 10) / 2);
    }

    /**
     * Format modifier for display (+3, -1, etc.)
     * @param {number} modifier
     * @returns {string}
     */
    static formatModifier(modifier) {
        return modifier >= 0 ? `+${modifier}` : `${modifier}`;
    }

    /**
     * Roll a d20 with advantage/disadvantage
     * @param {string} advantageType - 'normal', 'advantage', 'disadvantage'
     * @returns {object} Roll result
     */
    static rollD20(advantageType = 'normal') {
        const roll1 = rollDie(20);
        const roll2 = advantageType !== 'normal' ? rollDie(20) : null;

        let finalRoll = roll1;
        let usedRoll = roll1;
        let otherRoll = null;

        if (advantageType === 'advantage') {
            finalRoll = Math.max(roll1, roll2);
            usedRoll = finalRoll;
            otherRoll = roll1 === finalRoll ? roll2 : roll1;
        } else if (advantageType === 'disadvantage') {
            finalRoll = Math.min(roll1, roll2);
            usedRoll = finalRoll;
            otherRoll = roll1 === finalRoll ? roll2 : roll1;
        }

        return {
            roll: finalRoll,
            allRolls: roll2 !== null ? [roll1, roll2] : [roll1],
            usedRoll,
            droppedRoll: otherRoll,
            isCritical: finalRoll === 20,
            isFumble: finalRoll === 1,
            advantageType
        };
    }

    /**
     * Roll a generic dice expression
     * @param {string} notation - Dice notation (e.g., "2d6+3")
     * @param {object} options - Additional options
     * @returns {object} Roll result
     */
    static roll(notation, options = {}) {
        const { userId, guildId, characterId, context, rollType = 'custom' } = options;

        const result = executeRoll(notation);

        return {
            ...result,
            rollType,
            context,
            userId,
            guildId,
            characterId
        };
    }

    /**
     * Make an ability check
     * @param {object} character - Character data
     * @param {string} ability - Ability name (strength, dexterity, etc.)
     * @param {string} advantageType - 'normal', 'advantage', 'disadvantage'
     * @param {number} dc - Difficulty Class (optional)
     * @returns {object} Check result
     */
    static abilityCheck(character, ability, advantageType = 'normal', dc = null) {
        const abilityKey = ABILITY_CODES[ability.toLowerCase()] || ability.toLowerCase();
        const abilityName = ABILITIES[abilityKey];

        if (!abilityName) {
            throw new Error(`Invalid ability: ${ability}`);
        }

        const score = character[abilityKey] || 10;
        const modifier = this.getModifier(score);

        const d20Result = this.rollD20(advantageType);
        const total = d20Result.roll + modifier;

        const success = dc !== null ? total >= dc : null;

        return {
            rollType: 'ability',
            ability: abilityKey,
            abilityName,
            score,
            modifier,
            d20: d20Result,
            total,
            dc,
            success,
            margin: dc !== null ? total - dc : null,
            formula: `1d20 ${this.formatModifier(modifier)}`
        };
    }

    /**
     * Make a skill check
     * @param {object} character - Character data with skill proficiencies
     * @param {string} skill - Skill name
     * @param {string} advantageType - 'normal', 'advantage', 'disadvantage'
     * @param {number} dc - Difficulty Class (optional)
     * @returns {object} Check result
     */
    static skillCheck(character, skill, advantageType = 'normal', dc = null) {
        const skillKey = skill.toLowerCase().replace(/ /g, '_');
        const skillInfo = SKILLS[skillKey];

        if (!skillInfo) {
            throw new Error(`Invalid skill: ${skill}`);
        }

        const abilityScore = character[skillInfo.ability] || 10;
        const abilityMod = this.getModifier(abilityScore);
        const proficiencyBonus = character.proficiency_bonus || 2;

        // Check if proficient/expert in skill
        let proficiencyLevel = 0; // 0 = none, 1 = proficient, 2 = expertise
        let skillMod = abilityMod;

        // Check skill proficiencies JSON
        if (character.skill_proficiencies) {
            let proficiencies = character.skill_proficiencies;
            if (typeof proficiencies === 'string') {
                try {
                    proficiencies = JSON.parse(proficiencies);
                } catch {
                    proficiencies = [];
                }
            }

            if (Array.isArray(proficiencies)) {
                const skillEntry = proficiencies.find(p =>
                    (typeof p === 'string' && p.toLowerCase() === skillKey) ||
                    (typeof p === 'object' && p.name?.toLowerCase().replace(/ /g, '_') === skillKey)
                );

                if (skillEntry) {
                    proficiencyLevel = typeof skillEntry === 'object' && skillEntry.expertise ? 2 : 1;
                }
            }
        }

        skillMod += proficiencyBonus * proficiencyLevel;

        const d20Result = this.rollD20(advantageType);
        const total = d20Result.roll + skillMod;
        const success = dc !== null ? total >= dc : null;

        return {
            rollType: 'skill_check',
            skill: skillKey,
            skillName: skillInfo.name,
            ability: skillInfo.ability,
            abilityScore,
            abilityMod,
            proficiencyLevel,
            proficiencyBonus: proficiencyLevel > 0 ? proficiencyBonus * proficiencyLevel : 0,
            totalModifier: skillMod,
            d20: d20Result,
            total,
            dc,
            success,
            margin: dc !== null ? total - dc : null,
            formula: `1d20 ${this.formatModifier(skillMod)}`
        };
    }

    /**
     * Make a saving throw
     * @param {object} character - Character data
     * @param {string} ability - Saving throw type
     * @param {number} dc - Difficulty Class
     * @param {string} advantageType - 'normal', 'advantage', 'disadvantage'
     * @returns {object} Save result
     */
    static savingThrow(character, ability, dc, advantageType = 'normal') {
        const abilityKey = ABILITY_CODES[ability.toLowerCase()] || ability.toLowerCase();
        const abilityName = ABILITIES[abilityKey];

        if (!abilityName) {
            throw new Error(`Invalid ability: ${ability}`);
        }

        const score = character[abilityKey] || 10;
        const abilityMod = this.getModifier(score);
        const proficiencyBonus = character.proficiency_bonus || 2;

        // Check if proficient in this save
        let isProficient = false;
        if (character.saving_throws) {
            let saves = character.saving_throws;
            if (typeof saves === 'string') {
                try {
                    saves = JSON.parse(saves);
                } catch {
                    saves = [];
                }
            }
            if (Array.isArray(saves)) {
                isProficient = saves.some(s =>
                    (typeof s === 'string' && s.toLowerCase() === abilityKey) ||
                    (typeof s === 'object' && s.ability?.toLowerCase() === abilityKey && s.proficient)
                );
            }
        }

        const saveMod = abilityMod + (isProficient ? proficiencyBonus : 0);

        const d20Result = this.rollD20(advantageType);
        const total = d20Result.roll + saveMod;
        const success = total >= dc;

        return {
            rollType: 'saving_throw',
            ability: abilityKey,
            abilityName,
            score,
            abilityMod,
            isProficient,
            proficiencyBonus: isProficient ? proficiencyBonus : 0,
            totalModifier: saveMod,
            d20: d20Result,
            total,
            dc,
            success,
            margin: total - dc,
            formula: `1d20 ${this.formatModifier(saveMod)}`
        };
    }

    /**
     * Roll initiative
     * @param {object} character - Character data
     * @param {number} bonus - Additional initiative bonus
     * @returns {object} Initiative result
     */
    static rollInitiative(character, bonus = 0) {
        const dexMod = this.getModifier(character.dexterity || 10);
        const initiativeBonus = (character.initiative || 0) + bonus;
        const totalMod = dexMod + initiativeBonus;

        const d20Result = this.rollD20('normal');
        const total = d20Result.roll + totalMod;

        return {
            rollType: 'initiative',
            d20: d20Result,
            dexMod,
            initiativeBonus,
            totalModifier: totalMod,
            total,
            formula: `1d20 ${this.formatModifier(totalMod)}`
        };
    }

    /**
     * Roll an attack
     * @param {object} character - Character data
     * @param {string} attackType - 'melee' or 'ranged'
     * @param {object} weapon - Weapon data (optional)
     * @param {string} advantageType - 'normal', 'advantage', 'disadvantage'
     * @param {number} targetAC - Target's AC
     * @returns {object} Attack result
     */
    static rollAttack(character, attackType = 'melee', weapon = null, advantageType = 'normal', targetAC = null) {
        // Determine ability modifier
        const isFinesse = weapon?.properties?.includes('finesse');
        const isRanged = attackType === 'ranged' || weapon?.properties?.includes('ranged');

        let abilityKey = isRanged ? 'dexterity' : 'strength';
        if (isFinesse) {
            // Use higher of STR or DEX for finesse weapons
            const strMod = this.getModifier(character.strength || 10);
            const dexMod = this.getModifier(character.dexterity || 10);
            abilityKey = dexMod > strMod ? 'dexterity' : 'strength';
        }

        const abilityMod = this.getModifier(character[abilityKey] || 10);
        const proficiencyBonus = character.proficiency_bonus || 2;
        const weaponBonus = weapon?.attack_bonus || 0;

        // Assume proficiency with weapon for simplicity
        const attackMod = abilityMod + proficiencyBonus + weaponBonus;

        const d20Result = this.rollD20(advantageType);
        const total = d20Result.roll + attackMod;

        // Determine hit (nat 20 always hits, nat 1 always misses)
        let hit = null;
        if (targetAC !== null) {
            if (d20Result.isCritical) {
                hit = true;
            } else if (d20Result.isFumble) {
                hit = false;
            } else {
                hit = total >= targetAC;
            }
        }

        return {
            rollType: 'attack',
            attackType,
            ability: abilityKey,
            abilityMod,
            proficiencyBonus,
            weaponBonus,
            totalModifier: attackMod,
            d20: d20Result,
            total,
            targetAC,
            hit,
            isCritical: d20Result.isCritical,
            isFumble: d20Result.isFumble,
            formula: `1d20 ${this.formatModifier(attackMod)}`
        };
    }

    /**
     * Roll damage
     * @param {string} damageDice - Damage dice notation (e.g., "1d8")
     * @param {number} modifier - Damage modifier
     * @param {boolean} critical - Double dice on critical
     * @param {string} damageType - Type of damage (slashing, fire, etc.)
     * @returns {object} Damage result
     */
    static rollDamage(damageDice, modifier = 0, critical = false, damageType = 'bludgeoning') {
        let notation = damageDice;

        // Double dice on critical
        if (critical) {
            const match = notation.match(/^(\d+)d(\d+)/);
            if (match) {
                const count = parseInt(match[1]) * 2;
                notation = notation.replace(/^\d+/, count.toString());
            }
        }

        // Add modifier
        if (modifier !== 0) {
            notation = `${notation}${modifier >= 0 ? '+' : ''}${modifier}`;
        }

        const result = executeRoll(notation);

        return {
            rollType: 'damage',
            originalDice: damageDice,
            notation,
            ...result,
            critical,
            damageType
        };
    }

    /**
     * Log a roll to the database
     * @param {object} rollData - Roll data to log
     */
    static async logRoll(rollData) {
        try {
            const {
                userId,
                guildId,
                characterId,
                rollType,
                notation,
                rolls,
                modifier,
                total,
                advantageType,
                isCritical,
                isFumble,
                dc,
                success,
                context
            } = rollData;

            await pool.execute(
                `INSERT INTO dnd_dice_rolls
                (user_id, guild_id, character_id, roll_type, dice_notation, individual_rolls,
                 modifier, total_result, advantage_status, is_critical, is_fumble, dc, success, context)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    guildId,
                    characterId || null,
                    rollType || 'custom',
                    notation || '1d20',
                    JSON.stringify(rolls || []),
                    modifier || 0,
                    total,
                    advantageType || 'normal',
                    isCritical || false,
                    isFumble || false,
                    dc || null,
                    success !== undefined ? success : null,
                    context || null
                ]
            );
        } catch (error) {
            logger.error('[RPGDiceEngine] Failed to log roll:', { error: error.message });
        }
    }

    /**
     * Get recent rolls for a user
     * @param {string} userId - Discord user ID
     * @param {string} guildId - Guild ID
     * @param {number} limit - Max rolls to return
     * @returns {Array} Recent rolls
     */
    static async getRecentRolls(userId, guildId, limit = 10) {
        const [rows] = await pool.execute(
            `SELECT * FROM dnd_dice_rolls
             WHERE user_id = ? AND guild_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [userId, guildId, limit]
        );
        return rows;
    }
}

export default RPGDiceEngine;
export { RPGDiceEngine };
