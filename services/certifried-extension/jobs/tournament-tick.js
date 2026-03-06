/**
 * Tournament Lifecycle Tick
 * Manages tournament state transitions and auto-creates new tournaments
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Tournament tick - runs every 5 minutes
 * 1. Transition upcoming → active when starts_at <= NOW()
 * 2. Transition active → completed when ends_at <= NOW()
 * 3. On completion: calculate rankings and assign prizes
 * 4. Auto-create new weekly tournaments if none upcoming/active
 */
export async function tournamentTick() {
    // 1. Activate upcoming tournaments
    const [activated] = await pool.execute(`
        UPDATE cfx_tournaments
        SET status = 'active'
        WHERE status = 'upcoming' AND starts_at <= NOW()
    `);

    if (activated.affectedRows > 0) {
        logger.info('[TournamentTick] Activated tournaments', { count: activated.affectedRows });
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

            // Mark as completed
            await conn.execute(
                `UPDATE cfx_tournaments SET status = 'completed' WHERE id = ?`,
                [tournament.id]
            );

            // Calculate rankings using ROW_NUMBER
            const [participants] = await conn.execute(`
                SELECT tp.id, tp.player_id, tp.score,
                       ROW_NUMBER() OVER (ORDER BY tp.score DESC) as rank_position
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
                        SET \`rank\` = ?, prize_amount = ?
                        WHERE id = ?
                    `, [rank, prize, participant.id]);
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

    // 3. Auto-create weekly tournaments if none upcoming/active
    const [existing] = await pool.execute(`
        SELECT tournament_type FROM cfx_tournaments
        WHERE status IN ('upcoming', 'active')
    `);

    const activeTypes = new Set(existing.map(t => t.tournament_type));
    const tournamentTemplates = [
        { type: 'harvest', name: 'Weekly Harvest Championship', prizePool: 50000 },
        { type: 'sales', name: 'Weekly Sales Showdown', prizePool: 75000 },
        { type: 'quality', name: 'Weekly Quality Cup', prizePool: 60000 }
    ];

    for (const template of tournamentTemplates) {
        if (!activeTypes.has(template.type)) {
            // Create a new tournament starting now, ending in 7 days
            try {
                await pool.execute(`
                    INSERT INTO cfx_tournaments (tournament_type, name, starts_at, ends_at, prize_pool, status)
                    VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), ?, 'active')
                `, [template.type, template.name, template.prizePool]);

                logger.info('[TournamentTick] Auto-created tournament', { type: template.type });
            } catch (createErr) {
                logger.error('[TournamentTick] Failed to create tournament', {
                    type: template.type,
                    error: createErr.message
                });
            }
        }
    }
}
