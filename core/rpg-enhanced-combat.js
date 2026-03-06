/**
 * RPG Enhanced Combat Manager
 * D&D 5e compliant turn-based combat system
 * Handles initiative, attack rolls, damage, conditions, and action economy
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import RPGDiceEngine from './rpg-dice-engine.js';

class RPGEnhancedCombat {
    /**
     * Start a new combat encounter
     * @param {string} guildId - Guild ID
     * @param {object} options - Combat options
     * @returns {object} Combat session
     */
    static async startCombat(guildId, options = {}) {
        const { campaignId, sessionId, combatName, combatType = 'pve', environment } = options;

        const [result] = await pool.execute(
            `INSERT INTO dnd_combat_sessions
             (guild_id, campaign_id, session_id, combat_name, combat_type, environment, status)
             VALUES (?, ?, ?, ?, ?, ?, 'setup')`,
            [guildId, campaignId || null, sessionId || null, combatName || 'Combat', combatType, environment || null]
        );

        logger.info('[Combat] Started new combat', { combatId: result.insertId, guildId });

        return {
            combat_id: result.insertId,
            status: 'setup'
        };
    }

    /**
     * Add a participant to combat
     * @param {number} combatId - Combat ID
     * @param {object} participant - Participant data
     * @returns {object} Added participant
     */
    static async addParticipant(combatId, participant) {
        const {
            type, // 'player', 'enemy', 'ally', 'npc'
            characterId,
            enemyId,
            name,
            hp,
            maxHp,
            ac,
            initiativeBonus = 0,
            conditions = []
        } = participant;

        const [result] = await pool.execute(
            `INSERT INTO dnd_combat_participants
             (combat_id, participant_type, character_id, enemy_id, name, current_hp, max_hp, armor_class, initiative_bonus, conditions)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [combatId, type, characterId || null, enemyId || null, name, hp, maxHp || hp, ac || 10, initiativeBonus, JSON.stringify(conditions)]
        );

        return {
            participant_id: result.insertId,
            name,
            type,
            hp,
            maxHp: maxHp || hp,
            ac: ac || 10
        };
    }

    /**
     * Roll initiative for all participants and start combat
     * @param {number} combatId - Combat ID
     * @returns {object} Initiative order
     */
    static async rollInitiative(combatId) {
        // Get all participants
        const [participants] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE combat_id = ? AND is_active = TRUE',
            [combatId]
        );

        if (participants.length === 0) {
            throw new Error('No participants in combat');
        }

        // Roll initiative for each
        const initiativeRolls = [];
        for (const p of participants) {
            const roll = RPGDiceEngine.rollD20('normal');
            const total = roll.roll + p.initiative_bonus;

            await pool.execute(
                'UPDATE dnd_combat_participants SET initiative_roll = ? WHERE participant_id = ?',
                [total, p.participant_id]
            );

            initiativeRolls.push({
                participant_id: p.participant_id,
                name: p.name,
                type: p.participant_type,
                roll: roll.roll,
                bonus: p.initiative_bonus,
                total,
                isCritical: roll.isCritical
            });
        }

        // Sort by initiative (descending), with DEX bonus as tiebreaker
        initiativeRolls.sort((a, b) => {
            if (b.total !== a.total) return b.total - a.total;
            return b.bonus - a.bonus;
        });

        // Assign turn order
        for (let i = 0; i < initiativeRolls.length; i++) {
            await pool.execute(
                'UPDATE dnd_combat_participants SET turn_order = ? WHERE participant_id = ?',
                [i + 1, initiativeRolls[i].participant_id]
            );
            initiativeRolls[i].turn_order = i + 1;
        }

        // Update combat status
        await pool.execute(
            `UPDATE dnd_combat_sessions SET status = 'active', initiative_order = ?, current_turn = 1
             WHERE combat_id = ?`,
            [JSON.stringify(initiativeRolls.map(p => p.participant_id)), combatId]
        );

        return {
            combatId,
            initiativeOrder: initiativeRolls,
            currentTurn: 1,
            currentRound: 1
        };
    }

    /**
     * Make an attack roll
     * @param {number} combatId - Combat ID
     * @param {number} attackerId - Attacker participant ID
     * @param {number} targetId - Target participant ID
     * @param {object} options - Attack options
     * @returns {object} Attack result
     */
    static async attack(combatId, attackerId, targetId, options = {}) {
        const { advantageType = 'normal', attackBonus = 0, damageRoll = '1d8', damageBonus = 0, damageType = 'slashing' } = options;

        // Get participants
        const [attackers] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE participant_id = ?',
            [attackerId]
        );
        const [targets] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE participant_id = ?',
            [targetId]
        );

        if (attackers.length === 0 || targets.length === 0) {
            throw new Error('Invalid attacker or target');
        }

        const attacker = attackers[0];
        const target = targets[0];

        // Check conditions that affect attack
        const attackerConditions = JSON.parse(attacker.conditions || '[]');
        const targetConditions = JSON.parse(target.conditions || '[]');

        let finalAdvantage = advantageType;

        // Conditions that give attacker disadvantage
        if (attackerConditions.some(c => ['blinded', 'frightened', 'poisoned', 'prone', 'restrained'].includes(c))) {
            finalAdvantage = finalAdvantage === 'advantage' ? 'normal' : 'disadvantage';
        }

        // Conditions that give attacker advantage
        if (targetConditions.some(c => ['blinded', 'paralyzed', 'stunned', 'unconscious', 'restrained'].includes(c))) {
            finalAdvantage = finalAdvantage === 'disadvantage' ? 'normal' : 'advantage';
        }

        // Prone target - advantage for melee, disadvantage for ranged (simplified to advantage here)
        if (targetConditions.includes('prone')) {
            finalAdvantage = finalAdvantage === 'disadvantage' ? 'normal' : 'advantage';
        }

        // Roll attack
        const attackRoll = RPGDiceEngine.rollD20(finalAdvantage);
        const totalAttack = attackRoll.roll + attackBonus;

        // Determine hit
        let hit = false;
        let isCrit = attackRoll.isCritical;
        let isFumble = attackRoll.isFumble;

        if (isCrit) {
            hit = true; // Nat 20 always hits
        } else if (isFumble) {
            hit = false; // Nat 1 always misses
        } else {
            hit = totalAttack >= target.armor_class;
        }

        // Auto-crit conditions
        if (hit && targetConditions.some(c => ['paralyzed', 'unconscious'].includes(c))) {
            isCrit = true;
        }

        let damage = 0;
        let damageRolls = [];

        if (hit) {
            // Roll damage
            const damageResult = RPGDiceEngine.roll(damageRoll);
            damageRolls = damageResult.rolls;
            damage = damageResult.total + damageBonus;

            // Double dice on crit
            if (isCrit) {
                const critDamage = RPGDiceEngine.roll(damageRoll);
                damageRolls = [...damageRolls, ...critDamage.rolls];
                damage += critDamage.total;
            }

            // Apply damage to target
            const newHp = Math.max(0, target.current_hp - damage);
            await pool.execute(
                'UPDATE dnd_combat_participants SET current_hp = ? WHERE participant_id = ?',
                [newHp, targetId]
            );

            // Check if target is down
            if (newHp === 0 && target.participant_type === 'player') {
                // Start death saves for players
                await pool.execute(
                    'UPDATE dnd_combat_participants SET death_saves_success = 0, death_saves_failure = 0 WHERE participant_id = ?',
                    [targetId]
                );
            }
        }

        // Log the attack
        const [combat] = await pool.execute('SELECT current_round, current_turn FROM dnd_combat_sessions WHERE combat_id = ?', [combatId]);

        await pool.execute(
            `INSERT INTO dnd_combat_log
             (combat_id, round, turn, actor_id, action_type, target_ids, description, roll_data, damage_dealt)
             VALUES (?, ?, ?, ?, 'attack', ?, ?, ?, ?)`,
            [
                combatId,
                combat[0].current_round,
                combat[0].current_turn,
                attackerId,
                JSON.stringify([targetId]),
                `${attacker.name} attacks ${target.name}`,
                JSON.stringify({ attackRoll: attackRoll.allRolls, attackTotal: totalAttack, damageRolls, damageTotal: damage, isCrit, isFumble }),
                damage
            ]
        );

        // Mark action as used
        await pool.execute(
            'UPDATE dnd_combat_participants SET action_used = TRUE WHERE participant_id = ?',
            [attackerId]
        );

        return {
            attacker: attacker.name,
            target: target.name,
            attackRoll: attackRoll.allRolls,
            attackTotal: totalAttack,
            targetAC: target.armor_class,
            hit,
            isCrit,
            isFumble,
            damage: hit ? damage : 0,
            damageType,
            damageRolls: hit ? damageRolls : [],
            targetHpRemaining: hit ? Math.max(0, target.current_hp - damage) : target.current_hp,
            targetDown: hit && (target.current_hp - damage) <= 0,
            advantageType: finalAdvantage
        };
    }

    /**
     * End current turn and advance to next
     * @param {number} combatId - Combat ID
     * @returns {object} Next turn info
     */
    static async nextTurn(combatId) {
        const [combats] = await pool.execute(
            'SELECT * FROM dnd_combat_sessions WHERE combat_id = ?',
            [combatId]
        );

        if (combats.length === 0) {
            throw new Error('Combat not found');
        }

        const combat = combats[0];
        const initiativeOrder = JSON.parse(combat.initiative_order || '[]');

        // Get active participants
        const [participants] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE combat_id = ? AND is_active = TRUE AND current_hp > 0 ORDER BY turn_order',
            [combatId]
        );

        if (participants.length === 0) {
            // Combat ended
            await this.endCombat(combatId, 'victory');
            return { combatEnded: true, result: 'victory' };
        }

        // Check for victory/defeat
        const enemies = participants.filter(p => p.participant_type === 'enemy');
        const players = participants.filter(p => p.participant_type === 'player');

        if (enemies.length === 0) {
            await this.endCombat(combatId, 'victory');
            return { combatEnded: true, result: 'victory' };
        }

        if (players.length === 0) {
            await this.endCombat(combatId, 'defeat');
            return { combatEnded: true, result: 'defeat' };
        }

        // Find next active participant
        let nextTurn = combat.current_turn + 1;
        let nextRound = combat.current_round;

        // If we've gone through all participants, start new round
        if (nextTurn > participants.length) {
            nextTurn = 1;
            nextRound++;
        }

        // Reset action economy for next participant
        const nextParticipant = participants[nextTurn - 1];
        await pool.execute(
            'UPDATE dnd_combat_participants SET action_used = FALSE, bonus_action_used = FALSE, reaction_used = FALSE, movement_used = 0 WHERE participant_id = ?',
            [nextParticipant.participant_id]
        );

        // Update combat state
        await pool.execute(
            'UPDATE dnd_combat_sessions SET current_turn = ?, current_round = ? WHERE combat_id = ?',
            [nextTurn, nextRound, combatId]
        );

        // Process start-of-turn effects (conditions, etc.)
        await this.processStartOfTurn(nextParticipant);

        return {
            combatEnded: false,
            currentRound: nextRound,
            currentTurn: nextTurn,
            currentParticipant: {
                id: nextParticipant.participant_id,
                name: nextParticipant.name,
                type: nextParticipant.participant_type,
                hp: nextParticipant.current_hp,
                maxHp: nextParticipant.max_hp,
                conditions: JSON.parse(nextParticipant.conditions || '[]')
            }
        };
    }

    /**
     * Process start of turn effects
     * @param {object} participant - Current participant
     */
    static async processStartOfTurn(participant) {
        // Decrement condition durations, apply damage over time, etc.
        const conditions = JSON.parse(participant.conditions || '[]');

        // This would check dnd_active_conditions and process effects
        // For now, just log
        if (conditions.length > 0) {
            logger.debug('[Combat] Start of turn conditions:', { participant: participant.name, conditions });
        }
    }

    /**
     * End combat
     * @param {number} combatId - Combat ID
     * @param {string} result - 'victory', 'defeat', 'fled', 'ended'
     */
    static async endCombat(combatId, result) {
        await pool.execute(
            'UPDATE dnd_combat_sessions SET status = ?, ended_at = NOW() WHERE combat_id = ?',
            [result, combatId]
        );

        logger.info('[Combat] Combat ended', { combatId, result });
    }

    /**
     * Get combat status
     * @param {number} combatId - Combat ID
     * @returns {object} Combat state
     */
    static async getCombatStatus(combatId) {
        const [combats] = await pool.execute(
            'SELECT * FROM dnd_combat_sessions WHERE combat_id = ?',
            [combatId]
        );

        if (combats.length === 0) {
            return null;
        }

        const combat = combats[0];

        const [participants] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE combat_id = ? ORDER BY turn_order',
            [combatId]
        );

        const current = participants.find(p => p.turn_order === combat.current_turn);

        return {
            combat_id: combatId,
            status: combat.status,
            round: combat.current_round,
            turn: combat.current_turn,
            currentParticipant: current ? {
                id: current.participant_id,
                name: current.name,
                type: current.participant_type,
                hp: current.current_hp,
                maxHp: current.max_hp
            } : null,
            participants: participants.map(p => ({
                id: p.participant_id,
                name: p.name,
                type: p.participant_type,
                hp: p.current_hp,
                maxHp: p.max_hp,
                ac: p.armor_class,
                initiative: p.initiative_roll,
                turnOrder: p.turn_order,
                conditions: JSON.parse(p.conditions || '[]'),
                isActive: p.is_active && p.current_hp > 0
            }))
        };
    }

    /**
     * Perform a saving throw in combat
     * @param {number} participantId - Participant ID
     * @param {string} ability - Ability type
     * @param {number} dc - Difficulty class
     * @param {string} advantageType - 'normal', 'advantage', 'disadvantage'
     * @returns {object} Save result
     */
    static async savingThrow(participantId, ability, dc, advantageType = 'normal') {
        const [participants] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE participant_id = ?',
            [participantId]
        );

        if (participants.length === 0) {
            throw new Error('Participant not found');
        }

        const participant = participants[0];
        const conditions = JSON.parse(participant.conditions || '[]');

        // Check conditions that affect saves
        let finalAdvantage = advantageType;

        if (conditions.some(c => ['exhaustion_3', 'exhaustion_4', 'exhaustion_5'].includes(c))) {
            finalAdvantage = finalAdvantage === 'advantage' ? 'normal' : 'disadvantage';
        }

        // Paralyzed/stunned auto-fail STR/DEX saves
        if (['str', 'dex'].includes(ability.toLowerCase()) &&
            conditions.some(c => ['paralyzed', 'stunned', 'unconscious'].includes(c))) {
            return {
                participant: participant.name,
                ability,
                roll: 1,
                total: 1,
                dc,
                success: false,
                autoFail: true,
                reason: 'Condition causes automatic failure'
            };
        }

        const roll = RPGDiceEngine.rollD20(finalAdvantage);
        const modifier = 0; // Would need character data for actual modifier
        const total = roll.roll + modifier;
        const success = total >= dc;

        return {
            participant: participant.name,
            ability,
            roll: roll.roll,
            allRolls: roll.allRolls,
            modifier,
            total,
            dc,
            success,
            isCrit: roll.isCritical,
            isFumble: roll.isFumble,
            advantageType: finalAdvantage
        };
    }

    /**
     * Apply condition to participant
     * @param {number} participantId - Participant ID
     * @param {string} conditionName - Condition name
     * @param {object} options - Duration, source, etc.
     */
    static async applyCondition(participantId, conditionName, options = {}) {
        const { duration, source, saveDC, saveType } = options;

        const [participants] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE participant_id = ?',
            [participantId]
        );

        if (participants.length === 0) {
            throw new Error('Participant not found');
        }

        const participant = participants[0];
        const conditions = JSON.parse(participant.conditions || '[]');

        if (!conditions.includes(conditionName)) {
            conditions.push(conditionName);
            await pool.execute(
                'UPDATE dnd_combat_participants SET conditions = ? WHERE participant_id = ?',
                [JSON.stringify(conditions), participantId]
            );
        }

        // Log to active conditions table for duration tracking
        await pool.execute(
            `INSERT INTO dnd_active_conditions
             (participant_id, condition_id, source, duration_rounds, save_dc, save_type)
             SELECT ?, condition_id, ?, ?, ?, ?
             FROM dnd_conditions WHERE condition_name = ?`,
            [participantId, source || null, duration || null, saveDC || null, saveType || null, conditionName]
        );

        return { applied: conditionName, to: participant.name };
    }

    /**
     * Remove condition from participant
     * @param {number} participantId - Participant ID
     * @param {string} conditionName - Condition name
     */
    static async removeCondition(participantId, conditionName) {
        const [participants] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE participant_id = ?',
            [participantId]
        );

        if (participants.length === 0) {
            throw new Error('Participant not found');
        }

        const participant = participants[0];
        let conditions = JSON.parse(participant.conditions || '[]');
        conditions = conditions.filter(c => c !== conditionName);

        await pool.execute(
            'UPDATE dnd_combat_participants SET conditions = ? WHERE participant_id = ?',
            [JSON.stringify(conditions), participantId]
        );

        // Remove from active conditions
        await pool.execute(
            `DELETE ac FROM dnd_active_conditions ac
             JOIN dnd_conditions c ON ac.condition_id = c.condition_id
             WHERE ac.participant_id = ? AND c.condition_name = ?`,
            [participantId, conditionName]
        );

        return { removed: conditionName, from: participant.name };
    }

    /**
     * Death saving throw
     * @param {number} participantId - Participant ID
     * @returns {object} Death save result
     */
    static async deathSave(participantId) {
        const [participants] = await pool.execute(
            'SELECT * FROM dnd_combat_participants WHERE participant_id = ?',
            [participantId]
        );

        if (participants.length === 0) {
            throw new Error('Participant not found');
        }

        const participant = participants[0];

        if (participant.current_hp > 0) {
            throw new Error('Participant is not at 0 HP');
        }

        const roll = RPGDiceEngine.rollD20('normal');
        let successes = participant.death_saves_success;
        let failures = participant.death_saves_failure;
        let stabilized = false;
        let dead = false;
        let regainedConscious = false;

        if (roll.isCritical) {
            // Nat 20 - regain 1 HP
            regainedConscious = true;
            await pool.execute(
                'UPDATE dnd_combat_participants SET current_hp = 1, death_saves_success = 0, death_saves_failure = 0 WHERE participant_id = ?',
                [participantId]
            );
        } else if (roll.isFumble) {
            // Nat 1 - 2 failures
            failures += 2;
        } else if (roll.roll >= 10) {
            successes++;
        } else {
            failures++;
        }

        if (!regainedConscious) {
            if (successes >= 3) {
                stabilized = true;
                await pool.execute(
                    'UPDATE dnd_combat_participants SET death_saves_success = 3, death_saves_failure = ? WHERE participant_id = ?',
                    [failures, participantId]
                );
            } else if (failures >= 3) {
                dead = true;
                await pool.execute(
                    'UPDATE dnd_combat_participants SET death_saves_failure = 3, is_active = FALSE WHERE participant_id = ?',
                    [participantId]
                );
            } else {
                await pool.execute(
                    'UPDATE dnd_combat_participants SET death_saves_success = ?, death_saves_failure = ? WHERE participant_id = ?',
                    [successes, failures, participantId]
                );
            }
        }

        return {
            participant: participant.name,
            roll: roll.roll,
            isCrit: roll.isCritical,
            isFumble: roll.isFumble,
            successes: regainedConscious ? 0 : successes,
            failures: regainedConscious ? 0 : failures,
            stabilized,
            dead,
            regainedConscious
        };
    }

    /**
     * Get active combat for a character
     * @param {number} characterId - Character ID
     * @returns {object|null} Active combat or null
     */
    static async getActiveCombatForCharacter(characterId) {
        const [combats] = await pool.execute(
            `SELECT cs.* FROM dnd_combat_sessions cs
             JOIN dnd_combat_participants cp ON cs.combat_id = cp.combat_id
             WHERE cp.character_id = ? AND cs.status = 'active'
             LIMIT 1`,
            [characterId]
        );

        return combats.length > 0 ? combats[0] : null;
    }
}

export default RPGEnhancedCombat;
export { RPGEnhancedCombat };
