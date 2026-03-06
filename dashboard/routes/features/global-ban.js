import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /:guildId/global-ban/config
 * Get guild's global ban configuration
 */
router.get('/:guildId/global-ban/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM global_ban_config WHERE guild_id = ?',
            [req.guildId]
        );

        res.json({
            success: true,
            config: rows[0] || {
                enabled: false,
                action_critical: 'ban',
                action_high: 'ban',
                action_medium: 'kick',
                action_low: 'alert',
                alert_channel_id: null,
                check_on_join: true,
                check_on_message: false,
                auto_aggregate_opt_in: true,
                exempt_roles: '[]'
            }
        });
    } catch (error) {
        logger.error('[API GlobalBan Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch global ban config' });
    }
});

/**
 * PUT /:guildId/global-ban/config
 * Update guild's global ban configuration
 */
router.put('/:guildId/global-ban/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const {
            enabled,
            action_critical,
            action_high,
            action_medium,
            action_low,
            alert_channel_id,
            check_on_join,
            check_on_message,
            auto_aggregate_opt_in,
            exempt_roles
        } = req.body;

        await pool.execute(`
            INSERT INTO global_ban_config
                (guild_id, enabled, action_critical, action_high, action_medium, action_low,
                 alert_channel_id, check_on_join, check_on_message, auto_aggregate_opt_in, exempt_roles)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                action_critical = VALUES(action_critical),
                action_high = VALUES(action_high),
                action_medium = VALUES(action_medium),
                action_low = VALUES(action_low),
                alert_channel_id = VALUES(alert_channel_id),
                check_on_join = VALUES(check_on_join),
                check_on_message = VALUES(check_on_message),
                auto_aggregate_opt_in = VALUES(auto_aggregate_opt_in),
                exempt_roles = VALUES(exempt_roles)
        `, [
            req.guildId,
            enabled ? 1 : 0,
            action_critical || 'ban',
            action_high || 'ban',
            action_medium || 'kick',
            action_low || 'alert',
            alert_channel_id || null,
            check_on_join ? 1 : 0,
            check_on_message ? 1 : 0,
            auto_aggregate_opt_in ? 1 : 0,
            JSON.stringify(exempt_roles || [])
        ]);

        res.json({ success: true, message: 'Global ban config updated' });
    } catch (error) {
        logger.error('[API GlobalBan Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update global ban config' });
    }
});

/**
 * GET /:guildId/global-ban/entries
 * Get paginated global ban entries (read-only for guild admins)
 */
router.get('/:guildId/global-ban/entries', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { page = 1, limit = 25, severity, category, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = 'SELECT * FROM global_ban_entries WHERE active = 1';
        const params = [];

        if (severity) {
            query += ' AND severity = ?';
            params.push(severity);
        }
        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }
        if (search) {
            query += ' AND user_id = ?';
            params.push(search);
        }

        // Get total count
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [countResult] = await pool.execute(countQuery, params);

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [entries] = await pool.execute(query, params);

        res.json({
            success: true,
            entries,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / parseInt(limit))
            }
        });
    } catch (error) {
        logger.error('[API GlobalBan Entries GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch global ban entries' });
    }
});

/**
 * GET /:guildId/global-ban/action-log
 * Get action log for this guild
 */
router.get('/:guildId/global-ban/action-log', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { page = 1, limit = 25 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const [logs] = await pool.execute(
            `SELECT * FROM global_ban_action_log
             WHERE guild_id = ?
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [req.guildId, parseInt(limit), offset]
        );

        const [[countResult]] = await pool.execute(
            'SELECT COUNT(*) as total FROM global_ban_action_log WHERE guild_id = ?',
            [req.guildId]
        );

        res.json({
            success: true,
            logs,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult.total,
                pages: Math.ceil(countResult.total / parseInt(limit))
            }
        });
    } catch (error) {
        logger.error('[API GlobalBan ActionLog GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch action log' });
    }
});

/**
 * GET /:guildId/global-ban/stats
 * Get global ban statistics
 */
router.get('/:guildId/global-ban/stats', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [[totalActive]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_entries WHERE active = 1');
        const [[pendingReports]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_reports WHERE status = "pending"');
        const [[pendingAppeals]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_appeals WHERE status IN ("pending","under_review")');
        const [[enabledGuilds]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_config WHERE enabled = 1');
        const [[guildActions]] = await pool.execute(
            'SELECT COUNT(*) as count FROM global_ban_action_log WHERE guild_id = ?',
            [req.guildId]
        );

        const [bySeverity] = await pool.execute(
            'SELECT severity, COUNT(*) as count FROM global_ban_entries WHERE active = 1 GROUP BY severity'
        );
        const [byCategory] = await pool.execute(
            'SELECT category, COUNT(*) as count FROM global_ban_entries WHERE active = 1 GROUP BY category ORDER BY count DESC LIMIT 5'
        );

        res.json({
            success: true,
            stats: {
                activeEntries: totalActive.count,
                pendingReports: pendingReports.count,
                pendingAppeals: pendingAppeals.count,
                enabledGuilds: enabledGuilds.count,
                guildActions: guildActions.count,
                bySeverity,
                byCategory
            }
        });
    } catch (error) {
        logger.error('[API GlobalBan Stats GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

/**
 * GET /:guildId/global-ban/lookup/:userId
 * Look up a specific user's global ban record
 */
router.get('/:guildId/global-ban/lookup/:userId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { userId } = req.params;

        const [entries] = await pool.execute(
            'SELECT * FROM global_ban_entries WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        const [reports] = await pool.execute(
            'SELECT * FROM global_ban_reports WHERE target_user_id = ? ORDER BY created_at DESC LIMIT 10',
            [userId]
        );
        const [aggregateData] = await pool.execute(
            `SELECT action_type, COUNT(DISTINCT guild_id) as guild_count, COUNT(*) as total
             FROM global_ban_auto_aggregate WHERE user_id = ?
             GROUP BY action_type`,
            [userId]
        );

        res.json({
            success: true,
            record: { entries, reports, aggregateData }
        });
    } catch (error) {
        logger.error('[API GlobalBan Lookup GET] Error:', error);
        res.status(500).json({ error: 'Failed to look up user' });
    }
});

export default router;
