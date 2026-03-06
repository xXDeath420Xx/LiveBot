/**
 * Admin Routes
 * Admin-only operations (owner restricted)
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

// Owner check middleware
const ownerOnly = (req, res, next) => {
    // Check if player is the bot owner (from env)
    const ownerId = process.env.BOT_OWNER_ID;

    // For Twitch, we'd need to check the platform user ID
    // This is a simplified check - in production, maintain an admin table
    if (!ownerId) {
        return res.status(403).json({ error: 'Admin access not configured', code: 'NO_ADMIN' });
    }

    // Check against a list of admin player IDs
    // For now, we'll use an environment variable
    const adminIds = (process.env.CFX_ADMIN_IDS || '').split(',').map(id => id.trim());

    if (!adminIds.includes(req.player.id.toString())) {
        return res.status(403).json({ error: 'Admin access required', code: 'NOT_ADMIN' });
    }

    next();
};

/**
 * GET /admin/stats
 * Get game statistics
 */
router.get('/stats', ownerOnly, async (req, res) => {
    try {
        // Player stats
        const [[playerStats]] = await pool.execute(
            `SELECT
                COUNT(*) as total_players,
                COUNT(CASE WHEN last_online_at > DATE_SUB(NOW(), INTERVAL 1 DAY) THEN 1 END) as active_24h,
                COUNT(CASE WHEN last_online_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 END) as active_7d,
                SUM(cash) as total_cash,
                AVG(level) as avg_level,
                MAX(level) as max_level,
                COUNT(CASE WHEN prestige_level > 0 THEN 1 END) as prestiged_players
             FROM cfx_players WHERE is_banned = 0`
        );

        // Market stats
        const [[marketStats]] = await pool.execute(
            `SELECT
                COUNT(*) as active_listings,
                SUM(quantity * price_per_unit) as total_listing_value
             FROM cfx_market_listings WHERE status = 'active'`
        );

        // Strain stats
        const [[strainStats]] = await pool.execute(
            `SELECT
                COUNT(*) as total_strains,
                COUNT(CASE WHEN is_bred = 1 THEN 1 END) as bred_strains
             FROM cfx_strains`
        );

        // Recent activity
        const [recentPlayers] = await pool.execute(
            `SELECT id, display_name, level, last_online_at
             FROM cfx_players
             ORDER BY last_online_at DESC
             LIMIT 10`
        );

        res.json({
            success: true,
            stats: {
                players: {
                    total: playerStats.total_players,
                    active24h: playerStats.active_24h,
                    active7d: playerStats.active_7d,
                    prestiged: playerStats.prestiged_players,
                    avgLevel: parseFloat(playerStats.avg_level) || 0,
                    maxLevel: playerStats.max_level || 0,
                    totalCash: playerStats.total_cash || 0
                },
                market: {
                    activeListings: marketStats.active_listings || 0,
                    totalValue: marketStats.total_listing_value || 0
                },
                strains: {
                    total: strainStats.total_strains,
                    bred: strainStats.bred_strains
                },
                recentPlayers: recentPlayers.map(p => ({
                    id: p.id,
                    displayName: p.display_name,
                    level: p.level,
                    lastOnline: p.last_online_at
                }))
            }
        });

    } catch (error) {
        logger.error('[Admin] Get stats failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /admin/season
 * Start or end a season
 */
router.post('/season', ownerOnly, async (req, res) => {
    try {
        const { action, name, theme, durationDays } = req.body;

        if (action === 'start') {
            // End any active season
            await pool.execute(
                `UPDATE cfx_seasons SET status = 'ended' WHERE status = 'active'`
            );

            // Create new season
            const startsAt = new Date();
            const endsAt = new Date(Date.now() + (durationDays || 30) * 24 * 60 * 60 * 1000);

            const [result] = await pool.execute(
                `INSERT INTO cfx_seasons (name, theme, starts_at, ends_at, status)
                 VALUES (?, ?, ?, ?, 'active')`,
                [name || `Season ${Date.now()}`, theme, startsAt, endsAt]
            );

            // Update all players to new season
            await pool.execute(
                'UPDATE cfx_players SET current_season_id = ?, season_xp = 0',
                [result.insertId]
            );

            res.json({
                success: true,
                seasonId: result.insertId,
                startsAt,
                endsAt
            });

        } else if (action === 'end') {
            // Get active season
            const [[season]] = await pool.execute(
                `SELECT id FROM cfx_seasons WHERE status = 'active'`
            );

            if (!season) {
                return res.status(400).json({ error: 'No active season', code: 'NO_SEASON' });
            }

            // Calculate final rankings
            const [players] = await pool.execute(
                `SELECT id, season_xp, lifetime_earnings, lifetime_sales
                 FROM cfx_players
                 WHERE current_season_id = ?
                 ORDER BY season_xp DESC`,
                [season.id]
            );

            // Record leaderboard
            for (let i = 0; i < players.length; i++) {
                await pool.execute(
                    `INSERT INTO cfx_season_leaderboard
                     (season_id, player_id, final_rank, season_xp, season_earnings, season_sales)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [season.id, players[i].id, i + 1, players[i].season_xp,
                     players[i].lifetime_earnings, players[i].lifetime_sales]
                );
            }

            // End season
            await pool.execute(
                `UPDATE cfx_seasons SET status = 'ended' WHERE id = ?`,
                [season.id]
            );

            res.json({
                success: true,
                seasonId: season.id,
                totalPlayers: players.length
            });

        } else {
            res.status(400).json({ error: 'Invalid action', code: 'INVALID_ACTION' });
        }

    } catch (error) {
        logger.error('[Admin] Season action failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /admin/ban
 * Ban or unban a player
 */
router.post('/ban', ownerOnly, async (req, res) => {
    try {
        const { playerId, action, reason } = req.body;

        if (!playerId) {
            return res.status(400).json({ error: 'Player ID required', code: 'NO_ID' });
        }

        if (action === 'ban') {
            await pool.execute(
                'UPDATE cfx_players SET is_banned = 1, ban_reason = ? WHERE id = ?',
                [reason || 'No reason provided', playerId]
            );
            logger.info('[Admin] Player banned', { playerId, reason });
        } else if (action === 'unban') {
            await pool.execute(
                'UPDATE cfx_players SET is_banned = 0, ban_reason = NULL WHERE id = ?',
                [playerId]
            );
            logger.info('[Admin] Player unbanned', { playerId });
        } else {
            return res.status(400).json({ error: 'Invalid action', code: 'INVALID_ACTION' });
        }

        res.json({ success: true, action, playerId });

    } catch (error) {
        logger.error('[Admin] Ban action failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
