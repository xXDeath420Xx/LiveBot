/**
 * Tokes Bot Admin API Routes
 * Analytics, Moderation, Events, Webhooks, User Management
 */

import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireTokesAuth } from './auth-tokes-bot.js';
import crypto from 'crypto';

const router = express.Router();

// Owner IDs from environment
const TOKES_OWNER_ID = process.env.TOKES_OWNER_ID;
const TOKES_KICK_OWNER_ID = process.env.TOKES_KICK_OWNER_ID;

/**
 * Check if user is Tokes Bot owner
 */
function isTokesOwner(platformId) {
    const id = String(platformId);
    if (TOKES_OWNER_ID && id === String(TOKES_OWNER_ID)) return true;
    if (TOKES_KICK_OWNER_ID && id === String(TOKES_KICK_OWNER_ID)) return true;
    return false;
}

// Admin session timeout: 30 minutes of inactivity
const ADMIN_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

/**
 * Middleware: Require owner access
 * Includes 30-minute inactivity timeout for admin sessions
 */
async function requireOwner(req, res, next) {
    if (!req.session?.tokesUser) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = req.session.tokesUser;

    // Check admin session timeout (30 min inactivity)
    const lastActivity = req.session.lastActivity || 0;
    const now = Date.now();

    if (lastActivity && (now - lastActivity) > ADMIN_SESSION_TIMEOUT) {
        // Session timed out - log the timeout event
        try {
            await pool.execute(
                `INSERT INTO tokes_session_logs (user_id, session_id, event_type, ip_address, details)
                 VALUES (?, ?, 'timeout', ?, 'Admin API session timed out after 30 minutes of inactivity')`,
                [user.id, req.sessionID, req.ip || req.connection?.remoteAddress]
            );
        } catch (logError) {
            logger.error('[Tokes Admin API] Failed to log session timeout', { error: logError.message });
        }

        // Destroy the session
        req.session.destroy((err) => {
            if (err) logger.error('[Tokes Admin API] Session destroy error', { error: err.message });
        });

        logger.info('[Tokes Admin API] Admin session timed out', { user: user.name, userId: user.id });
        return res.status(401).json({ error: 'Session timed out', reason: 'timeout' });
    }

    // Update last activity timestamp
    req.session.lastActivity = now;

    if (!isTokesOwner(user.platformId)) {
        return res.status(403).json({ error: 'Owner access required' });
    }
    next();
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Resolve a user by userId OR username (primary_name / platform_name)
 * Returns { id, primary_name, role } or null
 */
async function resolveUser(identifier) {
    if (!identifier) return null;

    const id = String(identifier).trim();

    // Try numeric ID first
    if (/^\d+$/.test(id)) {
        const [[user]] = await pool.execute(
            'SELECT id, primary_name, role FROM tokes_users WHERE id = ?',
            [id]
        );
        if (user) return user;
    }

    // Try primary_name (case-insensitive)
    const [[byName]] = await pool.execute(
        'SELECT id, primary_name, role FROM tokes_users WHERE LOWER(primary_name) = LOWER(?)',
        [id]
    );
    if (byName) return byName;

    // Try platform_name in connections (case-insensitive)
    const [[byPlatform]] = await pool.execute(
        `SELECT u.id, u.primary_name, u.role
         FROM tokes_users u
         JOIN tokes_platform_connections pc ON pc.user_id = u.id
         WHERE LOWER(pc.platform_name) = LOWER(?)
         LIMIT 1`,
        [id]
    );
    if (byPlatform) return byPlatform;

    return null;
}

// ============================================================
// ADMIN OVERVIEW API
// ============================================================

/**
 * GET /tokes-bot/api/admin/stats
 * Get admin overview stats (for admin.ejs dashboard)
 */
router.get('/tokes-bot/api/admin/stats', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [[stats]] = await pool.execute(`
            SELECT
                (SELECT COUNT(*) FROM tokes_users) as totalUsers,
                (SELECT COUNT(*) FROM tokes_channels WHERE is_enabled = 1) as activeChannels,
                (SELECT COALESCE(SUM(cs.tokes), 0) FROM tokes_channel_stats cs
                 JOIN tokes_channels c ON cs.channel_id = c.id WHERE c.is_enabled = 1) as totalTokes,
                (SELECT COUNT(*) FROM tokes_web_sessions WHERE expires_at > NOW()) as activeSessions
        `);
        res.json(stats);
    } catch (error) {
        logger.error('[Tokes Admin] Stats error', { error: error.message });
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

/**
 * GET /tokes-bot/api/admin/activity
 * Get recent activity log (for admin.ejs dashboard)
 * Query params: limit (default 20), event_type (filter), channel (filter)
 */
router.get('/tokes-bot/api/admin/activity', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { limit = 20, event_type, channel } = req.query;
        const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);

        let query = `
            SELECT
                al.id,
                al.event_type as action,
                al.actor as username,
                al.details,
                al.platform,
                al.logged_at as created_at,
                c.channel_name
            FROM tokes_activity_log al
            LEFT JOIN tokes_channels c ON al.channel_id = c.id
            WHERE (c.is_enabled = 1 OR al.channel_id IS NULL)
        `;
        const params = [];

        if (event_type) {
            query += ' AND al.event_type = ?';
            params.push(event_type);
        }

        if (channel) {
            query += ' AND c.channel_name = ?';
            params.push(channel);
        }

        query += ' ORDER BY al.logged_at DESC LIMIT ?';
        params.push(safeLimit);

        const [activity] = await pool.execute(query, params);
        res.json({ activity });
    } catch (error) {
        logger.error('[Tokes Admin] Activity error', { error: error.message });
        res.status(500).json({ error: 'Failed to load activity' });
    }
});

/**
 * GET /tokes-bot/api/admin/commands
 * Get all commands for admin management
 */
router.get('/tokes-bot/api/admin/commands', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [commands] = await pool.execute(`
            SELECT * FROM tokes_global_command_config
            ORDER BY category, command_key
        `);
        res.json({ commands });
    } catch (error) {
        logger.error('[Tokes Admin] Commands list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load commands' });
    }
});

// ============================================================
// ANALYTICS API
// ============================================================

/**
 * GET /tokes-bot/api/admin/analytics/overview
 * Get analytics overview stats
 */
router.get('/tokes-bot/api/admin/analytics/overview', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { days = 7 } = req.query;

        // Get overview stats - scoped to authenticated users and active channels
        const [[stats]] = await pool.execute(`
            SELECT
                (SELECT COUNT(*) FROM tokes_users) as total_users,
                (SELECT COUNT(*) FROM tokes_users WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) as new_users,
                (SELECT COUNT(*) FROM tokes_channels WHERE is_enabled = 1) as active_channels,
                (SELECT COALESCE(SUM(cs.tokes), 0) FROM tokes_channel_stats cs
                 JOIN tokes_channels c ON cs.channel_id = c.id WHERE c.is_enabled = 1) as total_tokes,
                (SELECT COUNT(*) FROM tokes_sessions s
                 JOIN tokes_channels c ON s.channel_id = c.id
                 WHERE s.status = 'active' AND c.is_enabled = 1) as active_sessions,
                (SELECT COUNT(*) FROM tokes_activity_log al
                 JOIN tokes_channels c ON al.channel_id = c.id
                 WHERE al.logged_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND c.is_enabled = 1) as activity_24h,
                (SELECT COUNT(DISTINCT al.actor) FROM tokes_activity_log al
                 JOIN tokes_channels c ON al.channel_id = c.id
                 WHERE al.logged_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND al.actor IS NOT NULL AND c.is_enabled = 1) as active_users_24h
        `, [days]);

        // Get daily activity for chart - scoped to active channels
        const [dailyActivity] = await pool.execute(`
            SELECT
                DATE(al.logged_at) as date,
                COUNT(*) as events,
                COUNT(DISTINCT al.actor) as unique_users
            FROM tokes_activity_log al
            JOIN tokes_channels c ON al.channel_id = c.id
            WHERE al.logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND c.is_enabled = 1
            GROUP BY DATE(al.logged_at)
            ORDER BY date ASC
        `, [days]);

        // Get hourly distribution for heatmap - scoped to active channels
        const [hourlyDistribution] = await pool.execute(`
            SELECT
                DAYOFWEEK(al.logged_at) as day_of_week,
                HOUR(al.logged_at) as hour,
                COUNT(*) as count
            FROM tokes_activity_log al
            JOIN tokes_channels c ON al.channel_id = c.id
            WHERE al.logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND c.is_enabled = 1
            GROUP BY DAYOFWEEK(al.logged_at), HOUR(al.logged_at)
        `, [days]);

        // Get top commands - scoped to active channels
        const [topCommands] = await pool.execute(`
            SELECT
                al.event_type as command,
                COUNT(*) as usage_count,
                COUNT(DISTINCT al.actor) as unique_users
            FROM tokes_activity_log al
            JOIN tokes_channels c ON al.channel_id = c.id
            WHERE al.logged_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                AND al.event_type NOT IN ('error', 'join', 'leave', 'system')
                AND c.is_enabled = 1
            GROUP BY al.event_type
            ORDER BY usage_count DESC
            LIMIT 10
        `, [days]);

        res.json({
            stats,
            dailyActivity,
            hourlyDistribution,
            topCommands
        });

    } catch (error) {
        logger.error('[Tokes Admin] Analytics overview error', { error: error.message });
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

/**
 * GET /tokes-bot/api/admin/analytics/realtime
 * Get real-time activity feed
 */
router.get('/tokes-bot/api/admin/analytics/realtime', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { limit = 50 } = req.query;

        // Only show activity from enabled channels
        const [activity] = await pool.execute(`
            SELECT
                al.id,
                al.event_type,
                al.actor,
                al.details,
                al.logged_at,
                c.channel_name,
                c.platform
            FROM tokes_activity_log al
            JOIN tokes_channels c ON al.channel_id = c.id
            WHERE c.is_enabled = 1
            ORDER BY al.logged_at DESC
            LIMIT ?
        `, [parseInt(limit)]);

        res.json({ activity });

    } catch (error) {
        logger.error('[Tokes Admin] Realtime activity error', { error: error.message });
        res.status(500).json({ error: 'Failed to load activity' });
    }
});

/**
 * GET /tokes-bot/api/admin/analytics/retention
 * Get user retention metrics
 */
router.get('/tokes-bot/api/admin/analytics/retention', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        // Calculate cohort retention
        const [cohorts] = await pool.execute(`
            SELECT
                DATE(u.created_at) as cohort_date,
                COUNT(DISTINCT u.id) as cohort_size,
                COUNT(DISTINCT CASE WHEN al.logged_at >= DATE_ADD(u.created_at, INTERVAL 1 DAY) THEN u.id END) as day1,
                COUNT(DISTINCT CASE WHEN al.logged_at >= DATE_ADD(u.created_at, INTERVAL 7 DAY) THEN u.id END) as day7,
                COUNT(DISTINCT CASE WHEN al.logged_at >= DATE_ADD(u.created_at, INTERVAL 30 DAY) THEN u.id END) as day30
            FROM tokes_users u
            LEFT JOIN tokes_platform_connections pc ON u.id = pc.user_id
            LEFT JOIN tokes_activity_log al ON pc.platform_id = al.platform_user_id
            WHERE u.created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)
            GROUP BY DATE(u.created_at)
            ORDER BY cohort_date DESC
            LIMIT 30
        `);

        res.json({ cohorts });

    } catch (error) {
        logger.error('[Tokes Admin] Retention metrics error', { error: error.message });
        res.status(500).json({ error: 'Failed to load retention data' });
    }
});

// ============================================================
// MODERATION API
// ============================================================

/**
 * GET /tokes-bot/api/admin/moderation/queue
 * Get moderation queue items
 */
router.get('/tokes-bot/api/admin/moderation/queue', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { status = 'pending', type = null, limit = 50 } = req.query;

        let query = `
            SELECT
                mq.*,
                u.primary_name as submitter_name
            FROM tokes_moderation_queue mq
            LEFT JOIN tokes_users u ON mq.submitted_by = u.id
            WHERE mq.status = ?
        `;
        const params = [status];

        if (type) {
            query += ' AND mq.content_type = ?';
            params.push(type);
        }

        query += ' ORDER BY mq.priority ASC, mq.submitted_at ASC LIMIT ?';
        params.push(parseInt(limit));

        const [items] = await pool.execute(query, params);

        // Get counts by type
        const [[counts]] = await pool.execute(`
            SELECT
                SUM(CASE WHEN content_type = 'thought' THEN 1 ELSE 0 END) as thoughts,
                SUM(CASE WHEN content_type = 'trivia' THEN 1 ELSE 0 END) as trivia,
                SUM(CASE WHEN content_type = 'strain' THEN 1 ELSE 0 END) as strains,
                SUM(CASE WHEN content_type = 'report' THEN 1 ELSE 0 END) as reports
            FROM tokes_moderation_queue
            WHERE status = 'pending'
        `);

        res.json({ items, counts });

    } catch (error) {
        logger.error('[Tokes Admin] Moderation queue error', { error: error.message });
        res.status(500).json({ error: 'Failed to load moderation queue' });
    }
});

/**
 * POST /tokes-bot/api/admin/moderation/queue/:id/review
 * Review a moderation queue item
 */
router.post('/tokes-bot/api/admin/moderation/queue/:id/review', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { action, notes } = req.body;
        const userId = req.session.tokesUser.id;

        if (!['approved', 'rejected'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action' });
        }

        // Get the queue item
        const [[item]] = await pool.execute(
            'SELECT * FROM tokes_moderation_queue WHERE id = ?',
            [id]
        );

        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }

        // Update queue status
        await pool.execute(`
            UPDATE tokes_moderation_queue
            SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_notes = ?
            WHERE id = ?
        `, [action, userId, notes || null, id]);

        // If approved, apply the content
        if (action === 'approved') {
            const contentData = JSON.parse(item.content_data);

            switch (item.content_type) {
                case 'thought':
                    await pool.execute(
                        'UPDATE tokes_thoughts SET approved = 1, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?',
                        [userId, item.content_id]
                    );
                    break;
                case 'trivia':
                    await pool.execute(`
                        INSERT INTO tokes_trivia_questions (question, correct_answer, wrong_answer_1, wrong_answer_2, wrong_answer_3, category)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [contentData.question, contentData.correct, contentData.wrong1, contentData.wrong2, contentData.wrong3, contentData.category || 'general']);
                    break;
                case 'strain':
                    await pool.execute(`
                        INSERT INTO tokes_strains (name, type, thc_percent, cbd_percent, effects, flavors, description)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `, [contentData.name, contentData.type, contentData.thc, contentData.cbd, contentData.effects, contentData.flavors, contentData.description]);
                    break;
            }
        }

        logger.info('[Tokes Admin] Moderation review', { itemId: id, action, by: userId });

        res.json({ success: true, action });

    } catch (error) {
        logger.error('[Tokes Admin] Moderation review error', { error: error.message });
        res.status(500).json({ error: 'Failed to review item' });
    }
});

/**
 * GET /tokes-bot/api/admin/moderation/thoughts
 * Get thoughts for moderation
 */
router.get('/tokes-bot/api/admin/moderation/thoughts', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { status = 'pending' } = req.query;

        const approved = status === 'approved' ? 1 : 0;

        const [thoughts] = await pool.execute(`
            SELECT
                t.id,
                t.thought as content,
                t.submitted_by,
                t.is_approved,
                t.times_shown,
                t.created_at as submitted_at,
                t.reported_count,
                t.reviewed_by,
                t.reviewed_at,
                t.submitted_by as submitter_name
            FROM tokes_thoughts t
            WHERE t.is_approved = ?
            ORDER BY t.created_at DESC
            LIMIT 100
        `, [approved]);

        res.json({ thoughts });

    } catch (error) {
        logger.error('[Tokes Admin] Thoughts list error', { error: error.message, stack: error.stack });
        console.error('[Tokes Admin] Thoughts error:', error);
        res.status(500).json({ error: 'Failed to load thoughts: ' + error.message });
    }
});

/**
 * POST /tokes-bot/api/admin/moderation/thoughts/:id/approve
 * Approve or reject a thought
 */
router.post('/tokes-bot/api/admin/moderation/thoughts/:id/approve', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { approved } = req.body;
        const userId = req.session.tokesUser.id;

        await pool.execute(`
            UPDATE tokes_thoughts
            SET is_approved = ?, reviewed_by = ?, reviewed_at = NOW()
            WHERE id = ?
        `, [approved ? 1 : 0, userId, id]);

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Thought approve error', { error: error.message });
        res.status(500).json({ error: 'Failed to update thought' });
    }
});

// ============================================================
// USER MANAGEMENT API
// ============================================================

/**
 * GET /tokes-bot/api/admin/users/stats
 * Get user statistics broken down by platform
 */
router.get('/tokes-bot/api/admin/users/stats', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        // Get platform-specific user counts
        const [[platformStats]] = await pool.execute(`
            SELECT
                (SELECT COUNT(*) FROM tokes_users) as total_users,
                (SELECT COUNT(DISTINCT user_id) FROM tokes_platform_connections WHERE platform = 'twitch') as twitch_users,
                (SELECT COUNT(DISTINCT user_id) FROM tokes_platform_connections WHERE platform = 'kick') as kick_users,
                (SELECT COUNT(DISTINCT user_id) FROM tokes_platform_connections pc1
                 WHERE EXISTS (SELECT 1 FROM tokes_platform_connections pc2 WHERE pc2.user_id = pc1.user_id AND pc2.platform = 'twitch')
                 AND EXISTS (SELECT 1 FROM tokes_platform_connections pc3 WHERE pc3.user_id = pc1.user_id AND pc3.platform = 'kick')
                ) as linked_both,
                (SELECT COUNT(*) FROM tokes_users WHERE role = 'banned') as banned_users,
                (SELECT COUNT(*) FROM tokes_users WHERE role = 'admin' OR role = 'owner') as admin_users,
                (SELECT COUNT(*) FROM tokes_users WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) as new_users_7d,
                (SELECT COUNT(*) FROM tokes_users WHERE last_seen > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as active_24h
        `);

        // Get top users by platform (aggregated per user, filtered by platform)
        const [topTwitchUsers] = await pool.execute(`
            SELECT u.id, u.primary_name,
                   MAX(pc.platform_avatar) as platform_avatar,
                   SUM(COALESCE(p.lifetime_tokes, 0)) as lifetime_tokes,
                   MAX(COALESCE(p.level, 1)) as level
            FROM tokes_users u
            JOIN tokes_platform_connections pc ON pc.user_id = u.id AND pc.platform = 'twitch'
            LEFT JOIN tokes_profiles p ON p.claimed_by_user_id = u.id AND p.is_claimed = 1 AND p.platform = 'twitch'
            GROUP BY u.id, u.primary_name
            ORDER BY lifetime_tokes DESC
            LIMIT 5
        `);

        const [topKickUsers] = await pool.execute(`
            SELECT u.id, u.primary_name,
                   MAX(pc.platform_avatar) as platform_avatar,
                   SUM(COALESCE(p.lifetime_tokes, 0)) as lifetime_tokes,
                   MAX(COALESCE(p.level, 1)) as level
            FROM tokes_users u
            JOIN tokes_platform_connections pc ON pc.user_id = u.id AND pc.platform = 'kick'
            LEFT JOIN tokes_profiles p ON p.claimed_by_user_id = u.id AND p.is_claimed = 1 AND p.platform = 'kick'
            GROUP BY u.id, u.primary_name
            ORDER BY lifetime_tokes DESC
            LIMIT 5
        `);

        res.json({
            stats: platformStats,
            topTwitchUsers,
            topKickUsers
        });

    } catch (error) {
        logger.error('[Tokes Admin] User stats error', { error: error.message });
        res.status(500).json({ error: 'Failed to load user stats' });
    }
});

/**
 * GET /tokes-bot/api/admin/users
 * Search and list users - ONE ROW PER USER PER PLATFORM
 */
router.get('/tokes-bot/api/admin/users', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { search, sort = 'created_at', order = 'DESC', limit = 50, offset = 0, platform } = req.query;

        // Query: one row per user per platform with that platform's specific stats
        let query = `
            SELECT
                u.id,
                u.primary_name,
                u.email,
                u.role,
                u.created_at,
                u.last_seen,
                pc.platform,
                pc.platform_name,
                pc.platform_avatar,
                COALESCE(p.lifetime_tokes, 0) as lifetime_tokes,
                COALESCE(p.level, 1) as level,
                COALESCE(p.current_streak, 0) as current_streak
            FROM tokes_users u
            JOIN tokes_platform_connections pc ON pc.user_id = u.id
            LEFT JOIN tokes_profiles p ON p.claimed_by_user_id = u.id AND p.is_claimed = 1 AND p.platform = pc.platform
        `;

        const params = [];
        const conditions = [];

        if (search) {
            conditions.push('(u.primary_name LIKE ? OR pc.platform_name LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        // Platform filter
        if (platform && ['twitch', 'kick'].includes(platform.toLowerCase())) {
            conditions.push('pc.platform = ?');
            params.push(platform.toLowerCase());
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        // Group by user + platform to get one row per user per platform
        query += ' GROUP BY u.id, pc.platform';

        // Validate sort column
        const validSorts = ['created_at', 'last_seen', 'lifetime_tokes', 'level', 'primary_name'];
        const sortCol = validSorts.includes(sort) ? sort : 'created_at';
        const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        query += ` ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [users] = await pool.execute(query, params);

        // Format for frontend - single platform per row
        const processedUsers = users.map(user => ({
            ...user,
            platforms: [{ platform: user.platform, platform_name: user.platform_name, platform_avatar: user.platform_avatar }]
        }));

        // Get total count (user-platform combinations)
        let countQuery = `
            SELECT COUNT(*) as total
            FROM (
                SELECT u.id, pc.platform
                FROM tokes_users u
                JOIN tokes_platform_connections pc ON pc.user_id = u.id
        `;
        const countParams = [];

        if (search || platform) {
            countQuery += ' WHERE ';
            const countConditions = [];
            if (search) {
                countConditions.push('(u.primary_name LIKE ? OR pc.platform_name LIKE ?)');
                countParams.push(`%${search}%`, `%${search}%`);
            }
            if (platform && ['twitch', 'kick'].includes(platform.toLowerCase())) {
                countConditions.push('pc.platform = ?');
                countParams.push(platform.toLowerCase());
            }
            countQuery += countConditions.join(' AND ');
        }
        countQuery += ' GROUP BY u.id, pc.platform) as subq';

        const [[{ total }]] = await pool.execute(countQuery, countParams);

        res.json({ users: processedUsers, total });

    } catch (error) {
        logger.error('[Tokes Admin] User list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load users' });
    }
});

/**
 * GET /tokes-bot/api/admin/users/:id
 * Get detailed user info
 */
router.get('/tokes-bot/api/admin/users/:id', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;

        // Get user details
        const [[user]] = await pool.execute(`
            SELECT u.*, p.*
            FROM tokes_users u
            LEFT JOIN tokes_profiles p ON p.claimed_by_user_id = u.id AND p.is_claimed = 1
            WHERE u.id = ?
        `, [id]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get platform connections
        const [connections] = await pool.execute(
            'SELECT * FROM tokes_platform_connections WHERE user_id = ?',
            [id]
        );

        // Get channels owned
        const [channels] = await pool.execute(
            'SELECT * FROM tokes_channels WHERE owner_id = ?',
            [id]
        );

        // Get recent activity
        const [activity] = await pool.execute(`
            SELECT al.*
            FROM tokes_activity_log al
            JOIN tokes_platform_connections pc ON al.platform_user_id = pc.platform_id
            WHERE pc.user_id = ?
            ORDER BY al.logged_at DESC
            LIMIT 50
        `, [id]);

        // Get moderation history
        const [moderationHistory] = await pool.execute(
            'SELECT * FROM tokes_moderation_actions WHERE user_id = ? ORDER BY issued_at DESC',
            [id]
        );

        res.json({
            user,
            connections,
            channels,
            activity,
            moderationHistory
        });

    } catch (error) {
        logger.error('[Tokes Admin] User detail error', { error: error.message });
        res.status(500).json({ error: 'Failed to load user' });
    }
});

/**
 * POST /tokes-bot/api/admin/users/:id/action
 * Perform moderation action on user
 */
router.post('/tokes-bot/api/admin/users/:id/action', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { action, reason, duration } = req.body;
        const adminId = req.session.tokesUser.id;

        const validActions = ['warning', 'mute', 'ban', 'unban', 'stat_reset', 'note'];
        if (!validActions.includes(action)) {
            return res.status(400).json({ error: 'Invalid action' });
        }

        // Calculate expiry for temporary actions
        let expiresAt = null;
        if (duration && ['mute', 'ban'].includes(action)) {
            expiresAt = new Date(Date.now() + duration * 1000);
        }

        // Record the action
        await pool.execute(`
            INSERT INTO tokes_moderation_actions (user_id, action_type, reason, issued_by, expires_at)
            VALUES (?, ?, ?, ?, ?)
        `, [id, action, reason || null, adminId, expiresAt]);

        // Apply the action
        if (action === 'stat_reset') {
            await pool.execute(`
                UPDATE tokes_profiles
                SET lifetime_tokes = 0, daily_tokes = 0, level = 1, xp = 0, current_streak = 0
                WHERE claimed_by_user_id = ?
            `, [id]);
        } else if (action === 'ban') {
            await pool.execute('UPDATE tokes_users SET role = ? WHERE id = ?', ['banned', id]);
        } else if (action === 'unban') {
            await pool.execute('UPDATE tokes_users SET role = ? WHERE id = ?', ['user', id]);
            await pool.execute(
                'UPDATE tokes_moderation_actions SET is_active = 0 WHERE user_id = ? AND action_type = ?',
                [id, 'ban']
            );
        }

        logger.info('[Tokes Admin] User moderation action', { userId: id, action, by: adminId });

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] User action error', { error: error.message });
        res.status(500).json({ error: 'Failed to perform action' });
    }
});

// ============================================================
// DEDICATED BAN / UNBAN API
// ============================================================

/**
 * POST /tokes-bot/api/admin/ban
 * Ban a user by ID or username
 * Body: { user (ID or username), reason?, duration? (seconds, omit for permanent) }
 */
router.post('/tokes-bot/api/admin/ban', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { user: userIdentifier, userId, reason, duration } = req.body;
        const adminId = req.session.tokesUser.id;
        const lookup = userIdentifier || userId;

        if (!lookup) {
            return res.status(400).json({ error: 'user is required (ID or username)' });
        }

        const targetUser = await resolveUser(lookup);

        if (!targetUser) {
            return res.status(404).json({ error: `User not found: ${lookup}` });
        }

        if (String(targetUser.id) === String(adminId)) {
            return res.status(400).json({ error: 'Cannot ban yourself' });
        }

        if (targetUser.role === 'banned') {
            return res.status(409).json({ error: `${targetUser.primary_name} is already banned` });
        }

        if (targetUser.role === 'owner') {
            return res.status(403).json({ error: 'Cannot ban an owner' });
        }

        // Calculate expiry for temporary bans
        let expiresAt = null;
        if (duration && Number.isFinite(Number(duration)) && Number(duration) > 0) {
            expiresAt = new Date(Date.now() + Number(duration) * 1000);
        }

        // Record the moderation action
        await pool.execute(`
            INSERT INTO tokes_moderation_actions (user_id, action_type, reason, issued_by, expires_at)
            VALUES (?, 'ban', ?, ?, ?)
        `, [targetUser.id, reason || null, adminId, expiresAt]);

        // Apply the ban
        await pool.execute('UPDATE tokes_users SET role = ? WHERE id = ?', ['banned', targetUser.id]);

        logger.info('[Tokes Admin] User banned', {
            userId: targetUser.id,
            userName: targetUser.primary_name,
            reason,
            duration: duration || 'permanent',
            by: adminId
        });

        res.json({
            success: true,
            message: `User ${targetUser.primary_name} has been banned`,
            user: { id: targetUser.id, name: targetUser.primary_name },
            permanent: !expiresAt,
            expiresAt: expiresAt || null
        });

    } catch (error) {
        logger.error('[Tokes Admin] Ban error', { error: error.message });
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

/**
 * POST /tokes-bot/api/admin/unban
 * Unban a user by ID or username
 * Body: { user (ID or username), reason? }
 */
router.post('/tokes-bot/api/admin/unban', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { user: userIdentifier, userId, reason } = req.body;
        const adminId = req.session.tokesUser.id;
        const lookup = userIdentifier || userId;

        if (!lookup) {
            return res.status(400).json({ error: 'user is required (ID or username)' });
        }

        const targetUser = await resolveUser(lookup);

        if (!targetUser) {
            return res.status(404).json({ error: `User not found: ${lookup}` });
        }

        if (targetUser.role !== 'banned') {
            return res.status(409).json({ error: `${targetUser.primary_name} is not banned` });
        }

        // Record the moderation action
        await pool.execute(`
            INSERT INTO tokes_moderation_actions (user_id, action_type, reason, issued_by)
            VALUES (?, 'unban', ?, ?)
        `, [targetUser.id, reason || null, adminId]);

        // Remove the ban
        await pool.execute('UPDATE tokes_users SET role = ? WHERE id = ?', ['user', targetUser.id]);

        // Deactivate all active ban records
        await pool.execute(
            'UPDATE tokes_moderation_actions SET is_active = 0 WHERE user_id = ? AND action_type = ? AND is_active = 1',
            [targetUser.id, 'ban']
        );

        logger.info('[Tokes Admin] User unbanned', {
            userId: targetUser.id,
            userName: targetUser.primary_name,
            reason,
            by: adminId
        });

        res.json({
            success: true,
            message: `User ${targetUser.primary_name} has been unbanned`,
            user: { id: targetUser.id, name: targetUser.primary_name }
        });

    } catch (error) {
        logger.error('[Tokes Admin] Unban error', { error: error.message });
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// ============================================================
// CHANNEL HEALTH API
// ============================================================

/**
 * GET /tokes-bot/api/admin/channels/health
 * Get channel health overview
 */
router.get('/tokes-bot/api/admin/channels/health', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [channels] = await pool.execute(`
            SELECT
                c.*,
                u.primary_name as owner_name,
                (SELECT COUNT(*) FROM tokes_activity_log WHERE channel_id = c.id AND logged_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) as activity_24h,
                (SELECT COUNT(*) FROM tokes_activity_log WHERE channel_id = c.id AND logged_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) as activity_7d,
                (SELECT MAX(logged_at) FROM tokes_activity_log WHERE channel_id = c.id) as last_activity
            FROM tokes_channels c
            LEFT JOIN tokes_users u ON c.owner_id = u.id
            ORDER BY c.health_score ASC, activity_24h DESC
        `);

        // Calculate health scores
        const channelsWithHealth = channels.map(ch => {
            let score = 100;
            const issues = [];

            // No activity in 24h = -20
            if (ch.activity_24h === 0) {
                score -= 20;
                issues.push('No activity in 24 hours');
            }

            // No activity in 7d = -40
            if (ch.activity_7d === 0) {
                score -= 40;
                issues.push('No activity in 7 days');
            }

            // Errors = -5 each
            if (ch.error_count_24h > 0) {
                score -= Math.min(ch.error_count_24h * 5, 30);
                issues.push(`${ch.error_count_24h} errors in 24h`);
            }

            // Not enabled = -10
            if (!ch.is_enabled) {
                score -= 10;
                issues.push('Bot disabled');
            }

            return {
                ...ch,
                calculated_health: Math.max(0, score),
                health_issues: issues
            };
        });

        res.json({ channels: channelsWithHealth });

    } catch (error) {
        logger.error('[Tokes Admin] Channel health error', { error: error.message });
        res.status(500).json({ error: 'Failed to load channel health' });
    }
});

// ============================================================
// EVENTS API
// ============================================================

/**
 * GET /tokes-bot/api/admin/events
 * List all events
 */
router.get('/tokes-bot/api/admin/events', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { status = 'all' } = req.query;

        let query = `
            SELECT e.*,
                (SELECT COUNT(*) FROM tokes_event_participants WHERE event_id = e.id) as participant_count
            FROM tokes_events e
        `;

        if (status === 'active') {
            query += ' WHERE e.is_active = 1 AND NOW() BETWEEN e.starts_at AND e.ends_at';
        } else if (status === 'upcoming') {
            query += ' WHERE e.starts_at > NOW()';
        } else if (status === 'ended') {
            query += ' WHERE e.ends_at < NOW()';
        }

        query += ' ORDER BY e.starts_at DESC';

        const [events] = await pool.execute(query);

        res.json({ events });

    } catch (error) {
        logger.error('[Tokes Admin] Events list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load events' });
    }
});

/**
 * POST /tokes-bot/api/admin/events
 * Create a new event
 */
router.post('/tokes-bot/api/admin/events', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { event_key, name, description, event_type, config, starts_at, ends_at } = req.body;
        const userId = req.session.tokesUser.id;

        if (!event_key || !name || !event_type || !starts_at || !ends_at) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const [result] = await pool.execute(`
            INSERT INTO tokes_events (event_key, name, description, event_type, config, starts_at, ends_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [event_key, name, description || null, event_type, JSON.stringify(config || {}), starts_at, ends_at, userId]);

        logger.info('[Tokes Admin] Event created', { eventId: result.insertId, name, by: userId });

        res.json({ success: true, eventId: result.insertId });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Event key already exists' });
        }
        logger.error('[Tokes Admin] Create event error', { error: error.message });
        res.status(500).json({ error: 'Failed to create event' });
    }
});

/**
 * PUT /tokes-bot/api/admin/events/:id
 * Update an event
 */
router.put('/tokes-bot/api/admin/events/:id', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, config, starts_at, ends_at, is_active } = req.body;

        await pool.execute(`
            UPDATE tokes_events
            SET name = COALESCE(?, name),
                description = COALESCE(?, description),
                config = COALESCE(?, config),
                starts_at = COALESCE(?, starts_at),
                ends_at = COALESCE(?, ends_at),
                is_active = COALESCE(?, is_active)
            WHERE id = ?
        `, [name, description, config ? JSON.stringify(config) : null, starts_at, ends_at, is_active, id]);

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Update event error', { error: error.message });
        res.status(500).json({ error: 'Failed to update event' });
    }
});

/**
 * DELETE /tokes-bot/api/admin/events/:id
 * Delete an event
 */
router.delete('/tokes-bot/api/admin/events/:id', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.execute('DELETE FROM tokes_events WHERE id = ?', [id]);

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Delete event error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// ============================================================
// COMMUNITY CHALLENGES API
// ============================================================

/**
 * GET /tokes-bot/api/admin/challenges
 * List community challenges
 */
router.get('/tokes-bot/api/admin/challenges', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [challenges] = await pool.execute(`
            SELECT *,
                ROUND((current_progress / goal_amount) * 100, 2) as progress_percent
            FROM tokes_community_challenges
            ORDER BY starts_at DESC
        `);

        res.json({ challenges });

    } catch (error) {
        logger.error('[Tokes Admin] Challenges list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load challenges' });
    }
});

/**
 * POST /tokes-bot/api/admin/challenges
 * Create a community challenge
 */
router.post('/tokes-bot/api/admin/challenges', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { name, description, challenge_type, goal_amount, reward_type, reward_config, starts_at, ends_at } = req.body;
        const userId = req.session.tokesUser.id;

        const [result] = await pool.execute(`
            INSERT INTO tokes_community_challenges
            (name, description, challenge_type, goal_amount, reward_type, reward_config, starts_at, ends_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [name, description, challenge_type, goal_amount, reward_type, JSON.stringify(reward_config), starts_at, ends_at, userId]);

        res.json({ success: true, challengeId: result.insertId });

    } catch (error) {
        logger.error('[Tokes Admin] Create challenge error', { error: error.message });
        res.status(500).json({ error: 'Failed to create challenge' });
    }
});

// ============================================================
// WEBHOOKS API
// ============================================================

/**
 * GET /tokes-bot/api/admin/webhooks
 * List all webhooks
 */
router.get('/tokes-bot/api/admin/webhooks', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [webhooks] = await pool.execute(`
            SELECT w.*, u.primary_name as owner_name, c.channel_name
            FROM tokes_webhooks w
            LEFT JOIN tokes_users u ON w.user_id = u.id
            LEFT JOIN tokes_channels c ON w.channel_id = c.id
            ORDER BY w.created_at DESC
        `);

        res.json({ webhooks });

    } catch (error) {
        logger.error('[Tokes Admin] Webhooks list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load webhooks' });
    }
});

/**
 * POST /tokes-bot/api/webhooks
 * Create a webhook (user endpoint)
 */
router.post('/tokes-bot/api/webhooks', requireTokesAuth, async (req, res) => {
    try {
        const { name, url, events, channel_id } = req.body;
        const userId = req.session.tokesUser.id;

        if (!name || !url || !events || !events.length) {
            return res.status(400).json({ error: 'Name, URL, and events are required' });
        }

        // Generate webhook secret
        const secret = crypto.randomBytes(32).toString('hex');

        const [result] = await pool.execute(`
            INSERT INTO tokes_webhooks (user_id, channel_id, name, url, secret, events)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [userId, channel_id || null, name, url, secret, JSON.stringify(events)]);

        res.json({
            success: true,
            webhookId: result.insertId,
            secret // Only returned on creation
        });

    } catch (error) {
        logger.error('[Tokes Bot] Create webhook error', { error: error.message });
        res.status(500).json({ error: 'Failed to create webhook' });
    }
});

// ============================================================
// ACHIEVEMENTS API
// ============================================================

/**
 * GET /tokes-bot/api/admin/achievements
 * List achievements with stats
 */
router.get('/tokes-bot/api/admin/achievements', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        // Get built-in achievements (from toke_achievements if exists)
        const [achievements] = await pool.execute(`
            SELECT
                a.*,
                (SELECT COUNT(*) FROM toke_user_achievements WHERE achievement_id = a.id) as unlock_count,
                (SELECT COUNT(*) FROM tokes_users) as total_users
            FROM toke_achievements a
            ORDER BY a.category, a.rarity_order
        `).catch(() => [[]]);

        // Get custom achievements
        const [customAchievements] = await pool.execute(`
            SELECT
                ca.*,
                (SELECT COUNT(*) FROM tokes_achievement_unlocks WHERE custom_achievement_id = ca.id) as unlock_count
            FROM tokes_custom_achievements ca
            ORDER BY ca.category, ca.rarity
        `);

        res.json({ achievements, customAchievements });

    } catch (error) {
        logger.error('[Tokes Admin] Achievements list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load achievements' });
    }
});

/**
 * POST /tokes-bot/api/admin/achievements
 * Create a custom achievement
 */
router.post('/tokes-bot/api/admin/achievements', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const {
            achievement_key, name, description, category, rarity,
            condition_type, condition_config, xp_reward, title_reward, badge_url
        } = req.body;
        const userId = req.session.tokesUser.id;

        if (!achievement_key || !name || !description || !category || !rarity) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const [result] = await pool.execute(`
            INSERT INTO tokes_custom_achievements
            (achievement_key, name, description, category, rarity, condition_type, condition_config, xp_reward, title_reward, badge_url, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            achievement_key, name, description, category, rarity,
            condition_type || 'manual', condition_config ? JSON.stringify(condition_config) : null,
            xp_reward || 0, title_reward || null, badge_url || null, userId
        ]);

        res.json({ success: true, achievementId: result.insertId });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Achievement key already exists' });
        }
        logger.error('[Tokes Admin] Create achievement error', { error: error.message });
        res.status(500).json({ error: 'Failed to create achievement' });
    }
});

/**
 * POST /tokes-bot/api/admin/achievements/:id/grant
 * Grant achievement to user
 */
router.post('/tokes-bot/api/admin/achievements/:id/grant', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        // Check if already unlocked
        const [[existing]] = await pool.execute(
            'SELECT id FROM tokes_achievement_unlocks WHERE user_id = ? AND custom_achievement_id = ?',
            [user_id, id]
        );

        if (existing) {
            return res.status(409).json({ error: 'User already has this achievement' });
        }

        // Grant the achievement
        await pool.execute(`
            INSERT INTO tokes_achievement_unlocks (user_id, custom_achievement_id, unlock_context)
            VALUES (?, ?, ?)
        `, [user_id, id, JSON.stringify({ granted_by: req.session.tokesUser.id })]);

        // Update unlock count
        await pool.execute(
            'UPDATE tokes_custom_achievements SET current_unlocks = current_unlocks + 1 WHERE id = ?',
            [id]
        );

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Grant achievement error', { error: error.message });
        res.status(500).json({ error: 'Failed to grant achievement' });
    }
});

// ============================================================
// TRIVIA MANAGEMENT API
// ============================================================

/**
 * GET /tokes-bot/api/admin/trivia
 * List trivia questions with stats
 */
router.get('/tokes-bot/api/admin/trivia', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [questions] = await pool.execute(`
            SELECT *,
                CASE WHEN times_asked > 0
                    THEN ROUND(times_correct / times_asked * 100, 1)
                    ELSE 0
                END as success_rate
            FROM tokes_trivia_questions
            ORDER BY times_asked DESC
        `);

        res.json({ questions });

    } catch (error) {
        logger.error('[Tokes Admin] Trivia list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load trivia' });
    }
});

/**
 * POST /tokes-bot/api/admin/trivia
 * Add a trivia question
 */
router.post('/tokes-bot/api/admin/trivia', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { question, correct_answer, wrong_answer_1, wrong_answer_2, wrong_answer_3, category } = req.body;

        if (!question || !correct_answer || !wrong_answer_1 || !wrong_answer_2 || !wrong_answer_3) {
            return res.status(400).json({ error: 'All answers are required' });
        }

        const [result] = await pool.execute(`
            INSERT INTO tokes_trivia_questions (question, correct_answer, wrong_answer_1, wrong_answer_2, wrong_answer_3, category)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [question, correct_answer, wrong_answer_1, wrong_answer_2, wrong_answer_3, category || 'general']);

        res.json({ success: true, questionId: result.insertId });

    } catch (error) {
        logger.error('[Tokes Admin] Add trivia error', { error: error.message });
        res.status(500).json({ error: 'Failed to add question' });
    }
});

/**
 * DELETE /tokes-bot/api/admin/trivia/:id
 * Delete a trivia question
 */
router.delete('/tokes-bot/api/admin/trivia/:id', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.execute('DELETE FROM tokes_trivia_questions WHERE id = ?', [id]);

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Delete trivia error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete question' });
    }
});

// ============================================================
// STRAINS MANAGEMENT API
// ============================================================

/**
 * GET /tokes-bot/api/admin/strains
 * List strains
 */
router.get('/tokes-bot/api/admin/strains', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { search, limit = 100, offset = 0 } = req.query;
        const limitNum = Math.min(parseInt(limit) || 100, 500);
        const offsetNum = parseInt(offset) || 0;

        let query = 'SELECT id, name, strain_type, thc_min, thc_max, effects, description FROM tokes_strains';
        let countQuery = 'SELECT COUNT(*) as total FROM tokes_strains';
        const params = [];
        const countParams = [];

        if (search && search.trim()) {
            query += ' WHERE name LIKE ?';
            countQuery += ' WHERE name LIKE ?';
            params.push(`%${search.trim()}%`);
            countParams.push(`%${search.trim()}%`);
        }

        query += ' ORDER BY name ASC LIMIT ? OFFSET ?';
        params.push(limitNum, offsetNum);

        const [strains] = await pool.execute(query, params);
        const [[{ total }]] = await pool.execute(countQuery, countParams);

        res.json({
            strains,
            total,
            offset: offsetNum,
            limit: limitNum,
            hasMore: offsetNum + strains.length < total
        });

    } catch (error) {
        logger.error('[Tokes Admin] Strains list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load strains' });
    }
});

/**
 * POST /tokes-bot/api/admin/strains
 * Add a strain
 */
router.post('/tokes-bot/api/admin/strains', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { name, type, thc_percent, cbd_percent, effects, flavors, description, lineage } = req.body;

        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        // Generate slug from name
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        const [result] = await pool.execute(`
            INSERT INTO tokes_strains (name, slug, strain_type, thc_min, thc_max, cbd_min, cbd_max, effects, flavors, description, parent_1, parent_2)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            name,
            slug,
            type || 'hybrid',
            thc_percent || null,
            thc_percent || null,  // Use same value for min/max when single value provided
            cbd_percent || null,
            cbd_percent || null,
            effects ? JSON.stringify(effects.split(',').map(e => e.trim().toLowerCase())) : null,
            flavors ? JSON.stringify(flavors.split(',').map(f => f.trim().toLowerCase())) : null,
            description || null,
            lineage ? lineage.split(' x ')[0]?.trim() : null,
            lineage ? lineage.split(' x ')[1]?.trim() : null
        ]);

        res.json({ success: true, strainId: result.insertId });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Strain already exists' });
        }
        logger.error('[Tokes Admin] Add strain error', { error: error.message });
        res.status(500).json({ error: 'Failed to add strain' });
    }
});

/**
 * PUT /tokes-bot/api/admin/strains/:id
 * Update a strain
 */
router.put('/tokes-bot/api/admin/strains/:id', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, strain_type, thc_min, thc_max, cbd_min, cbd_max, effects, flavors, description } = req.body;

        // Build dynamic update query based on provided fields
        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (strain_type !== undefined) { updates.push('strain_type = ?'); params.push(strain_type); }
        if (thc_min !== undefined) { updates.push('thc_min = ?'); params.push(thc_min); }
        if (thc_max !== undefined) { updates.push('thc_max = ?'); params.push(thc_max); }
        if (cbd_min !== undefined) { updates.push('cbd_min = ?'); params.push(cbd_min); }
        if (cbd_max !== undefined) { updates.push('cbd_max = ?'); params.push(cbd_max); }
        if (effects !== undefined) { updates.push('effects = ?'); params.push(effects); }
        if (flavors !== undefined) { updates.push('flavors = ?'); params.push(flavors); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(id);
        await pool.execute(`UPDATE tokes_strains SET ${updates.join(', ')} WHERE id = ?`, params);

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Update strain error', { error: error.message });
        res.status(500).json({ error: 'Failed to update strain' });
    }
});

/**
 * DELETE /tokes-bot/api/admin/strains/:id
 * Delete a strain
 */
router.delete('/tokes-bot/api/admin/strains/:id', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.execute('DELETE FROM tokes_strains WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Tokes Admin] Delete strain error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete strain' });
    }
});

// ============================================================
// SCHEDULED TASKS API
// ============================================================

/**
 * GET /tokes-bot/api/admin/tasks
 * List scheduled tasks
 */
router.get('/tokes-bot/api/admin/tasks', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [tasks] = await pool.execute(`
            SELECT *,
                schedule_value as schedule,
                avg_duration_ms as avg_duration,
                CASE WHEN run_count > 0
                    THEN ROUND(success_count / run_count * 100, 1)
                    ELSE 0
                END as success_rate
            FROM tokes_scheduled_tasks
            ORDER BY next_run ASC
        `);

        // Get recent executions
        const [recentExecutions] = await pool.execute(`
            SELECT te.*, t.name as task_name
            FROM tokes_task_executions te
            JOIN tokes_scheduled_tasks t ON te.task_id = t.id
            ORDER BY te.started_at DESC
            LIMIT 20
        `);

        // Get stats
        const [[stats]] = await pool.execute(`
            SELECT
                COUNT(*) as total_tasks,
                SUM(CASE WHEN is_enabled = 1 THEN 1 ELSE 0 END) as enabled_tasks,
                SUM(run_count) as total_runs,
                SUM(success_count) as total_successes,
                SUM(failure_count) as total_failures
            FROM tokes_scheduled_tasks
        `);

        res.json({ tasks, recentExecutions, stats });

    } catch (error) {
        logger.error('[Tokes Admin] Tasks list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load tasks' });
    }
});

/**
 * POST /tokes-bot/api/admin/tasks/:id/toggle
 * Enable/disable a scheduled task
 */
router.post('/tokes-bot/api/admin/tasks/:id/toggle', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { enabled } = req.body;

        await pool.execute(
            'UPDATE tokes_scheduled_tasks SET is_enabled = ? WHERE id = ?',
            [enabled ? 1 : 0, id]
        );

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Toggle task error', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle task' });
    }
});

/**
 * POST /tokes-bot/api/admin/tasks/:id/run
 * Manually trigger a scheduled task
 */
router.post('/tokes-bot/api/admin/tasks/:id/run', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;

        // Get the task
        const [[task]] = await pool.execute('SELECT * FROM tokes_scheduled_tasks WHERE id = ?', [id]);

        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Mark as running
        await pool.execute(
            'UPDATE tokes_scheduled_tasks SET last_status = ? WHERE id = ?',
            ['running', id]
        );

        // TODO: Actually execute the task via the scheduler service
        // For now, just acknowledge the request
        logger.info('[Tokes Admin] Manual task trigger', { taskId: id, taskKey: task.task_key });

        res.json({ success: true, message: 'Task triggered' });

    } catch (error) {
        logger.error('[Tokes Admin] Run task error', { error: error.message });
        res.status(500).json({ error: 'Failed to run task' });
    }
});

// ============================================================
// API KEYS MANAGEMENT
// ============================================================

/**
 * GET /tokes-bot/api/admin/api-keys
 * List all API keys (admin view)
 */
router.get('/tokes-bot/api/admin/api-keys', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [keys] = await pool.execute(`
            SELECT ak.*, u.primary_name as owner_name
            FROM tokes_api_keys ak
            JOIN tokes_users u ON ak.user_id = u.id
            ORDER BY ak.created_at DESC
        `);

        res.json({ keys });

    } catch (error) {
        logger.error('[Tokes Admin] API keys list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load API keys' });
    }
});

/**
 * POST /tokes-bot/api/keys
 * Create an API key (user endpoint)
 */
router.post('/tokes-bot/api/keys', requireTokesAuth, async (req, res) => {
    try {
        const { name, scopes } = req.body;
        const userId = req.session.tokesUser.id;

        if (!name || !scopes || !scopes.length) {
            return res.status(400).json({ error: 'Name and scopes are required' });
        }

        // Generate API key
        const key = `tokes_${crypto.randomBytes(24).toString('hex')}`;
        const keyHash = crypto.createHash('sha256').update(key).digest('hex');
        const keyPrefix = key.substring(0, 12);

        const [result] = await pool.execute(`
            INSERT INTO tokes_api_keys (user_id, name, key_hash, key_prefix, scopes)
            VALUES (?, ?, ?, ?, ?)
        `, [userId, name, keyHash, keyPrefix, JSON.stringify(scopes)]);

        res.json({
            success: true,
            keyId: result.insertId,
            key // Only returned on creation - user must save it
        });

    } catch (error) {
        logger.error('[Tokes Bot] Create API key error', { error: error.message });
        res.status(500).json({ error: 'Failed to create API key' });
    }
});

// ============================================================
// HEALTH MONITORING API
// ============================================================

/**
 * GET /tokes-bot/api/admin/health/status
 * Get system health status
 */
router.get('/tokes-bot/api/admin/health/status', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        // Check database connection
        let dbOk = false;
        try {
            await pool.execute('SELECT 1');
            dbOk = true;
        } catch (e) {
            logger.error('[Health] Database check failed', { error: e.message });
        }

        // Get active sessions (only from enabled channels)
        const [[sessionStats]] = await pool.execute(`
            SELECT COUNT(*) as active_sessions FROM tokes_sessions s
            JOIN tokes_channels c ON s.channel_id = c.id
            WHERE s.status = 'active' AND c.is_enabled = 1
        `);

        // Get errors in last 24h (only from enabled channels)
        const [[errorStats]] = await pool.execute(`
            SELECT COUNT(*) as errors FROM tokes_activity_log al
            JOIN tokes_channels c ON al.channel_id = c.id
            WHERE al.event_type = 'error' AND al.logged_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND c.is_enabled = 1
        `);

        // Get Twitch channel count
        const [[twitchStats]] = await pool.execute(`
            SELECT COUNT(*) as channels FROM tokes_channels WHERE platform = 'twitch' AND is_enabled = 1
        `);

        // Get Kick channel count
        const [[kickStats]] = await pool.execute(`
            SELECT COUNT(*) as channels FROM tokes_channels WHERE platform = 'kick' AND is_enabled = 1
        `);

        // Memory usage
        const memUsage = process.memoryUsage();
        const memoryMB = Math.round(memUsage.heapUsed / 1024 / 1024);

        // Uptime
        const uptimeSeconds = process.uptime();
        const uptimeStr = formatUptime(uptimeSeconds);

        res.json({
            database: dbOk,
            twitch: {
                connected: global.certiFriedBot?.twitchBot?.isConnected || false,
                channels: twitchStats.channels,
                messageRate: 0 // Would need message tracking
            },
            kick: {
                connected: global.certiFriedBot?.kickBot?.isConnected || false,
                channels: kickStats.channels,
                messageRate: 0
            },
            activeSessions: sessionStats.active_sessions,
            errors24h: errorStats.errors,
            memory: `${memoryMB} MB`,
            uptime: uptimeStr,
            apiRequests: 0 // Would need request tracking
        });

    } catch (error) {
        logger.error('[Tokes Admin] Health status error', { error: error.message });
        res.status(500).json({ error: 'Failed to get health status' });
    }
});

/**
 * GET /tokes-bot/api/admin/health/channels
 * Get channel health data
 */
router.get('/tokes-bot/api/admin/health/channels', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { includeDisabled = 'false' } = req.query;

        // Only show enabled channels by default
        const whereClause = includeDisabled === 'true' ? '' : 'WHERE c.is_enabled = 1';

        const [channels] = await pool.execute(`
            SELECT c.id, c.channel_name, c.platform, c.is_enabled,
                   ch.health_status, ch.uptime_percentage, ch.avg_latency_ms,
                   ch.error_rate, ch.last_health_check,
                   (SELECT COUNT(*) FROM tokes_activity_log
                    WHERE channel_id = c.id AND event_type = 'error'
                    AND logged_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as errors_24h
            FROM tokes_channels c
            LEFT JOIN tokes_channel_health ch ON c.id = ch.channel_id
            ${whereClause}
            ORDER BY ch.health_status DESC, c.channel_name ASC
        `);

        res.json(channels);

    } catch (error) {
        logger.error('[Tokes Admin] Channel health error', { error: error.message });
        res.status(500).json({ error: 'Failed to get channel health' });
    }
});

/**
 * POST /tokes-bot/api/admin/health/reconnect/:platform
 * Reconnect bot to platform
 */
router.post('/tokes-bot/api/admin/health/reconnect/:platform', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { platform } = req.params;

        if (!['twitch', 'kick'].includes(platform)) {
            return res.status(400).json({ error: 'Invalid platform' });
        }

        // Attempt reconnect
        if (platform === 'twitch' && global.certiFriedBot?.twitchBot) {
            global.certiFriedBot.twitchBot.reconnect?.();
        } else if (platform === 'kick' && global.certiFriedBot?.kickBot) {
            global.certiFriedBot.kickBot.reconnect?.();
        }

        logger.info('[Tokes Admin] Bot reconnect requested', { platform });
        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Reconnect error', { error: error.message });
        res.status(500).json({ error: 'Failed to reconnect' });
    }
});

/**
 * POST /tokes-bot/api/admin/health/check/:channelId
 * Trigger health check for a channel
 */
router.post('/tokes-bot/api/admin/health/check/:channelId', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { channelId } = req.params;

        // Update last health check timestamp
        await pool.execute(`
            INSERT INTO tokes_channel_health (channel_id, last_health_check, health_status)
            VALUES (?, NOW(), 'healthy')
            ON DUPLICATE KEY UPDATE last_health_check = NOW()
        `, [channelId]);

        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Health check error', { error: error.message });
        res.status(500).json({ error: 'Failed to check health' });
    }
});

/**
 * Helper to format uptime
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// ============================================================
// SESSION MANAGEMENT API
// ============================================================

import { getSessionStore } from '../config/session.js';

/**
 * GET /tokes-bot/api/admin/sessions
 * Get all active sessions
 */
router.get('/tokes-bot/api/admin/sessions', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [sessions] = await pool.execute(`
            SELECT
                ws.session_id,
                ws.user_id,
                ws.user_agent,
                ws.ip_address,
                ws.created_at,
                ws.last_activity,
                ws.expires_at,
                u.primary_name,
                u.role
            FROM tokes_web_sessions ws
            LEFT JOIN tokes_users u ON ws.user_id = u.id
            WHERE ws.expires_at > NOW()
            ORDER BY ws.last_activity DESC
        `);

        // Calculate session duration and idle time for each
        const now = Date.now();
        const enrichedSessions = sessions.map(s => ({
            ...s,
            idle_minutes: Math.floor((now - new Date(s.last_activity).getTime()) / 60000),
            session_duration_minutes: Math.floor((now - new Date(s.created_at).getTime()) / 60000),
            is_admin: s.role === 'admin' || s.role === 'owner'
        }));

        res.json({ sessions: enrichedSessions, total: sessions.length });

    } catch (error) {
        logger.error('[Tokes Admin] Sessions list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load sessions' });
    }
});

/**
 * GET /tokes-bot/api/admin/sessions/logs
 * Get session event logs
 */
router.get('/tokes-bot/api/admin/sessions/logs', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { limit = 100, offset = 0, type, userId } = req.query;

        let query = `
            SELECT
                sl.*,
                u.primary_name
            FROM tokes_session_logs sl
            LEFT JOIN tokes_users u ON sl.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (type) {
            query += ' AND sl.event_type = ?';
            params.push(type);
        }

        if (userId) {
            query += ' AND sl.user_id = ?';
            params.push(userId);
        }

        query += ' ORDER BY sl.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [logs] = await pool.execute(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM tokes_session_logs WHERE 1=1';
        const countParams = [];
        if (type) {
            countQuery += ' AND event_type = ?';
            countParams.push(type);
        }
        if (userId) {
            countQuery += ' AND user_id = ?';
            countParams.push(userId);
        }
        const [[{ total }]] = await pool.execute(countQuery, countParams);

        res.json({ logs, total });

    } catch (error) {
        logger.error('[Tokes Admin] Session logs error', { error: error.message });
        res.status(500).json({ error: 'Failed to load session logs' });
    }
});

/**
 * GET /tokes-bot/api/admin/sessions/user/:userId
 * Get sessions for a specific user
 */
router.get('/tokes-bot/api/admin/sessions/user/:userId', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { userId } = req.params;

        const [sessions] = await pool.execute(`
            SELECT session_id, user_agent, ip_address, created_at, last_activity, expires_at
            FROM tokes_web_sessions
            WHERE user_id = ? AND expires_at > NOW()
            ORDER BY last_activity DESC
        `, [userId]);

        // Get recent session logs for user
        const [logs] = await pool.execute(`
            SELECT event_type, ip_address, created_at, details
            FROM tokes_session_logs
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `, [userId]);

        res.json({ sessions, logs });

    } catch (error) {
        logger.error('[Tokes Admin] User sessions error', { error: error.message });
        res.status(500).json({ error: 'Failed to load user sessions' });
    }
});

/**
 * POST /tokes-bot/api/admin/sessions/terminate/:sessionId
 * Terminate a specific session
 */
router.post('/tokes-bot/api/admin/sessions/terminate/:sessionId', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { reason } = req.body;
        const adminUser = req.session.tokesUser;

        // Get session info before deletion
        const [[session]] = await pool.execute(
            'SELECT user_id, ip_address FROM tokes_web_sessions WHERE session_id = ?',
            [sessionId]
        );

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Log the forced logout
        await pool.execute(
            `INSERT INTO tokes_session_logs
             (user_id, session_id, event_type, ip_address, details)
             VALUES (?, ?, 'force_logout', ?, ?)`,
            [session.user_id, sessionId, session.ip_address, `Terminated by admin ${adminUser.name}: ${reason || 'No reason given'}`]
        );

        // Delete the session
        await pool.execute('DELETE FROM tokes_web_sessions WHERE session_id = ?', [sessionId]);

        logger.info('[Tokes Admin] Session terminated', { sessionId, by: adminUser.name, reason });
        res.json({ success: true });

    } catch (error) {
        logger.error('[Tokes Admin] Session terminate error', { error: error.message });
        res.status(500).json({ error: 'Failed to terminate session' });
    }
});

/**
 * POST /tokes-bot/api/admin/sessions/terminate-user/:userId
 * Terminate all sessions for a user
 */
router.post('/tokes-bot/api/admin/sessions/terminate-user/:userId', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;
        const adminUser = req.session.tokesUser;

        // Get session store
        const store = getSessionStore();

        // Destroy all user sessions
        const terminatedCount = await store.destroyUserSessions(
            userId,
            `Terminated by admin ${adminUser.name}: ${reason || 'No reason given'}`
        );

        logger.info('[Tokes Admin] All user sessions terminated', { userId, count: terminatedCount, by: adminUser.name });
        res.json({ success: true, terminated: terminatedCount });

    } catch (error) {
        logger.error('[Tokes Admin] User sessions terminate error', { error: error.message });
        res.status(500).json({ error: 'Failed to terminate user sessions' });
    }
});

/**
 * POST /tokes-bot/api/admin/sessions/cleanup
 * Force cleanup of expired sessions
 */
router.post('/tokes-bot/api/admin/sessions/cleanup', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [result] = await pool.execute(
            'DELETE FROM tokes_web_sessions WHERE expires_at < NOW()'
        );

        logger.info('[Tokes Admin] Sessions cleanup', { deleted: result.affectedRows });
        res.json({ success: true, deleted: result.affectedRows });

    } catch (error) {
        logger.error('[Tokes Admin] Sessions cleanup error', { error: error.message });
        res.status(500).json({ error: 'Failed to cleanup sessions' });
    }
});

/**
 * GET /tokes-bot/api/admin/sessions/stats
 * Get session statistics
 */
router.get('/tokes-bot/api/admin/sessions/stats', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const [[stats]] = await pool.execute(`
            SELECT
                (SELECT COUNT(*) FROM tokes_web_sessions WHERE expires_at > NOW()) as active_sessions,
                (SELECT COUNT(DISTINCT user_id) FROM tokes_web_sessions WHERE expires_at > NOW() AND user_id IS NOT NULL) as unique_users,
                (SELECT COUNT(*) FROM tokes_web_sessions ws
                 JOIN tokes_users u ON ws.user_id = u.id
                 WHERE ws.expires_at > NOW() AND (u.role = 'admin' OR u.role = 'owner')) as admin_sessions,
                (SELECT COUNT(*) FROM tokes_session_logs WHERE event_type = 'login' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as logins_24h,
                (SELECT COUNT(*) FROM tokes_session_logs WHERE event_type = 'timeout' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as timeouts_24h,
                (SELECT COUNT(*) FROM tokes_session_logs WHERE event_type = 'force_logout' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as force_logouts_24h,
                (SELECT COUNT(*) FROM tokes_login_attempts WHERE was_successful = 0 AND attempt_time > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as failed_logins_24h
        `);

        // Get login activity by hour for chart
        const [hourlyLogins] = await pool.execute(`
            SELECT
                HOUR(created_at) as hour,
                COUNT(*) as logins
            FROM tokes_session_logs
            WHERE event_type = 'login' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY HOUR(created_at)
            ORDER BY hour
        `);

        res.json({ stats, hourlyLogins });

    } catch (error) {
        logger.error('[Tokes Admin] Session stats error', { error: error.message });
        res.status(500).json({ error: 'Failed to load session stats' });
    }
});

/**
 * GET /tokes-bot/api/admin/security/login-attempts
 * Get failed login attempts (for security monitoring)
 */
router.get('/tokes-bot/api/admin/security/login-attempts', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;

        const [attempts] = await pool.execute(`
            SELECT *
            FROM tokes_login_attempts
            WHERE was_successful = 0
            ORDER BY attempt_time DESC
            LIMIT ? OFFSET ?
        `, [parseInt(limit), parseInt(offset)]);

        // Get IPs with multiple failures (potential brute force)
        const [suspiciousIps] = await pool.execute(`
            SELECT
                ip_address,
                COUNT(*) as attempt_count,
                MAX(attempt_time) as last_attempt
            FROM tokes_login_attempts
            WHERE was_successful = 0 AND attempt_time > DATE_SUB(NOW(), INTERVAL 1 HOUR)
            GROUP BY ip_address
            HAVING attempt_count >= 5
            ORDER BY attempt_count DESC
        `);

        res.json({ attempts, suspiciousIps });

    } catch (error) {
        logger.error('[Tokes Admin] Login attempts error', { error: error.message });
        res.status(500).json({ error: 'Failed to load login attempts' });
    }
});

export default router;
