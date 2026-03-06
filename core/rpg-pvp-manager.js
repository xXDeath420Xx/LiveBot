/**
 * RPG PvP Manager
 * Handles player vs player dueling with ELO rankings
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import { RPGDiceEngine } from './rpg-dice-engine.js';

// ELO constants
const ELO_K_FACTOR = 32; // Standard K-factor
const ELO_DEFAULT = 1000;

// Match types
const MATCH_TYPES = {
    duel: {
        name: 'Duel',
        description: '1v1 combat to the death (or surrender)',
        minPlayers: 2,
        maxPlayers: 2,
        ranked: true
    },
    tournament: {
        name: 'Tournament',
        description: 'Bracket-style elimination',
        minPlayers: 4,
        maxPlayers: 16,
        ranked: true
    },
    arena: {
        name: 'Arena',
        description: 'Free-for-all combat',
        minPlayers: 3,
        maxPlayers: 8,
        ranked: false
    },
    team: {
        name: 'Team Battle',
        description: 'Team vs Team combat',
        minPlayers: 4,
        maxPlayers: 8,
        ranked: true
    }
};

// Arena modifiers
const ARENA_MODIFIERS = {
    standard: { name: 'Standard Arena', effects: {} },
    lava: { name: 'Lava Pit', effects: { envDamage: '1d6 fire', trigger: 'end_turn' } },
    ice: { name: 'Frozen Tundra', effects: { movePenalty: -10, dexSave: 12 } },
    darkness: { name: 'Shadow Realm', effects: { disadvantage: 'ranged', blindsight: true } },
    wind: { name: 'Stormy Peak', effects: { rangedPenalty: -2, pushChance: 0.2 } }
};

class RPGPvPManager {
    /**
     * Create a PvP match
     * @param {string} guildId - Guild ID
     * @param {string} challengerId - Challenger user ID
     * @param {number} challengerCharacterId - Challenger character
     * @param {string} matchType - Match type
     * @param {string} arena - Arena type
     * @returns {object} Match info
     */
    static async createMatch(guildId, challengerId, challengerCharacterId, matchType = 'duel', arena = 'standard') {
        const matchConfig = MATCH_TYPES[matchType];
        if (!matchConfig) {
            throw new Error('Invalid match type');
        }

        const arenaConfig = ARENA_MODIFIERS[arena];
        if (!arenaConfig) {
            throw new Error('Invalid arena');
        }

        const [result] = await pool.execute(
            `INSERT INTO dnd_pvp_matches
             (guild_id, match_type, arena_type, challenger_user_id, challenger_character_id, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [guildId, matchType, arena, challengerId, challengerCharacterId]
        );

        logger.info('[PvP] Match created', { matchId: result.insertId, matchType, arena });

        return {
            match_id: result.insertId,
            match_type: matchType,
            arena: arenaConfig.name,
            status: 'pending',
            config: matchConfig,
            arenaEffects: arenaConfig.effects
        };
    }

    /**
     * Accept a match challenge
     * @param {number} matchId - Match ID
     * @param {string} defenderId - Defender user ID
     * @param {number} defenderCharacterId - Defender character
     * @returns {object} Updated match
     */
    static async acceptMatch(matchId, defenderId, defenderCharacterId) {
        const [matches] = await pool.execute(
            'SELECT * FROM dnd_pvp_matches WHERE match_id = ? AND status = ?',
            [matchId, 'pending']
        );

        if (matches.length === 0) {
            throw new Error('Match not found or already started');
        }

        const match = matches[0];

        if (match.challenger_user_id === defenderId) {
            throw new Error('You cannot accept your own challenge');
        }

        await pool.execute(
            `UPDATE dnd_pvp_matches
             SET defender_user_id = ?, defender_character_id = ?, status = 'active', started_at = NOW()
             WHERE match_id = ?`,
            [defenderId, defenderCharacterId, matchId]
        );

        // Initialize combat state
        const combatState = {
            turn: 1,
            currentTurn: 'challenger', // Will be determined by initiative
            actions: []
        };

        await pool.execute(
            'UPDATE dnd_pvp_matches SET combat_state = ? WHERE match_id = ?',
            [JSON.stringify(combatState), matchId]
        );

        return {
            match_id: matchId,
            status: 'active',
            challenger_character_id: match.challenger_character_id,
            defender_character_id: defenderCharacterId
        };
    }

    /**
     * Decline a match
     * @param {number} matchId - Match ID
     * @param {string} userId - User declining
     */
    static async declineMatch(matchId, userId) {
        const [matches] = await pool.execute(
            'SELECT * FROM dnd_pvp_matches WHERE match_id = ? AND status = ?',
            [matchId, 'pending']
        );

        if (matches.length === 0) {
            throw new Error('Match not found');
        }

        await pool.execute(
            'UPDATE dnd_pvp_matches SET status = ? WHERE match_id = ?',
            ['declined', matchId]
        );
    }

    /**
     * Get match details
     * @param {number} matchId - Match ID
     * @returns {object} Match details
     */
    static async getMatch(matchId) {
        const [matches] = await pool.execute(
            `SELECT m.*,
                    c1.character_name as challenger_name, c1.class as challenger_class, c1.level as challenger_level,
                    c2.character_name as defender_name, c2.class as defender_class, c2.level as defender_level
             FROM dnd_pvp_matches m
             LEFT JOIN dnd_characters c1 ON m.challenger_character_id = c1.character_id
             LEFT JOIN dnd_characters c2 ON m.defender_character_id = c2.character_id
             WHERE m.match_id = ?`,
            [matchId]
        );

        if (matches.length === 0) return null;

        const match = matches[0];
        match.combat_state = typeof match.combat_state === 'string' ? JSON.parse(match.combat_state) : match.combat_state;

        return match;
    }

    /**
     * End a match with a winner
     * @param {number} matchId - Match ID
     * @param {string} winnerUserId - Winner's user ID
     * @param {string} method - How match ended (ko, surrender, timeout)
     * @returns {object} Match result with ELO changes
     */
    static async endMatch(matchId, winnerUserId, method = 'ko') {
        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('Match not found or not active');
        }

        const loserUserId = winnerUserId === match.challenger_user_id
            ? match.defender_user_id
            : match.challenger_user_id;

        // Calculate ELO changes for ranked matches
        let winnerEloChange = 0;
        let loserEloChange = 0;

        const matchConfig = MATCH_TYPES[match.match_type];
        if (matchConfig?.ranked) {
            const eloChanges = await this._calculateEloChange(winnerUserId, loserUserId, match.guild_id);
            winnerEloChange = eloChanges.winner;
            loserEloChange = eloChanges.loser;

            // Update ELO ratings
            await this._updateElo(winnerUserId, match.guild_id, winnerEloChange, true);
            await this._updateElo(loserUserId, match.guild_id, loserEloChange, false);
        }

        // Update match
        await pool.execute(
            `UPDATE dnd_pvp_matches
             SET status = 'completed', winner_user_id = ?, end_method = ?, ended_at = NOW()
             WHERE match_id = ?`,
            [winnerUserId, method, matchId]
        );

        logger.info('[PvP] Match ended', { matchId, winner: winnerUserId, method });

        return {
            match_id: matchId,
            winner_user_id: winnerUserId,
            loser_user_id: loserUserId,
            method,
            elo_changes: {
                winner: winnerEloChange,
                loser: loserEloChange
            }
        };
    }

    /**
     * Calculate ELO change
     * @private
     */
    static async _calculateEloChange(winnerId, loserId, guildId) {
        const [winnerStats] = await pool.execute(
            'SELECT elo_rating FROM dnd_pvp_stats WHERE user_id = ? AND guild_id = ?',
            [winnerId, guildId]
        );

        const [loserStats] = await pool.execute(
            'SELECT elo_rating FROM dnd_pvp_stats WHERE user_id = ? AND guild_id = ?',
            [loserId, guildId]
        );

        const winnerElo = winnerStats[0]?.elo_rating || ELO_DEFAULT;
        const loserElo = loserStats[0]?.elo_rating || ELO_DEFAULT;

        // ELO calculation
        const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
        const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));

        const winnerChange = Math.round(ELO_K_FACTOR * (1 - expectedWinner));
        const loserChange = Math.round(ELO_K_FACTOR * (0 - expectedLoser));

        return {
            winner: winnerChange,
            loser: loserChange
        };
    }

    /**
     * Update player ELO
     * @private
     */
    static async _updateElo(userId, guildId, change, isWin) {
        const [existing] = await pool.execute(
            'SELECT * FROM dnd_pvp_stats WHERE user_id = ? AND guild_id = ?',
            [userId, guildId]
        );

        if (existing.length === 0) {
            // Create stats record
            await pool.execute(
                `INSERT INTO dnd_pvp_stats
                 (user_id, guild_id, elo_rating, wins, losses, matches_played)
                 VALUES (?, ?, ?, ?, ?, 1)`,
                [userId, guildId, ELO_DEFAULT + change, isWin ? 1 : 0, isWin ? 0 : 1]
            );
        } else {
            await pool.execute(
                `UPDATE dnd_pvp_stats
                 SET elo_rating = GREATEST(100, elo_rating + ?),
                     wins = wins + ?,
                     losses = losses + ?,
                     matches_played = matches_played + 1,
                     ${isWin ? 'current_streak = current_streak + 1, best_streak = GREATEST(best_streak, current_streak + 1)' : 'current_streak = 0'}
                 WHERE user_id = ? AND guild_id = ?`,
                [change, isWin ? 1 : 0, isWin ? 0 : 1, userId, guildId]
            );
        }
    }

    /**
     * Get player PvP stats
     * @param {string} userId - User ID
     * @param {string} guildId - Guild ID
     * @returns {object} Stats
     */
    static async getPlayerStats(userId, guildId) {
        const [stats] = await pool.execute(
            'SELECT * FROM dnd_pvp_stats WHERE user_id = ? AND guild_id = ?',
            [userId, guildId]
        );

        if (stats.length === 0) {
            return {
                user_id: userId,
                elo_rating: ELO_DEFAULT,
                wins: 0,
                losses: 0,
                matches_played: 0,
                current_streak: 0,
                best_streak: 0,
                rank: 'Unranked'
            };
        }

        const playerStats = stats[0];
        playerStats.rank = this._getRank(playerStats.elo_rating);
        playerStats.winRate = playerStats.matches_played > 0
            ? ((playerStats.wins / playerStats.matches_played) * 100).toFixed(1)
            : 0;

        return playerStats;
    }

    /**
     * Get rank from ELO
     * @private
     */
    static _getRank(elo) {
        if (elo >= 2000) return '🏆 Grandmaster';
        if (elo >= 1800) return '💎 Diamond';
        if (elo >= 1600) return '🥇 Platinum';
        if (elo >= 1400) return '🥈 Gold';
        if (elo >= 1200) return '🥉 Silver';
        if (elo >= 1000) return '⚔️ Bronze';
        return '🗡️ Iron';
    }

    /**
     * Get PvP leaderboard
     * @param {string} guildId - Guild ID
     * @param {number} limit - Max results
     * @returns {array} Leaderboard
     */
    static async getLeaderboard(guildId, limit = 10) {
        const [players] = await pool.execute(
            `SELECT s.*, c.character_name
             FROM dnd_pvp_stats s
             LEFT JOIN dnd_characters c ON s.user_id = c.user_id AND c.guild_id = s.guild_id AND c.is_active = TRUE
             WHERE s.guild_id = ?
             ORDER BY s.elo_rating DESC
             LIMIT ?`,
            [guildId, limit]
        );

        return players.map((p, i) => ({
            ...p,
            position: i + 1,
            rank: this._getRank(p.elo_rating)
        }));
    }

    /**
     * Get pending matches for a user
     * @param {string} userId - User ID
     * @param {string} guildId - Guild ID
     * @returns {array} Pending matches
     */
    static async getPendingMatches(userId, guildId) {
        const [matches] = await pool.execute(
            `SELECT m.*, c.character_name as challenger_name
             FROM dnd_pvp_matches m
             JOIN dnd_characters c ON m.challenger_character_id = c.character_id
             WHERE m.guild_id = ? AND m.status = 'pending'
             AND m.challenger_user_id != ?
             ORDER BY m.created_at DESC`,
            [guildId, userId]
        );

        return matches;
    }

    /**
     * Get active match for user
     * @param {string} userId - User ID
     * @param {string} guildId - Guild ID
     * @returns {object|null} Active match
     */
    static async getActiveMatch(userId, guildId) {
        const [matches] = await pool.execute(
            `SELECT * FROM dnd_pvp_matches
             WHERE guild_id = ? AND status = 'active'
             AND (challenger_user_id = ? OR defender_user_id = ?)`,
            [guildId, userId, userId]
        );

        return matches.length > 0 ? this.getMatch(matches[0].match_id) : null;
    }

    /**
     * Get recent matches for user
     * @param {string} userId - User ID
     * @param {string} guildId - Guild ID
     * @param {number} limit - Max results
     * @returns {array} Recent matches
     */
    static async getMatchHistory(userId, guildId, limit = 10) {
        const [matches] = await pool.execute(
            `SELECT m.*,
                    c1.character_name as challenger_name,
                    c2.character_name as defender_name
             FROM dnd_pvp_matches m
             LEFT JOIN dnd_characters c1 ON m.challenger_character_id = c1.character_id
             LEFT JOIN dnd_characters c2 ON m.defender_character_id = c2.character_id
             WHERE m.guild_id = ? AND m.status = 'completed'
             AND (m.challenger_user_id = ? OR m.defender_user_id = ?)
             ORDER BY m.ended_at DESC
             LIMIT ?`,
            [guildId, userId, userId, limit]
        );

        return matches.map(m => ({
            ...m,
            won: m.winner_user_id === userId,
            opponent: m.challenger_user_id === userId ? m.defender_name : m.challenger_name
        }));
    }

    /**
     * Forfeit an active match
     * @param {number} matchId - Match ID
     * @param {string} forfeitingUserId - User forfeiting
     */
    static async forfeit(matchId, forfeitingUserId) {
        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('No active match found');
        }

        const winnerId = forfeitingUserId === match.challenger_user_id
            ? match.defender_user_id
            : match.challenger_user_id;

        return this.endMatch(matchId, winnerId, 'surrender');
    }
}

export default RPGPvPManager;
export { RPGPvPManager, MATCH_TYPES, ARENA_MODIFIERS, ELO_DEFAULT };
