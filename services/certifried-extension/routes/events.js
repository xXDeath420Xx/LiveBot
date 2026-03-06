/**
 * Seasonal Events Routes
 * Limited-time events with special rewards and bonuses
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash } from '../game/engine.js';

const router = Router();

/**
 * GET /events
 * Get all active events
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;
        const now = new Date();

        // Get active events
        const [events] = await pool.execute(
            `SELECT e.*, pe.points_earned, pe.rewards_claimed, pe.joined_at
             FROM cfx_seasonal_events e
             LEFT JOIN cfx_player_events pe ON e.id = pe.event_id AND pe.player_id = ?
             WHERE e.is_active = 1 AND e.starts_at <= ? AND e.ends_at >= ?
             ORDER BY e.ends_at ASC`,
            [playerId, now, now]
        );

        res.json({
            success: true,
            events: events.map(e => ({
                id: e.id,
                slug: e.event_slug,
                name: e.name,
                description: e.description,
                type: e.event_type,
                startsAt: e.starts_at,
                endsAt: e.ends_at,
                bonusType: e.bonus_type,
                bonusValue: parseFloat(e.bonus_value) || 0,
                specialStrains: e.special_strain_ids ? JSON.parse(e.special_strain_ids) : [],
                rewards: e.rewards_json ? JSON.parse(e.rewards_json) : null,
                // Player participation
                hasJoined: !!e.joined_at,
                pointsEarned: e.points_earned || 0,
                rewardsClaimed: e.rewards_claimed ? JSON.parse(e.rewards_claimed) : [],
                joinedAt: e.joined_at,
                // Time remaining
                remainingMs: new Date(e.ends_at) - now,
                remainingDays: Math.ceil((new Date(e.ends_at) - now) / 86400000)
            }))
        });

    } catch (error) {
        logger.error('[Events] Get active events failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /events/join
 * Join an active event
 */
router.post('/join', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { eventId } = req.body;

        if (!eventId) {
            return res.status(400).json({ error: 'Event ID required', code: 'INVALID_INPUT' });
        }

        // Check if event is active
        const [[event]] = await pool.execute(
            `SELECT * FROM cfx_seasonal_events
             WHERE id = ? AND is_active = 1 AND starts_at <= NOW() AND ends_at >= NOW()`,
            [eventId]
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found or not active', code: 'NOT_FOUND' });
        }

        // Join the event
        await pool.execute(
            `INSERT IGNORE INTO cfx_player_events (player_id, event_id)
             VALUES (?, ?)`,
            [playerId, eventId]
        );

        logger.info('[Events] Player joined event', { playerId, eventId, eventName: event.name });

        res.json({
            success: true,
            event: {
                id: event.id,
                name: event.name
            }
        });

    } catch (error) {
        logger.error('[Events] Join event failed', { error: error.message });
        res.status(500).json({ error: 'Failed to join event', code: 'ERROR' });
    }
});

/**
 * POST /events/claim-reward
 * Claim a milestone reward from an event
 */
router.post('/claim-reward', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const playerId = req.player.id;
        const { eventId, milestoneIndex } = req.body;

        if (eventId === undefined || milestoneIndex === undefined) {
            await conn.rollback();
            return res.status(400).json({ error: 'Event ID and milestone index required', code: 'INVALID_INPUT' });
        }

        // Get event and player participation
        const [[event]] = await conn.execute(
            `SELECT e.*, pe.points_earned, pe.rewards_claimed
             FROM cfx_seasonal_events e
             JOIN cfx_player_events pe ON e.id = pe.event_id AND pe.player_id = ?
             WHERE e.id = ?
             FOR UPDATE`,
            [playerId, eventId]
        );

        if (!event) {
            await conn.rollback();
            return res.status(404).json({ error: 'Event not found or not joined', code: 'NOT_FOUND' });
        }

        const rewards = event.rewards_json ? JSON.parse(event.rewards_json) : null;
        if (!rewards?.milestones || !rewards.milestones[milestoneIndex]) {
            await conn.rollback();
            return res.status(400).json({ error: 'Invalid milestone', code: 'INVALID_MILESTONE' });
        }

        const milestone = rewards.milestones[milestoneIndex];
        const playerPoints = event.points_earned || 0;
        const claimedRewards = event.rewards_claimed ? JSON.parse(event.rewards_claimed) : [];

        // Check if already claimed
        if (claimedRewards.includes(milestoneIndex)) {
            await conn.rollback();
            return res.status(400).json({ error: 'Reward already claimed', code: 'ALREADY_CLAIMED' });
        }

        // Check if enough points
        if (playerPoints < milestone.points) {
            await conn.rollback();
            return res.status(400).json({
                error: `Need ${milestone.points} points, you have ${playerPoints}`,
                code: 'INSUFFICIENT_POINTS'
            });
        }

        // Grant the reward
        let rewardDetails = { reward: milestone.reward };

        // Parse and apply reward (simple format: "500 cash" or "rare_seed_pack")
        const rewardStr = milestone.reward.toLowerCase();
        let pendingCashAward = 0;
        if (rewardStr.includes('cash')) {
            pendingCashAward = parseInt(rewardStr.match(/\d+/)?.[0] || '500', 10);
            rewardDetails.cashAwarded = pendingCashAward; // Will be updated after awardCash
        } else if (rewardStr.includes('seed_pack')) {
            // Give random seeds
            const rarity = rewardStr.includes('epic') ? 'epic' : rewardStr.includes('rare') ? 'rare' : 'uncommon';
            const quantity = rewardStr.includes('epic') ? 2 : 3;

            const [strains] = await conn.execute(
                'SELECT id FROM cfx_strains WHERE rarity = ? ORDER BY RAND() LIMIT ?',
                [rarity, quantity]
            );

            for (const strain of strains) {
                await conn.execute(
                    `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity)
                     VALUES (?, ?, 1)
                     ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
                    [playerId, strain.id]
                );
            }
            rewardDetails.seedsAwarded = strains.length;
            rewardDetails.rarity = rarity;
        }

        // Mark reward as claimed
        claimedRewards.push(milestoneIndex);
        await conn.execute(
            `UPDATE cfx_player_events
             SET rewards_claimed = ?
             WHERE player_id = ? AND event_id = ?`,
            [JSON.stringify(claimedRewards), playerId, eventId]
        );

        await conn.commit();

        // Apply cash award after transaction using proper engine function
        if (pendingCashAward > 0) {
            const cashResult = await awardCash(playerId, pendingCashAward);
            rewardDetails.cashAwarded = cashResult.cashAwarded;
        }

        logger.info('[Events] Reward claimed', {
            playerId,
            eventId,
            milestone: milestoneIndex,
            reward: milestone.reward
        });

        res.json({
            success: true,
            reward: rewardDetails
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Events] Claim reward failed', { error: error.message });
        res.status(500).json({ error: 'Failed to claim reward', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * GET /events/leaderboard/:eventId
 * Get event leaderboard
 */
router.get('/leaderboard/:eventId', async (req, res) => {
    try {
        const { eventId } = req.params;
        const playerId = req.player.id;

        const [leaders] = await pool.execute(
            `SELECT pe.player_id, pe.points_earned, p.display_name, p.level
             FROM cfx_player_events pe
             JOIN cfx_players p ON pe.player_id = p.id
             WHERE pe.event_id = ?
             ORDER BY pe.points_earned DESC
             LIMIT 50`,
            [eventId]
        );

        // Get player's rank
        const [[playerRank]] = await pool.execute(
            `SELECT COUNT(*) + 1 as rank
             FROM cfx_player_events
             WHERE event_id = ? AND points_earned > (
                 SELECT COALESCE(points_earned, 0) FROM cfx_player_events
                 WHERE player_id = ? AND event_id = ?
             )`,
            [eventId, playerId, eventId]
        );

        res.json({
            success: true,
            leaderboard: leaders.map((l, i) => ({
                rank: i + 1,
                playerId: l.player_id,
                displayName: l.display_name,
                level: l.level,
                points: l.points_earned,
                isCurrentPlayer: l.player_id === playerId
            })),
            playerRank: playerRank?.rank || null
        });

    } catch (error) {
        logger.error('[Events] Get leaderboard failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * Helper: Award event points to a player
 * Call this from other routes when player does event-related actions
 */
export async function awardEventPoints(playerId, points, eventSlug = null) {
    try {
        let query = `
            UPDATE cfx_player_events pe
            JOIN cfx_seasonal_events e ON pe.event_id = e.id
            SET pe.points_earned = pe.points_earned + ?
            WHERE pe.player_id = ?
            AND e.is_active = 1
            AND e.starts_at <= NOW()
            AND e.ends_at >= NOW()
        `;
        const params = [points, playerId];

        if (eventSlug) {
            query += ' AND e.event_slug = ?';
            params.push(eventSlug);
        }

        await pool.execute(query, params);
    } catch (error) {
        logger.warn('[Events] Award points failed', { playerId, points, error: error.message });
    }
}

export default router;
