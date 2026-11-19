import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import configCache from '../../../utils/configCache.js';
import { normaliseMode, normaliseThreshold, DEFAULT_THRESHOLD } from '../../../core/global-ban-confidence.js';
import { logFeatureEvent, userLabel } from '../../../core/feature-log.js';
import { liveConfigAccess } from '../../../core/protection-exempt.js';

/*
 * Global Ban page API. Since migration 329: the server's mode (protect | alert | feed) and confidence
 * threshold, a privacy-safe network check for one user (/check/:userId — the same as `/globalban check`)
 * and network stats (/network — the same as `/globalban stats`). Config saves are partial: a field the
 * request leaves out keeps its value (the page used to wipe the exempt roles on every save).
 */
const router = express.Router();
const SNOWFLAKE = /^\d{15,25}$/;
const ACTIONS = ['ban', 'kick', 'alert', 'none'];
const managerFor = (req) => req.guildObject?.client?.globalBanManager || null;

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
                exempt_roles: '[]',
                mode: 'protect',
                confidence_threshold: DEFAULT_THRESHOLD
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
        // Judged live (owner, Administrator, Manage Server or a bot-manager role), not from the login.
        if (!req.isSuperAdmin && req.guildObject) {
            const a = await liveConfigAccess(req.guildObject, req.user.id);
            if (!a.ok) return res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
        }
        const b = req.body || {};
        const sets = [];
        const vals = [];
        const put = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };
        const flag = (v) => (v ? 1 : 0);

        if (b.enabled !== undefined) put('enabled', flag(b.enabled));
        for (const col of ['action_critical', 'action_high', 'action_medium', 'action_low']) {
            if (b[col] !== undefined) {
                if (!ACTIONS.includes(b[col])) return res.status(400).json({ error: `Unknown action for ${col}.` });
                put(col, b[col]);
            }
        }
        if (b.alert_channel_id !== undefined) {
            const ch = b.alert_channel_id ? String(b.alert_channel_id) : null;
            if (ch && !SNOWFLAKE.test(ch)) return res.status(400).json({ error: 'Bad alert channel.' });
            put('alert_channel_id', ch);
        }
        if (b.check_on_join !== undefined) put('check_on_join', flag(b.check_on_join));
        if (b.check_on_message !== undefined) put('check_on_message', flag(b.check_on_message));
        if (b.auto_aggregate_opt_in !== undefined) put('auto_aggregate_opt_in', flag(b.auto_aggregate_opt_in));
        if (b.exempt_roles !== undefined) {
            const roles = Array.isArray(b.exempt_roles) ? b.exempt_roles.map(String).filter(r => SNOWFLAKE.test(r)) : [];
            put('exempt_roles', JSON.stringify(roles));
        }
        if (b.mode !== undefined) put('mode', normaliseMode(b.mode));
        if (b.confidence_threshold !== undefined) put('confidence_threshold', normaliseThreshold(b.confidence_threshold));
        if (!sets.length) return res.status(400).json({ error: 'Nothing to save.' });

        const [[before]] = await pool.execute('SELECT mode, confidence_threshold FROM global_ban_config WHERE guild_id = ?', [req.guildId]);
        await pool.execute('INSERT IGNORE INTO global_ban_config (guild_id) VALUES (?)', [req.guildId]);
        await pool.execute(`UPDATE global_ban_config SET ${sets.join(', ')} WHERE guild_id = ?`, [...vals, req.guildId]);
        configCache.invalidate('global_ban_config', req.guildId);
        configCache.invalidate('global_ban_config_any', req.guildId);

        const [[after]] = await pool.execute('SELECT mode, confidence_threshold FROM global_ban_config WHERE guild_id = ?', [req.guildId]);
        if (req.guildObject && after && (!before || before.mode !== after.mode || before.confidence_threshold !== after.confidence_threshold)) {
            void logFeatureEvent(() => (req.guildObject), 'moderation.globalBanSettings', () => ({
                title: '🌐 Global Ban Mode Changed',
                fields: [['Mode', after.mode], ['Threshold', after.mode === 'protect' ? String(after.confidence_threshold) : null],
                    ['By', `${userLabel(req.user.id)} (dashboard)`]],
            }));
        }
        logger.info(`[API GlobalBan Config PUT] ${req.user.username} saved ${sets.length} setting(s) in ${req.guildId}`);
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

        // Who reported is private to the network: only super-admins see reporters and their servers.
        const safeReports = req.isSuperAdmin ? reports : reports.map(r => ({
            id: r.id, category: r.category, severity: r.severity, status: r.status, created_at: r.created_at,
        }));
        res.json({
            success: true,
            record: { entries, reports: safeReports, aggregateData }
        });
    } catch (error) {
        logger.error('[API GlobalBan Lookup GET] Error:', error);
        res.status(500).json({ error: 'Failed to look up user' });
    }
});

/**
 * GET /:guildId/global-ban/check/:userId
 * Privacy-safe network check: confidence, independent servers, kinds of source and reasons, and what
 * this server's mode would do — never which servers reported or who moderated (as `/globalban check`).
 */
router.get('/:guildId/global-ban/check/:userId', ensureAuth, ensureGuildPerms, async (req, res) => {
    const userId = String(req.params.userId || '').replace(/[<@!>]/g, '');
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'Give a user ID.' });
    const manager = managerFor(req);
    if (!manager) return res.status(503).json({ error: 'The global ban system is not running on this bot.' });
    try {
        const check = await manager.getNetworkCheck(userId, req.guildId);
        const user = await req.guildObject.client.users.fetch(userId).catch(() => null);
        res.json({
            success: true,
            user: user ? { id: user.id, username: user.username, avatar: user.displayAvatarURL({ size: 64 }) } : { id: userId },
            check,
        });
    } catch (error) {
        logger.error('[API GlobalBan Check GET] Error:', error);
        res.status(500).json({ error: 'Failed to check this user' });
    }
});

/**
 * GET /:guildId/global-ban/network
 * Network size, recent additions, modes in use, and this server's own contribution and actions.
 */
router.get('/:guildId/global-ban/network', ensureAuth, ensureGuildPerms, async (req, res) => {
    const manager = managerFor(req);
    if (!manager) return res.status(503).json({ error: 'The global ban system is not running on this bot.' });
    try {
        const stats = await manager.getNetworkStats(req.guildId);
        res.json({ success: true, stats });
    } catch (error) {
        logger.error('[API GlobalBan Network GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch network stats' });
    }
});

export default router;
