import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * RPG Character Manager - Handles D&D 5e character management
 * Implements authentic tabletop D&D rules
 */
class RPGCharacterManager {
    constructor(client) {
        this.client = client;

        // Racial stat bonuses and traits (D&D 5e PHB)
        this.racialBonuses = {
            'human': { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1, speed: 30, traits: ['Extra Language'] },
            'variant human': { choice: 2, feat: true, speed: 30, traits: ['Extra Skill', 'Bonus Feat'] },
            'elf': { dex: 2, speed: 30, traits: ['Darkvision', 'Fey Ancestry', 'Trance'] },
            'high elf': { dex: 2, int: 1, speed: 30, traits: ['Darkvision', 'Fey Ancestry', 'Trance', 'Cantrip'] },
            'wood elf': { dex: 2, wis: 1, speed: 35, traits: ['Darkvision', 'Fey Ancestry', 'Trance', 'Mask of the Wild'] },
            'dark elf': { dex: 2, cha: 1, speed: 30, traits: ['Superior Darkvision', 'Sunlight Sensitivity', 'Drow Magic'] },
            'dwarf': { con: 2, speed: 25, traits: ['Darkvision', 'Dwarven Resilience', 'Stonecunning'] },
            'hill dwarf': { con: 2, wis: 1, speed: 25, hpBonus: 1, traits: ['Darkvision', 'Dwarven Resilience', 'Dwarven Toughness'] },
            'mountain dwarf': { con: 2, str: 2, speed: 25, traits: ['Darkvision', 'Dwarven Resilience', 'Dwarven Armor Training'] },
            'halfling': { dex: 2, speed: 25, traits: ['Lucky', 'Brave', 'Halfling Nimbleness'] },
            'lightfoot halfling': { dex: 2, cha: 1, speed: 25, traits: ['Lucky', 'Brave', 'Naturally Stealthy'] },
            'stout halfling': { dex: 2, con: 1, speed: 25, traits: ['Lucky', 'Brave', 'Stout Resilience'] },
            'dragonborn': { str: 2, cha: 1, speed: 30, traits: ['Draconic Ancestry', 'Breath Weapon', 'Damage Resistance'] },
            'gnome': { int: 2, speed: 25, traits: ['Darkvision', 'Gnome Cunning'] },
            'rock gnome': { int: 2, con: 1, speed: 25, traits: ['Darkvision', 'Gnome Cunning', 'Artificer\'s Lore', 'Tinker'] },
            'forest gnome': { int: 2, dex: 1, speed: 25, traits: ['Darkvision', 'Gnome Cunning', 'Natural Illusionist', 'Speak with Small Beasts'] },
            'half-elf': { cha: 2, choice: 2, speed: 30, traits: ['Darkvision', 'Fey Ancestry', 'Skill Versatility'] },
            'half-orc': { str: 2, con: 1, speed: 30, traits: ['Darkvision', 'Menacing', 'Relentless Endurance', 'Savage Attacks'] },
            'tiefling': { cha: 2, int: 1, speed: 30, traits: ['Darkvision', 'Hellish Resistance', 'Infernal Legacy'] },
            'aasimar': { cha: 2, speed: 30, traits: ['Darkvision', 'Celestial Resistance', 'Healing Hands', 'Light Bearer'] },
            'goliath': { str: 2, con: 1, speed: 30, traits: ['Natural Athlete', 'Stone\'s Endurance', 'Powerful Build', 'Mountain Born'] },
            'tabaxi': { dex: 2, cha: 1, speed: 30, traits: ['Darkvision', 'Feline Agility', 'Cat\'s Claws', 'Cat\'s Talent'] },
            'kenku': { dex: 2, wis: 1, speed: 30, traits: ['Expert Forgery', 'Kenku Training', 'Mimicry'] },
            'tortle': { str: 2, wis: 1, speed: 30, traits: ['Natural Armor', 'Hold Breath', 'Shell Defense', 'Survival Instinct'] },
            'aarakocra': { dex: 2, wis: 1, speed: 25, fly: 50, traits: ['Flight', 'Talons'] },
            'genasi': { con: 2, speed: 30, traits: ['Elemental Heritage'] },
            'firbolg': { wis: 2, str: 1, speed: 30, traits: ['Firbolg Magic', 'Hidden Step', 'Powerful Build', 'Speech of Beast and Leaf'] },
            'yuan-ti': { cha: 2, int: 1, speed: 30, traits: ['Darkvision', 'Innate Spellcasting', 'Magic Resistance', 'Poison Immunity'] },
            'changeling': { cha: 2, choice: 1, speed: 30, traits: ['Shapechanger', 'Changeling Instincts'] },
            'warforged': { con: 2, choice: 1, speed: 30, traits: ['Constructed Resilience', 'Sentry\'s Rest', 'Integrated Protection'] },
            'custom': { choice: 3, speed: 30, traits: ['Custom Lineage'] }
        };

        // Background proficiencies and features (D&D 5e PHB)
        this.backgrounds = {
            'acolyte': { skills: ['insight', 'religion'], languages: 2, feature: 'Shelter of the Faithful' },
            'charlatan': { skills: ['deception', 'sleight of hand'], tools: ['disguise kit', 'forgery kit'], feature: 'False Identity' },
            'criminal': { skills: ['deception', 'stealth'], tools: ['thieves\' tools', 'gaming set'], feature: 'Criminal Contact' },
            'entertainer': { skills: ['acrobatics', 'performance'], tools: ['disguise kit', 'musical instrument'], feature: 'By Popular Demand' },
            'folk hero': { skills: ['animal handling', 'survival'], tools: ['artisan\'s tools', 'vehicles (land)'], feature: 'Rustic Hospitality' },
            'guild artisan': { skills: ['insight', 'persuasion'], tools: ['artisan\'s tools'], languages: 1, feature: 'Guild Membership' },
            'hermit': { skills: ['medicine', 'religion'], tools: ['herbalism kit'], languages: 1, feature: 'Discovery' },
            'noble': { skills: ['history', 'persuasion'], tools: ['gaming set'], languages: 1, feature: 'Position of Privilege' },
            'outlander': { skills: ['athletics', 'survival'], tools: ['musical instrument'], languages: 1, feature: 'Wanderer' },
            'sage': { skills: ['arcana', 'history'], languages: 2, feature: 'Researcher' },
            'sailor': { skills: ['athletics', 'perception'], tools: ['navigator\'s tools', 'vehicles (water)'], feature: 'Ship\'s Passage' },
            'soldier': { skills: ['athletics', 'intimidation'], tools: ['gaming set', 'vehicles (land)'], feature: 'Military Rank' },
            'urchin': { skills: ['sleight of hand', 'stealth'], tools: ['disguise kit', 'thieves\' tools'], feature: 'City Secrets' },
            'haunted one': { skills: ['choice', 'choice'], languages: 2, feature: 'Heart of Darkness' },
            'far traveler': { skills: ['insight', 'perception'], tools: ['musical instrument or gaming set'], languages: 1, feature: 'All Eyes on You' }
        };

        // Class base stats - Full D&D Beyond classes
        this.classStats = {
            'barbarian': {
                health: 12, hitDie: 'd12', mana: 0,
                strength: 15, dexterity: 13, constitution: 14,
                intelligence: 8, wisdom: 12, charisma: 10,
                saveProficiencies: ['str', 'con']
            },
            'bard': {
                health: 8, hitDie: 'd8', mana: 100,
                strength: 10, dexterity: 14, constitution: 12,
                intelligence: 12, wisdom: 10, charisma: 15,
                saveProficiencies: ['dex', 'cha']
            },
            'cleric': {
                health: 8, hitDie: 'd8', mana: 100,
                strength: 14, dexterity: 10, constitution: 13,
                intelligence: 10, wisdom: 15, charisma: 12,
                saveProficiencies: ['wis', 'cha']
            },
            'druid': {
                health: 8, hitDie: 'd8', mana: 100,
                strength: 10, dexterity: 12, constitution: 14,
                intelligence: 12, wisdom: 15, charisma: 10,
                saveProficiencies: ['int', 'wis']
            },
            'fighter': {
                health: 10, hitDie: 'd10', mana: 20,
                strength: 15, dexterity: 13, constitution: 14,
                intelligence: 10, wisdom: 12, charisma: 10,
                saveProficiencies: ['str', 'con']
            },
            'monk': {
                health: 8, hitDie: 'd8', mana: 50,
                strength: 12, dexterity: 15, constitution: 13,
                intelligence: 10, wisdom: 14, charisma: 10,
                saveProficiencies: ['str', 'dex']
            },
            'paladin': {
                health: 10, hitDie: 'd10', mana: 80,
                strength: 15, dexterity: 10, constitution: 13,
                intelligence: 10, wisdom: 12, charisma: 14,
                saveProficiencies: ['wis', 'cha']
            },
            'ranger': {
                health: 10, hitDie: 'd10', mana: 80,
                strength: 12, dexterity: 15, constitution: 13,
                intelligence: 10, wisdom: 14, charisma: 10,
                saveProficiencies: ['str', 'dex']
            },
            'rogue': {
                health: 8, hitDie: 'd8', mana: 30,
                strength: 10, dexterity: 15, constitution: 12,
                intelligence: 14, wisdom: 12, charisma: 13,
                saveProficiencies: ['dex', 'int']
            },
            'sorcerer': {
                health: 6, hitDie: 'd6', mana: 100,
                strength: 8, dexterity: 12, constitution: 14,
                intelligence: 10, wisdom: 10, charisma: 15,
                saveProficiencies: ['con', 'cha']
            },
            'warlock': {
                health: 8, hitDie: 'd8', mana: 100,
                strength: 10, dexterity: 12, constitution: 14,
                intelligence: 10, wisdom: 10, charisma: 15,
                saveProficiencies: ['wis', 'cha']
            },
            'wizard': {
                health: 6, hitDie: 'd6', mana: 100,
                strength: 8, dexterity: 12, constitution: 13,
                intelligence: 15, wisdom: 14, charisma: 10,
                saveProficiencies: ['int', 'wis']
            },
            'artificer': {
                health: 8, hitDie: 'd8', mana: 80,
                strength: 10, dexterity: 12, constitution: 14,
                intelligence: 15, wisdom: 12, charisma: 10,
                saveProficiencies: ['con', 'int']
            }
        };
    }

    // ========================================
    // D&D 5e STAT ROLLING METHODS
    // ========================================

    /**
     * Roll 4d6 drop lowest - Standard D&D stat rolling method
     * @returns {Object} { total: number, rolls: number[], dropped: number }
     */
    roll4d6DropLowest() {
        const rolls = [];
        for (let i = 0; i < 4; i++) {
            rolls.push(Math.floor(Math.random() * 6) + 1);
        }
        rolls.sort((a, b) => b - a); // Sort descending
        const dropped = rolls.pop(); // Remove lowest
        const total = rolls.reduce((sum, r) => sum + r, 0);
        return { total, rolls: [...rolls, dropped], dropped, kept: rolls };
    }

    /**
     * Roll a full set of 6 ability scores using 4d6 drop lowest
     * @returns {Object} { scores: number[], details: Array<{total, rolls, dropped}> }
     */
    rollAbilityScores() {
        const details = [];
        const scores = [];
        for (let i = 0; i < 6; i++) {
            const roll = this.roll4d6DropLowest();
            scores.push(roll.total);
            details.push(roll);
        }
        // Sort scores descending for easier assignment
        scores.sort((a, b) => b - a);
        return { scores, details };
    }

    /**
     * Standard Array - Pre-determined balanced stats
     * @returns {number[]} [15, 14, 13, 12, 10, 8]
     */
    getStandardArray() {
        return [15, 14, 13, 12, 10, 8];
    }

    /**
     * Point Buy - Calculate cost of a stat value
     * Stats start at 8, cost 1 point each up to 13, then 2 points for 14-15
     * @param {number} value - The stat value (8-15)
     * @returns {number} - Point cost
     */
    getPointBuyCost(value) {
        if (value <= 8) return 0;
        if (value <= 13) return value - 8;
        if (value === 14) return 7;
        if (value === 15) return 9;
        return Infinity; // Can't buy higher than 15
    }

    /**
     * Validate point buy allocation
     * @param {Object} stats - { str, dex, con, int, wis, cha }
     * @returns {Object} { valid: boolean, totalCost: number, remaining: number }
     */
    validatePointBuy(stats) {
        const POINT_BUDGET = 27;
        let totalCost = 0;
        for (const stat of Object.values(stats)) {
            if (stat < 8 || stat > 15) {
                return { valid: false, error: 'Stats must be between 8 and 15' };
            }
            totalCost += this.getPointBuyCost(stat);
        }
        return {
            valid: totalCost <= POINT_BUDGET,
            totalCost,
            remaining: POINT_BUDGET - totalCost
        };
    }

    /**
     * Apply racial bonuses to base stats
     * @param {Object} baseStats - { str, dex, con, int, wis, cha }
     * @param {string} race - Race/species name
     * @returns {Object} Modified stats with bonuses applied
     */
    applyRacialBonuses(baseStats, race) {
        const raceLower = race?.toLowerCase() || 'human';
        const bonuses = this.racialBonuses[raceLower] || this.racialBonuses['human'];

        const modifiedStats = { ...baseStats };
        if (bonuses.str) modifiedStats.str = Math.min(20, modifiedStats.str + bonuses.str);
        if (bonuses.dex) modifiedStats.dex = Math.min(20, modifiedStats.dex + bonuses.dex);
        if (bonuses.con) modifiedStats.con = Math.min(20, modifiedStats.con + bonuses.con);
        if (bonuses.int) modifiedStats.int = Math.min(20, modifiedStats.int + bonuses.int);
        if (bonuses.wis) modifiedStats.wis = Math.min(20, modifiedStats.wis + bonuses.wis);
        if (bonuses.cha) modifiedStats.cha = Math.min(20, modifiedStats.cha + bonuses.cha);

        return {
            stats: modifiedStats,
            bonusesApplied: bonuses,
            traits: bonuses.traits || [],
            speed: bonuses.speed || 30,
            hpBonus: bonuses.hpBonus || 0
        };
    }

    /**
     * Calculate ability modifier from score
     * @param {number} score - Ability score (1-30)
     * @returns {number} Modifier (-5 to +10)
     */
    getAbilityModifier(score) {
        return Math.floor((score - 10) / 2);
    }

    // ========================================
    // D&D 5e DEATH SAVING THROWS
    // ========================================

    /**
     * Make a death saving throw
     * @param {number} characterId
     * @returns {Object} { roll, success, failures, successes, stable, dead, criticalSuccess }
     */
    async makeDeathSave(characterId) {
        const [chars] = await pool.execute(
            'SELECT death_save_successes, death_save_failures, health FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (!chars[0]) throw new Error('Character not found');

        const char = chars[0];
        if (char.health > 0) {
            return { error: 'Character is not at 0 HP' };
        }

        let successes = char.death_save_successes || 0;
        let failures = char.death_save_failures || 0;

        const roll = Math.floor(Math.random() * 20) + 1;
        let criticalSuccess = false;
        let criticalFailure = false;

        if (roll === 1) {
            // Critical failure - 2 failures
            failures += 2;
            criticalFailure = true;
        } else if (roll === 20) {
            // Critical success - regain 1 HP and wake up!
            criticalSuccess = true;
            await pool.execute(
                'UPDATE dnd_characters SET health = 1, death_save_successes = 0, death_save_failures = 0 WHERE character_id = ?',
                [characterId]
            );
            return { roll, criticalSuccess: true, regainedHP: true, message: 'Critical Success! You regain 1 HP and are conscious!' };
        } else if (roll >= 10) {
            successes += 1;
        } else {
            failures += 1;
        }

        // Check for stabilization or death
        const stable = successes >= 3;
        const dead = failures >= 3;

        if (stable) {
            await pool.execute(
                'UPDATE dnd_characters SET death_save_successes = 0, death_save_failures = 0 WHERE character_id = ?',
                [characterId]
            );
        } else if (dead) {
            await pool.execute(
                'UPDATE dnd_characters SET health = 0, death_save_successes = 0, death_save_failures = 0 WHERE character_id = ?',
                [characterId]
            );
        } else {
            await pool.execute(
                'UPDATE dnd_characters SET death_save_successes = ?, death_save_failures = ? WHERE character_id = ?',
                [successes, failures, characterId]
            );
        }

        return {
            roll,
            success: roll >= 10,
            criticalFailure,
            successes,
            failures,
            stable,
            dead,
            message: dead ? '💀 You have died.' : stable ? '🛡️ You are stable!' : `Death Save: ${roll} (${roll >= 10 ? '✅' : '❌'})`
        };
    }

    // ========================================
    // D&D 5e REST MECHANICS
    // ========================================

    /**
     * Short Rest - Spend hit dice to heal, recover some abilities
     * @param {number} characterId
     * @param {number} hitDiceToSpend - How many hit dice to spend for healing
     * @returns {Object} Result of short rest
     */
    async shortRest(characterId, hitDiceToSpend = 0) {
        const [chars] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (!chars[0]) throw new Error('Character not found');
        const char = chars[0];

        // Parse hit dice (e.g., "3d10" -> { current: 3, die: 'd10' })
        const hitDiceMatch = char.hit_dice?.match(/(\d+)(d\d+)/);
        const currentHitDice = hitDiceMatch ? parseInt(hitDiceMatch[1]) : char.level;
        const hitDie = hitDiceMatch ? hitDiceMatch[2] : 'd8';
        const hitDieMax = parseInt(hitDie.substring(1));

        const diceToSpend = Math.min(hitDiceToSpend, currentHitDice);
        let healingTotal = 0;
        const healingRolls = [];

        // Roll hit dice for healing
        const conMod = this.getAbilityModifier(char.constitution);
        for (let i = 0; i < diceToSpend; i++) {
            const roll = Math.floor(Math.random() * hitDieMax) + 1;
            const healing = Math.max(1, roll + conMod); // Minimum 1 HP per die
            healingTotal += healing;
            healingRolls.push({ roll, conMod, total: healing });
        }

        const newHealth = Math.min(char.max_health, char.health + healingTotal);
        const newHitDice = currentHitDice - diceToSpend;

        // Update character
        await pool.execute(
            `UPDATE dnd_characters SET
                health = ?,
                hit_dice = ?,
                death_save_successes = 0,
                death_save_failures = 0
            WHERE character_id = ?`,
            [newHealth, `${newHitDice}${hitDie}`, characterId]
        );

        // Recover resources (Warlock spell slots, Fighter action surge, etc.)
        // This would be class-specific in a full implementation

        logger.info(`[RPG] Short rest: ${char.character_name} spent ${diceToSpend} hit dice, healed ${healingTotal} HP`);

        return {
            type: 'short',
            hitDiceSpent: diceToSpend,
            hitDiceRemaining: newHitDice,
            healingRolls,
            totalHealing: healingTotal,
            previousHP: char.health,
            newHP: newHealth,
            message: `🏕️ **Short Rest Complete!** Spent ${diceToSpend} hit dice, healed ${healingTotal} HP (${char.health} → ${newHealth})`
        };
    }

    /**
     * Long Rest - Full HP recovery, recover half hit dice, reset abilities
     * @param {number} characterId
     * @returns {Object} Result of long rest
     */
    async longRest(characterId) {
        const [chars] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (!chars[0]) throw new Error('Character not found');
        const char = chars[0];

        // Parse hit dice
        const hitDiceMatch = char.hit_dice?.match(/(\d+)(d\d+)/);
        const currentHitDice = hitDiceMatch ? parseInt(hitDiceMatch[1]) : 0;
        const hitDie = hitDiceMatch ? hitDiceMatch[2] : 'd8';

        // Recover half of total hit dice (minimum 1)
        const maxHitDice = char.level;
        const hitDiceRecovered = Math.max(1, Math.floor(maxHitDice / 2));
        const newHitDice = Math.min(maxHitDice, currentHitDice + hitDiceRecovered);

        // Reduce exhaustion by 1 level (if they have food/water)
        const currentExhaustion = char.exhaustion_level || 0;
        const newExhaustion = Math.max(0, currentExhaustion - 1);

        // Full HP recovery, full mana/spell slot recovery
        await pool.execute(
            `UPDATE dnd_characters SET
                health = max_health,
                mana = max_mana,
                hit_dice = ?,
                exhaustion_level = ?,
                death_save_successes = 0,
                death_save_failures = 0,
                inspiration = COALESCE(inspiration, 0)
            WHERE character_id = ?`,
            [`${newHitDice}${hitDie}`, newExhaustion, characterId]
        );

        logger.info(`[RPG] Long rest: ${char.character_name} fully healed, recovered ${hitDiceRecovered} hit dice`);

        return {
            type: 'long',
            previousHP: char.health,
            newHP: char.max_health,
            hitDiceRecovered,
            hitDiceTotal: newHitDice,
            exhaustionReduced: currentExhaustion > 0,
            newExhaustionLevel: newExhaustion,
            manaRestored: char.max_mana,
            message: `🌙 **Long Rest Complete!** Fully healed to ${char.max_health} HP. Recovered ${hitDiceRecovered} hit dice. ${currentExhaustion > 0 ? `Exhaustion reduced to level ${newExhaustion}.` : ''}`
        };
    }

    // ========================================
    // D&D 5e EXHAUSTION SYSTEM
    // ========================================

    /**
     * Add exhaustion level
     * @param {number} characterId
     * @param {number} levels - Number of levels to add (default 1)
     */
    async addExhaustion(characterId, levels = 1) {
        const [chars] = await pool.execute(
            'SELECT exhaustion_level, character_name FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (!chars[0]) throw new Error('Character not found');

        const currentLevel = chars[0].exhaustion_level || 0;
        const newLevel = Math.min(6, currentLevel + levels);

        await pool.execute(
            'UPDATE dnd_characters SET exhaustion_level = ? WHERE character_id = ?',
            [newLevel, characterId]
        );

        const effects = this.getExhaustionEffects(newLevel);

        // Level 6 = death
        if (newLevel >= 6) {
            await pool.execute(
                'UPDATE dnd_characters SET health = 0 WHERE character_id = ?',
                [characterId]
            );
        }

        return {
            previousLevel: currentLevel,
            newLevel,
            effects,
            dead: newLevel >= 6,
            message: newLevel >= 6
                ? `💀 ${chars[0].character_name} has died from exhaustion!`
                : `😰 Exhaustion increased to level ${newLevel}: ${effects.join(', ')}`
        };
    }

    /**
     * Remove exhaustion level
     * @param {number} characterId
     * @param {number} levels - Number of levels to remove (default 1)
     */
    async removeExhaustion(characterId, levels = 1) {
        const [chars] = await pool.execute(
            'SELECT exhaustion_level, character_name FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (!chars[0]) throw new Error('Character not found');

        const currentLevel = chars[0].exhaustion_level || 0;
        const newLevel = Math.max(0, currentLevel - levels);

        await pool.execute(
            'UPDATE dnd_characters SET exhaustion_level = ? WHERE character_id = ?',
            [newLevel, characterId]
        );

        const effects = newLevel > 0 ? this.getExhaustionEffects(newLevel) : [];

        return {
            previousLevel: currentLevel,
            newLevel,
            effects,
            fullyRested: newLevel === 0,
            message: newLevel === 0
                ? `✨ ${chars[0].character_name} is no longer exhausted!`
                : `😌 Exhaustion reduced to level ${newLevel}: ${effects.join(', ')}`
        };
    }

    /**
     * Get effects of exhaustion level
     * @param {number} level - Exhaustion level (1-6)
     * @returns {string[]} Array of effect descriptions
     */
    getExhaustionEffects(level) {
        const effects = [];
        if (level >= 1) effects.push('Disadvantage on ability checks');
        if (level >= 2) effects.push('Speed halved');
        if (level >= 3) effects.push('Disadvantage on attack rolls and saving throws');
        if (level >= 4) effects.push('HP maximum halved');
        if (level >= 5) effects.push('Speed reduced to 0');
        if (level >= 6) effects.push('DEATH');
        return effects;
    }

    // ========================================
    // D&D 5e INSPIRATION SYSTEM
    // ========================================

    /**
     * Award inspiration to a character
     * @param {number} characterId
     */
    async grantInspiration(characterId) {
        await pool.execute(
            'UPDATE dnd_characters SET inspiration = 1 WHERE character_id = ?',
            [characterId]
        );
        return { message: '✨ You have been granted Inspiration!' };
    }

    /**
     * Use inspiration for advantage on a roll
     * @param {number} characterId
     */
    async useInspiration(characterId) {
        const [chars] = await pool.execute(
            'SELECT inspiration FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (!chars[0] || !chars[0].inspiration) {
            return { success: false, message: 'You don\'t have inspiration to use.' };
        }

        await pool.execute(
            'UPDATE dnd_characters SET inspiration = 0 WHERE character_id = ?',
            [characterId]
        );

        return { success: true, message: '✨ Inspiration used! Roll with advantage.' };
    }

    // ========================================
    // D&D 5e ADVANTAGE/DISADVANTAGE ROLLING
    // ========================================

    /**
     * Roll with advantage (roll 2d20, take higher)
     * @returns {Object} { roll1, roll2, result, type: 'advantage' }
     */
    rollWithAdvantage() {
        const roll1 = Math.floor(Math.random() * 20) + 1;
        const roll2 = Math.floor(Math.random() * 20) + 1;
        return {
            roll1,
            roll2,
            result: Math.max(roll1, roll2),
            type: 'advantage',
            display: `🎲 (${roll1}, ${roll2}) = **${Math.max(roll1, roll2)}** (Advantage)`
        };
    }

    /**
     * Roll with disadvantage (roll 2d20, take lower)
     * @returns {Object} { roll1, roll2, result, type: 'disadvantage' }
     */
    rollWithDisadvantage() {
        const roll1 = Math.floor(Math.random() * 20) + 1;
        const roll2 = Math.floor(Math.random() * 20) + 1;
        return {
            roll1,
            roll2,
            result: Math.min(roll1, roll2),
            type: 'disadvantage',
            display: `🎲 (${roll1}, ${roll2}) = **${Math.min(roll1, roll2)}** (Disadvantage)`
        };
    }

    /**
     * Create a new character (D&D Beyond style)
     */
    async createCharacter(userId, guildId, characterName, className, options = {}) {
        try {
            const classLower = className.toLowerCase();
            if (!this.classStats[classLower]) {
                throw new Error(`Invalid class. Available classes: ${Object.keys(this.classStats).join(', ')}`);
            }

            const classInfo = this.classStats[classLower];

            // Start with base class stats
            let finalStats = {
                str: classInfo.strength,
                dex: classInfo.dexterity,
                con: classInfo.constitution,
                int: classInfo.intelligence,
                wis: classInfo.wisdom,
                cha: classInfo.charisma
            };

            // Apply racial bonuses if species is provided
            let racialInfo = { traits: [], speed: 30, hpBonus: 0 };
            if (options.species) {
                const raceResult = this.applyRacialBonuses(finalStats, options.species);
                finalStats = raceResult.stats;
                racialInfo = raceResult;
            }

            // Get background proficiencies if provided
            let backgroundProfs = [];
            if (options.background) {
                const bgLower = options.background.toLowerCase().replace(/\s+/g, '_');
                if (this.backgrounds[bgLower]) {
                    backgroundProfs = this.backgrounds[bgLower].skills || [];
                }
            }

            // Calculate starting HP: Hit die max + CON modifier + racial HP bonus
            const conMod = Math.floor((finalStats.con - 10) / 2);
            const hitDieMax = parseInt(classInfo.hitDie.substring(1), 10);
            const startingHP = hitDieMax + conMod + racialInfo.hpBonus;

            // Calculate AC (base 10 + DEX mod)
            const dexMod = Math.floor((finalStats.dex - 10) / 2);
            const baseAC = 10 + dexMod;

            // Calculate initiative
            const initiative = dexMod;

            // Combine class skill profs with background profs
            const allSkillProfs = [...new Set([...(classInfo.skillProficiencies || []), ...backgroundProfs])];

            const [result] = await pool.execute(
                `INSERT INTO dnd_characters (
                    user_id, guild_id, character_name, class, level, experience,
                    health, max_health, mana, max_mana, strength, dexterity, constitution,
                    intelligence, wisdom, charisma, gold, current_zone,
                    armor_class, speed, initiative, proficiency_bonus, hit_dice,
                    species, background, saving_throws, skill_proficiencies, racial_traits
                )
                 VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 'town', ?, ?, ?, 2, ?, ?, ?, ?, ?, ?)`,
                [
                    userId, guildId, characterName, classLower,
                    startingHP, startingHP, classInfo.mana, classInfo.mana,
                    finalStats.str, finalStats.dex, finalStats.con,
                    finalStats.int, finalStats.wis, finalStats.cha,
                    baseAC, `${racialInfo.speed} ft.`, initiative, `1${classInfo.hitDie}`,
                    options.species || 'Human', options.background || null,
                    JSON.stringify(classInfo.saveProficiencies),
                    JSON.stringify(allSkillProfs),
                    JSON.stringify(racialInfo.traits || [])
                ]
            );

            logger.info(`[RPGCharacterManager] Created character ${characterName} (${className}/${options.species || 'Human'}) for user ${userId} in guild ${guildId}`);
            return {
                characterId: result.insertId,
                health: startingHP,
                max_health: startingHP,
                strength: finalStats.str,
                dexterity: finalStats.dex,
                constitution: finalStats.con,
                intelligence: finalStats.int,
                wisdom: finalStats.wis,
                charisma: finalStats.cha,
                racialTraits: racialInfo.traits,
                speed: racialInfo.speed,
                backgroundSkills: backgroundProfs,
                ...classInfo
            };

        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw new Error('You already have a character in this server. Delete it first to create a new one.');
            }
            logger.error(`[RPGCharacterManager] Error creating character: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get character info
     */
    async getCharacter(userId, guildId) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM dnd_characters WHERE user_id = ? AND guild_id = ?',
                [userId, guildId]
            );

            return rows[0] || null;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error getting character: ${error.message}`);
            return null;
        }
    }

    /**
     * Create a character from imported PDF data - Full D&D Beyond support
     */
    async createCharacterFromImport(userId, guildId, characterData) {
        try {
            // Build the full insert query with all D&D Beyond fields
            const [result] = await pool.execute(
                `INSERT INTO dnd_characters (
                    user_id, guild_id, character_name, player_name, class, multiclass, subclass,
                    species, background, alignment, level, experience,
                    health, max_health, temp_hp, mana, max_mana,
                    strength, dexterity, constitution, intelligence, wisdom, charisma,
                    armor_class, speed, initiative, proficiency_bonus, hit_dice,
                    saving_throws, skill_proficiencies,
                    languages, weapon_proficiencies, armor_proficiencies, tool_proficiencies,
                    features, racial_traits, class_features,
                    spellcasting_ability, spell_save_dc, spell_attack_bonus, spell_slots, spells_known, cantrips,
                    class_resource, class_resource_max, class_resource_current,
                    personality_traits, ideals, bonds, flaws, backstory,
                    age, height, weight, eyes, skin, hair,
                    resistances, immunities, vulnerabilities, senses,
                    attacks, actions, bonus_actions, reactions,
                    equipment, gold, copper, silver, electrum, platinum,
                    death_save_successes, death_save_failures, inspiration,
                    current_zone, imported_from, import_data
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?
                )`,
                [
                    userId, guildId, characterData.character_name, characterData.player_name, characterData.class, characterData.multiclass, characterData.subclass,
                    characterData.species, characterData.background, characterData.alignment, characterData.level, characterData.experience || 0,
                    characterData.health, characterData.max_health, characterData.temp_hp || 0, characterData.mana, characterData.max_mana,
                    characterData.strength, characterData.dexterity, characterData.constitution, characterData.intelligence, characterData.wisdom, characterData.charisma,
                    characterData.armor_class || 10, characterData.speed || '30 ft.', characterData.initiative || 0, characterData.proficiency_bonus || 2, characterData.hit_dice,
                    characterData.saving_throws, characterData.skill_proficiencies,
                    characterData.languages, characterData.weapon_proficiencies, characterData.armor_proficiencies, characterData.tool_proficiencies,
                    characterData.features, characterData.racial_traits, characterData.class_features,
                    characterData.spellcasting_ability, characterData.spell_save_dc, characterData.spell_attack_bonus, characterData.spell_slots, characterData.spells_known, characterData.cantrips,
                    characterData.class_resource, characterData.class_resource_max || 0, characterData.class_resource_current || 0,
                    characterData.personality_traits, characterData.ideals, characterData.bonds, characterData.flaws, characterData.backstory,
                    characterData.age, characterData.height, characterData.weight, characterData.eyes, characterData.skin, characterData.hair,
                    characterData.resistances, characterData.immunities, characterData.vulnerabilities, characterData.senses,
                    characterData.attacks, characterData.actions, characterData.bonus_actions, characterData.reactions,
                    characterData.equipment, characterData.gold || 0, characterData.copper || 0, characterData.silver || 0, characterData.electrum || 0, characterData.platinum || 0,
                    characterData.death_save_successes || 0, characterData.death_save_failures || 0, characterData.inspiration || false,
                    characterData.current_zone || 'town', characterData.imported_from || 'dndbeyond', characterData.import_data
                ]
            );

            logger.info(`[RPGCharacterManager] Imported full D&D Beyond character ${characterData.character_name} (${characterData.class}${characterData.subclass ? ' - ' + characterData.subclass : ''} L${characterData.level}) for user ${userId} in guild ${guildId}`);
            return { characterId: result.insertId, ...characterData };

        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw new Error('You already have a character in this server. Delete it first to import a new one.');
            }
            logger.error(`[RPGCharacterManager] Error importing character: ${error.message}`);
            throw error;
        }
    }

    /**
     * Update character fields
     */
    async updateCharacter(characterId, updates) {
        try {
            const validFields = ['health', 'mana', 'gold', 'current_zone', 'experience', 'level'];
            const updateFields = [];
            const values = [];

            for (const [key, value] of Object.entries(updates)) {
                if (validFields.includes(key)) {
                    updateFields.push(`${key} = ?`);
                    values.push(value);
                }
            }

            if (updateFields.length === 0) {
                throw new Error('No valid fields to update');
            }

            values.push(characterId);
            await pool.execute(
                `UPDATE dnd_characters SET ${updateFields.join(', ')} WHERE character_id = ?`,
                values
            );

            return true;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error updating character: ${error.message}`);
            throw error;
        }
    }

    /**
     * Delete character
     */
    async deleteCharacter(userId, guildId) {
        try {
            await pool.execute(
                'DELETE FROM dnd_characters WHERE user_id = ? AND guild_id = ?',
                [userId, guildId]
            );

            logger.info(`[RPGCharacterManager] Deleted character for user ${userId} in guild ${guildId}`);
            return true;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error deleting character: ${error.message}`);
            return false;
        }
    }

    /**
     * Level up character
     */
    async levelUp(characterId) {
        try {
            const [chars] = await pool.execute(
                'SELECT * FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );
            const character = chars[0];

            if (!character) return false;

            const newLevel = character.level + 1;
            const healthIncrease = 10 + Math.floor(character.constitution / 3);
            const manaIncrease = 5 + Math.floor(character.intelligence / 3);

            await pool.execute(
                `UPDATE dnd_characters
                 SET level = ?, max_health = max_health + ?, max_mana = max_mana + ?,
                     health = max_health + ?, mana = max_mana + ?
                 WHERE character_id = ?`,
                [newLevel, healthIncrease, manaIncrease, healthIncrease, manaIncrease, characterId]
            );

            logger.info(`[RPGCharacterManager] Character ${characterId} leveled up to level ${newLevel}`);
            return { newLevel, healthIncrease, manaIncrease };

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error leveling up character: ${error.message}`);
            return false;
        }
    }

    /**
     * Add experience to character
     */
    async addExperience(characterId, exp) {
        try {
            const [chars] = await pool.execute(
                'SELECT level, experience FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );
            const character = chars[0];

            if (!character) return false;

            const newExp = character.experience + exp;
            const expNeeded = character.level * 100; // Simple formula: level * 100 EXP per level

            if (newExp >= expNeeded) {
                // Level up!
                await pool.execute(
                    'UPDATE dnd_characters SET experience = ? - ? WHERE character_id = ?',
                    [newExp, expNeeded, characterId]
                );

                const levelUpResult = await this.levelUp(characterId);
                if (levelUpResult) {
                    return { leveledUp: true, ...levelUpResult };
                }
                return false;
            } else {
                await pool.execute(
                    'UPDATE dnd_characters SET experience = ? WHERE character_id = ?',
                    [newExp, characterId]
                );

                return { leveledUp: false, newExp, expNeeded };
            }

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error adding experience: ${error.message}`);
            return false;
        }
    }

    /**
     * Update character stats (health, mana, gold)
     */
    async updateCharacterStats(characterId, updates) {
        try {
            const validFields = ['health', 'mana', 'gold', 'current_zone'];
            const updateFields = [];
            const values = [];

            for (const [key, value] of Object.entries(updates)) {
                if (validFields.includes(key)) {
                    updateFields.push(`${key} = ?`);
                    values.push(value);
                }
            }

            if (updateFields.length === 0) {
                throw new Error('No valid fields to update');
            }

            values.push(characterId);
            await pool.execute(
                `UPDATE dnd_characters SET ${updateFields.join(', ')} WHERE character_id = ?`,
                values
            );

            return true;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error updating character stats: ${error.message}`);
            throw error;
        }
    }

    /**
     * Add gold to character
     */
    async addGold(characterId, amount) {
        try {
            await pool.execute(
                'UPDATE dnd_characters SET gold = gold + ? WHERE character_id = ?',
                [amount, characterId]
            );
            return true;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error adding gold: ${error.message}`);
            return false;
        }
    }

    /**
     * Remove gold from character
     */
    async removeGold(characterId, amount) {
        try {
            const [chars] = await pool.execute(
                'SELECT gold FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );

            if (!chars[0] || chars[0].gold < amount) {
                throw new Error('Not enough gold');
            }

            await pool.execute(
                'UPDATE dnd_characters SET gold = gold - ? WHERE character_id = ?',
                [amount, characterId]
            );
            return true;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error removing gold: ${error.message}`);
            throw error;
        }
    }

    /**
     * Add item to inventory
     */
    async addItem(characterId, itemId, quantity = 1) {
        try {
            // Check if item already in inventory
            const [existing] = await pool.execute(
                'SELECT * FROM dnd_inventory WHERE character_id = ? AND item_id = ?',
                [characterId, itemId]
            );

            if (existing.length > 0) {
                await pool.execute(
                    'UPDATE dnd_inventory SET quantity = quantity + ? WHERE character_id = ? AND item_id = ?',
                    [quantity, characterId, itemId]
                );
            } else {
                await pool.execute(
                    'INSERT INTO dnd_inventory (character_id, item_id, quantity, equipped) VALUES (?, ?, ?, FALSE)',
                    [characterId, itemId, quantity]
                );
            }

            logger.info(`[RPGCharacterManager] Added ${quantity}x item ${itemId} to character ${characterId}`);
            return true;

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error adding item: ${error.message}`);
            return false;
        }
    }

    /**
     * Remove item from inventory
     */
    async removeItem(characterId, itemId, quantity = 1) {
        try {
            const [existing] = await pool.execute(
                'SELECT quantity FROM dnd_inventory WHERE character_id = ? AND item_id = ?',
                [characterId, itemId]
            );

            if (existing.length === 0 || existing[0].quantity < quantity) {
                throw new Error('Not enough items in inventory');
            }

            const newQuantity = existing[0].quantity - quantity;

            if (newQuantity <= 0) {
                await pool.execute(
                    'DELETE FROM dnd_inventory WHERE character_id = ? AND item_id = ?',
                    [characterId, itemId]
                );
            } else {
                await pool.execute(
                    'UPDATE dnd_inventory SET quantity = ? WHERE character_id = ? AND item_id = ?',
                    [newQuantity, characterId, itemId]
                );
            }

            logger.info(`[RPGCharacterManager] Removed ${quantity}x item ${itemId} from character ${characterId}`);
            return true;

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error removing item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get character inventory
     */
    async getInventory(characterId) {
        try {
            const [items] = await pool.execute(
                `SELECT i.*, inv.quantity, inv.equipped
                 FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ?
                 ORDER BY i.item_type, i.rarity DESC, i.item_name`,
                [characterId]
            );

            return items;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error getting inventory: ${error.message}`);
            return [];
        }
    }

    /**
     * Equip an item
     */
    async equipItem(characterId, itemId) {
        try {
            // First, check if the item exists in inventory
            const [inventory] = await pool.execute(
                `SELECT i.item_type, inv.equipped
                 FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ? AND inv.item_id = ?`,
                [characterId, itemId]
            );

            if (inventory.length === 0) {
                throw new Error('Item not found in inventory');
            }

            const itemType = inventory[0].item_type;

            // Unequip any other item of the same type
            await pool.execute(
                `UPDATE dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 SET inv.equipped = FALSE
                 WHERE inv.character_id = ? AND i.item_type = ? AND inv.item_id != ?`,
                [characterId, itemType, itemId]
            );

            // Equip the new item
            await pool.execute(
                'UPDATE dnd_inventory SET equipped = TRUE WHERE character_id = ? AND item_id = ?',
                [characterId, itemId]
            );

            logger.info(`[RPGCharacterManager] Character ${characterId} equipped item ${itemId}`);
            return true;

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error equipping item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Unequip an item
     */
    async unequipItem(characterId, itemId) {
        try {
            await pool.execute(
                'UPDATE dnd_inventory SET equipped = FALSE WHERE character_id = ? AND item_id = ?',
                [characterId, itemId]
            );

            logger.info(`[RPGCharacterManager] Character ${characterId} unequipped item ${itemId}`);
            return true;

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error unequipping item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get equipped items
     */
    async getEquippedItems(characterId) {
        try {
            const [items] = await pool.execute(
                `SELECT i.*, inv.quantity
                 FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ? AND inv.equipped = TRUE`,
                [characterId]
            );

            return items;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error getting equipped items: ${error.message}`);
            return [];
        }
    }

    /**
     * Get list of available classes
     */
    getAvailableClasses() {
        return Object.keys(this.classStats).map(className => ({
            name: className.charAt(0).toUpperCase() + className.slice(1),
            stats: this.classStats[className]
        }));
    }

    /**
     * Calculate total character damage (base + equipment bonuses)
     */
    async calculateDamage(characterId) {
        try {
            const [chars] = await pool.execute(
                'SELECT strength, dexterity FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );

            if (!chars[0]) return 0;

            const character = chars[0];
            let baseDamage = character.strength + Math.floor(character.dexterity / 2);

            // Get equipped weapons
            const [weapons] = await pool.execute(
                `SELECT i.damage_bonus
                 FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ? AND inv.equipped = TRUE AND i.item_type = 'weapon'`,
                [characterId]
            );

            weapons.forEach(weapon => {
                baseDamage += weapon.damage_bonus || 0;
            });

            return baseDamage;

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error calculating damage: ${error.message}`);
            return 0;
        }
    }

    /**
     * Calculate total character defense (equipment bonuses)
     */
    async calculateDefense(characterId) {
        try {
            // Get equipped armor
            const [armor] = await pool.execute(
                `SELECT i.defense_bonus
                 FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ? AND inv.equipped = TRUE AND i.item_type = 'armor'`,
                [characterId]
            );

            let totalDefense = 0;
            armor.forEach(piece => {
                totalDefense += piece.defense_bonus || 0;
            });

            return totalDefense;

        } catch (error) {
            logger.error(`[RPGCharacterManager] Error calculating defense: ${error.message}`);
            return 0;
        }
    }

    /**
     * Heal character
     */
    async healCharacter(characterId, amount) {
        try {
            await pool.execute(
                `UPDATE dnd_characters
                 SET health = LEAST(health + ?, max_health)
                 WHERE character_id = ?`,
                [amount, characterId]
            );
            return true;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error healing character: ${error.message}`);
            return false;
        }
    }

    /**
     * Restore mana
     */
    async restoreMana(characterId, amount) {
        try {
            await pool.execute(
                `UPDATE dnd_characters
                 SET mana = LEAST(mana + ?, max_mana)
                 WHERE character_id = ?`,
                [amount, characterId]
            );
            return true;
        } catch (error) {
            logger.error(`[RPGCharacterManager] Error restoring mana: ${error.message}`);
            return false;
        }
    }
}

export default RPGCharacterManager;
