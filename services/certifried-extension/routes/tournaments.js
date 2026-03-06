/**
 * Tournaments Routes
 * Weekly competitive events
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash } from '../game/engine.js';

const router = Router();

/**
 * GET /tournaments
 * Get active and upcoming tournaments
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get active and upcoming tournaments
        const [tournaments] = await pool.execute(`
            SELECT t.*,
                   tp.score as my_score,
                   tp.rank as my_rank,
                   tp.joined_at,
                   tp.reward_claimed,
                   (SELECT COUNT(*) FROM cfx_tournament_participants WHERE tournament_id = t.id) as participant_count
            FROM cfx_tournaments t
            LEFT JOIN cfx_tournament_participants tp ON t.id = tp.tournament_id AND tp.player_id = ?
            WHERE t.status IN ('upcoming', 'active', 'completed')
            AND t.ends_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
            ORDER BY
                CASE t.status WHEN 'active' THEN 1 WHEN 'upcoming' THEN 2 ELSE 3 END,
                t.starts_at ASC
        `, [playerId]);

        // Get player info
        const [playerRows] = await pool.execute(`
            SELECT level, cash FROM cfx_players WHERE id = ?
        `, [playerId]);
        const player = playerRows[0] || { level: 1, cash: 0 };

        res.json({
            success: true,
            tournaments: tournaments.map(t => ({
                id: t.id,
                name: t.name,
                description: t.description,
                type: t.tournament_type,
                entryFee: t.entry_fee,
                prizePool: t.prize_pool,
                minLevel: t.min_level,
                maxParticipants: t.max_participants,
                participantCount: t.participant_count,
                status: t.status,
                startsAt: t.starts_at,
                endsAt: t.ends_at,
                isJoined: !!t.joined_at,
                myScore: t.my_score || 0,
                myRank: t.my_rank,
                rewardClaimed: !!t.reward_claimed,
                canJoin: !t.joined_at &&
                         t.status === 'active' &&
                         player.level >= t.min_level &&
                         player.cash >= t.entry_fee &&
                         (!t.max_participants || t.participant_count < t.max_participants)
            })),
            player: {
                level: player.level,
                cash: player.cash
            }
        });
    } catch (error) {
        logger.error('[Tournaments] Error loading:', error);
        res.status(500).json({ success: false, error: 'Failed to load tournaments' });
    }
});

/**
 * GET /tournaments/:id/leaderboard
 * Get tournament leaderboard
 */
router.get('/:id/leaderboard', async (req, res) => {
    try {
        const playerId = req.player.id;
        const tournamentId = parseInt(req.params.id, 10);

        // Get tournament
        const [tournamentRows] = await pool.execute(`
            SELECT * FROM cfx_tournaments WHERE id = ?
        `, [tournamentId]);

        if (tournamentRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tournament not found' });
        }

        const tournament = tournamentRows[0];

        // Get leaderboard
        const [participants] = await pool.execute(`
            SELECT tp.*, p.display_name, p.level
            FROM cfx_tournament_participants tp
            JOIN cfx_players p ON tp.player_id = p.id
            WHERE tp.tournament_id = ?
            ORDER BY tp.score DESC
            LIMIT 100
        `, [tournamentId]);

        // Find player's position
        const [myPosition] = await pool.execute(`
            SELECT tp.*,
                   (SELECT COUNT(*) + 1 FROM cfx_tournament_participants tp2
                    WHERE tp2.tournament_id = ? AND tp2.score > tp.score) as current_rank
            FROM cfx_tournament_participants tp
            WHERE tp.tournament_id = ? AND tp.player_id = ?
        `, [tournamentId, tournamentId, playerId]);

        res.json({
            success: true,
            tournament: {
                id: tournament.id,
                name: tournament.name,
                type: tournament.tournament_type,
                status: tournament.status,
                prizePool: tournament.prize_pool,
                endsAt: tournament.ends_at
            },
            leaderboard: participants.map((p, idx) => ({
                rank: idx + 1,
                playerId: p.player_id,
                displayName: p.display_name,
                level: p.level,
                score: p.score,
                prizeAmount: p.prize_amount
            })),
            myPosition: myPosition.length > 0 ? {
                rank: myPosition[0].current_rank,
                score: myPosition[0].score
            } : null
        });
    } catch (error) {
        logger.error('[Tournaments] Error loading leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
    }
});

/**
 * POST /tournaments/:id/join
 * Join a tournament
 */
router.post('/:id/join', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const tournamentId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get tournament
        const [tournamentRows] = await conn.execute(`
            SELECT t.*,
                   (SELECT COUNT(*) FROM cfx_tournament_participants WHERE tournament_id = t.id) as participant_count
            FROM cfx_tournaments t WHERE t.id = ?
        `, [tournamentId]);

        if (tournamentRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Tournament not found' });
        }

        const tournament = tournamentRows[0];

        if (tournament.status !== 'active') {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Tournament is not active' });
        }

        if (tournament.max_participants && tournament.participant_count >= tournament.max_participants) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Tournament is full' });
        }

        // Check if already joined
        const [existingRows] = await conn.execute(`
            SELECT id FROM cfx_tournament_participants WHERE tournament_id = ? AND player_id = ?
        `, [tournamentId, playerId]);

        if (existingRows.length > 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Already joined this tournament' });
        }

        // Check player requirements
        const [playerRows] = await conn.execute(`
            SELECT level, cash FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        const player = playerRows[0];

        if (player.level < tournament.min_level) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: `Requires level ${tournament.min_level}` });
        }

        if (player.cash < tournament.entry_fee) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash for entry fee' });
        }

        // Deduct entry fee and add to prize pool
        if (tournament.entry_fee > 0) {
            await conn.execute(`
                UPDATE cfx_players SET cash = cash - ? WHERE id = ?
            `, [tournament.entry_fee, playerId]);

            await conn.execute(`
                UPDATE cfx_tournaments SET prize_pool = prize_pool + ? WHERE id = ?
            `, [tournament.entry_fee, tournamentId]);
        }

        // Join tournament
        await conn.execute(`
            INSERT INTO cfx_tournament_participants (tournament_id, player_id, score)
            VALUES (?, ?, 0)
        `, [tournamentId, playerId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Joined "${tournament.name}"!`
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Tournaments] Error joining:', error);
        res.status(500).json({ success: false, error: 'Failed to join tournament' });
    } finally {
        conn.release();
    }
});

/**
 * POST /tournaments/:id/claim
 * Claim tournament reward
 */
router.post('/:id/claim', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const tournamentId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get tournament status
        const [tournamentRows] = await conn.execute(`
            SELECT * FROM cfx_tournaments WHERE id = ?
        `, [tournamentId]);

        if (tournamentRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Tournament not found' });
        }

        if (tournamentRows[0].status !== 'completed') {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Tournament not yet completed' });
        }

        // Get participant info
        const [participantRows] = await conn.execute(`
            SELECT * FROM cfx_tournament_participants
            WHERE tournament_id = ? AND player_id = ?
        `, [tournamentId, playerId]);

        if (participantRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Did not participate in this tournament' });
        }

        const participant = participantRows[0];

        if (participant.reward_claimed) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Reward already claimed' });
        }

        if (!participant.prize_amount || participant.prize_amount <= 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'No prize to claim' });
        }

        await conn.execute(`
            UPDATE cfx_tournament_participants SET reward_claimed = TRUE WHERE id = ?
        `, [participant.id]);

        await conn.commit();

        // Give prize using proper engine function (after transaction)
        const cashResult = await awardCash(playerId, parseFloat(participant.prize_amount));

        res.json({
            success: true,
            message: `Claimed $${cashResult.cashAwarded.toLocaleString()} prize!`,
            prizeAmount: cashResult.cashAwarded,
            rank: participant.rank
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Tournaments] Error claiming:', error);
        res.status(500).json({ success: false, error: 'Failed to claim reward' });
    } finally {
        conn.release();
    }
});

/**
 * Helper: Update tournament scores (called by game actions)
 */
export async function updateTournamentScore(playerId, tournamentType, amount) {
    try {
        // Find active tournaments of this type that player joined
        const [rows] = await pool.execute(`
            UPDATE cfx_tournament_participants tp
            JOIN cfx_tournaments t ON tp.tournament_id = t.id
            SET tp.score = tp.score + ?
            WHERE tp.player_id = ?
            AND t.tournament_type = ?
            AND t.status = 'active'
            AND NOW() BETWEEN t.starts_at AND t.ends_at
        `, [amount, playerId, tournamentType]);

        return rows.affectedRows;
    } catch (error) {
        logger.error('[Tournaments] Error updating score:', error);
        return 0;
    }
}

export default router;
