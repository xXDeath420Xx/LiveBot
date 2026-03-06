/**
 * Social Routes
 * Leaderboards and player profiles
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /social/leaderboard
 * Get leaderboard data (filtered by player's platform)
 */
router.get('/leaderboard', async (req, res) => {
    try {
        const { type = 'cash', limit = 50 } = req.query;

        // Get current player's platform to filter leaderboard
        const platform = req.player?.platform || 'twitch';

        logger.info('[Leaderboard] Request', {
            playerId: req.player?.id,
            playerPlatform: req.player?.platform,
            filterPlatform: platform
        });

        let orderBy;
        switch (type) {
            case 'level':
                orderBy = 'level DESC, xp DESC';
                break;
            case 'prestige':
                orderBy = 'prestige_level DESC, level DESC';
                break;
            case 'sales':
                orderBy = 'lifetime_sales DESC';
                break;
            case 'earnings':
                orderBy = 'lifetime_earnings DESC';
                break;
            case 'cash':
            default:
                orderBy = 'cash DESC';
        }

        // Filter by platform - only show users from the same platform
        const [players] = await pool.execute(
            `SELECT id, display_name, avatar_url, cash, level, prestige_level,
                    lifetime_earnings, lifetime_sales, facility_name
             FROM cfx_players
             WHERE platform = ?
             ORDER BY ${orderBy}
             LIMIT ?`,
            [platform, parseInt(limit)]
        );

        // Get requester's rank within their platform
        let playerRank = null;
        if (req.player) {
            const [[rankData]] = await pool.execute(
                `SELECT COUNT(*) + 1 as rank FROM cfx_players
                 WHERE platform = ? AND ${type === 'level' ? 'level > ?' :
                       type === 'prestige' ? 'prestige_level > ?' :
                       type === 'sales' ? 'lifetime_sales > ?' :
                       type === 'earnings' ? 'lifetime_earnings > ?' : 'cash > ?'}`,
                [platform,
                 type === 'level' ? req.player.level :
                 type === 'prestige' ? req.player.prestige_level :
                 type === 'sales' ? req.player.lifetime_sales :
                 type === 'earnings' ? req.player.lifetime_earnings : req.player.cash]
            );
            playerRank = rankData.rank;
        }

        res.json({
            success: true,
            type,
            platform,
            leaderboard: players.map((p, i) => ({
                rank: i + 1,
                id: p.id,
                displayName: p.display_name,
                avatarUrl: p.avatar_url,
                cash: p.cash,
                level: p.level,
                prestigeLevel: p.prestige_level,
                lifetimeEarnings: p.lifetime_earnings,
                lifetimeSales: p.lifetime_sales,
                facilityName: p.facility_name,
                isYou: req.player && p.id === req.player.id
            })),
            playerRank
        });

    } catch (error) {
        logger.error('[Social] Leaderboard failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /social/player/:id
 * Get player profile
 */
router.get('/player/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [[player]] = await pool.execute(
            `SELECT id, display_name, avatar_url, cash, level, prestige_level,
                    lifetime_earnings, lifetime_sales, facility_name, created_at
             FROM cfx_players
             WHERE id = ? AND is_banned = 0`,
            [id]
        );

        if (!player) {
            return res.status(404).json({ error: 'Player not found', code: 'NOT_FOUND' });
        }

        // Get achievement count
        const [[achievementCount]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_player_achievements WHERE player_id = ?',
            [id]
        );

        // Get strain discovery count
        const [[discoveryCount]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_strain_discoveries WHERE player_id = ?',
            [id]
        );

        // Get created strains count
        const [[createdCount]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_strains WHERE bred_by_player_id = ?',
            [id]
        );

        res.json({
            success: true,
            player: {
                id: player.id,
                displayName: player.display_name,
                avatarUrl: player.avatar_url,
                cash: player.cash,
                level: player.level,
                prestigeLevel: player.prestige_level,
                lifetimeEarnings: player.lifetime_earnings,
                lifetimeSales: player.lifetime_sales,
                facilityName: player.facility_name,
                joinedAt: player.created_at,
                achievements: achievementCount.count,
                strainsDiscovered: discoveryCount.count,
                strainsCreated: createdCount.count
            }
        });

    } catch (error) {
        logger.error('[Social] Get player failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /social/search
 * Search for players
 */
router.get('/search', async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;

        if (!q || q.length < 2) {
            return res.status(400).json({ error: 'Query too short', code: 'INVALID_QUERY' });
        }

        const [players] = await pool.execute(
            `SELECT id, display_name, avatar_url, level, prestige_level
             FROM cfx_players
             WHERE display_name LIKE ?              ORDER BY level DESC
             LIMIT ?`,
            [`%${q}%`, parseInt(limit)]
        );

        res.json({
            success: true,
            results: players.map(p => ({
                id: p.id,
                displayName: p.display_name,
                avatarUrl: p.avatar_url,
                level: p.level,
                prestigeLevel: p.prestige_level
            }))
        });

    } catch (error) {
        logger.error('[Social] Search failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
