import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import RPGConditionManager from './rpg-condition-manager.js';
import RPGSpellManager from './rpg-spell-manager.js';
import RPGLeaderboardManager from './rpg-leaderboard-manager.js';

/**
 * RPG Combat Manager - Handles turn-based combat
 */
class RPGCombatManager {
    constructor(client, characterManager) {
        this.client = client;
        this.characterManager = characterManager;
    }

    /**
     * Combined mechanical effects of the character's active conditions.
     * Never throws (conditions must not break combat).
     * @private
     */
    async _getConditionEffects(characterId) {
        try {
            return await RPGConditionManager.getActiveEffects(characterId);
        } catch (err) {
            logger.error(`[RPGCombatManager] Could not read conditions for ${characterId}: ${err.message}`);
            return {};
        }
    }

    /**
     * Rage damage bonus by level (D&D 5e: +2, +3 at 9, +4 at 16).
     * @private
     */
    _rageDamageBonus(level) {
        const lvl = Number(level) || 1;
        return lvl >= 16 ? 4 : lvl >= 9 ? 3 : 2;
    }

    /**
     * Apply incoming-damage condition effects (resistance halves, min 1).
     * @private
     */
    _applyIncomingDamageEffects(damage, effects, notes) {
        if (effects.resistance_physical || effects.resistance_all) {
            notes.push('🛡️ Resistance halves the blow.');
            return Math.max(1, Math.floor(damage / 2));
        }
        return damage;
    }

    /**
     * End-of-round bookkeeping for the character: tick condition durations and,
     * if they took damage while concentrating, roll the concentration save.
     * Never throws. Appends player-facing notes.
     * @private
     */
    async _endOfRound(characterId, damageTaken, notes) {
        try {
            const expired = await RPGConditionManager.processEndOfTurn(characterId);
            for (const name of expired) notes.push(`⌛ ${name} has worn off.`);
        } catch (err) {
            logger.error(`[RPGCombatManager] Condition tick failed for ${characterId}: ${err.message}`);
        }
        if (damageTaken > 0) {
            try {
                const check = await RPGSpellManager.concentrationCheck(characterId, damageTaken);
                if (check && check.concentrating) notes.push(`🧠 ${check.message} (CON ${check.total} vs DC ${check.dc})`);
            } catch (err) {
                logger.error(`[RPGCombatManager] Concentration check failed for ${characterId}: ${err.message}`);
            }
        }
    }

    /**
     * Start a battle
     */
    async startBattle(characterId, enemyId) {
        try {
            // Check for active battles
            const [activeBattles] = await pool.execute(
                'SELECT * FROM dnd_battles WHERE character_id = ? AND status = "ongoing"',
                [characterId]
            );

            if (activeBattles.length > 0) {
                throw new Error('You already have an active battle! Finish it first.');
            }

            // Get character info
            const [chars] = await pool.execute(
                'SELECT * FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );
            const character = chars[0];

            if (!character) {
                throw new Error('Character not found');
            }

            // Get enemy info
            const [enemies] = await pool.execute(
                'SELECT * FROM dnd_enemies WHERE enemy_id = ?',
                [enemyId]
            );
            const enemy = enemies[0];

            if (!enemy) {
                throw new Error('Enemy not found');
            }

            // Check if character meets level requirement
            if (character.level < enemy.level) {
                throw new Error(`You need to be at least level ${enemy.level} to fight ${enemy.enemy_name}`);
            }

            // Calculate character damage
            const characterDamage = await this.characterManager.calculateDamage(characterId);

            // Create battle
            const [result] = await pool.execute(
                `INSERT INTO dnd_battles (character_id, enemy_id, character_health, enemy_health, turn, status)
                 VALUES (?, ?, ?, ?, 1, 'ongoing')`,
                [characterId, enemyId, character.health, enemy.health]
            );

            logger.info(`[RPGCombatManager] Character ${characterId} started battle ${result.insertId} with enemy ${enemyId}`);

            return {
                battleId: result.insertId,
                character: {
                    id: characterId,
                    name: character.character_name,
                    health: character.health,
                    maxHealth: character.max_health,
                    damage: characterDamage,
                    level: character.level
                },
                enemy: {
                    id: enemyId,
                    name: enemy.enemy_name,
                    health: enemy.health,
                    maxHealth: enemy.health,
                    damage: enemy.damage,
                    level: enemy.level
                },
                turn: 1
            };

        } catch (error) {
            logger.error(`[RPGCombatManager] Error starting battle: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get active battle
     */
    async getActiveBattle(characterId) {
        try {
            const [battles] = await pool.execute(
                `SELECT b.*, e.enemy_name, e.damage as enemy_damage, c.character_name, c.level as character_level
                 FROM dnd_battles b
                 JOIN dnd_enemies e ON b.enemy_id = e.enemy_id
                 JOIN dnd_characters c ON b.character_id = c.character_id
                 WHERE b.character_id = ? AND b.status = 'ongoing'`,
                [characterId]
            );

            if (battles.length === 0) {
                return null;
            }

            const battle = battles[0];

            // Get character info for damage calculation
            const characterDamage = await this.characterManager.calculateDamage(characterId);

            return {
                battleId: battle.battle_id,
                character: {
                    id: characterId,
                    name: battle.character_name,
                    health: battle.character_health,
                    damage: characterDamage,
                    level: battle.character_level
                },
                enemy: {
                    id: battle.enemy_id,
                    name: battle.enemy_name,
                    health: battle.enemy_health,
                    damage: battle.enemy_damage
                },
                turn: battle.turn,
                status: battle.status
            };

        } catch (error) {
            logger.error(`[RPGCombatManager] Error getting active battle: ${error.message}`);
            return null;
        }
    }

    /**
     * Perform an attack
     */
    async attack(characterId) {
        try {
            const battle = await this.getActiveBattle(characterId);

            if (!battle) {
                throw new Error('No active battle found');
            }

            const notes = [];
            const effects = await this._getConditionEffects(characterId);

            // Calculate damage with some randomness (80-120% of base damage)
            const damageMultiplier = 0.8 + Math.random() * 0.4;
            let damage = Math.floor(battle.character.damage * damageMultiplier);

            // Raging: melee damage bonus
            if (effects.rage_damage_bonus) {
                const bonus = this._rageDamageBonus(battle.character.level);
                damage += bonus;
                notes.push(`😤 Rage adds **+${bonus}** damage.`);
            }

            // Apply damage to enemy (track only what actually landed)
            const newEnemyHealth = Math.max(0, battle.enemy.health - damage);
            RPGLeaderboardManager.trackStat(characterId, 'total_damage_dealt', battle.enemy.health - newEnemyHealth);

            await pool.execute(
                'UPDATE dnd_battles SET enemy_health = ?, turn = turn + 1 WHERE battle_id = ?',
                [newEnemyHealth, battle.battleId]
            );

            // Check if enemy is defeated
            if (newEnemyHealth <= 0) {
                return await this.endBattle(battle.battleId, 'victory');
            }

            // Enemy counter-attack
            const enemyDamageMultiplier = 0.8 + Math.random() * 0.4;
            const enemyDamage = Math.floor(battle.enemy.damage * enemyDamageMultiplier);

            // Get character's defense
            const defense = await this.characterManager.calculateDefense(characterId);
            const actualDamage = this._applyIncomingDamageEffects(Math.max(1, enemyDamage - defense), effects, notes);

            const newCharacterHealth = Math.max(0, battle.character.health - actualDamage);

            await pool.execute(
                'UPDATE dnd_battles SET character_health = ? WHERE battle_id = ?',
                [newCharacterHealth, battle.battleId]
            );

            // Check if character is defeated
            if (newCharacterHealth <= 0) {
                return await this.endBattle(battle.battleId, 'defeat');
            }

            await this._endOfRound(characterId, actualDamage, notes);

            return {
                status: 'ongoing',
                playerDamage: damage,
                enemyDamage: actualDamage,
                characterHealth: newCharacterHealth,
                enemyHealth: newEnemyHealth,
                turn: battle.turn + 1,
                notes
            };

        } catch (error) {
            logger.error(`[RPGCombatManager] Error performing attack: ${error.message}`);
            throw error;
        }
    }

    /**
     * Use an item in battle
     */
    async useItem(characterId, itemId) {
        try {
            const battle = await this.getActiveBattle(characterId);

            if (!battle) {
                throw new Error('No active battle found');
            }

            // Get item info
            const [items] = await pool.execute(
                `SELECT i.*, inv.quantity
                 FROM dnd_items i
                 JOIN dnd_inventory inv ON i.item_id = inv.item_id
                 WHERE inv.character_id = ? AND i.item_id = ? AND i.item_type IN ('consumable', 'potion')`,
                [characterId, itemId]
            );

            if (items.length === 0) {
                throw new Error('Item not found in inventory or is not a usable consumable/potion');
            }

            const item = items[0];

            if (item.quantity <= 0) {
                throw new Error('You don\'t have any of this item');
            }

            // Remove item from inventory
            await this.characterManager.removeItem(characterId, itemId, 1);

            let healAmount = 0;
            let manaAmount = 0;

            // Apply item effects
            if (item.healing) {
                healAmount = item.healing;
                const newHealth = Math.min(battle.character.health + healAmount, await this.getCharacterMaxHealth(characterId));
                await pool.execute(
                    'UPDATE dnd_battles SET character_health = ? WHERE battle_id = ?',
                    [newHealth, battle.battleId]
                );
            }

            if (item.mana_restore) {
                manaAmount = item.mana_restore;
                await this.characterManager.restoreMana(characterId, manaAmount);
            }

            // Enemy gets a turn
            const notes = [];
            const effects = await this._getConditionEffects(characterId);
            const enemyDamageMultiplier = 0.8 + Math.random() * 0.4;
            const enemyDamage = Math.floor(battle.enemy.damage * enemyDamageMultiplier);
            const defense = await this.characterManager.calculateDefense(characterId);
            const actualDamage = this._applyIncomingDamageEffects(Math.max(1, enemyDamage - defense), effects, notes);

            const [currentBattle] = await pool.execute(
                'SELECT character_health FROM dnd_battles WHERE battle_id = ?',
                [battle.battleId]
            );

            const newCharacterHealth = Math.max(0, currentBattle[0].character_health - actualDamage);

            await pool.execute(
                'UPDATE dnd_battles SET character_health = ?, turn = turn + 1 WHERE battle_id = ?',
                [newCharacterHealth, battle.battleId]
            );

            // Check if character is defeated
            if (newCharacterHealth <= 0) {
                return await this.endBattle(battle.battleId, 'defeat');
            }

            await this._endOfRound(characterId, actualDamage, notes);

            return {
                status: 'ongoing',
                itemName: item.item_name,
                healAmount,
                manaAmount,
                enemyDamage: actualDamage,
                characterHealth: newCharacterHealth,
                turn: battle.turn + 1,
                notes
            };

        } catch (error) {
            logger.error(`[RPGCombatManager] Error using item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Flee from battle
     */
    async flee(characterId) {
        try {
            const battle = await this.getActiveBattle(characterId);

            if (!battle) {
                throw new Error('No active battle found');
            }

            // 50% chance to flee successfully
            const fleeSuccess = Math.random() < 0.5;

            if (fleeSuccess) {
                await pool.execute(
                    'UPDATE dnd_battles SET status = "fled", ended_at = NOW() WHERE battle_id = ?',
                    [battle.battleId]
                );

                // Battle-bound conditions (e.g. Rage) end with the battle
                try {
                    await RPGConditionManager.clearCombatConditions(characterId, battle.battleId);
                } catch (err) {
                    logger.error(`[RPGCombatManager] Failed to clear combat conditions: ${err.message}`);
                }

                logger.info(`[RPGCombatManager] Character ${characterId} fled from battle ${battle.battleId}`);

                return {
                    status: 'fled',
                    success: true
                };
            } else {
                // Failed to flee, enemy attacks
                const notes = [];
                const effects = await this._getConditionEffects(characterId);
                const enemyDamageMultiplier = 0.8 + Math.random() * 0.4;
                const enemyDamage = Math.floor(battle.enemy.damage * enemyDamageMultiplier);
                const defense = await this.characterManager.calculateDefense(characterId);
                const actualDamage = this._applyIncomingDamageEffects(Math.max(1, enemyDamage - defense), effects, notes);

                const newCharacterHealth = Math.max(0, battle.character.health - actualDamage);

                await pool.execute(
                    'UPDATE dnd_battles SET character_health = ?, turn = turn + 1 WHERE battle_id = ?',
                    [newCharacterHealth, battle.battleId]
                );

                // Check if character is defeated
                if (newCharacterHealth <= 0) {
                    return await this.endBattle(battle.battleId, 'defeat');
                }

                await this._endOfRound(characterId, actualDamage, notes);

                return {
                    status: 'ongoing',
                    success: false,
                    enemyDamage: actualDamage,
                    characterHealth: newCharacterHealth,
                    turn: battle.turn + 1,
                    notes
                };
            }

        } catch (error) {
            logger.error(`[RPGCombatManager] Error fleeing: ${error.message}`);
            throw error;
        }
    }

    /**
     * End battle
     */
    async endBattle(battleId, result) {
        try {
            // Get battle info
            const [battles] = await pool.execute(
                `SELECT b.*, e.exp_reward, e.gold_reward, e.enemy_name, c.character_id
                 FROM dnd_battles b
                 JOIN dnd_enemies e ON b.enemy_id = e.enemy_id
                 JOIN dnd_characters c ON b.character_id = c.character_id
                 WHERE b.battle_id = ?`,
                [battleId]
            );

            if (battles.length === 0) {
                throw new Error('Battle not found');
            }

            const battle = battles[0];

            // Map logical result to the dnd_battles.status enum ('ongoing','won','lost','fled')
            const statusMap = { victory: 'won', defeat: 'lost', won: 'won', lost: 'lost', fled: 'fled' };
            const dbStatus = statusMap[result] || 'lost';

            // Update battle status
            await pool.execute(
                'UPDATE dnd_battles SET status = ?, ended_at = NOW() WHERE battle_id = ?',
                [dbStatus, battleId]
            );

            // Update character health
            await pool.execute(
                'UPDATE dnd_characters SET health = ? WHERE character_id = ?',
                [battle.character_health, battle.character_id]
            );

            // Battle-bound conditions (e.g. Rage) end with the battle
            try {
                await RPGConditionManager.clearCombatConditions(battle.character_id, battleId);
            } catch (err) {
                logger.error(`[RPGCombatManager] Failed to clear combat conditions: ${err.message}`);
            }

            let rewards = {
                exp: 0,
                gold: 0,
                item: null,
                leveledUp: false
            };

            // Award rewards for victory
            if (result === 'victory') {
                rewards.exp = battle.exp_reward || 0;
                rewards.gold = battle.gold_reward || 0;

                // Add gold
                if (rewards.gold > 0) {
                    await this.characterManager.addGold(battle.character_id, rewards.gold);
                }

                // Add experience
                if (rewards.exp > 0) {
                    const expResult = await this.characterManager.addExperience(battle.character_id, rewards.exp);
                    if (expResult && expResult.leveledUp) {
                        rewards.leveledUp = true;
                        rewards.newLevel = expResult.newLevel;
                    }
                }

                // Stats + achievements (fire-and-forget; never blocks the result)
                RPGLeaderboardManager.trackStat(battle.character_id, 'total_monsters_killed', 1);
                RPGLeaderboardManager.trackKill(battle.character_id, battle.enemy_name);
            } else if (dbStatus === 'lost') {
                RPGLeaderboardManager.trackStat(battle.character_id, 'deaths', 1);
            }

            logger.info(`[RPGCombatManager] Battle ${battleId} ended with result: ${result}`);

            return {
                status: result,
                rewards
            };

        } catch (error) {
            logger.error(`[RPGCombatManager] Error ending battle: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get enemy list for a zone
     */
    async getEnemiesByZone(zoneName) {
        try {
            const [enemies] = await pool.execute(
                'SELECT * FROM dnd_enemies WHERE zone = ? ORDER BY level, enemy_name',
                [zoneName]
            );

            return enemies;
        } catch (error) {
            logger.error(`[RPGCombatManager] Error getting enemies: ${error.message}`);
            return [];
        }
    }

    /**
     * Get all enemies
     */
    async getAllEnemies() {
        try {
            const [enemies] = await pool.execute(
                'SELECT * FROM dnd_enemies ORDER BY level, enemy_name'
            );

            return enemies;
        } catch (error) {
            logger.error(`[RPGCombatManager] Error getting all enemies: ${error.message}`);
            return [];
        }
    }

    /**
     * Get enemy by ID
     */
    async getEnemy(enemyId) {
        try {
            const [enemies] = await pool.execute(
                'SELECT * FROM dnd_enemies WHERE enemy_id = ?',
                [enemyId]
            );

            return enemies[0] || null;
        } catch (error) {
            logger.error(`[RPGCombatManager] Error getting enemy: ${error.message}`);
            return null;
        }
    }

    /**
     * Get character max health
     */
    async getCharacterMaxHealth(characterId) {
        try {
            const [chars] = await pool.execute(
                'SELECT max_health FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );

            return chars[0] ? chars[0].max_health : 0;
        } catch (error) {
            logger.error(`[RPGCombatManager] Error getting max health: ${error.message}`);
            return 0;
        }
    }

    /**
     * Get battle history
     */
    async getBattleHistory(characterId, limit = 10) {
        try {
            const [battles] = await pool.execute(
                `SELECT b.*, e.enemy_name
                 FROM dnd_battles b
                 JOIN dnd_enemies e ON b.enemy_id = e.enemy_id
                 WHERE b.character_id = ? AND b.status != 'ongoing'
                 ORDER BY b.ended_at DESC
                 LIMIT ?`,
                [characterId, limit]
            );

            return battles;
        } catch (error) {
            logger.error(`[RPGCombatManager] Error getting battle history: ${error.message}`);
            return [];
        }
    }
}

export default RPGCombatManager;
