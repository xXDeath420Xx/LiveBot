/**
 * RPG Leaderboard & Achievement Manager
 * Handles rankings, achievements, and statistics
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';

// Achievement categories
const ACHIEVEMENT_CATEGORIES = {
    combat: { name: 'Combat', icon: '⚔️' },
    exploration: { name: 'Exploration', icon: '🗺️' },
    social: { name: 'Social', icon: '🤝' },
    wealth: { name: 'Wealth', icon: '💰' },
    progression: { name: 'Progression', icon: '📈' },
    pvp: { name: 'PvP', icon: '🏆' },
    special: { name: 'Special', icon: '⭐' }
};

// Leaderboard types
// Column names map to the REAL dnd_characters / dnd_pvp_stats schema.
// quests_completed has no counter column on dnd_characters: completions are rows in
// dnd_character_quests (status='completed'), so it is counted there (source: 'completed_quests').
const LEADERBOARD_TYPES = {
    level: { name: 'Level', column: 'level', order: 'DESC' },
    gold: { name: 'Wealth', column: 'gold', order: 'DESC' },
    monsters_killed: { name: 'Monster Slayer', column: 'total_monsters_killed', order: 'DESC' },
    quests_completed: { name: 'Quest Master', source: 'completed_quests', order: 'DESC' },
    dungeons_cleared: { name: 'Dungeon Delver', column: 'dungeons_completed', order: 'DESC' },
    pvp_wins: { name: 'PvP Champion', table: 'dnd_pvp_stats', column: 'wins', order: 'DESC' },
    pvp_elo: { name: 'PvP Rating', table: 'dnd_pvp_stats', column: 'elo_rating', order: 'DESC' },
    total_damage: { name: 'Total Damage', column: 'total_damage_dealt', order: 'DESC' },
    deaths: { name: 'Most Deaths', column: 'deaths', order: 'DESC' } // Funny one
};

// Maps an achievement requirement_type to the real dnd_characters stat column
const REQUIREMENT_STAT_COLUMN = {
    enemies_defeated: 'total_monsters_killed',
    monsters_killed: 'total_monsters_killed',
    dungeons_completed: 'dungeons_completed',
    dungeons_cleared: 'dungeons_completed',
    bosses_killed: 'bosses_killed',
    deaths: 'deaths',
    total_damage_dealt: 'total_damage_dealt',
    total_healing_done: 'total_healing_done',
    crits_rolled: 'crits_rolled',
    level: 'level',
    gold: 'gold',
    total_gold: 'gold',
    // Derived (not dnd_characters columns) - filled in by _loadAchievementStats
    pvp_wins: 'pvp_wins',
    quests_completed: 'quests_completed',
    // Lifetime counters on dnd_characters (migration 428), bumped through trackStat
    gold_earned: 'gold_earned',
    dragons_slain: 'dragons_slain',
    spells_cast: 'spells_cast',
    parties_joined: 'parties_joined',
    // Derived from other tables / columns - filled in by _loadAchievementStats
    deathless_level: 'deathless_level',
    unique_items: 'unique_items',
    zones_visited: 'zones_visited'
};

// Stats that incrementStat may add to (real dnd_characters counter columns)
const INCREMENTABLE_STATS = [
    'total_monsters_killed', 'dungeons_completed', 'bosses_killed',
    'deaths', 'total_damage_dealt', 'total_healing_done',
    'crits_rolled', 'gold', 'level',
    'gold_earned', 'dragons_slain', 'spells_cast', 'parties_joined'
];

// Enemy names that are dragons. In dnd_enemies: Flame Dragon Whelp, Shadow Drake, Ancient Dragon,
// Young Dragon, Wyvern. "Dragon Cultist" and the like are people who serve dragons, not dragons.
const DRAGON_NAME = /\b(dragons?|drakes?|wyrms?|wyverns?|dracolich(es)?)\b/i;
const NOT_A_DRAGON = /\b(cultists?|priests?|worshipp?ers?|riders?|hunters?|slayers?|knights?|eggs?|statues?)\b/i;

// Collects achievements awarded while one RPG command or button runs (see withAchievementNotices).
// Fire-and-forget trackStat / trackAchievements calls started inside it inherit the scope.
const noticeScope = new AsyncLocalStorage();
// How long to wait, after the handler has replied, for its fire-and-forget tracking to finish.
const NOTICE_SETTLE_MS = 5000;

function formatAchievementLine(a) {
    const rewards = [];
    const gold = Number(a.reward_gold) || 0;
    const exp = Number(a.reward_exp) || 0;
    if (gold > 0) rewards.push(`${gold} gold`);
    if (exp > 0) rewards.push(`${exp} XP`);
    const desc = a.description ? ` - ${String(a.description).slice(0, 150)}` : '';
    return `- **${a.name}**${desc}${rewards.length ? ` (reward: ${rewards.join(', ')})` : ''}`;
}

class RPGLeaderboardManager {
    static achievementCache = null;

    /**
     * Load achievements into cache
     */
    static async loadAchievements() {
        if (this.achievementCache) return this.achievementCache;

        const [achievements] = await pool.execute('SELECT * FROM dnd_achievements WHERE is_active = TRUE');
        this.achievementCache = new Map();

        for (const a of achievements) {
            this.achievementCache.set(a.achievement_id, { ...a });
        }

        return this.achievementCache;
    }

    /**
     * Get all achievements
     * @returns {array} All achievements
     */
    static async getAllAchievements() {
        await this.loadAchievements();
        return Array.from(this.achievementCache.values());
    }

    /**
     * Get achievements by category
     * @param {string} category - Achievement category
     * @returns {array} Achievements in category
     */
    static async getAchievementsByCategory(category) {
        await this.loadAchievements();
        return Array.from(this.achievementCache.values())
            .filter(a => a.category === category);
    }

    /**
     * Get character's achievements
     * @param {number} characterId - Character ID
     * @returns {array} Earned achievements
     */
    static async getCharacterAchievements(characterId) {
        const [earned] = await pool.execute(
            `SELECT ca.*, a.name, a.description, a.category, a.icon_emoji,
                    a.reward_gold, a.reward_exp
             FROM dnd_character_achievements ca
             JOIN dnd_achievements a ON ca.achievement_id = a.achievement_id
             WHERE ca.character_id = ? AND ca.completed = TRUE
             ORDER BY ca.completed_at DESC`,
            [characterId]
        );

        return earned;
    }

    /**
     * Award achievement to character
     * @param {number} characterId - Character ID
     * @param {number} achievementId - Achievement ID
     * @returns {object|null} Achievement if newly awarded
     */
    static async awardAchievement(characterId, achievementId) {
        await this.loadAchievements();
        const achievement = this.achievementCache.get(achievementId);

        if (!achievement) {
            throw new Error('Achievement not found');
        }

        // Check if already earned
        const [existing] = await pool.execute(
            'SELECT id FROM dnd_character_achievements WHERE character_id = ? AND achievement_id = ?',
            [characterId, achievementId]
        );

        if (existing.length > 0) {
            return null; // Already has it
        }

        // INSERT IGNORE + affectedRows: two concurrent checks can't double-award
        // (uk_char_achievement) or throw ER_DUP_ENTRY.
        const [ins] = await pool.execute(
            `INSERT IGNORE INTO dnd_character_achievements (character_id, achievement_id, progress, completed, completed_at)
             VALUES (?, ?, ?, TRUE, NOW())`,
            [characterId, achievementId, achievement.requirement_value || 0]
        );
        if (!ins.affectedRows) {
            return null;
        }

        // Pay the reward the achievement lists (28 of 32 give gold, 31 give XP). Until 2026-11-18 these
        // columns were shown in /rpg stats but never paid. XP goes through addExperience so level-ups apply;
        // it is imported lazily because rpg-character-manager imports this file.
        try {
            const gold = Number(achievement.reward_gold) || 0;
            const exp = Number(achievement.reward_exp) || 0;
            if (gold > 0) {
                await pool.execute('UPDATE dnd_characters SET gold = gold + ? WHERE character_id = ?', [gold, characterId]);
                this.trackStat(characterId, 'gold_earned', gold);
            }
            if (exp > 0) {
                const { default: RPGCharacterManager } = await import('./rpg-character-manager.js');
                await new RPGCharacterManager(null).addExperience(characterId, exp);
            }
        } catch (rewardError) {
            logger.error('[Achievements] reward payout failed', { characterId, achievementId, error: rewardError.message });
        }

        logger.info('[Achievements] Awarded achievement', {
            characterId,
            achievement: achievement.name
        });

        // Inside an RPG command/button: queue it for the player's "achievement unlocked" notice
        noticeScope.getStore()?.earned.push({ characterId: Number(characterId), achievement });

        return achievement;
    }

    /**
     * Check and award achievements based on stats
     * @param {number} characterId - Character ID
     * @param {object} stats - Current character stats
     * @returns {array} Newly earned achievements
     */
    static async checkAchievements(characterId, stats) {
        await this.loadAchievements();
        const newAchievements = [];

        for (const [id, achievement] of this.achievementCache) {
            if (this._meetsRequirement(achievement, stats)) {
                const awarded = await this.awardAchievement(characterId, id);
                if (awarded) {
                    newAchievements.push(awarded);
                }
            }
        }

        return newAchievements;
    }

    /**
     * Check if a single-column achievement requirement is met
     * @private
     */
    static _meetsRequirement(achievement, stats) {
        const statColumn = REQUIREMENT_STAT_COLUMN[achievement.requirement_type];
        if (!statColumn) return false;
        const required = Number(achievement.requirement_value) || 0;
        return (Number(stats[statColumn]) || 0) >= required;
    }

    /**
     * Get leaderboard
     * @param {string} guildId - Guild ID
     * @param {string} type - Leaderboard type
     * @param {number} limit - Max results
     * @returns {array} Leaderboard entries
     */
    static async getLeaderboard(guildId, type = 'level', limit = 10) {
        const config = LEADERBOARD_TYPES[type];
        if (!config) {
            throw new Error('Invalid leaderboard type');
        }

        let query;
        if (config.table === 'dnd_pvp_stats') {
            query = `
                SELECT c.user_id, s.${config.column} as value, c.character_name, c.class, c.level
                FROM ${config.table} s
                JOIN dnd_characters c ON s.character_id = c.character_id
                WHERE s.guild_id = ?
                ORDER BY s.${config.column} ${config.order}
                LIMIT ?
            `;
        } else if (config.source === 'completed_quests') {
            query = `
                SELECT c.user_id, COUNT(*) as value, c.character_name, c.class, c.level
                FROM dnd_character_quests cq
                JOIN dnd_characters c ON cq.character_id = c.character_id
                WHERE c.guild_id = ? AND cq.status = 'completed'
                GROUP BY c.character_id, c.user_id, c.character_name, c.class, c.level
                ORDER BY value ${config.order}, c.level DESC
                LIMIT ?
            `;
        } else {
            query = `
                SELECT user_id, ${config.column} as value, character_name, class, level
                FROM dnd_characters
                WHERE guild_id = ?
                ORDER BY ${config.column} ${config.order}
                LIMIT ?
            `;
        }

        const [entries] = await pool.execute(query, [String(guildId), Number(limit)]);

        return entries.map((e, i) => ({
            position: i + 1,
            user_id: e.user_id,
            character_name: e.character_name || 'Unknown',
            class: e.class,
            level: e.level,
            value: e.value,
            medal: i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ''
        }));
    }

    /**
     * Get character's rank on a leaderboard
     * @param {string} guildId - Guild ID
     * @param {number} characterId - Character ID
     * @param {string} type - Leaderboard type
     * @returns {object} Rank info
     */
    static async getCharacterRank(guildId, characterId, type = 'level') {
        const config = LEADERBOARD_TYPES[type];
        if (!config) {
            throw new Error('Invalid leaderboard type');
        }

        // Get character's value
        const [character] = await pool.execute(
            `SELECT ${config.column} as value FROM dnd_characters WHERE character_id = ?`,
            [characterId]
        );

        if (character.length === 0) {
            throw new Error('Character not found');
        }

        const value = character[0].value;

        // Count how many are higher
        const [higherCount] = await pool.execute(
            `SELECT COUNT(*) as count FROM dnd_characters
             WHERE guild_id = ? AND ${config.column} ${config.order === 'DESC' ? '>' : '<'} ?`,
            [guildId, value]
        );

        const rank = higherCount[0].count + 1;

        // Get total count
        const [totalCount] = await pool.execute(
            'SELECT COUNT(*) as count FROM dnd_characters WHERE guild_id = ?',
            [guildId]
        );

        return {
            rank,
            total: totalCount[0].count,
            value,
            leaderboard: config.name
        };
    }

    /**
     * Get global stats for a guild
     * @param {string} guildId - Guild ID
     * @returns {object} Guild stats
     */
    static async getGuildStats(guildId) {
        const [stats] = await pool.execute(`
            SELECT
                COUNT(*) as total_characters,
                SUM(level) as total_levels,
                AVG(level) as avg_level,
                MAX(level) as max_level,
                SUM(gold) as total_gold,
                SUM(total_monsters_killed) as total_monsters_killed,
                SUM(dungeons_completed) as total_dungeons,
                SUM(deaths) as total_deaths
            FROM dnd_characters
            WHERE guild_id = ?
        `, [guildId]);

        const [pvpStats] = await pool.execute(`
            SELECT
                COUNT(*) as pvp_players,
                SUM(wins + losses + draws) as total_matches,
                AVG(elo_rating) as avg_elo
            FROM dnd_pvp_stats
            WHERE guild_id = ?
        `, [guildId]);

        const [classDistribution] = await pool.execute(`
            SELECT class, COUNT(*) as count
            FROM dnd_characters
            WHERE guild_id = ?
            GROUP BY class
            ORDER BY count DESC
        `, [guildId]);

        return {
            characters: stats[0],
            pvp: pvpStats[0],
            classDistribution
        };
    }

    /**
     * Record stat increment (for tracking)
     * @param {number} characterId - Character ID
     * @param {string} stat - Stat name
     * @param {number} amount - Amount to add
     */
    static async incrementStat(characterId, stat, amount = 1) {
        if (!INCREMENTABLE_STATS.includes(stat)) {
            throw new Error('Invalid stat name');
        }

        await pool.execute(
            `UPDATE dnd_characters SET ${stat} = COALESCE(${stat}, 0) + ? WHERE character_id = ?`,
            [amount, characterId]
        );

        // Check for new achievements
        return this.recheckAchievements(characterId);
    }

    /**
     * Load the stats achievements are measured against: the dnd_characters row
     * plus derived counters that live in other tables (PvP wins, completed quests).
     * @private
     */
    static async _loadAchievementStats(characterId) {
        const [character] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );
        if (character.length === 0) return null;

        const stats = { ...character[0] };

        const [pvp] = await pool.execute(
            'SELECT COALESCE(SUM(wins), 0) AS wins FROM dnd_pvp_stats WHERE character_id = ?',
            [characterId]
        );
        stats.pvp_wins = Number(pvp[0]?.wins) || 0;

        const [quests] = await pool.execute(
            `SELECT COUNT(*) AS n FROM dnd_character_quests WHERE character_id = ? AND status = 'completed'`,
            [characterId]
        );
        stats.quests_completed = Number(quests[0]?.n) || 0;

        // "Reach level N without dying": the character's level for as long as it has never died.
        // dnd_characters.deaths counts every death (combat defeat, dungeon defeat, 3 failed death
        // saves, exhaustion level 6, AI DM character death); the first one ends the run for good.
        stats.deathless_level = (Number(stats.deaths) || 0) === 0 ? (Number(stats.level) || 0) : 0;

        // Distinct items owned right now (a stack of 5 potions is one item)
        const [items] = await pool.execute(
            'SELECT COUNT(DISTINCT item_id) AS n FROM dnd_inventory WHERE character_id = ? AND quantity > 0',
            [characterId]
        );
        stats.unique_items = Number(items[0]?.n) || 0;

        // World zones reached (dnd_zone_discoveries, written when the character moves). Free-text
        // places the DM invents are not zones. The safe hub (danger 0, Town Square) is where every
        // character starts, so "visit every zone" means every zone outside it (10 today).
        const [zones] = await pool.execute(
            `SELECT COUNT(DISTINCT d.zone_id) AS n
               FROM dnd_zone_discoveries d
               JOIN dnd_zones z ON z.zone_id = d.zone_id
              WHERE d.character_id = ? AND z.danger_level > 0`,
            [characterId]
        );
        stats.zones_visited = Number(zones[0]?.n) || 0;

        return stats;
    }

    /**
     * Re-evaluate all achievements for a character against current stats.
     * @param {number} characterId - Character ID
     * @returns {array} Newly earned achievements
     */
    static async recheckAchievements(characterId) {
        const stats = await this._loadAchievementStats(characterId);
        if (!stats) return [];
        return this.checkAchievements(characterId, stats);
    }

    /**
     * Fire-and-forget stat increment for gameplay outcome points. A stats or
     * achievement failure is logged and never propagates into gameplay.
     * @param {number} characterId - Character ID
     * @param {string} stat - Stat column (see INCREMENTABLE_STATS)
     * @param {number} amount - Amount to add (non-positive amounts are skipped)
     */
    static trackStat(characterId, stat, amount = 1) {
        const n = Number(amount);
        if (!characterId || !Number.isFinite(n) || n <= 0) return;
        this._holdForNotice(this.incrementStat(characterId, stat, Math.floor(n))
            .then(earned => this._logEarned(characterId, earned))
            .catch(err => logger.error('[Achievements] Stat tracking failed', { characterId, stat, amount, error: err.message })));
    }

    /**
     * Fire-and-forget achievement re-check (level-up, PvP win, quest completion,
     * gold changes - outcomes whose stat is not a counter incremented here).
     * @param {number} characterId - Character ID
     */
    static trackAchievements(characterId) {
        if (!characterId) return;
        this._holdForNotice(this.recheckAchievements(characterId)
            .then(earned => this._logEarned(characterId, earned))
            .catch(err => logger.error('[Achievements] Achievement check failed', { characterId, error: err.message })));
    }

    /**
     * True when an enemy name is a dragon (Ancient Dragon, Shadow Drake, Wyvern ...).
     * @param {string} name - Enemy name (dnd_enemies.enemy_name or a dungeon snapshot name)
     */
    static isDragon(name) {
        const s = String(name || '');
        return DRAGON_NAME.test(s) && !NOT_A_DRAGON.test(s);
    }

    /**
     * Count a slain enemy toward Dragonslayer when it is a dragon (fire-and-forget).
     * @param {number} characterId - Character ID
     * @param {string} enemyName - Name of the enemy that was killed
     */
    static trackKill(characterId, enemyName) {
        if (this.isDragon(enemyName)) this.trackStat(characterId, 'dragons_slain', 1);
    }

    /**
     * Run an RPG command or button handler, then tell the player about achievements their own
     * characters earned while it ran: one ephemeral follow-up, so the shared channel gets nothing
     * extra and every subcommand is covered without touching its reply. Achievements earned by
     * other players' characters in the same action (PvP opponent, party members) or by background
     * work are not announced here; they are in the database and show in /rpg stats.
     * @param {import('discord.js').Interaction} interaction
     * @param {Function} fn - The handler to run
     */
    static async withAchievementNotices(interaction, fn) {
        if (noticeScope.getStore()) return fn();
        const store = { earned: [], pending: new Set() };
        try {
            return await noticeScope.run(store, fn);
        } finally {
            await this._sendAchievementNotices(interaction, store).catch(err =>
                logger.warn('[Achievements] Could not send achievement notice', { error: err.message }));
        }
    }

    /** @private Keep a fire-and-forget tracking promise visible to the open notice scope. */
    static _holdForNotice(promise) {
        const store = noticeScope.getStore();
        if (store) {
            store.pending.add(promise);
            promise.finally(() => store.pending.delete(promise));
        }
        return promise;
    }

    /** @private */
    static async _sendAchievementNotices(interaction, store) {
        // Let the handler's fire-and-forget tracking settle (it can chain: a reward's XP levels the
        // character up, which re-checks again). Bounded so a slow DB never holds the interaction.
        const deadline = Date.now() + NOTICE_SETTLE_MS;
        while (store.pending.size > 0 && Date.now() < deadline) {
            let timer;
            await Promise.race([
                Promise.allSettled([...store.pending]),
                new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })
            ]);
            clearTimeout(timer);
        }
        if (store.earned.length === 0) return;
        if (!interaction?.user || !(interaction.replied || interaction.deferred)) return;

        const ids = [...new Set(store.earned.map(e => e.characterId))];
        const [rows] = await pool.query(
            'SELECT character_id, user_id FROM dnd_characters WHERE character_id IN (?)',
            [ids]
        );
        const mine = new Set(rows
            .filter(r => String(r.user_id) === String(interaction.user.id))
            .map(r => Number(r.character_id)));
        const lines = store.earned
            .filter(e => mine.has(e.characterId))
            .map(e => formatAchievementLine(e.achievement));
        if (lines.length === 0) return;

        const shown = lines.slice(0, 10);
        if (lines.length > shown.length) shown.push(`...and ${lines.length - shown.length} more - see /rpg stats.`);
        const header = lines.length === 1 ? 'Achievement unlocked:' : 'Achievements unlocked:';
        const content = `${header}\n${shown.join('\n')}`.slice(0, 2000);
        await interaction.followUp({ content, ephemeral: true });
    }

    /** @private */
    static _logEarned(characterId, earned) {
        if (Array.isArray(earned) && earned.length > 0) {
            logger.info('[Achievements] Newly earned', { characterId, achievements: earned.map(a => a.name) });
        }
    }

    /**
     * Get achievement progress
     * @param {number} characterId - Character ID
     * @returns {array} Achievement progress
     */
    static async getAchievementProgress(characterId) {
        await this.loadAchievements();

        const stats = await this._loadAchievementStats(characterId);

        if (!stats) {
            throw new Error('Character not found');
        }

        const earned = await this.getCharacterAchievements(characterId);
        const earnedIds = new Set(earned.map(e => e.achievement_id));

        const progress = [];

        for (const [id, achievement] of this.achievementCache) {
            if (earnedIds.has(id)) continue;

            const statColumn = REQUIREMENT_STAT_COLUMN[achievement.requirement_type];
            const required = Number(achievement.requirement_value) || 0;
            if (!statColumn || required <= 0) continue;

            const current = Math.min(Number(stats[statColumn]) || 0, required);

            progress.push({
                ...achievement,
                current,
                required,
                percentage: Math.floor((current / required) * 100)
            });
        }

        return progress.sort((a, b) => b.percentage - a.percentage);
    }

}

export default RPGLeaderboardManager;
export { RPGLeaderboardManager, ACHIEVEMENT_CATEGORIES, LEADERBOARD_TYPES };
