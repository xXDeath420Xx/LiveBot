/**
 * RPG Dungeon Manager
 * Handles co-op dungeon crawling, rooms, encounters, and loot
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import { RPGDiceEngine } from './rpg-dice-engine.js';

// Room types and their properties
const ROOM_TYPES = {
    combat: {
        name: 'Combat',
        description: 'A room with enemies to defeat',
        icon: '⚔️'
    },
    trap: {
        name: 'Trap',
        description: 'A dangerous trap awaits',
        icon: '🪤'
    },
    puzzle: {
        name: 'Puzzle',
        description: 'A riddle or puzzle to solve',
        icon: '🧩'
    },
    treasure: {
        name: 'Treasure',
        description: 'Valuable loot awaits',
        icon: '💰'
    },
    rest: {
        name: 'Rest Area',
        description: 'A safe place to recover',
        icon: '🏕️'
    },
    boss: {
        name: 'Boss',
        description: 'A powerful enemy guards this room',
        icon: '👹'
    },
    shop: {
        name: 'Merchant',
        description: 'A wandering merchant',
        icon: '🛒'
    },
    event: {
        name: 'Event',
        description: 'Something interesting happens',
        icon: '❓'
    }
};

// Difficulty modifiers
const DIFFICULTY_MODIFIERS = {
    easy: { xpMult: 0.75, goldMult: 0.75, enemyMult: 0.8 },
    normal: { xpMult: 1.0, goldMult: 1.0, enemyMult: 1.0 },
    hard: { xpMult: 1.5, goldMult: 1.25, enemyMult: 1.2 },
    nightmare: { xpMult: 2.0, goldMult: 1.5, enemyMult: 1.5 }
};

class RPGDungeonManager {
    /**
     * Get available dungeons for a guild
     * @param {string} guildId - Guild ID
     * @param {number} partyLevel - Average party level
     * @returns {array} Available dungeons
     */
    static async getAvailableDungeons(guildId, partyLevel) {
        const [dungeons] = await pool.execute(
            `SELECT * FROM dnd_dungeons
             WHERE is_active = TRUE AND min_level <= ?
             ORDER BY min_level, dungeon_name`,
            [partyLevel]
        );

        return dungeons.map(d => ({
            ...d,
            rewards: typeof d.rewards === 'string' ? JSON.parse(d.rewards) : d.rewards
        }));
    }

    /**
     * Get dungeon details
     * @param {number} dungeonId - Dungeon ID
     * @returns {object} Dungeon with rooms
     */
    static async getDungeon(dungeonId) {
        const [dungeons] = await pool.execute(
            'SELECT * FROM dnd_dungeons WHERE dungeon_id = ?',
            [dungeonId]
        );

        if (dungeons.length === 0) return null;

        const dungeon = dungeons[0];
        dungeon.rewards = typeof dungeon.rewards === 'string' ? JSON.parse(dungeon.rewards) : dungeon.rewards;

        const [rooms] = await pool.execute(
            'SELECT * FROM dnd_dungeon_rooms WHERE dungeon_id = ? ORDER BY room_order',
            [dungeonId]
        );

        dungeon.rooms = rooms.map(r => ({
            ...r,
            encounters: typeof r.encounters === 'string' ? JSON.parse(r.encounters) : r.encounters,
            loot_table: typeof r.loot_table === 'string' ? JSON.parse(r.loot_table) : r.loot_table
        }));

        return dungeon;
    }

    /**
     * Start a dungeon run
     * @param {number} partyId - Party ID
     * @param {number} dungeonId - Dungeon ID
     * @param {string} difficulty - Difficulty level
     * @returns {object} Run info
     */
    static async startRun(partyId, dungeonId, difficulty = 'normal') {
        const dungeon = await this.getDungeon(dungeonId);
        if (!dungeon) {
            throw new Error('Dungeon not found');
        }

        // Check for existing active run
        const [existing] = await pool.execute(
            `SELECT run_id FROM dnd_dungeon_runs
             WHERE party_id = ? AND status = 'in_progress'`,
            [partyId]
        );

        if (existing.length > 0) {
            throw new Error('Party already has an active dungeon run');
        }

        const [result] = await pool.execute(
            `INSERT INTO dnd_dungeon_runs
             (party_id, dungeon_id, difficulty, current_room, status)
             VALUES (?, ?, ?, 1, 'in_progress')`,
            [partyId, dungeonId, difficulty]
        );

        logger.info('[Dungeon] Started run', { partyId, dungeonId, difficulty });

        return {
            run_id: result.insertId,
            dungeon_name: dungeon.dungeon_name,
            difficulty,
            total_rooms: dungeon.rooms.length,
            current_room: 1,
            first_room: dungeon.rooms[0]
        };
    }

    /**
     * Get current room in a run
     * @param {number} runId - Run ID
     * @returns {object} Current room
     */
    static async getCurrentRoom(runId) {
        const [runs] = await pool.execute(
            `SELECT dr.*, d.dungeon_name
             FROM dnd_dungeon_runs dr
             JOIN dnd_dungeons d ON dr.dungeon_id = d.dungeon_id
             WHERE dr.run_id = ?`,
            [runId]
        );

        if (runs.length === 0) {
            throw new Error('Run not found');
        }

        const run = runs[0];

        const [rooms] = await pool.execute(
            'SELECT * FROM dnd_dungeon_rooms WHERE dungeon_id = ? AND room_order = ?',
            [run.dungeon_id, run.current_room]
        );

        if (rooms.length === 0) {
            throw new Error('Room not found');
        }

        const room = rooms[0];
        room.encounters = typeof room.encounters === 'string' ? JSON.parse(room.encounters) : room.encounters;
        room.loot_table = typeof room.loot_table === 'string' ? JSON.parse(room.loot_table) : room.loot_table;

        return {
            run,
            room,
            roomType: ROOM_TYPES[room.room_type] || ROOM_TYPES.event
        };
    }

    /**
     * Complete current room and advance
     * @param {number} runId - Run ID
     * @param {object} result - Room completion result
     * @returns {object} Next room or completion
     */
    static async completeRoom(runId, result = {}) {
        const { run, room } = await this.getCurrentRoom(runId);

        // Update run stats
        const xpGained = result.xp || 0;
        const goldGained = result.gold || 0;
        const enemiesKilled = result.enemiesKilled || 0;

        await pool.execute(
            `UPDATE dnd_dungeon_runs
             SET total_xp = total_xp + ?,
                 total_gold = total_gold + ?,
                 enemies_defeated = enemies_defeated + ?,
                 rooms_cleared = rooms_cleared + 1
             WHERE run_id = ?`,
            [xpGained, goldGained, enemiesKilled, runId]
        );

        // Get total rooms
        const [totalRooms] = await pool.execute(
            'SELECT COUNT(*) as count FROM dnd_dungeon_rooms WHERE dungeon_id = ?',
            [run.dungeon_id]
        );

        const isLastRoom = run.current_room >= totalRooms[0].count;

        if (isLastRoom) {
            // Complete the dungeon
            return this.completeRun(runId);
        }

        // Advance to next room
        await pool.execute(
            'UPDATE dnd_dungeon_runs SET current_room = current_room + 1 WHERE run_id = ?',
            [runId]
        );

        return this.getCurrentRoom(runId);
    }

    /**
     * Complete a dungeon run
     * @param {number} runId - Run ID
     * @returns {object} Completion rewards
     */
    static async completeRun(runId) {
        const [runs] = await pool.execute(
            `SELECT dr.*, d.rewards, d.dungeon_name
             FROM dnd_dungeon_runs dr
             JOIN dnd_dungeons d ON dr.dungeon_id = d.dungeon_id
             WHERE dr.run_id = ?`,
            [runId]
        );

        if (runs.length === 0) {
            throw new Error('Run not found');
        }

        const run = runs[0];
        const rewards = typeof run.rewards === 'string' ? JSON.parse(run.rewards) : run.rewards;
        const diffMod = DIFFICULTY_MODIFIERS[run.difficulty] || DIFFICULTY_MODIFIERS.normal;

        // Calculate final rewards
        const totalXP = Math.floor(run.total_xp * diffMod.xpMult);
        const totalGold = Math.floor(run.total_gold * diffMod.goldMult);
        const completionBonus = rewards?.completionXP || 100;

        // Update run status
        await pool.execute(
            `UPDATE dnd_dungeon_runs
             SET status = 'completed',
                 completed_at = NOW(),
                 total_xp = ?,
                 total_gold = ?
             WHERE run_id = ?`,
            [totalXP + completionBonus, totalGold, runId]
        );

        // Increment dungeon completion count
        await pool.execute(
            'UPDATE dnd_dungeons SET times_completed = times_completed + 1 WHERE dungeon_id = ?',
            [run.dungeon_id]
        );

        logger.info('[Dungeon] Completed run', { runId, totalXP, totalGold });

        return {
            completed: true,
            dungeon_name: run.dungeon_name,
            difficulty: run.difficulty,
            rooms_cleared: run.rooms_cleared + 1,
            enemies_defeated: run.enemies_defeated,
            total_xp: totalXP + completionBonus,
            total_gold: totalGold,
            time_taken: run.completed_at ? Math.floor((new Date(run.completed_at) - new Date(run.started_at)) / 1000) : null
        };
    }

    /**
     * Abandon a dungeon run
     * @param {number} runId - Run ID
     */
    static async abandonRun(runId) {
        await pool.execute(
            `UPDATE dnd_dungeon_runs
             SET status = 'abandoned', completed_at = NOW()
             WHERE run_id = ?`,
            [runId]
        );
    }

    /**
     * Get party's active run
     * @param {number} partyId - Party ID
     * @returns {object|null} Active run
     */
    static async getActiveRun(partyId) {
        const [runs] = await pool.execute(
            `SELECT dr.*, d.dungeon_name, d.total_rooms
             FROM dnd_dungeon_runs dr
             JOIN dnd_dungeons d ON dr.dungeon_id = d.dungeon_id
             WHERE dr.party_id = ? AND dr.status = 'in_progress'`,
            [partyId]
        );

        return runs.length > 0 ? runs[0] : null;
    }

    /**
     * Get party's run history
     * @param {number} partyId - Party ID
     * @returns {array} Past runs
     */
    static async getRunHistory(partyId) {
        const [runs] = await pool.execute(
            `SELECT dr.*, d.dungeon_name
             FROM dnd_dungeon_runs dr
             JOIN dnd_dungeons d ON dr.dungeon_id = d.dungeon_id
             WHERE dr.party_id = ? AND dr.status != 'in_progress'
             ORDER BY dr.completed_at DESC
             LIMIT 20`,
            [partyId]
        );

        return runs;
    }

    /**
     * Generate encounter for a room
     * @param {object} room - Room data
     * @param {number} partyLevel - Party's average level
     * @param {string} difficulty - Difficulty setting
     * @returns {object} Generated encounter
     */
    static generateEncounter(room, partyLevel, difficulty = 'normal') {
        const diffMod = DIFFICULTY_MODIFIERS[difficulty] || DIFFICULTY_MODIFIERS.normal;
        const encounters = room.encounters || [];

        if (encounters.length === 0) {
            return null;
        }

        // Select random encounter
        const encounter = encounters[Math.floor(Math.random() * encounters.length)];

        // Scale enemy count
        const enemyCount = Math.ceil((encounter.count || 1) * diffMod.enemyMult);

        // Scale enemy stats based on party level
        const levelDiff = partyLevel - (encounter.baseLevel || 1);
        const hpScale = 1 + (levelDiff * 0.1);
        const damageScale = 1 + (levelDiff * 0.05);

        return {
            enemies: Array(enemyCount).fill(null).map((_, i) => ({
                id: i + 1,
                name: encounter.enemy,
                hp: Math.floor((encounter.hp || 20) * hpScale * diffMod.enemyMult),
                maxHp: Math.floor((encounter.hp || 20) * hpScale * diffMod.enemyMult),
                ac: encounter.ac || 12,
                damage: `${Math.ceil((encounter.damageDice || 1) * damageScale)}d${encounter.damageDie || 6}`,
                xp: Math.floor((encounter.xp || 50) * diffMod.xpMult)
            })),
            totalXP: Math.floor((encounter.xp || 50) * enemyCount * diffMod.xpMult)
        };
    }

    /**
     * Generate trap for a room
     * @param {object} room - Room data
     * @param {string} difficulty - Difficulty setting
     * @returns {object} Trap info
     */
    static generateTrap(room, difficulty = 'normal') {
        const diffMod = DIFFICULTY_MODIFIERS[difficulty] || DIFFICULTY_MODIFIERS.normal;

        const traps = [
            { name: 'Poison Dart Trap', dc: 12, damage: '2d6', type: 'poison', perception: 14 },
            { name: 'Pit Trap', dc: 14, damage: '2d10', type: 'fall', perception: 12 },
            { name: 'Fire Glyph', dc: 15, damage: '3d6', type: 'fire', perception: 16 },
            { name: 'Pressure Plate', dc: 13, damage: '2d8', type: 'bludgeoning', perception: 13 },
            { name: 'Swinging Blade', dc: 14, damage: '3d8', type: 'slashing', perception: 15 }
        ];

        const trap = traps[Math.floor(Math.random() * traps.length)];

        return {
            ...trap,
            dc: trap.dc + (difficulty === 'hard' ? 2 : difficulty === 'nightmare' ? 4 : 0),
            perception: trap.perception + (difficulty === 'hard' ? 2 : difficulty === 'nightmare' ? 4 : 0)
        };
    }

    /**
     * Generate loot from a room
     * @param {object} room - Room data
     * @param {string} difficulty - Difficulty setting
     * @returns {object} Generated loot
     */
    static generateLoot(room, difficulty = 'normal') {
        const diffMod = DIFFICULTY_MODIFIERS[difficulty] || DIFFICULTY_MODIFIERS.normal;
        const lootTable = room.loot_table || { gold: { min: 10, max: 50 } };

        const loot = {
            gold: 0,
            items: []
        };

        // Gold
        if (lootTable.gold) {
            const baseGold = Math.floor(
                Math.random() * (lootTable.gold.max - lootTable.gold.min) + lootTable.gold.min
            );
            loot.gold = Math.floor(baseGold * diffMod.goldMult);
        }

        // Items
        if (lootTable.items && Array.isArray(lootTable.items)) {
            for (const item of lootTable.items) {
                if (Math.random() * 100 <= (item.dropChance || 10)) {
                    loot.items.push({
                        name: item.name,
                        type: item.type || 'misc',
                        value: item.value || 0
                    });
                }
            }
        }

        return loot;
    }

    /**
     * Process a puzzle room
     * @param {number} characterId - Character attempting
     * @param {string} approach - How they approach it
     * @returns {object} Result
     */
    static async attemptPuzzle(characterId, approach = 'intelligence') {
        const [characters] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (characters.length === 0) {
            throw new Error('Character not found');
        }

        const character = characters[0];
        const stats = typeof character.stats === 'string' ? JSON.parse(character.stats) : character.stats;

        // Determine which ability to use
        let abilityMod;
        switch (approach.toLowerCase()) {
            case 'strength':
            case 'force':
                abilityMod = Math.floor((stats.strength - 10) / 2);
                break;
            case 'wisdom':
            case 'insight':
                abilityMod = Math.floor((stats.wisdom - 10) / 2);
                break;
            case 'charisma':
            case 'persuade':
                abilityMod = Math.floor((stats.charisma - 10) / 2);
                break;
            default:
                abilityMod = Math.floor((stats.intelligence - 10) / 2);
        }

        const roll = RPGDiceEngine.rollDice(1, 20);
        const total = roll.total + abilityMod;
        const dc = 13; // Base puzzle DC

        return {
            roll: roll.total,
            modifier: abilityMod,
            total,
            dc,
            success: total >= dc,
            approach
        };
    }
}

export default RPGDungeonManager;
export { RPGDungeonManager, ROOM_TYPES, DIFFICULTY_MODIFIERS };
