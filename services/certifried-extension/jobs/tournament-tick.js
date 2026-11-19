/**
 * Tournament Lifecycle Tick
 * Manages tournament state transitions and auto-creates new tournaments
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { countActivePlayers } from '../game/season-system.js';

/**
 * Weekly tournaments are only worth running when people play (H-409).
 * "Active" = a real (non-test, non-banned) player whose last signed-in
 * request (cfx_players.last_online_at, updated on every API call) was in the
 * last ACTIVE_DAYS days. A competition needs at least two of them;
 * CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS overrides the minimum.
 */
export const ACTIVE_DAYS = 7;
export function minActivePlayers() {
    const n = parseInt(process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS || '2', 10);
    return Number.isFinite(n) && n >= 1 ? n : 2;
}

export const TOURNAMENT_TEMPLATES = Object.freeze([
    { type: 'harvest', name: 'Weekly Harvest Championship', prizePool: 50000 },
    { type: 'sales', name: 'Weekly Sales Showdown', prizePool: 75000 },
    { type: 'quality', name: 'Weekly Quality Cup', prizePool: 60000 }
]);

/** Which templates need a new tournament, given the types already running. Pure; tested. */
export function templatesToCreate(runningTypes, activePlayers, minimum = minActivePlayers()) {
    if (activePlayers < minimum) return [];
    const running = new Set(runningTypes);
    return TOURNAMENT_TEMPLATES.filter(t => !running.has(t.type));
}

/**
 * Tournament tick - runs every 5 minutes
 * 1. Transition upcoming -> active when starts_at <= NOW()
 * 2. Transition active -> completed when ends_at <= NOW(), ranking entrants and
 *    recording prizes (50% / 30% / 20% of the pool for places 1-3, claimed in
 *    the game). A tournament that ends with nobody entered is deleted instead:
 *    it has no results worth keeping.
 * 3. Start the weekly tournaments that are not running, if enough players are active
 */
export async function tournamentTick() {
    // 1. Activate upcoming tournaments
    const [activated] = await pool.execute(`
        UPDATE cfx_tournaments
        SET status = 'active'
        WHERE status = 'upcoming' AND starts_at <= NOW()
    `);

    if (activated.affectedRows > 0) {
        logger.debug('[TournamentTick] Activated tournaments', { count: activated.affectedRows });
    }

    // 2. Complete ended tournaments
    const [ended] = await pool.execute(`
        SELECT id, tournament_type, prize_pool
        FROM cfx_tournaments
        WHERE status = 'active' AND ends_at <= NOW()
    `);

    for (const tournament of ended) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[{ entrants }]] = await conn.execute(
                'SELECT COUNT(*) AS entrants FROM cfx_tournament_participants WHERE tournament_id = ?',
                [tournament.id]
            );

            if (Number(entrants) === 0) {
                await conn.execute(`DELETE FROM cfx_tournaments WHERE id = ? AND status = 'active'`, [tournament.id]);
                await conn.commit();
                logger.debug('[TournamentTick] Removed tournament that ended with no entrants', { tournamentId: tournament.id });
                continue;
            }

            // Mark as completed
            await conn.execute(
                `UPDATE cfx_tournaments SET status = 'completed' WHERE id = ?`,
                [tournament.id]
            );

            // Calculate rankings using ROW_NUMBER
            const [participants] = await conn.execute(`
                SELECT tp.id, tp.player_id, tp.score,
                       ROW_NUMBER() OVER (ORDER BY tp.score DESC, tp.joined_at ASC) as rank_position
                FROM cfx_tournament_participants tp
                WHERE tp.tournament_id = ? AND tp.score > 0
                ORDER BY tp.score DESC
            `, [tournament.id]);

            if (participants.length > 0) {
                const prizePool = parseFloat(tournament.prize_pool) || 0;

                // Distribute prizes: 50% to 1st, 30% to 2nd, 20% to 3rd
                const prizeDistribution = [0.50, 0.30, 0.20];

                for (const participant of participants) {
                    const rank = participant.rank_position;
                    const prize = rank <= 3 ? Math.floor(prizePool * (prizeDistribution[rank - 1] || 0)) : 0;

                    await conn.execute(`
                        UPDATE cfx_tournament_participants
                        SET \`rank\` = ?, rank_position = ?, prize_amount = ?
                        WHERE id = ?
                    `, [rank, rank, prize, participant.id]);
                }
            }

            await conn.commit();

            logger.info('[TournamentTick] Completed tournament', {
                tournamentId: tournament.id,
                type: tournament.tournament_type,
                participants: participants.length
            });
        } catch (error) {
            await conn.rollback();
            logger.error('[TournamentTick] Failed to complete tournament', {
                tournamentId: tournament.id,
                error: error.message
            });
        } finally {
            conn.release();
        }
    }

    // 3. Auto-create weekly tournaments if none upcoming/active, when people are playing
    const [existing] = await pool.execute(`
        SELECT tournament_type FROM cfx_tournaments
        WHERE status IN ('upcoming', 'active')
    `);

    const activePlayers = await countActivePlayers(ACTIVE_DAYS);
    for (const template of templatesToCreate(existing.map(t => t.tournament_type), activePlayers)) {
        // Create a new tournament starting now, ending in 7 days
        try {
            await pool.execute(`
                INSERT INTO cfx_tournaments (tournament_type, name, starts_at, ends_at, prize_pool, status)
                VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), ?, 'active')
            `, [template.type, template.name, template.prizePool]);

            logger.debug('[TournamentTick] Auto-created tournament', { type: template.type, activePlayers });
        } catch (createErr) {
            logger.error('[TournamentTick] Failed to create tournament', {
                type: template.type,
                error: createErr.message
            });
        }
    }
}
