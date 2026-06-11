/**
 * RPG Dungeon Manager
 * Handles co-op dungeon crawling, rooms, encounters, and loot
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import { RPGDiceEngine } from './rpg-dice-engine.js';
import { resolveEncounter } from './rpg-auto-combat.js';

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
            rewards: { completionXP: d.reward_exp_base || 0, completionGold: d.reward_gold_base || 0 }
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
        dungeon.rewards = { completionXP: dungeon.reward_exp_base || 0, completionGold: dungeon.reward_gold_base || 0 };

        const [rooms] = await pool.execute(
            'SELECT * FROM dnd_dungeon_rooms WHERE dungeon_id = ? ORDER BY room_number',
            [dungeonId]
        );

        dungeon.rooms = rooms.map(r => ({
            ...r,
            encounters: typeof r.enemies === 'string' ? JSON.parse(r.enemies) : r.enemies,
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
    static async startRun(partyId, dungeonId, difficulty = 'normal', options = {}) {
        // Backwards-compatible: callers may pass a guildId/characterId via options.
        // guild_id is NOT NULL on dnd_dungeon_runs, so it must always be provided.
        const { guildId, characterId } = options;
        if (!guildId) {
            throw new Error('guildId is required to start a dungeon run');
        }

        const dungeon = await this.getDungeon(dungeonId);
        if (!dungeon) {
            throw new Error('Dungeon not found');
        }

        // Check for existing active run (by party if present, else by character)
        let existing;
        if (partyId) {
            [existing] = await pool.execute(
                `SELECT run_id FROM dnd_dungeon_runs WHERE party_id = ? AND status = 'active'`,
                [partyId]
            );
        } else {
            [existing] = await pool.execute(
                `SELECT run_id FROM dnd_dungeon_runs WHERE character_id = ? AND status = 'active'`,
                [characterId]
            );
        }

        if (existing.length > 0) {
            throw new Error('There is already an active dungeon run');
        }

        const [result] = await pool.execute(
            `INSERT INTO dnd_dungeon_runs
             (party_id, character_id, guild_id, dungeon_id, current_room, status)
             VALUES (?, ?, ?, ?, 1, 'active')`,
            [partyId || null, characterId || null, guildId, dungeonId]
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
            'SELECT * FROM dnd_dungeon_rooms WHERE dungeon_id = ? AND room_number = ?',
            [run.dungeon_id, run.current_room]
        );

        if (rooms.length === 0) {
            throw new Error('Room not found');
        }

        const room = rooms[0];
        room.encounters = typeof room.enemies === 'string' ? JSON.parse(room.enemies) : room.enemies;
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

        await pool.execute(
            `UPDATE dnd_dungeon_runs
             SET total_exp = COALESCE(total_exp, 0) + ?,
                 total_gold = COALESCE(total_gold, 0) + ?,
                 rooms_cleared = COALESCE(rooms_cleared, 0) + 1
             WHERE run_id = ?`,
            [xpGained, goldGained, runId]
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
            `SELECT dr.*, d.reward_exp_base, d.reward_gold_base, d.dungeon_name
             FROM dnd_dungeon_runs dr
             JOIN dnd_dungeons d ON dr.dungeon_id = d.dungeon_id
             WHERE dr.run_id = ?`,
            [runId]
        );

        if (runs.length === 0) {
            throw new Error('Run not found');
        }

        const run = runs[0];
        const diffMod = DIFFICULTY_MODIFIERS[run.difficulty] || DIFFICULTY_MODIFIERS.normal;

        // Calculate final rewards
        const totalXP = Math.floor((run.total_exp || 0) * diffMod.xpMult);
        const totalGold = Math.floor((run.total_gold || 0) * diffMod.goldMult);
        const completionBonus = run.reward_exp_base || 100;
        const completionGold = run.reward_gold_base || 0;

        // Update run status
        await pool.execute(
            `UPDATE dnd_dungeon_runs
             SET status = 'completed',
                 ended_at = NOW(),
                 total_exp = ?,
                 total_gold = ?
             WHERE run_id = ?`,
            [totalXP + completionBonus, totalGold + completionGold, runId]
        );

        logger.info('[Dungeon] Completed run', { runId, totalXP, totalGold });

        return {
            completed: true,
            dungeon_name: run.dungeon_name,
            difficulty: run.difficulty,
            rooms_cleared: Number(run.rooms_cleared || 0) + 1,
            total_xp: totalXP + completionBonus,
            total_gold: totalGold + completionGold,
            time_taken: run.ended_at ? Math.floor((new Date(run.ended_at) - new Date(run.started_at)) / 1000) : null
        };
    }

    /**
     * Abandon a dungeon run
     * @param {number} runId - Run ID
     */
    static async abandonRun(runId) {
        await pool.execute(
            `UPDATE dnd_dungeon_runs
             SET status = 'abandoned', ended_at = NOW()
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
             WHERE dr.party_id = ? AND dr.status = 'active'`,
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
             WHERE dr.party_id = ? AND dr.status != 'active'
             ORDER BY dr.ended_at DESC
             LIMIT 20`,
            [partyId]
        );

        return runs;
    }

    /**
     * Mark a dungeon run as failed (e.g. the character was downed in combat).
     * @param {number} runId - Run ID
     */
    static async failRun(runId) {
        await pool.execute(
            `UPDATE dnd_dungeon_runs
             SET status = 'failed', ended_at = NOW()
             WHERE run_id = ?`,
            [runId]
        );
    }

    /**
     * Build concrete enemy combat-snapshots for a room.
     *
     * Supports BOTH on-disk `enemies` JSON shapes:
     *   1. inline objects: [{ name, hp, ac, damage:"1d6+2", count, is_boss }]
     *   2. name strings:   ["Bandit","Wolf"]  -> looked up in dnd_enemies
     *
     * Falls back to a level-appropriate seeded enemy from dnd_enemies when the
     * room has no enemies defined but is a combat/boss room.
     *
     * @param {object} room - room with `.encounters` (parsed enemies JSON)
     * @param {number} partyLevel - character/party level for fallback + scaling
     * @param {string} difficulty - dungeon difficulty
     * @returns {Promise<object[]>} array of enemy snapshots:
     *   { name, hp, maxHp, ac, defense, damage, attackBonus, initiative, xp, gold, isBoss }
     */
    static async buildRoomEnemies(room, partyLevel = 1, difficulty = 'normal') {
        const diffMod = DIFFICULTY_MODIFIERS[difficulty] || DIFFICULTY_MODIFIERS.normal;
        const raw = room.encounters || [];
        const snapshots = [];

        // Resolve a damage value (number) from either a numeric or "NdM+K" string.
        const rollAvgDamage = (dmg) => {
            if (typeof dmg === 'number') return dmg;
            if (typeof dmg === 'string') {
                const r = RPGDiceEngine.roll(dmg);
                return r.total || 1;
            }
            return 1;
        };

        const isBossRoom = room.room_type === 'boss';

        for (const entry of raw) {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                // Inline stat object — may carry a count.
                const count = Math.max(1, Math.ceil((entry.count || 1) * diffMod.enemyMult));
                for (let i = 0; i < count; i++) {
                    const hp = Math.max(1, Math.floor((entry.hp || 20) * diffMod.enemyMult));
                    snapshots.push({
                        name: count > 1 ? `${entry.name} #${i + 1}` : entry.name,
                        hp,
                        maxHp: hp,
                        ac: entry.ac || 12,
                        defense: entry.defense || 0,
                        damage: Math.max(1, Math.floor(rollAvgDamage(entry.damage) * diffMod.enemyMult)),
                        attackBonus: entry.attackBonus || Math.max(2, Math.floor(partyLevel / 2) + 2),
                        initiative: entry.initiative || 10,
                        xp: Math.floor((entry.xp || (entry.is_boss ? 80 : 30)) * diffMod.xpMult),
                        gold: Math.floor((entry.gold || (entry.is_boss ? 25 : 8)) * diffMod.goldMult),
                        isBoss: !!entry.is_boss,
                    });
                }
            } else if (typeof entry === 'string') {
                // Name string — look up the canonical enemy from dnd_enemies.
                const [rows] = await pool.execute(
                    'SELECT * FROM dnd_enemies WHERE enemy_name = ? LIMIT 1',
                    [entry]
                );
                const e = rows[0];
                if (e) {
                    const hp = Math.max(1, Math.floor(e.health * diffMod.enemyMult));
                    snapshots.push({
                        name: e.enemy_name,
                        hp,
                        maxHp: hp,
                        ac: 10 + (e.defense || 0),
                        defense: e.defense || 0,
                        damage: Math.max(1, Math.floor(e.damage * diffMod.enemyMult)),
                        attackBonus: Math.max(2, (e.level || 1) + 1),
                        initiative: 8 + (e.level || 1),
                        xp: Math.floor((e.exp_reward || 25) * diffMod.xpMult),
                        gold: Math.floor((e.gold_reward || 5) * diffMod.goldMult),
                        isBoss: isBossRoom,
                    });
                } else {
                    // Unknown name — synthesize a level-appropriate stand-in.
                    snapshots.push(this._fallbackEnemy(entry, partyLevel, diffMod, isBossRoom));
                }
            }
        }

        // No enemies defined on a combat/boss room — seed a level-appropriate foe.
        if (snapshots.length === 0 && (room.room_type === 'combat' || room.room_type === 'boss')) {
            const [rows] = await pool.execute(
                `SELECT * FROM dnd_enemies
                 WHERE level <= ?
                 ORDER BY level DESC, RAND() LIMIT 1`,
                [Math.max(1, partyLevel)]
            );
            const e = rows[0];
            if (e) {
                const mult = isBossRoom ? diffMod.enemyMult * 1.5 : diffMod.enemyMult;
                const hp = Math.max(1, Math.floor(e.health * mult));
                snapshots.push({
                    name: isBossRoom ? `${e.enemy_name} (Boss)` : e.enemy_name,
                    hp,
                    maxHp: hp,
                    ac: 10 + (e.defense || 0),
                    defense: e.defense || 0,
                    damage: Math.max(1, Math.floor(e.damage * mult)),
                    attackBonus: Math.max(2, (e.level || 1) + 1),
                    initiative: 8 + (e.level || 1),
                    xp: Math.floor((e.exp_reward || 25) * diffMod.xpMult * (isBossRoom ? 2 : 1)),
                    gold: Math.floor((e.gold_reward || 5) * diffMod.goldMult * (isBossRoom ? 2 : 1)),
                    isBoss: isBossRoom,
                });
            } else {
                snapshots.push(this._fallbackEnemy('Lurking Horror', partyLevel, diffMod, isBossRoom));
            }
        }

        return snapshots;
    }

    /** Synthesize a level-appropriate enemy snapshot when no DB row exists. */
    static _fallbackEnemy(name, partyLevel, diffMod, isBoss) {
        const lvl = Math.max(1, partyLevel);
        const bossMult = isBoss ? 1.5 : 1;
        const hp = Math.floor((10 + lvl * 6) * diffMod.enemyMult * bossMult);
        return {
            name: isBoss ? `${name} (Boss)` : name,
            hp,
            maxHp: hp,
            ac: 11 + Math.floor(lvl / 2),
            defense: Math.floor(lvl / 3),
            damage: Math.max(1, Math.floor((3 + lvl) * diffMod.enemyMult * bossMult)),
            attackBonus: Math.max(2, lvl + 1),
            initiative: 8 + lvl,
            xp: Math.floor((20 + lvl * 10) * diffMod.xpMult * bossMult),
            gold: Math.floor((5 + lvl * 3) * diffMod.goldMult * bossMult),
            isBoss,
        };
    }

    /**
     * Resolve a combat/boss room as a REAL auto-fight (reuses the shared
     * auto-combat resolver, which mirrors the verified PvE combat math).
     *
     * On victory: room loot + enemy xp/gold are folded into the run totals and
     * the run advances (or completes). On the character dropping to 0 HP: the
     * run is marked `failed` and the character's HP is persisted.
     *
     * @param {number} runId - active run id
     * @param {object} character - full dnd_characters row
     * @param {object} characterManager - instance for calculateDamage/Defense + reward apply
     * @returns {Promise<object>} result describing the combat + outcome
     */
    static async resolveCombatRoom(runId, character, characterManager) {
        const { run, room, roomType } = await this.getCurrentRoom(runId);
        const difficulty = run.difficulty || 'normal';
        const partyLevel = character.level || 1;

        const enemies = await this.buildRoomEnemies(room, partyLevel, difficulty);

        // Build the player combat snapshot from real character stats + gear.
        const baseDamage = await characterManager.calculateDamage(character.character_id);
        const defense = await characterManager.calculateDefense(character.character_id);
        const dexMod = RPGDiceEngine.getModifier(character.dexterity || 10);
        const strMod = RPGDiceEngine.getModifier(character.strength || 10);
        const profBonus = character.proficiency_bonus || 2;

        const player = {
            name: character.character_name,
            hp: character.health,
            maxHp: character.max_health,
            ac: character.armor_class || (10 + dexMod + defense),
            defense,
            damage: Math.max(1, baseDamage),
            attackBonus: Math.max(strMod, dexMod) + profBonus,
            initiative: (character.initiative || 0) + dexMod + 10,
        };

        const outcome = resolveEncounter(player, enemies, {});

        if (outcome.victory) {
            // Roll room loot (gold + items) on top of the enemy xp/gold.
            const loot = this.generateLoot(room, difficulty);
            const xpGained = outcome.xpEarned;
            const goldGained = outcome.goldEarned + (loot.gold || 0);

            // Persist the character's surviving HP.
            await pool.execute(
                'UPDATE dnd_characters SET health = ? WHERE character_id = ?',
                [Math.max(0, outcome.playerHp), character.character_id]
            );

            // Advance the run (folds xp/gold into totals; completes on last room).
            const advance = await this.completeRoom(runId, { xp: xpGained, gold: goldGained });

            return {
                combat: true,
                victory: true,
                roomType,
                roomName: room.room_name,
                enemies,
                outcome,
                loot,
                xpGained,
                goldGained,
                advance,
            };
        }

        // Defeat: character downed. Persist HP at 0, fail the run.
        await pool.execute(
            'UPDATE dnd_characters SET health = 0, deaths = COALESCE(deaths, 0) + 1 WHERE character_id = ?',
            [character.character_id]
        );
        await this.failRun(runId);

        return {
            combat: true,
            victory: false,
            roomType,
            roomName: room.room_name,
            enemies,
            outcome,
            xpGained: 0,
            goldGained: 0,
        };
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

        // Gold — supports both {min,max} object and [min,max] array shapes.
        if (lootTable.gold) {
            let gMin, gMax;
            if (Array.isArray(lootTable.gold)) {
                [gMin, gMax] = lootTable.gold;
            } else {
                gMin = lootTable.gold.min;
                gMax = lootTable.gold.max;
            }
            gMin = Number(gMin) || 0;
            gMax = Number(gMax) || gMin;
            const baseGold = Math.floor(Math.random() * Math.max(0, gMax - gMin) + gMin);
            loot.gold = Math.floor(baseGold * diffMod.goldMult);
        }

        // Items — supports both string entries ("Health Potion") and
        // {name,type,value,dropChance} objects.
        if (lootTable.items && Array.isArray(lootTable.items)) {
            for (const item of lootTable.items) {
                if (typeof item === 'string') {
                    loot.items.push({ name: item, type: 'misc', value: 0 });
                } else if (item && typeof item === 'object') {
                    if (Math.random() * 100 <= (item.dropChance || 100)) {
                        loot.items.push({
                            name: item.name,
                            type: item.type || 'misc',
                            value: item.value || 0
                        });
                    }
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
