import type { Client } from 'discord.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

interface ClassStats {
    health: number;
    mana: number;
    strength: number;
    dexterity: number;
    constitution: number;
    intelligence: number;
    wisdom: number;
    charisma: number;
}

interface DNDCharacter extends RowDataPacket {
    character_id: number;
    user_id: string;
    guild_id: string;
    character_name: string;
    class: string;
    level: number;
    experience: number;
    health: number;
    max_health: number;
    mana: number;
    max_mana: number;
    strength: number;
    dexterity: number;
    constitution: number;
    intelligence: number;
    wisdom: number;
    charisma: number;
    gold: number;
    current_zone: string;
}

interface DNDZone extends RowDataPacket {
    zone_id: string;
    zone_name: string;
    min_level: number;
    description: string;
}

interface DNDQuest extends RowDataPacket {
    quest_id: number;
    quest_name: string;
    required_level: number;
    reward_gold: number;
    reward_exp: number;
    reward_item_id: number | null;
}

interface DNDItem extends RowDataPacket {
    item_id: number;
    item_name: string;
    item_type: string;
    rarity: string;
}

interface DNDInventoryItem extends DNDItem {
    quantity: number;
    equipped: boolean;
}

interface DNDEnemy extends RowDataPacket {
    enemy_id: number;
    enemy_name: string;
    health: number;
    damage: number;
}

interface LevelUpResult {
    newLevel: number;
    healthIncrease: number;
    manaIncrease: number;
}

interface ExpResult {
    leveledUp: boolean;
    newExp?: number;
    expNeeded?: number;
    newLevel?: number;
    healthIncrease?: number;
    manaIncrease?: number;
}

/**
 * D&D Manager - Handles D&D RPG system
 */
class DNDManager {
    private client: Client;
    private classStats: Record<string, ClassStats>;

    constructor(client: Client) {
        this.client = client;

        // Class base stats
        this.classStats = {
            'warrior': { health: 120, mana: 30, strength: 15, dexterity: 10, constitution: 14, intelligence: 8, wisdom: 9, charisma: 10 },
            'mage': { health: 80, mana: 100, strength: 7, dexterity: 9, constitution: 8, intelligence: 16, wisdom: 14, charisma: 11 },
            'rogue': { health: 90, mana: 50, strength: 11, dexterity: 16, constitution: 10, intelligence: 12, wisdom: 10, charisma: 13 },
            'cleric': { health: 100, mana: 80, strength: 12, dexterity: 8, constitution: 12, intelligence: 13, wisdom: 16, charisma: 12 },
            'ranger': { health: 95, mana: 60, strength: 13, dexterity: 14, constitution: 11, intelligence: 11, wisdom: 13, charisma: 9 },
            'paladin': { health: 110, mana: 70, strength: 14, dexterity: 9, constitution: 13, intelligence: 10, wisdom: 12, charisma: 14 }
        };
    }

    /**
     * Create a new character
     */
    async createCharacter(userId: string, guildId: string, characterName: string, className: string): Promise<{ characterId: number } & ClassStats> {
        try {
            const classLower = className.toLowerCase();
            if (!this.classStats[classLower]) {
                throw new Error(`Invalid class. Available classes: ${Object.keys(this.classStats).join(', ')}`);
            }

            const stats = this.classStats[classLower];

            const [result] = await db.execute<ResultSetHeader>(
                `INSERT INTO dnd_characters (user_id, guild_id, character_name, class, level, experience,
                    health, max_health, mana, max_mana, strength, dexterity, constitution, intelligence, wisdom, charisma, gold, current_zone)
                 VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 'town')
                 ON DUPLICATE KEY UPDATE character_name = VALUES(character_name), class = VALUES(class), level = 1, experience = 0,
                    health = VALUES(health), max_health = VALUES(max_health), mana = VALUES(mana), max_mana = VALUES(max_mana),
                    strength = VALUES(strength), dexterity = VALUES(dexterity), constitution = VALUES(constitution),
                    intelligence = VALUES(intelligence), wisdom = VALUES(wisdom), charisma = VALUES(charisma), gold = 100, current_zone = 'town'`,
                [userId, guildId, characterName, className, stats.health, stats.health, stats.mana, stats.mana,
                    stats.strength, stats.dexterity, stats.constitution, stats.intelligence, stats.wisdom, stats.charisma]
            );

            logger.info(`[DNDManager] Created character ${characterName} (${className}) for user ${userId} in guild ${guildId}`);
            return { characterId: result.insertId, ...stats };

        } catch (error: any) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw new Error('You already have a character in this server. Delete it first to create a new one.');
            }
            logger.error(`[DNDManager] Error creating character: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get character info
     */
    async getCharacter(userId: string, guildId: string): Promise<DNDCharacter | null> {
        try {
            const [rows] = await db.execute<DNDCharacter[]>(
                'SELECT * FROM dnd_characters WHERE user_id = ? AND guild_id = ?',
                [userId, guildId]
            );

            return rows[0] || null;
        } catch (error: any) {
            logger.error(`[DNDManager] Error getting character: ${error.message}`);
            return null;
        }
    }

    /**
     * Delete character
     */
    async deleteCharacter(userId: string, guildId: string): Promise<boolean> {
        try {
            await db.execute(
                'DELETE FROM dnd_characters WHERE user_id = ? AND guild_id = ?',
                [userId, guildId]
            );

            logger.info(`[DNDManager] Deleted character for user ${userId} in guild ${guildId}`);
            return true;
        } catch (error: any) {
            logger.error(`[DNDManager] Error deleting character: ${error.message}`);
            return false;
        }
    }

    /**
     * Level up character
     */
    async levelUp(characterId: number): Promise<LevelUpResult | false> {
        try {
            const [chars] = await db.execute<DNDCharacter[]>('SELECT * FROM dnd_characters WHERE character_id = ?', [characterId]);
            const character = chars[0];

            if (!character) return false;

            const newLevel = character.level + 1;
            const healthIncrease = 10 + Math.floor(character.constitution / 3);
            const manaIncrease = 5 + Math.floor(character.intelligence / 3);

            await db.execute(
                `UPDATE dnd_characters
                 SET level = ?, max_health = max_health + ?, max_mana = max_mana + ?,
                     health = max_health + ?, mana = max_mana + ?
                 WHERE character_id = ?`,
                [newLevel, healthIncrease, manaIncrease, healthIncrease, manaIncrease, characterId]
            );

            logger.info(`[DNDManager] Character ${characterId} leveled up to level ${newLevel}`);
            return { newLevel, healthIncrease, manaIncrease };

        } catch (error: any) {
            logger.error(`[DNDManager] Error leveling up character: ${error.message}`);
            return false;
        }
    }

    /**
     * Add experience to character
     */
    async addExperience(characterId: number, exp: number): Promise<ExpResult | false> {
        try {
            const [chars] = await db.execute<DNDCharacter[]>('SELECT level, experience FROM dnd_characters WHERE character_id = ?', [characterId]);
            const character = chars[0];

            if (!character) return false;

            const newExp = character.experience + exp;
            const expNeeded = character.level * 100; // Simple formula: level * 100 EXP per level

            if (newExp >= expNeeded) {
                // Level up!
                await db.execute(
                    'UPDATE dnd_characters SET experience = ? - ? WHERE character_id = ?',
                    [newExp, expNeeded, characterId]
                );

                const levelUpResult = await this.levelUp(characterId);
                if (levelUpResult) {
                    return { leveledUp: true, ...levelUpResult };
                }
                return false;
            } else {
                await db.execute(
                    'UPDATE dnd_characters SET experience = ? WHERE character_id = ?',
                    [newExp, characterId]
                );

                return { leveledUp: false, newExp, expNeeded };
            }

        } catch (error: any) {
            logger.error(`[DNDManager] Error adding experience: ${error.message}`);
            return false;
        }
    }

    /**
     * Travel to a new zone
     */
    async travel(characterId: number, zoneName: string): Promise<DNDZone> {
        try {
            // Check if zone exists
            const [zones] = await db.execute<DNDZone[]>('SELECT * FROM dnd_zones WHERE zone_id = ?', [zoneName]);
            const zone = zones[0];

            if (!zone) {
                throw new Error('Zone not found');
            }

            // Check character level
            const [chars] = await db.execute<DNDCharacter[]>('SELECT level FROM dnd_characters WHERE character_id = ?', [characterId]);
            const character = chars[0];

            if (character.level < zone.min_level) {
                throw new Error(`You need to be at least level ${zone.min_level} to enter ${zone.zone_name}`);
            }

            await db.execute(
                'UPDATE dnd_characters SET current_zone = ? WHERE character_id = ?',
                [zoneName, characterId]
            );

            logger.info(`[DNDManager] Character ${characterId} traveled to ${zoneName}`);
            return zone;

        } catch (error: any) {
            logger.error(`[DNDManager] Error traveling: ${error.message}`);
            throw error;
        }
    }

    /**
     * Start a quest
     */
    async startQuest(characterId: number, questId: number): Promise<DNDQuest> {
        try {
            // Check if character already has this quest
            const [existing] = await db.execute<RowDataPacket[]>(
                'SELECT * FROM dnd_character_quests WHERE character_id = ? AND quest_id = ? AND status = "active"',
                [characterId, questId]
            );

            if (existing.length > 0) {
                throw new Error('You already have this quest active');
            }

            // Get quest info
            const [quests] = await db.execute<DNDQuest[]>('SELECT * FROM dnd_quests WHERE quest_id = ?', [questId]);
            const quest = quests[0];

            if (!quest) {
                throw new Error('Quest not found');
            }

            // Check character level
            const [chars] = await db.execute<DNDCharacter[]>('SELECT level FROM dnd_characters WHERE character_id = ?', [characterId]);
            const character = chars[0];

            if (character.level < quest.required_level) {
                throw new Error(`You need to be at least level ${quest.required_level} for this quest`);
            }

            await db.execute(
                'INSERT INTO dnd_character_quests (character_id, quest_id, status, progress) VALUES (?, ?, "active", 0)',
                [characterId, questId]
            );

            logger.info(`[DNDManager] Character ${characterId} started quest ${questId}`);
            return quest;

        } catch (error: any) {
            logger.error(`[DNDManager] Error starting quest: ${error.message}`);
            throw error;
        }
    }

    /**
     * Complete a quest
     */
    async completeQuest(characterId: number, questId: number): Promise<{ quest: DNDQuest; rewards: any }> {
        try {
            // Get quest info
            const [quests] = await db.execute<DNDQuest[]>('SELECT * FROM dnd_quests WHERE quest_id = ?', [questId]);
            const quest = quests[0];

            if (!quest) {
                throw new Error('Quest not found');
            }

            // Update quest status
            await db.execute(
                'UPDATE dnd_character_quests SET status = "completed", completed_at = NOW() WHERE character_id = ? AND quest_id = ?',
                [characterId, questId]
            );

            // Award rewards
            await db.execute(
                'UPDATE dnd_characters SET gold = gold + ? WHERE character_id = ?',
                [quest.reward_gold, characterId]
            );

            const expResult = await this.addExperience(characterId, quest.reward_exp);

            // Award item if any
            if (quest.reward_item_id) {
                await this.addItem(characterId, quest.reward_item_id, 1);
            }

            logger.info(`[DNDManager] Character ${characterId} completed quest ${questId}`);

            return {
                quest,
                rewards: {
                    gold: quest.reward_gold,
                    exp: quest.reward_exp,
                    item: quest.reward_item_id,
                    leveledUp: expResult && typeof expResult === 'object' ? expResult.leveledUp : false
                }
            };

        } catch (error: any) {
            logger.error(`[DNDManager] Error completing quest: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get character's active quests
     */
    async getActiveQuests(characterId: number): Promise<any[]> {
        try {
            const [quests] = await db.execute<RowDataPacket[]>(
                `SELECT q.*, cq.progress, cq.started_at
                 FROM dnd_character_quests cq
                 JOIN dnd_quests q ON cq.quest_id = q.quest_id
                 WHERE cq.character_id = ? AND cq.status = 'active'
                 ORDER BY cq.started_at DESC`,
                [characterId]
            );

            return quests;
        } catch (error: any) {
            logger.error(`[DNDManager] Error getting active quests: ${error.message}`);
            return [];
        }
    }

    /**
     * Add item to inventory
     */
    async addItem(characterId: number, itemId: number, quantity: number = 1): Promise<boolean> {
        try {
            // Check if item already in inventory
            const [existing] = await db.execute<RowDataPacket[]>(
                'SELECT * FROM dnd_inventory WHERE character_id = ? AND item_id = ?',
                [characterId, itemId]
            );

            if (existing.length > 0) {
                await db.execute(
                    'UPDATE dnd_inventory SET quantity = quantity + ? WHERE character_id = ? AND item_id = ?',
                    [quantity, characterId, itemId]
                );
            } else {
                await db.execute(
                    'INSERT INTO dnd_inventory (character_id, item_id, quantity) VALUES (?, ?, ?)',
                    [characterId, itemId, quantity]
                );
            }

            logger.info(`[DNDManager] Added ${quantity}x item ${itemId} to character ${characterId}`);
            return true;

        } catch (error: any) {
            logger.error(`[DNDManager] Error adding item: ${error.message}`);
            return false;
        }
    }

    /**
     * Remove item from inventory
     */
    async removeItem(characterId: number, itemId: number, quantity: number = 1): Promise<boolean> {
        try {
            const [existing] = await db.execute<RowDataPacket[]>(
                'SELECT quantity FROM dnd_inventory WHERE character_id = ? AND item_id = ?',
                [characterId, itemId]
            );

            if (existing.length === 0 || (existing[0] as any).quantity < quantity) {
                throw new Error('Not enough items in inventory');
            }

            const newQuantity = (existing[0] as any).quantity - quantity;

            if (newQuantity <= 0) {
                await db.execute(
                    'DELETE FROM dnd_inventory WHERE character_id = ? AND item_id = ?',
                    [characterId, itemId]
                );
            } else {
                await db.execute(
                    'UPDATE dnd_inventory SET quantity = ? WHERE character_id = ? AND item_id = ?',
                    [newQuantity, characterId, itemId]
                );
            }

            logger.info(`[DNDManager] Removed ${quantity}x item ${itemId} from character ${characterId}`);
            return true;

        } catch (error: any) {
            logger.error(`[DNDManager] Error removing item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get character inventory
     */
    async getInventory(characterId: number): Promise<DNDInventoryItem[]> {
        try {
            const [items] = await db.execute<DNDInventoryItem[]>(
                `SELECT i.*, inv.quantity, inv.equipped
                 FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ?
                 ORDER BY i.item_type, i.rarity DESC, i.item_name`,
                [characterId]
            );

            return items;
        } catch (error: any) {
            logger.error(`[DNDManager] Error getting inventory: ${error.message}`);
            return [];
        }
    }

    /**
     * Start a battle
     */
    async startBattle(characterId: number, enemyId: number): Promise<any> {
        try {
            // Check for active battles
            const [activeBattles] = await db.execute<RowDataPacket[]>(
                'SELECT * FROM dnd_battles WHERE character_id = ? AND status = "ongoing"',
                [characterId]
            );

            if (activeBattles.length > 0) {
                throw new Error('You already have an active battle');
            }

            // Get character and enemy info
            const [chars] = await db.execute<DNDCharacter[]>('SELECT * FROM dnd_characters WHERE character_id = ?', [characterId]);
            const character = chars[0];

            const [enemies] = await db.execute<DNDEnemy[]>('SELECT * FROM dnd_enemies WHERE enemy_id = ?', [enemyId]);
            const enemy = enemies[0];

            if (!enemy) {
                throw new Error('Enemy not found');
            }

            // Create battle
            await db.execute(
                `INSERT INTO dnd_battles (character_id, enemy_id, character_health, enemy_health, turn, status)
                 VALUES (?, ?, ?, ?, 1, 'ongoing')`,
                [characterId, enemyId, character.health, enemy.health]
            );

            logger.info(`[DNDManager] Character ${characterId} started battle with enemy ${enemyId}`);

            return {
                character: {
                    id: characterId,
                    name: character.character_name,
                    health: character.health,
                    maxHealth: character.max_health,
                    damage: character.strength + Math.floor(character.dexterity / 2)
                },
                enemy: {
                    id: enemyId,
                    name: enemy.enemy_name,
                    health: enemy.health,
                    damage: enemy.damage
                }
            };

        } catch (error: any) {
            logger.error(`[DNDManager] Error starting battle: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get list of available classes
     */
    getAvailableClasses(): Array<{ name: string; stats: ClassStats }> {
        return Object.keys(this.classStats).map(className => ({
            name: className.charAt(0).toUpperCase() + className.slice(1),
            stats: this.classStats[className]
        }));
    }
}

export default DNDManager;
