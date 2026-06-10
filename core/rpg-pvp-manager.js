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
    static async createMatch(guildId, challenger, defender, matchType = 'duel', wagerGold = 0) {
        // challenger/defender: { userId, characterId }
        // dnd_pvp_matches requires BOTH sides (NOT NULL), so this is a direct challenge.
        const validTypes = ['duel', 'ranked', 'tournament'];
        if (!validTypes.includes(matchType)) {
            throw new Error('Invalid match type');
        }

        if (challenger.characterId === defender.characterId) {
            throw new Error('You cannot challenge yourself');
        }

        const [result] = await pool.execute(
            `INSERT INTO dnd_pvp_matches
             (guild_id, challenger_id, defender_id, challenger_user_id, defender_user_id, match_type, wager_gold, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [guildId, challenger.characterId, defender.characterId, challenger.userId, defender.userId, matchType, wagerGold || 0]
        );

        logger.info('[PvP] Match created', { matchId: result.insertId, matchType });

        return {
            match_id: result.insertId,
            match_type: matchType,
            wager_gold: wagerGold || 0,
            status: 'pending'
        };
    }

    /**
     * Accept a match challenge
     * @param {number} matchId - Match ID
     * @param {string} defenderId - Defender user ID
     * @param {number} defenderCharacterId - Defender character
     * @returns {object} Updated match
     */
    static async acceptMatch(matchId, defenderUserId) {
        const [matches] = await pool.execute(
            'SELECT * FROM dnd_pvp_matches WHERE match_id = ? AND status = ?',
            [matchId, 'pending']
        );

        if (matches.length === 0) {
            throw new Error('Match not found or already started');
        }

        const match = matches[0];

        if (match.defender_user_id !== defenderUserId) {
            throw new Error('This challenge was not issued to you');
        }

        await pool.execute(
            `UPDATE dnd_pvp_matches
             SET status = 'active', started_at = NOW()
             WHERE match_id = ?`,
            [matchId]
        );

        return {
            match_id: matchId,
            status: 'active',
            challenger_id: match.challenger_id,
            defender_id: match.defender_id
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
             LEFT JOIN dnd_characters c1 ON m.challenger_id = c1.character_id
             LEFT JOIN dnd_characters c2 ON m.defender_id = c2.character_id
             WHERE m.match_id = ?`,
            [matchId]
        );

        if (matches.length === 0) return null;

        return matches[0];
    }

    /**
     * End a match with a winner
     * @param {number} matchId - Match ID
     * @param {string} winnerUserId - Winner's user ID
     * @param {string} method - How match ended (ko, surrender, timeout)
     * @returns {object} Match result with ELO changes
     */
    static async endMatch(matchId, winnerCharacterId, method = 'ko') {
        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('Match not found or not active');
        }

        if (![match.challenger_id, match.defender_id].includes(winnerCharacterId)) {
            throw new Error('Winner is not a participant of this match');
        }

        const loserCharacterId = winnerCharacterId === match.challenger_id
            ? match.defender_id
            : match.challenger_id;

        // ELO for ranked matches (duel + ranked are rated; tournament too)
        let winnerEloChange = 0;
        let loserEloChange = 0;

        const isRanked = ['duel', 'ranked', 'tournament'].includes(match.match_type);
        if (isRanked) {
            const eloChanges = await this._calculateEloChange(winnerCharacterId, loserCharacterId, match.guild_id);
            winnerEloChange = eloChanges.winner;
            loserEloChange = eloChanges.loser;

            await this._updateElo(winnerCharacterId, match.guild_id, winnerEloChange, true);
            await this._updateElo(loserCharacterId, match.guild_id, loserEloChange, false);
        }

        // Handle wager transfer
        if (match.wager_gold && match.wager_gold > 0) {
            await pool.execute('UPDATE dnd_characters SET gold = gold + ? WHERE character_id = ?', [match.wager_gold, winnerCharacterId]);
            await pool.execute('UPDATE dnd_characters SET gold = GREATEST(0, gold - ?) WHERE character_id = ?', [match.wager_gold, loserCharacterId]);
        }

        // Update match
        await pool.execute(
            `UPDATE dnd_pvp_matches
             SET status = 'completed', winner_id = ?, elo_change = ?, ended_at = NOW()
             WHERE match_id = ?`,
            [winnerCharacterId, winnerEloChange, matchId]
        );

        logger.info('[PvP] Match ended', { matchId, winner: winnerCharacterId, method });

        return {
            match_id: matchId,
            winner_character_id: winnerCharacterId,
            loser_character_id: loserCharacterId,
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
    static async _calculateEloChange(winnerCharacterId, loserCharacterId, guildId) {
        const [winnerStats] = await pool.execute(
            'SELECT elo_rating FROM dnd_pvp_stats WHERE character_id = ? AND guild_id = ?',
            [winnerCharacterId, guildId]
        );

        const [loserStats] = await pool.execute(
            'SELECT elo_rating FROM dnd_pvp_stats WHERE character_id = ? AND guild_id = ?',
            [loserCharacterId, guildId]
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
    static async _updateElo(characterId, guildId, change, isWin) {
        const [existing] = await pool.execute(
            'SELECT * FROM dnd_pvp_stats WHERE character_id = ? AND guild_id = ?',
            [characterId, guildId]
        );

        if (existing.length === 0) {
            // Create stats record
            await pool.execute(
                `INSERT INTO dnd_pvp_stats
                 (character_id, guild_id, elo_rating, wins, losses, win_streak, best_streak)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [characterId, guildId, ELO_DEFAULT + change, isWin ? 1 : 0, isWin ? 0 : 1, isWin ? 1 : 0, isWin ? 1 : 0]
            );
        } else {
            await pool.execute(
                `UPDATE dnd_pvp_stats
                 SET elo_rating = GREATEST(100, elo_rating + ?),
                     wins = wins + ?,
                     losses = losses + ?,
                     ${isWin ? 'win_streak = win_streak + 1, best_streak = GREATEST(best_streak, win_streak + 1)' : 'win_streak = 0'}
                 WHERE character_id = ? AND guild_id = ?`,
                [change, isWin ? 1 : 0, isWin ? 0 : 1, characterId, guildId]
            );
        }
    }

    /**
     * Get player PvP stats
     * @param {string} userId - User ID
     * @param {string} guildId - Guild ID
     * @returns {object} Stats
     */
    static async getPlayerStats(characterId, guildId) {
        const [stats] = await pool.execute(
            'SELECT * FROM dnd_pvp_stats WHERE character_id = ? AND guild_id = ?',
            [characterId, guildId]
        );

        if (stats.length === 0) {
            return {
                character_id: characterId,
                elo_rating: ELO_DEFAULT,
                wins: 0,
                losses: 0,
                draws: 0,
                matches_played: 0,
                win_streak: 0,
                best_streak: 0,
                rank: this._getRank(ELO_DEFAULT),
                winRate: 0
            };
        }

        const playerStats = stats[0];
        const played = (playerStats.wins || 0) + (playerStats.losses || 0) + (playerStats.draws || 0);
        playerStats.matches_played = played;
        playerStats.rank = this._getRank(playerStats.elo_rating);
        playerStats.winRate = played > 0
            ? ((playerStats.wins / played) * 100).toFixed(1)
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
            `SELECT s.*, c.character_name, c.user_id
             FROM dnd_pvp_stats s
             JOIN dnd_characters c ON s.character_id = c.character_id
             WHERE s.guild_id = ?
             ORDER BY s.elo_rating DESC
             LIMIT ?`,
            [String(guildId), Number(limit)]
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
             JOIN dnd_characters c ON m.challenger_id = c.character_id
             WHERE m.guild_id = ? AND m.status = 'pending'
             AND m.defender_user_id = ?
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
             LEFT JOIN dnd_characters c1 ON m.challenger_id = c1.character_id
             LEFT JOIN dnd_characters c2 ON m.defender_id = c2.character_id
             WHERE m.guild_id = ? AND m.status = 'completed'
             AND (m.challenger_user_id = ? OR m.defender_user_id = ?)
             ORDER BY m.ended_at DESC
             LIMIT ?`,
            [String(guildId), userId, userId, Number(limit)]
        );

        return matches.map(m => ({
            ...m,
            isChallenger: m.challenger_user_id === userId,
            won: (m.challenger_user_id === userId && m.winner_id === m.challenger_id) ||
                 (m.defender_user_id === userId && m.winner_id === m.defender_id),
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

        // The non-forfeiting participant wins (by character id)
        const winnerCharacterId = forfeitingUserId === match.challenger_user_id
            ? match.defender_id
            : match.challenger_id;

        return this.endMatch(matchId, winnerCharacterId, 'surrender');
    }
}

export default RPGPvPManager;
export { RPGPvPManager, MATCH_TYPES, ARENA_MODIFIERS, ELO_DEFAULT };
