/**
 * RPG PvP Manager
 * Handles player vs player dueling with ELO rankings
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import { RPGDiceEngine } from './rpg-dice-engine.js';
import { resolveDuel as autoResolveDuel, resolveAttack } from './rpg-auto-combat.js';

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
     * Build a combatant snapshot for an auto-duel from a character row.
     * Reuses the same stat primitives the PvE combat engine uses
     * (calculateDamage/calculateDefense) so PvP stays consistent.
     * @private
     */
    static async _buildCombatant(characterId, characterManager) {
        const [rows] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );
        const c = rows[0];
        if (!c) throw new Error('Character not found for duel');

        const baseDamage = await characterManager.calculateDamage(characterId);
        const defense = await characterManager.calculateDefense(characterId);
        const dexMod = RPGDiceEngine.getModifier(c.dexterity || 10);
        const strMod = RPGDiceEngine.getModifier(c.strength || 10);
        const profBonus = c.proficiency_bonus || 2;

        return {
            characterId,
            name: c.character_name,
            hp: c.max_health,       // duels start at FULL HP
            maxHp: c.max_health,
            ac: c.armor_class || (10 + dexMod + defense),
            defense,
            damage: Math.max(1, baseDamage),
            attackBonus: Math.max(strMod, dexMod) + profBonus,
            // Initiative: DEX-driven, level as a tiebreaker nudge.
            initiative: dexMod * 2 + (c.level || 1),
        };
    }

    /**
     * Resolve an active match as a deterministic-enough multi-round auto-duel,
     * then apply the SAME ELO + wager logic via endMatch().
     *
     * Single-interaction auto-resolution (NOT live two-player turns).
     *
     * @param {number} matchId - active match id
     * @param {object} characterManager - instance for stat calc
     * @returns {Promise<object>} {
     *   ...endMatch result,
     *   duel: { winner:'a'|'b'|null, rounds:[...], aHp, bHp, totalRounds },
     *   challenger: snapshot, defender: snapshot, winnerName, loserName
     * }
     */
    static async resolveMatch(matchId, characterManager) {
        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('Match not found or not active');
        }

        const challenger = await this._buildCombatant(match.challenger_id, characterManager);
        const defender = await this._buildCombatant(match.defender_id, characterManager);

        // If this match has live turn-by-turn state, resume the auto-duel from the
        // CURRENT HP (so damage already traded in the live duel still counts).
        // Otherwise both start at full HP (classic single-shot auto-resolve).
        if (match.challenger_hp != null) challenger.hp = match.challenger_hp;
        if (match.defender_hp != null) defender.hp = match.defender_hp;

        // side 'a' = challenger, side 'b' = defender
        const duel = autoResolveDuel(challenger, defender, { maxRounds: 30 });

        // Decide winner. On a true draw (round-limit + equal HP) the challenger
        // (initiator) loses the toss to keep results decisive for ELO/wager.
        let winnerCharId;
        if (duel.winner === 'a') winnerCharId = match.challenger_id;
        else if (duel.winner === 'b') winnerCharId = match.defender_id;
        else winnerCharId = match.defender_id; // draw -> defender holds

        const result = await this.endMatch(matchId, winnerCharId, 'ko');

        const winnerName = winnerCharId === match.challenger_id
            ? match.challenger_name : match.defender_name;
        const loserName = winnerCharId === match.challenger_id
            ? match.defender_name : match.challenger_name;

        return {
            ...result,
            duel,
            challenger,
            defender,
            winnerName,
            loserName,
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

    // ====================================================================
    // LIVE turn-by-turn combat (two players act across separate interactions)
    // State persisted on dnd_pvp_matches via migration 126.
    // ====================================================================

    /**
     * Build a live combatant snapshot keyed by side, mirroring _buildCombatant
     * but tagging which side (challenger/defender) + the owning user id so the
     * live engine can identify whose turn it is and apply ELO/wager correctly.
     * @private
     */
    static async _buildLiveCombatant(side, characterId, userId, characterManager) {
        const snap = await this._buildCombatant(characterId, characterManager);
        return { ...snap, side, userId };
    }

    /**
     * Start a live, turn-by-turn match from an already-active match.
     * Both sides start at FULL HP; first turn goes to the higher DEX
     * (tiebreak: challenger). Persists initial HP/turn/round state.
     *
     * @param {number} matchId
     * @param {object} characterManager
     * @returns {Promise<object>} live state (see getLiveState shape)
     */
    static async startLiveMatch(matchId, characterManager) {
        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('Match not found or not active');
        }

        const [challengerRow] = await pool.execute(
            'SELECT character_name, max_health, dexterity FROM dnd_characters WHERE character_id = ?',
            [match.challenger_id]
        );
        const [defenderRow] = await pool.execute(
            'SELECT character_name, max_health, dexterity FROM dnd_characters WHERE character_id = ?',
            [match.defender_id]
        );
        if (!challengerRow[0] || !defenderRow[0]) {
            throw new Error('One or both characters no longer exist');
        }

        const cMax = challengerRow[0].max_health;
        const dMax = defenderRow[0].max_health;
        const cDex = challengerRow[0].dexterity || 10;
        const dDex = defenderRow[0].dexterity || 10;

        // Higher DEX acts first; tie -> challenger.
        const firstTurnCharId = dDex > cDex ? match.defender_id : match.challenger_id;

        await pool.execute(
            `UPDATE dnd_pvp_matches
             SET challenger_hp = ?, defender_hp = ?,
                 challenger_max_hp = ?, defender_max_hp = ?,
                 active_turn = ?, round_number = 1,
                 combat_log = NULL, defending = NULL,
                 turn_started_at = NOW()
             WHERE match_id = ?`,
            [cMax, dMax, cMax, dMax, String(firstTurnCharId), matchId]
        );

        logger.info('[PvP] Live match started', { matchId, firstTurn: firstTurnCharId });

        return this.getLiveState(matchId);
    }

    /**
     * Read the full live state of a match: the row + both combatant snapshots
     * (stat-derived) merged with the persisted live HP, whose turn it is, the
     * round number and the parsed combat log lines.
     *
     * @param {number} matchId
     * @returns {Promise<object>}
     */
    static async getLiveState(matchId, characterManager = null) {
        const match = await this.getMatch(matchId);
        if (!match) throw new Error('Match not found');

        // Derive AC/damage from stats only if a characterManager is supplied;
        // otherwise fall back to stored AC columns (avoids a hard dependency for
        // pure render/status paths).
        const buildSide = async (side) => {
            const charId = side === 'a' ? match.challenger_id : match.defender_id;
            const userId = side === 'a' ? match.challenger_user_id : match.defender_user_id;
            const name = side === 'a' ? match.challenger_name : match.defender_name;
            const hp = side === 'a' ? match.challenger_hp : match.defender_hp;
            const maxHp = side === 'a' ? match.challenger_max_hp : match.defender_max_hp;

            let snap = null;
            if (characterManager) {
                snap = await this._buildLiveCombatant(side, charId, userId, characterManager);
            }
            return {
                side,
                characterId: charId,
                userId,
                name,
                hp: hp == null ? (snap?.maxHp ?? 0) : hp,
                maxHp: maxHp == null ? (snap?.maxHp ?? 0) : maxHp,
                ac: snap?.ac ?? null,
                damage: snap?.damage ?? null,
                defense: snap?.defense ?? 0,
                attackBonus: snap?.attackBonus ?? 0,
            };
        };

        const challenger = await buildSide('a');
        const defender = await buildSide('b');
        const log = match.combat_log ? match.combat_log.split('\n').filter(Boolean) : [];

        return {
            match,
            matchId: match.match_id,
            status: match.status,
            challenger,
            defender,
            whoseTurn: match.active_turn ? Number(match.active_turn) : null,
            defending: match.defending ? Number(match.defending) : null,
            round: match.round_number || 1,
            log,
        };
    }

    /**
     * Apply a single live action (attack | defend) for the side whose turn it is.
     * Validates the match is active and it's actorCharacterId's turn.
     *
     * attack: one resolveAttack exchange (with a Defend bonus applied to the
     *   opponent's AC if the opponent defended last turn), subtract opponent HP,
     *   log it. KO -> endMatch (ELO + wager) and return {ended:true, winner, state}.
     * defend: flag the actor's side as defending (buffs their defense until they
     *   are next attacked), log it.
     *
     * @param {number} matchId
     * @param {number} actorCharacterId
     * @param {'attack'|'defend'} action
     * @param {object} characterManager
     * @returns {Promise<object>} { ended, state, winner? , result? }
     */
    static async applyAction(matchId, actorCharacterId, action, characterManager) {
        if (!['attack', 'defend'].includes(action)) {
            throw new Error('Invalid action — must be attack or defend');
        }

        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('No active live match found');
        }
        if (Number(match.active_turn) !== Number(actorCharacterId)) {
            throw new Error("It is not your turn");
        }

        const actorIsChallenger = Number(actorCharacterId) === Number(match.challenger_id);
        const opponentCharacterId = actorIsChallenger ? match.defender_id : match.challenger_id;

        // Build live snapshots for the math.
        const actorSnap = await this._buildLiveCombatant(
            actorIsChallenger ? 'a' : 'b', actorCharacterId,
            actorIsChallenger ? match.challenger_user_id : match.defender_user_id, characterManager);
        const opponentSnap = await this._buildLiveCombatant(
            actorIsChallenger ? 'b' : 'a', opponentCharacterId,
            actorIsChallenger ? match.defender_user_id : match.challenger_user_id, characterManager);

        let actorHp = actorIsChallenger ? match.challenger_hp : match.defender_hp;
        let opponentHp = actorIsChallenger ? match.defender_hp : match.challenger_hp;

        const log = match.combat_log ? match.combat_log.split('\n').filter(Boolean) : [];
        // Whether the OPPONENT used Defend (their flag is set to their character id).
        const opponentDefended = match.defending != null &&
            Number(match.defending) === Number(opponentCharacterId);

        let ended = false;
        let endResult = null;
        let nextDefending = match.defending; // carry unless we change it

        if (action === 'attack') {
            // Apply Defend damage-reduction: +2 AC AND halve incoming damage
            // if the opponent defended on their last turn.
            const defendedOpponent = opponentDefended
                ? { ...opponentSnap, ac: (opponentSnap.ac || 10) + 2 }
                : opponentSnap;

            const swing = resolveAttack(actorSnap, defendedOpponent);
            let dmg = swing.damage;
            if (opponentDefended && dmg > 0) dmg = Math.max(1, Math.floor(dmg / 2));

            opponentHp = Math.max(0, opponentHp - dmg);

            if (!swing.hit) {
                log.push(`R${match.round_number}: ${actorSnap.name} → ${opponentSnap.name} **MISS** (roll ${swing.roll})`);
            } else {
                log.push(`R${match.round_number}: ${actorSnap.name} → ${opponentSnap.name} ${swing.crit ? '💥CRIT ' : ''}${opponentDefended ? '🛡️ ' : ''}**${dmg}** dmg (${opponentHp} HP left)`);
            }

            // Consuming the opponent's Defend (it only protects against this incoming attack).
            if (opponentDefended) nextDefending = null;

            // Persist HP before a possible endMatch (endMatch reads its own row).
            await pool.execute(
                `UPDATE dnd_pvp_matches
                 SET challenger_hp = ?, defender_hp = ?, combat_log = ?
                 WHERE match_id = ?`,
                [
                    actorIsChallenger ? actorHp : opponentHp,
                    actorIsChallenger ? opponentHp : actorHp,
                    log.join('\n').slice(0, 60000),
                    matchId,
                ]
            );

            if (opponentHp <= 0) {
                log.push(`☠️ ${opponentSnap.name} is defeated! ${actorSnap.name} wins!`);
                await pool.execute(
                    'UPDATE dnd_pvp_matches SET combat_log = ? WHERE match_id = ?',
                    [log.join('\n').slice(0, 60000), matchId]
                );
                endResult = await this.endMatch(matchId, actorCharacterId, 'ko');
                ended = true;
            }
        } else { // defend
            nextDefending = String(actorCharacterId);
            log.push(`R${match.round_number}: 🛡️ ${actorSnap.name} takes a defensive stance.`);
        }

        if (!ended) {
            // Flip the turn. Bump the round when both sides have acted this round:
            // the round bumps when the side that acted SECOND in the round finishes.
            // Track via "first-actor" heuristic: we bump when control returns to the
            // side that started the round. Simpler + robust: bump every time the turn
            // passes back to the side that has the lower-or-equal acted count. We
            // approximate "both acted" by bumping after the non-opener acts. Since we
            // don't store an opener, bump on every full swap by parity of total turns.
            // To stay correct without an extra column, bump round when the turn passes
            // to the challenger (challenger always opens a round in our flip order is
            // NOT guaranteed). Use a deterministic rule: increment round when the new
            // active side equals the side whose turn it was at round start. We store
            // that implicitly by bumping whenever active flips back toward the FIRST
            // mover of the match. Practical compromise (matches spec intent): bump
            // round_number every time BOTH sides have taken a turn — counted by log
            // length of action lines.
            const nextTurn = opponentCharacterId;

            // Count action turns taken so far (lines beginning with "R<digits>:").
            const turnsTaken = log.filter(l => /^R\d+:/.test(l)).length;
            const newRound = Math.floor(turnsTaken / 2) + 1;

            await pool.execute(
                `UPDATE dnd_pvp_matches
                 SET active_turn = ?, round_number = ?, combat_log = ?,
                     defending = ?, turn_started_at = NOW()
                 WHERE match_id = ?`,
                [
                    String(nextTurn),
                    newRound,
                    log.join('\n').slice(0, 60000),
                    nextDefending,
                    matchId,
                ]
            );
        }

        const state = await this.getLiveState(matchId, characterManager);
        if (ended) {
            return {
                ended: true,
                winner: actorCharacterId,
                winnerName: actorSnap.name,
                loserName: opponentSnap.name,
                result: endResult,
                state,
            };
        }
        return { ended: false, state };
    }

    /**
     * Forfeit an active match — the OPPONENT of actorCharacterId wins via endMatch.
     * @param {number} matchId
     * @param {number} actorCharacterId - the character giving up
     * @returns {Promise<object>} endMatch result
     */
    static async forfeit(matchId, actorCharacterId) {
        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('No active match found');
        }
        if (![Number(match.challenger_id), Number(match.defender_id)].includes(Number(actorCharacterId))) {
            throw new Error('You are not a participant of this match');
        }

        const winnerCharacterId = Number(actorCharacterId) === Number(match.challenger_id)
            ? match.defender_id
            : match.challenger_id;

        return this.endMatch(matchId, winnerCharacterId, 'surrender');
    }

    /**
     * Sweep abandoned live matches: any `active` match whose current turn has been
     * idle longer than the timeout is auto-forfeited by the player on the clock
     * (active_turn holds that character's id), so the opponent wins and the match
     * can't sit `active` forever when BOTH players walk away (the claim-based
     * timeout only covers the case where the waiting player comes back).
     * @param {number} [timeoutMinutes=10]
     * @returns {Promise<Array<{matchId:number, winner:number|null}>>}
     */
    static async sweepStaleMatches(timeoutMinutes = 10) {
        const [rows] = await pool.execute(
            `SELECT match_id, active_turn FROM dnd_pvp_matches
             WHERE status = 'active' AND turn_started_at IS NOT NULL
               AND turn_started_at < (NOW() - INTERVAL ? MINUTE)`,
            [timeoutMinutes]
        );
        const ended = [];
        for (const m of rows) {
            if (m.active_turn == null) continue;
            try {
                const res = await this.forfeit(m.match_id, m.active_turn); // player on the clock loses
                ended.push({ matchId: m.match_id, winner: res?.winnerCharacterId ?? res?.winner ?? null });
            } catch { /* match changed under us — skip */ }
        }
        return ended;
    }

    /**
     * Claim a win because the opponent ran out their turn timer.
     * Only valid when it is NOT the claimant's turn and the active side's
     * turn_started_at is older than timeoutMs.
     *
     * @param {number} matchId
     * @param {number} claimantCharacterId
     * @param {number} [timeoutMs=600000] - 10 minutes default
     * @returns {Promise<object>} endMatch result
     */
    static async claimTimeout(matchId, claimantCharacterId, timeoutMs = 600000) {
        const match = await this.getMatch(matchId);
        if (!match || match.status !== 'active') {
            throw new Error('No active match found');
        }
        if (![Number(match.challenger_id), Number(match.defender_id)].includes(Number(claimantCharacterId))) {
            throw new Error('You are not a participant of this match');
        }
        if (Number(match.active_turn) === Number(claimantCharacterId)) {
            throw new Error("It is your own turn — you cannot claim a timeout");
        }

        // How long has the active side had the turn?
        const startedAt = match.turn_started_at ? new Date(match.turn_started_at).getTime() : null;
        if (startedAt == null) {
            throw new Error('Turn timer not initialized');
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed < timeoutMs) {
            throw new Error('Opponent still has time');
        }

        // Claimant wins (the timed-out active side loses).
        return this.endMatch(matchId, claimantCharacterId, 'timeout');
    }
}

export default RPGPvPManager;
export { RPGPvPManager, MATCH_TYPES, ARENA_MODIFIERS, ELO_DEFAULT };
