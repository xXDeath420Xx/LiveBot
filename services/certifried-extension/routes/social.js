/**
 * Social Routes
 * Leaderboards and player profiles
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getActiveSeason, getLiveStandings } from '../game/season-system.js';

const router = Router();

/**
 * GET /social/leaderboard?type=cash|level|prestige|sales|earnings|season
 * One board for every real player whatever they signed in with (each row says
 * where they play); test ('dev') and banned accounts are left out (H-410).
 * type=season ranks the running season by season XP (game/season-system.js).
 */
const LEADERBOARD_TYPES = {
    cash: { order: 'cash DESC, id ASC', col: 'cash' },
    level: { order: 'level DESC, xp DESC, id ASC', col: 'level' },
    prestige: { order: 'prestige_level DESC, level DESC, id ASC', col: 'prestige_level' },
    sales: { order: 'lifetime_sales DESC, id ASC', col: 'lifetime_sales' },
    earnings: { order: 'lifetime_earnings DESC, id ASC', col: 'lifetime_earnings' }
};

router.get('/leaderboard', async (req, res) => {
    try {
        const type = String(req.query.type || 'cash');
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));

        if (type === 'season') {
            const season = await getActiveSeason();
            if (!season) return res.json({ success: true, type, season: null, leaderboard: [], playerRank: null });
            const live = await getLiveStandings(season.id, { limit, playerId: req.player?.id });
            return res.json({
                success: true,
                type,
                season,
                leaderboard: live.standings,
                playerRank: live.me?.rank ?? null
            });
        }

        const spec = LEADERBOARD_TYPES[type] || LEADERBOARD_TYPES.cash;
        const where = `platform <> 'dev' AND COALESCE(is_banned, 0) = 0`;
        const [players] = await pool.query(
            `SELECT id, display_name, avatar_url, platform, cash, level, prestige_level,
                    lifetime_earnings, lifetime_sales, facility_name
             FROM cfx_players
             WHERE ${where}
             ORDER BY ${spec.order}
             LIMIT ?`,
            [limit]
        );

        let playerRank = null;
        if (req.player && req.player.platform !== 'dev' && !req.player.is_banned) {
            const [[rankData]] = await pool.query(
                `SELECT COUNT(*) + 1 AS \`rank\` FROM cfx_players WHERE ${where} AND ${spec.col} > ?`,
                [req.player[spec.col] ?? 0]
            );
            playerRank = Number(rankData.rank);
        }

        res.json({
            success: true,
            type: LEADERBOARD_TYPES[type] ? type : 'cash',
            leaderboard: players.map((p, i) => ({
                rank: i + 1,
                id: p.id,
                displayName: p.display_name,
                avatarUrl: p.avatar_url,
                platform: p.platform,
                cash: p.cash,
                level: p.level,
                prestigeLevel: p.prestige_level,
                lifetimeEarnings: p.lifetime_earnings,
                lifetimeSales: p.lifetime_sales,
                facilityName: p.facility_name,
                isYou: !!req.player && p.id === req.player.id
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
