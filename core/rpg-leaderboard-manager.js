/**
 * RPG Leaderboard & Achievement Manager
 * Handles rankings, achievements, and statistics
 */

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
const LEADERBOARD_TYPES = {
    level: { name: 'Level', column: 'level', order: 'DESC' },
    gold: { name: 'Wealth', column: 'gold', order: 'DESC' },
    monsters_killed: { name: 'Monster Slayer', column: 'monsters_killed', order: 'DESC' },
    quests_completed: { name: 'Quest Master', column: 'quests_completed', order: 'DESC' },
    dungeons_cleared: { name: 'Dungeon Delver', column: 'dungeons_cleared', order: 'DESC' },
    pvp_wins: { name: 'PvP Champion', column: 'pvp_wins', order: 'DESC' },
    pvp_elo: { name: 'PvP Rating', table: 'dnd_pvp_stats', column: 'elo_rating', order: 'DESC' },
    total_damage: { name: 'Total Damage', column: 'total_damage_dealt', order: 'DESC' },
    deaths: { name: 'Most Deaths', column: 'deaths', order: 'DESC' }, // Funny one
    playtime: { name: 'Most Active', column: 'total_playtime', order: 'DESC' }
};

class RPGLeaderboardManager {
    static achievementCache = null;

    /**
     * Load achievements into cache
     */
    static async loadAchievements() {
        if (this.achievementCache) return this.achievementCache;

        const [achievements] = await pool.execute('SELECT * FROM dnd_achievements');
        this.achievementCache = new Map();

        for (const a of achievements) {
            this.achievementCache.set(a.achievement_id, {
                ...a,
                requirements: typeof a.requirements === 'string' ? JSON.parse(a.requirements) : a.requirements
            });
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
            `SELECT ca.*, a.achievement_name, a.description, a.category, a.icon_emoji, a.points
             FROM dnd_character_achievements ca
             JOIN dnd_achievements a ON ca.achievement_id = a.achievement_id
             WHERE ca.character_id = ?
             ORDER BY ca.earned_at DESC`,
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

        await pool.execute(
            'INSERT INTO dnd_character_achievements (character_id, achievement_id) VALUES (?, ?)',
            [characterId, achievementId]
        );

        logger.info('[Achievements] Awarded achievement', {
            characterId,
            achievement: achievement.achievement_name
        });

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
            if (!achievement.requirements) continue;

            const earned = this._checkRequirements(achievement.requirements, stats);
            if (earned) {
                const awarded = await this.awardAchievement(characterId, id);
                if (awarded) {
                    newAchievements.push(awarded);
                }
            }
        }

        return newAchievements;
    }

    /**
     * Check if requirements are met
     * @private
     */
    static _checkRequirements(requirements, stats) {
        for (const [key, value] of Object.entries(requirements)) {
            if (typeof value === 'number') {
                if ((stats[key] || 0) < value) return false;
            } else if (typeof value === 'boolean') {
                if (stats[key] !== value) return false;
            } else if (typeof value === 'string') {
                if (stats[key] !== value) return false;
            }
        }
        return true;
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
                SELECT s.user_id, s.${config.column} as value, c.character_name, c.class, c.level
                FROM ${config.table} s
                LEFT JOIN dnd_characters c ON s.user_id = c.user_id AND c.guild_id = s.guild_id AND c.is_active = TRUE
                WHERE s.guild_id = ?
                ORDER BY s.${config.column} ${config.order}
                LIMIT ?
            `;
        } else {
            query = `
                SELECT user_id, ${config.column} as value, character_name, class, level
                FROM dnd_characters
                WHERE guild_id = ? AND is_active = TRUE
                ORDER BY ${config.column} ${config.order}
                LIMIT ?
            `;
        }

        const [entries] = await pool.execute(query, [guildId, limit]);

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
             WHERE guild_id = ? AND is_active = TRUE AND ${config.column} ${config.order === 'DESC' ? '>' : '<'} ?`,
            [guildId, value]
        );

        const rank = higherCount[0].count + 1;

        // Get total count
        const [totalCount] = await pool.execute(
            'SELECT COUNT(*) as count FROM dnd_characters WHERE guild_id = ? AND is_active = TRUE',
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
                SUM(monsters_killed) as total_monsters_killed,
                SUM(quests_completed) as total_quests,
                SUM(dungeons_cleared) as total_dungeons,
                SUM(deaths) as total_deaths
            FROM dnd_characters
            WHERE guild_id = ? AND is_active = TRUE
        `, [guildId]);

        const [pvpStats] = await pool.execute(`
            SELECT
                COUNT(*) as pvp_players,
                SUM(matches_played) as total_matches,
                AVG(elo_rating) as avg_elo
            FROM dnd_pvp_stats
            WHERE guild_id = ?
        `, [guildId]);

        const [classDistribution] = await pool.execute(`
            SELECT class, COUNT(*) as count
            FROM dnd_characters
            WHERE guild_id = ? AND is_active = TRUE
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
        const validStats = [
            'monsters_killed', 'quests_completed', 'dungeons_cleared',
            'deaths', 'total_damage_dealt', 'total_healing_done',
            'critical_hits', 'gold_earned', 'gold_spent',
            'items_found', 'spells_cast', 'pvp_wins', 'pvp_losses'
        ];

        if (!validStats.includes(stat)) {
            throw new Error('Invalid stat name');
        }

        await pool.execute(
            `UPDATE dnd_characters SET ${stat} = ${stat} + ? WHERE character_id = ?`,
            [amount, characterId]
        );

        // Check for new achievements
        const [character] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (character.length > 0) {
            return this.checkAchievements(characterId, character[0]);
        }

        return [];
    }

    /**
     * Get achievement progress
     * @param {number} characterId - Character ID
     * @returns {array} Achievement progress
     */
    static async getAchievementProgress(characterId) {
        await this.loadAchievements();

        const [character] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );

        if (character.length === 0) {
            throw new Error('Character not found');
        }

        const stats = character[0];
        const earned = await this.getCharacterAchievements(characterId);
        const earnedIds = new Set(earned.map(e => e.achievement_id));

        const progress = [];

        for (const [id, achievement] of this.achievementCache) {
            if (earnedIds.has(id)) continue;

            const req = achievement.requirements || {};
            let currentProgress = 0;
            let maxProgress = 0;

            for (const [key, value] of Object.entries(req)) {
                if (typeof value === 'number') {
                    currentProgress += Math.min(stats[key] || 0, value);
                    maxProgress += value;
                }
            }

            if (maxProgress > 0) {
                progress.push({
                    ...achievement,
                    current: currentProgress,
                    required: maxProgress,
                    percentage: Math.floor((currentProgress / maxProgress) * 100)
                });
            }
        }

        return progress.sort((a, b) => b.percentage - a.percentage);
    }

    /**
     * Get total achievement points for character
     * @param {number} characterId - Character ID
     * @returns {number} Total points
     */
    static async getAchievementPoints(characterId) {
        const [result] = await pool.execute(
            `SELECT SUM(a.points) as total
             FROM dnd_character_achievements ca
             JOIN dnd_achievements a ON ca.achievement_id = a.achievement_id
             WHERE ca.character_id = ?`,
            [characterId]
        );

        return result[0]?.total || 0;
    }
}

export default RPGLeaderboardManager;
export { RPGLeaderboardManager, ACHIEVEMENT_CATEGORIES, LEADERBOARD_TYPES };
