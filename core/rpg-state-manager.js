/**
 * RPG State Manager
 * Comprehensive state tracking for RPG sessions
 * Handles inventory, enemies, positions, conditions, and all game state
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';

// In-memory session state cache
const sessionStateCache = new Map();

class RPGStateManager {
    /**
     * Get or create session state
     */
    static getSessionState(sessionId) {
        if (!sessionStateCache.has(sessionId)) {
            sessionStateCache.set(sessionId, {
                // Location tracking
                location: 'Unknown Location',
                subLocation: null,

                // Combat state
                inCombat: false,
                enemies: [], // Array of { id, name, hp, maxHp, ac, position, conditions, isAlive }
                initiative: [], // Array of { name, roll, isPlayer }
                currentTurn: 0,
                combatRound: 1,

                // Character positions (for tactical combat)
                positions: new Map(), // characterName/enemyName -> { x, y, zone }

                // NPC tracking
                npcsEncountered: [], // { name, description, disposition, lastInteraction }
                npcsPresent: [], // NPCs currently in scene

                // Roll history
                recentRolls: [], // Last 10 rolls

                // Rewards tracking (for current session)
                loot: [],
                goldGained: 0,
                xpGained: 0,

                // Conditions/status effects on players
                playerConditions: new Map(), // characterId -> [conditions]

                // Environment state
                timeOfDay: 'day',
                weather: 'clear',
                lightLevel: 'bright',

                // Quest progress
                questUpdates: [],

                // Session metadata
                lastAction: null,
                lastActionTime: Date.now()
            });
        }
        return sessionStateCache.get(sessionId);
    }

    /**
     * Clear session state
     */
    static clearSessionState(sessionId) {
        sessionStateCache.delete(sessionId);
    }

    /**
     * Add item to character inventory
     * Creates the item in dnd_items if it doesn't exist
     */
    static async addItemToInventory(characterId, itemName, quantity = 1, itemData = {}) {
        try {
            // First, try to find existing item by name
            let [items] = await pool.execute(
                'SELECT item_id FROM dnd_items WHERE LOWER(item_name) = LOWER(?)',
                [itemName]
            );

            let itemId;

            if (items.length === 0) {
                // Create new item
                const itemType = itemData.type || RPGStateManager.inferItemType(itemName);
                const rarity = itemData.rarity || 'common';
                const description = itemData.description || `A ${itemName} found during adventure.`;

                const [result] = await pool.execute(
                    `INSERT INTO dnd_items (item_name, item_type, rarity, description, damage_bonus, defense_bonus, heal_amount, sell_price)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        itemName,
                        itemType,
                        rarity,
                        description,
                        itemData.damageBonus || 0,
                        itemData.defenseBonus || 0,
                        itemData.healAmount || 0,
                        itemData.sellPrice || RPGStateManager.calculateSellPrice(rarity)
                    ]
                );
                itemId = result.insertId;

                logger.info('[RPG State] Created new item', { itemId, itemName, itemType, rarity });
            } else {
                itemId = items[0].item_id;
            }

            // Add to inventory
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

            logger.info('[RPG State] Added item to inventory', { characterId, itemId, itemName, quantity });
            return { itemId, itemName, quantity };

        } catch (error) {
            logger.error('[RPG State] Error adding item to inventory', { error: error.message });
            return null;
        }
    }

    /**
     * Remove item from character inventory
     */
    static async removeItemFromInventory(characterId, itemName, quantity = 1) {
        try {
            const [items] = await pool.execute(
                `SELECT inv.*, i.item_name FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ? AND LOWER(i.item_name) = LOWER(?)`,
                [characterId, itemName]
            );

            if (items.length === 0) {
                logger.warn('[RPG State] Item not found in inventory', { characterId, itemName });
                return false;
            }

            const item = items[0];
            const newQuantity = item.quantity - quantity;

            if (newQuantity <= 0) {
                await pool.execute(
                    'DELETE FROM dnd_inventory WHERE character_id = ? AND item_id = ?',
                    [characterId, item.item_id]
                );
            } else {
                await pool.execute(
                    'UPDATE dnd_inventory SET quantity = ? WHERE character_id = ? AND item_id = ?',
                    [newQuantity, characterId, item.item_id]
                );
            }

            logger.info('[RPG State] Removed item from inventory', { characterId, itemName, quantity });
            return true;

        } catch (error) {
            logger.error('[RPG State] Error removing item from inventory', { error: error.message });
            return false;
        }
    }

    /**
     * Update character health
     */
    static async updateCharacterHealth(characterId, healthChange) {
        try {
            // Get current health and max
            const [chars] = await pool.execute(
                'SELECT health, max_health FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );

            if (chars.length === 0) return null;

            const char = chars[0];
            let newHealth = char.health + healthChange;
            newHealth = Math.max(0, Math.min(newHealth, char.max_health));

            await pool.execute(
                'UPDATE dnd_characters SET health = ? WHERE character_id = ?',
                [newHealth, characterId]
            );

            logger.info('[RPG State] Updated character health', {
                characterId,
                previousHealth: char.health,
                change: healthChange,
                newHealth
            });

            return { previousHealth: char.health, newHealth, maxHealth: char.max_health };

        } catch (error) {
            logger.error('[RPG State] Error updating character health', { error: error.message });
            return null;
        }
    }

    /**
     * Update character gold
     */
    static async updateCharacterGold(characterId, goldChange) {
        try {
            if (goldChange >= 0) {
                await pool.execute(
                    'UPDATE dnd_characters SET gold = gold + ? WHERE character_id = ?',
                    [goldChange, characterId]
                );
            } else {
                // For spending, ensure they have enough
                const [chars] = await pool.execute(
                    'SELECT gold FROM dnd_characters WHERE character_id = ?',
                    [characterId]
                );

                if (chars.length === 0 || chars[0].gold < Math.abs(goldChange)) {
                    return false;
                }

                await pool.execute(
                    'UPDATE dnd_characters SET gold = gold - ? WHERE character_id = ?',
                    [Math.abs(goldChange), characterId]
                );
            }

            logger.info('[RPG State] Updated character gold', { characterId, goldChange });
            return true;

        } catch (error) {
            logger.error('[RPG State] Error updating character gold', { error: error.message });
            return false;
        }
    }

    /**
     * Add experience to character
     */
    static async addCharacterXP(characterId, xpAmount) {
        try {
            const [chars] = await pool.execute(
                'SELECT level, experience FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );

            if (chars.length === 0) return null;

            const char = chars[0];
            const newXP = char.experience + xpAmount;
            const xpNeeded = char.level * 100; // Simple leveling formula

            let leveledUp = false;
            let newLevel = char.level;

            if (newXP >= xpNeeded) {
                // Level up!
                newLevel = char.level + 1;
                const remainingXP = newXP - xpNeeded;

                // Calculate HP increase based on class (using average hit die)
                const hpIncrease = Math.floor(Math.random() * 6) + 5; // d10 average-ish

                await pool.execute(
                    `UPDATE dnd_characters
                     SET level = ?, experience = ?, max_health = max_health + ?, health = health + ?
                     WHERE character_id = ?`,
                    [newLevel, remainingXP, hpIncrease, hpIncrease, characterId]
                );

                leveledUp = true;
                logger.info('[RPG State] Character leveled up!', { characterId, newLevel, hpIncrease });
            } else {
                await pool.execute(
                    'UPDATE dnd_characters SET experience = ? WHERE character_id = ?',
                    [newXP, characterId]
                );
            }

            return { leveledUp, newLevel, xpGained: xpAmount, totalXP: leveledUp ? (newXP - xpNeeded) : newXP };

        } catch (error) {
            logger.error('[RPG State] Error adding XP', { error: error.message });
            return null;
        }
    }

    /**
     * Update character location
     */
    static async updateCharacterLocation(characterId, location) {
        try {
            await pool.execute(
                'UPDATE dnd_characters SET current_zone = ? WHERE character_id = ?',
                [location, characterId]
            );

            logger.info('[RPG State] Updated character location', { characterId, location });
            return true;

        } catch (error) {
            logger.error('[RPG State] Error updating location', { error: error.message });
            return false;
        }
    }

    /**
     * Add enemy to session combat state
     */
    static addEnemy(sessionId, enemyData) {
        const state = this.getSessionState(sessionId);

        const enemy = {
            id: `enemy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: enemyData.name,
            hp: enemyData.hp || 20,
            maxHp: enemyData.hp || 20,
            ac: enemyData.ac || 12,
            position: enemyData.position || 'melee range',
            conditions: [],
            isAlive: true,
            damage: enemyData.damage || '1d6',
            initiative: 0
        };

        state.enemies.push(enemy);
        state.inCombat = true;

        logger.info('[RPG State] Added enemy to combat', { sessionId, enemy: enemy.name });
        return enemy;
    }

    /**
     * Update enemy HP
     */
    static updateEnemyHP(sessionId, enemyIdentifier, hpChange) {
        const state = this.getSessionState(sessionId);

        // Find enemy by name or id
        const enemy = state.enemies.find(e =>
            e.name.toLowerCase() === enemyIdentifier.toLowerCase() ||
            e.id === enemyIdentifier
        );

        if (!enemy) {
            logger.warn('[RPG State] Enemy not found', { sessionId, enemyIdentifier });
            return null;
        }

        enemy.hp = Math.max(0, Math.min(enemy.hp + hpChange, enemy.maxHp));

        if (enemy.hp <= 0) {
            enemy.isAlive = false;
            enemy.conditions.push('dead');
        }

        logger.info('[RPG State] Updated enemy HP', {
            sessionId,
            enemyName: enemy.name,
            hpChange,
            newHP: enemy.hp,
            isAlive: enemy.isAlive
        });

        // Check if all enemies are dead
        const allDead = state.enemies.every(e => !e.isAlive);
        if (allDead && state.enemies.length > 0) {
            state.inCombat = false;
        }

        return enemy;
    }

    /**
     * Remove dead enemies from session
     */
    static clearDeadEnemies(sessionId) {
        const state = this.getSessionState(sessionId);
        state.enemies = state.enemies.filter(e => e.isAlive);
    }

    /**
     * Set initiative order
     */
    static setInitiative(sessionId, initiativeList) {
        const state = this.getSessionState(sessionId);
        state.initiative = initiativeList.sort((a, b) => b.roll - a.roll);
        state.currentTurn = 0;
        state.combatRound = 1;
    }

    /**
     * Advance combat turn
     */
    static nextTurn(sessionId) {
        const state = this.getSessionState(sessionId);
        state.currentTurn++;

        if (state.currentTurn >= state.initiative.length) {
            state.currentTurn = 0;
            state.combatRound++;
        }

        return {
            currentTurn: state.currentTurn,
            combatRound: state.combatRound,
            currentActor: state.initiative[state.currentTurn]
        };
    }

    /**
     * Add condition to character or enemy
     */
    static addCondition(sessionId, targetName, condition, duration = null) {
        const state = this.getSessionState(sessionId);

        // Check if it's an enemy
        const enemy = state.enemies.find(e => e.name.toLowerCase() === targetName.toLowerCase());
        if (enemy) {
            if (!enemy.conditions.includes(condition)) {
                enemy.conditions.push(condition);
            }
            return true;
        }

        // Otherwise it's a player condition
        if (!state.playerConditions.has(targetName)) {
            state.playerConditions.set(targetName, []);
        }

        const conditions = state.playerConditions.get(targetName);
        if (!conditions.includes(condition)) {
            conditions.push(condition);
        }

        return true;
    }

    /**
     * Remove condition from character or enemy
     */
    static removeCondition(sessionId, targetName, condition) {
        const state = this.getSessionState(sessionId);

        const enemy = state.enemies.find(e => e.name.toLowerCase() === targetName.toLowerCase());
        if (enemy) {
            enemy.conditions = enemy.conditions.filter(c => c !== condition);
            return true;
        }

        if (state.playerConditions.has(targetName)) {
            const conditions = state.playerConditions.get(targetName);
            state.playerConditions.set(targetName, conditions.filter(c => c !== condition));
        }

        return true;
    }

    /**
     * Get full session state for display
     */
    static getFullState(sessionId) {
        const state = this.getSessionState(sessionId);

        return {
            location: state.location,
            subLocation: state.subLocation,
            inCombat: state.inCombat,
            enemies: state.enemies.filter(e => e.isAlive).map(e => ({
                name: e.name,
                hp: e.hp,
                maxHp: e.maxHp,
                ac: e.ac,
                position: e.position,
                conditions: e.conditions
            })),
            initiative: state.initiative,
            currentTurn: state.currentTurn,
            combatRound: state.combatRound,
            npcsPresent: state.npcsPresent,
            recentRolls: state.recentRolls.slice(0, 5),
            sessionLoot: state.loot,
            sessionGold: state.goldGained,
            sessionXP: state.xpGained,
            timeOfDay: state.timeOfDay,
            weather: state.weather
        };
    }

    /**
     * Build comprehensive status display
     */
    static buildCombatStatus(sessionId, character) {
        const state = this.getSessionState(sessionId);

        if (!state.inCombat || state.enemies.length === 0) {
            return null;
        }

        let status = '**Combat Status:**\n';

        // Show initiative order
        if (state.initiative.length > 0) {
            status += `Round ${state.combatRound} | `;
            status += state.initiative.map((i, idx) => {
                const marker = idx === state.currentTurn ? '>' : '';
                return `${marker}${i.name}(${i.roll})`;
            }).join(' | ');
            status += '\n\n';
        }

        // Show enemies
        status += '**Enemies:**\n';
        for (const enemy of state.enemies.filter(e => e.isAlive)) {
            const hpPercent = Math.floor((enemy.hp / enemy.maxHp) * 100);
            const hpBar = hpPercent > 66 ? '🟢' : hpPercent > 33 ? '🟡' : '🔴';
            const conditions = enemy.conditions.length > 0 ? ` [${enemy.conditions.join(', ')}]` : '';
            status += `${hpBar} **${enemy.name}** - HP: ${enemy.hp}/${enemy.maxHp} | AC: ${enemy.ac} | ${enemy.position}${conditions}\n`;
        }

        // Show dead enemies
        const deadEnemies = state.enemies.filter(e => !e.isAlive);
        if (deadEnemies.length > 0) {
            status += `\n💀 Defeated: ${deadEnemies.map(e => e.name).join(', ')}`;
        }

        return status;
    }

    // Helper methods

    static inferItemType(itemName) {
        const name = itemName.toLowerCase();

        if (name.includes('sword') || name.includes('axe') || name.includes('bow') ||
            name.includes('dagger') || name.includes('staff') || name.includes('mace') ||
            name.includes('spear') || name.includes('hammer') || name.includes('blade')) {
            return 'weapon';
        }

        if (name.includes('armor') || name.includes('shield') || name.includes('helm') ||
            name.includes('boots') || name.includes('gauntlet') || name.includes('plate') ||
            name.includes('mail') || name.includes('robe')) {
            return 'armor';
        }

        if (name.includes('potion') || name.includes('elixir') || name.includes('salve') ||
            name.includes('antidote') || name.includes('flask')) {
            return 'consumable';
        }

        if (name.includes('ring') || name.includes('amulet') || name.includes('necklace') ||
            name.includes('bracelet') || name.includes('cloak')) {
            return 'accessory';
        }

        if (name.includes('scroll') || name.includes('tome') || name.includes('book') ||
            name.includes('map') || name.includes('letter') || name.includes('note')) {
            return 'scroll';
        }

        if (name.includes('key') || name.includes('gem') || name.includes('coin') ||
            name.includes('token') || name.includes('relic')) {
            return 'quest_item';
        }

        return 'misc';
    }

    static calculateSellPrice(rarity) {
        const prices = {
            'common': 10,
            'uncommon': 50,
            'rare': 200,
            'very_rare': 1000,
            'legendary': 5000,
            'artifact': 25000
        };
        return prices[rarity] || 10;
    }
}

export default RPGStateManager;
export { RPGStateManager, sessionStateCache };
