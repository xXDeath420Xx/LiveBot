import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireTokesAuth } from './auth-tokes-bot.js';
import { isSuperAdmin } from '../../utils/constants.js';
import { invalidateGlobalCache, invalidateChannelCache } from '../../services/certifried-bot/command-registry.js';
import {
    validateCommandName,
    validateCommandResponse,
    validateCooldown,
    validateBoolean,
    validateAliases,
    validateProfileBio,
    validateTimezone
} from '../../utils/input-validation.js';

const router = express.Router();

// ============================================================
// PUBLIC PAGES
// ============================================================

/**
 * GET /tokes-bot
 * Public landing page - shows bot info and login options
 */
router.get('/tokes-bot', async (req, res) => {
    try {
        // Get some public stats (only show claimed/authenticated user data)
        const [[stats]] = await pool.execute(`
            SELECT
                (SELECT COUNT(*) FROM tokes_channels WHERE is_enabled = 1) as active_channels,
                (SELECT COUNT(*) FROM tokes_users) as total_users,
                (SELECT COALESCE(SUM(lifetime_tokes), 0) FROM tokes_profiles WHERE is_claimed = 1) as total_tokes
        `);

        res.render('tokes-bot/index', {
            title: 'Tokes Bot - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            stats: stats || { active_channels: 0, total_users: 0, total_tokes: 0 },
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (error) {
        logger.error('[Tokes Bot] Landing page error', { error: error.message });
        res.render('tokes-bot/index', {
            title: 'Tokes Bot - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            stats: { active_channels: 0, total_users: 0, total_tokes: 0 },
            error: 'Failed to load stats'
        });
    }
});

/**
 * GET /tokes-bot/leaderboards
 * Public leaderboard page
 */
router.get('/tokes-bot/leaderboards', async (req, res) => {
    try {
        // Global top tokers (only show claimed/verified profiles)
        const [topTokers] = await pool.execute(`
            SELECT platform, platform_user_id, display_name, lifetime_tokes, level, current_streak
            FROM tokes_profiles
            WHERE is_claimed = 1
            ORDER BY lifetime_tokes DESC
            LIMIT 50
        `);

        // Top streaks (only claimed profiles)
        const [topStreaks] = await pool.execute(`
            SELECT platform, display_name, current_streak, best_streak
            FROM tokes_profiles
            WHERE is_claimed = 1 AND current_streak > 0
            ORDER BY current_streak DESC
            LIMIT 25
        `);

        // Top levels (only claimed profiles)
        const [topLevels] = await pool.execute(`
            SELECT platform, display_name, level, xp
            FROM tokes_profiles
            WHERE is_claimed = 1
            ORDER BY level DESC, xp DESC
            LIMIT 25
        `);

        res.render('tokes-bot/leaderboards', {
            title: 'Global Leaderboards - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            topTokers,
            topStreaks,
            topLevels
        });
    } catch (error) {
        logger.error('[Tokes Bot] Leaderboards error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load leaderboards'
        });
    }
});

/**
 * GET /tokes-bot/commands
 * Public commands reference
 */
router.get('/tokes-bot/commands', async (req, res) => {
    try {
        // Get commands from database
        const [commands] = await pool.execute(`
            SELECT command_key, default_aliases, description, category, cooldown_default
            FROM tokes_global_command_config
            WHERE is_enabled = 1
            ORDER BY category, command_key
        `);

        res.render('tokes-bot/commands', {
            title: 'Commands - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            commands
        });
    } catch (error) {
        logger.error('[Tokes Bot] Commands page error', { error: error.message });
        res.render('tokes-bot/commands', {
            title: 'Commands - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            commands: []
        });
    }
});

/**
 * GET /tokes-bot/privacy
 * Privacy policy
 */
router.get('/tokes-bot/privacy', (req, res) => {
    res.render('tokes-bot/privacy', {
        title: 'Privacy Policy - CertiFriedUtility',
        user: req.session?.tokesUser || null
    });
});

/**
 * GET /tokes-bot/terms
 * Terms of service
 */
router.get('/tokes-bot/terms', (req, res) => {
    res.render('tokes-bot/terms', {
        title: 'Terms of Service - CertiFriedUtility',
        user: req.session?.tokesUser || null
    });
});

// ============================================================
// AUTHENTICATED PAGES
// ============================================================

/**
 * GET /tokes-bot/dashboard
 * User's personal dashboard
 */
router.get('/tokes-bot/dashboard', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;

        // Get user's profile stats
        const [[profile]] = await pool.execute(
            `SELECT * FROM tokes_profiles WHERE platform = ? AND platform_user_id = ?`,
            [user.platform, user.platformId]
        );

        // Get user's channels
        const [channels] = await pool.execute(
            `SELECT c.*, pc.platform_name as connection_name
             FROM tokes_channels c
             JOIN tokes_platform_connections pc ON c.connection_id = pc.id
             WHERE c.owner_id = ?
             ORDER BY c.added_at DESC`,
            [user.id]
        );

        // Get user's platform connections
        const [connections] = await pool.execute(
            `SELECT id, platform, platform_name, platform_avatar, is_bot_account, connected_at
             FROM tokes_platform_connections
             WHERE user_id = ?`,
            [user.id]
        );

        // Recent activity in user's channels
        const channelIds = channels.map(c => c.id);
        let recentActivity = [];
        if (channelIds.length > 0) {
            [recentActivity] = await pool.execute(
                `SELECT * FROM tokes_activity_log
                 WHERE channel_id IN (${channelIds.map(() => '?').join(',')})
                 ORDER BY logged_at DESC
                 LIMIT 20`,
                channelIds
            );
        }

        // Check if user is admin/owner for nav display
        const isAdmin = isTokesOwner(user.platformId);

        res.render('tokes-bot/dashboard', {
            title: 'Dashboard - CertiFriedUtility',
            user,
            profile: profile || null,
            channels,
            connections,
            recentActivity,
            isAdmin
        });
    } catch (error) {
        logger.error('[Tokes Bot] Dashboard error', { error: error.message, stack: error.stack });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load dashboard'
        });
    }
});

/**
 * GET /tokes-bot/channels
 * Manage channels
 */
router.get('/tokes-bot/channels', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;

        // Get user's platform connections (to show which can be used)
        const [connections] = await pool.execute(
            `SELECT id, platform, platform_id, platform_name, platform_avatar, is_bot_account
             FROM tokes_platform_connections
             WHERE user_id = ?`,
            [user.id]
        );

        // Get user's channels with stats
        const [channels] = await pool.execute(
            `SELECT c.*,
                    pc.platform_name as connection_name,
                    (SELECT COUNT(*) FROM tokes_channel_stats WHERE channel_id = c.id) as member_count,
                    (SELECT SUM(tokes) FROM tokes_channel_stats WHERE channel_id = c.id) as total_tokes
             FROM tokes_channels c
             JOIN tokes_platform_connections pc ON c.connection_id = pc.id
             WHERE c.owner_id = ?
             ORDER BY c.added_at DESC`,
            [user.id]
        );

        res.render('tokes-bot/channels', {
            title: 'Manage Channels - CertiFriedUtility',
            user,
            connections,
            channels
        });
    } catch (error) {
        logger.error('[Tokes Bot] Channels page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load channels'
        });
    }
});

/**
 * GET /tokes-bot/channels/:channelId
 * Single channel management page
 */
router.get('/tokes-bot/channels/:channelId', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId } = req.params;

        // Get channel (verify ownership)
        const [[channel]] = await pool.execute(
            `SELECT c.*, pc.platform_name as connection_name
             FROM tokes_channels c
             JOIN tokes_platform_connections pc ON c.connection_id = pc.id
             WHERE c.id = ? AND c.owner_id = ?`,
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).render('tokes-bot/error', {
                title: 'Not Found - CertiFriedUtility',
                user,
                error: 'Channel not found or access denied'
            });
        }

        // Get channel leaderboard
        const [leaderboard] = await pool.execute(
            `SELECT * FROM tokes_channel_stats
             WHERE channel_id = ?
             ORDER BY tokes DESC
             LIMIT 50`,
            [channelId]
        );

        // Get active session if any
        const [[activeSession]] = await pool.execute(
            `SELECT s.*,
                    (SELECT COUNT(*) FROM tokes_session_participants WHERE session_id = s.id) as participant_count
             FROM tokes_sessions s
             WHERE s.channel_id = ? AND s.status = 'active'`,
            [channelId]
        );

        // Recent activity
        const [activity] = await pool.execute(
            `SELECT * FROM tokes_activity_log
             WHERE channel_id = ?
             ORDER BY logged_at DESC
             LIMIT 50`,
            [channelId]
        );

        // Get command configurations for this channel
        const [channelCommands] = await pool.execute(
            `SELECT gc.command_key, gc.description, gc.category, gc.default_aliases,
                    COALESCE(cc.is_enabled, 1) as is_enabled,
                    cc.custom_aliases, cc.custom_response
             FROM tokes_global_command_config gc
             LEFT JOIN tokes_channel_commands cc ON gc.command_key = cc.command_key AND cc.channel_id = ?
             WHERE gc.is_enabled = 1
             ORDER BY gc.category, gc.command_key`,
            [channelId]
        );

        // Get custom commands for this channel
        const [customCommands] = await pool.execute(
            `SELECT * FROM tokes_custom_commands
             WHERE channel_id = ?
             ORDER BY command_name`,
            [channelId]
        );

        // Get user's bot accounts (for same platform as this channel)
        const [botAccounts] = await pool.execute(
            `SELECT id, platform, platform_id, platform_name, platform_avatar
             FROM tokes_platform_connections
             WHERE user_id = ? AND is_bot_account = 1 AND platform = ?`,
            [user.id, channel.platform]
        );

        res.render('tokes-bot/channel-detail', {
            title: `${channel.channel_name} - CertiFriedUtility`,
            user,
            channel,
            leaderboard,
            activeSession,
            activity,
            channelCommands,
            customCommands,
            botAccounts
        });
    } catch (error) {
        logger.error('[Tokes Bot] Channel detail error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load channel'
        });
    }
});

/**
 * GET /tokes-bot/channels/:channelId/commands
 * Channel command management page
 */
router.get('/tokes-bot/channels/:channelId/commands', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId } = req.params;

        // Get channel (verify ownership)
        const [[channel]] = await pool.execute(
            `SELECT c.*, pc.platform_name as connection_name
             FROM tokes_channels c
             JOIN tokes_platform_connections pc ON c.connection_id = pc.id
             WHERE c.id = ? AND c.owner_id = ?`,
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).render('tokes-bot/error', {
                title: 'Not Found - CertiFriedUtility',
                user,
                error: 'Channel not found or access denied'
            });
        }

        // Get all global commands
        const [commands] = await pool.execute(
            `SELECT * FROM tokes_global_command_config WHERE is_enabled = 1 ORDER BY category, command_key`
        );

        // Get channel-specific command overrides
        const [channelCommands] = await pool.execute(
            `SELECT * FROM tokes_channel_commands WHERE channel_id = ?`,
            [channelId]
        );

        // Get custom commands
        const [customCommands] = await pool.execute(
            `SELECT * FROM tokes_custom_commands WHERE channel_id = ? ORDER BY command_name`,
            [channelId]
        );

        res.render('tokes-bot/channel-commands', {
            title: `Commands - ${channel.channel_name} - CertiFriedUtility`,
            user,
            channel,
            commands,
            channelCommands,
            customCommands
        });
    } catch (error) {
        logger.error('[Tokes Bot] Channel commands page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load command settings'
        });
    }
});

/**
 * GET /tokes-bot/profile
 * User profile management page
 */
router.get('/tokes-bot/profile', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;

        // Get user's profile
        const [[profile]] = await pool.execute(
            `SELECT * FROM tokes_profiles WHERE platform = ? AND platform_user_id = ?`,
            [user.platform, user.platformId]
        );

        // Get user's platform connections
        const [connections] = await pool.execute(
            `SELECT id, platform, platform_name, platform_avatar, connected_at
             FROM tokes_platform_connections
             WHERE user_id = ?`,
            [user.id]
        );

        res.render('tokes-bot/profile', {
            title: 'Profile Settings - CertiFriedUtility',
            user,
            profile: profile || {},
            connections
        });
    } catch (error) {
        logger.error('[Tokes Bot] Profile page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load profile'
        });
    }
});

/**
 * GET /tokes-bot/data-management
 * Data management page (export, delete)
 */
router.get('/tokes-bot/data-management', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;

        // Get user's owned channels
        const [ownedChannels] = await pool.execute(
            `SELECT id, channel_name, platform, is_active FROM tokes_channels WHERE owner_id = ?`,
            [user.id]
        );

        // Get user's platform connections
        const [connections] = await pool.execute(
            `SELECT id, platform, platform_name, platform_avatar FROM tokes_platform_connections WHERE user_id = ?`,
            [user.id]
        );

        res.render('tokes-bot/data-management', {
            title: 'Data Management - CertiFriedUtility',
            user,
            ownedChannels,
            connections
        });
    } catch (error) {
        logger.error('[Tokes Bot] Data management page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load page'
        });
    }
});

// ============================================================
// ADMIN PAGES
// ============================================================

// Tokes Bot owner IDs (platform user IDs)
const TOKES_OWNER_ID = process.env.TOKES_OWNER_ID; // Twitch ID
const TOKES_KICK_OWNER_ID = process.env.TOKES_KICK_OWNER_ID; // Kick ID

/**
 * Check if user is the Tokes Bot owner
 */
function isTokesOwner(platformId) {
    const id = String(platformId);
    if (TOKES_OWNER_ID && id === String(TOKES_OWNER_ID)) return true;
    if (TOKES_KICK_OWNER_ID && id === String(TOKES_KICK_OWNER_ID)) return true;
    return false;
}

/**
 * Middleware to require admin access
 */
async function requireAdmin(req, res, next) {
    const user = req.session?.tokesUser;
    if (!user) {
        return res.redirect('/tokes-bot/auth/twitch?returnTo=/tokes-bot/admin');
    }

    // Check if Tokes owner (by Twitch ID)
    if (isTokesOwner(user.platformId)) {
        req.isTokesAdmin = true;
        req.isTokesOwner = true;
        return next();
    }

    // Check tokes_users role
    try {
        const [[dbUser]] = await pool.execute(
            'SELECT role FROM tokes_users WHERE id = ?',
            [user.id]
        );

        if (dbUser && ['admin', 'owner'].includes(dbUser.role)) {
            req.isTokesAdmin = true;
            if (dbUser.role === 'owner') req.isTokesOwner = true;
            return next();
        }
    } catch (error) {
        logger.error('[Tokes Bot] Admin check error', { error: error.message });
    }

    res.status(403).render('tokes-bot/error', {
        title: 'Access Denied - CertiFriedUtility',
        user,
        error: 'You do not have admin access'
    });
}

// Admin session timeout: 30 minutes of inactivity
const ADMIN_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

/**
 * Middleware to require owner access
 * Includes 30-minute inactivity timeout for admin sessions
 */
async function requireOwner(req, res, next) {
    const user = req.session?.tokesUser;
    if (!user) {
        return res.redirect('/tokes-bot/auth/twitch?returnTo=/tokes-bot/admin');
    }

    // Check admin session timeout (30 min inactivity)
    const lastActivity = req.session.lastActivity || 0;
    const now = Date.now();

    if (lastActivity && (now - lastActivity) > ADMIN_SESSION_TIMEOUT) {
        // Session timed out - log the timeout event
        try {
            await pool.execute(
                `INSERT INTO tokes_session_logs (user_id, session_id, event_type, ip_address, details)
                 VALUES (?, ?, 'timeout', ?, 'Admin session timed out after 30 minutes of inactivity')`,
                [user.id, req.sessionID, req.ip || req.connection?.remoteAddress]
            );
        } catch (logError) {
            logger.error('[Tokes Bot] Failed to log session timeout', { error: logError.message });
        }

        // Destroy the session
        req.session.destroy((err) => {
            if (err) logger.error('[Tokes Bot] Session destroy error', { error: err.message });
        });

        logger.info('[Tokes Bot] Admin session timed out', { user: user.name, userId: user.id });
        return res.redirect('/tokes-bot/auth/twitch?returnTo=/tokes-bot/admin&reason=timeout');
    }

    // Update last activity timestamp
    req.session.lastActivity = now;

    // Check if Tokes owner (by Twitch ID)
    if (isTokesOwner(user.platformId)) {
        req.isTokesOwner = true;
        return next();
    }

    // Check tokes_users role
    try {
        const [[dbUser]] = await pool.execute(
            'SELECT role FROM tokes_users WHERE id = ?',
            [user.id]
        );

        if (dbUser && dbUser.role === 'owner') {
            req.isTokesOwner = true;
            return next();
        }
    } catch (error) {
        logger.error('[Tokes Bot] Owner check error', { error: error.message });
    }

    res.status(403).render('tokes-bot/error', {
        title: 'Access Denied - CertiFriedUtility',
        user,
        error: 'Owner access required'
    });
}

/**
 * GET /tokes-bot/admin
 * Admin dashboard
 */
router.get('/tokes-bot/admin', requireTokesAuth, requireAdmin, async (req, res) => {
    try {
        // Get system stats - scoped to authenticated users and active channels
        const [[stats]] = await pool.execute(`
            SELECT
                -- Authenticated users (those who logged in via Twitch)
                (SELECT COUNT(*) FROM tokes_users) as total_users,
                -- Channels with bot registered
                (SELECT COUNT(*) FROM tokes_channels) as total_channels,
                -- Enabled/active channels
                (SELECT COUNT(*) FROM tokes_channels WHERE is_enabled = 1) as active_channels,
                -- Active sessions only in enabled channels
                (SELECT COUNT(*) FROM tokes_sessions s
                 JOIN tokes_channels c ON s.channel_id = c.id
                 WHERE s.status = 'active' AND c.is_enabled = 1) as active_sessions,
                -- Total tokes from channel stats (only activity in bot channels)
                (SELECT COALESCE(SUM(cs.tokes), 0) FROM tokes_channel_stats cs
                 JOIN tokes_channels c ON cs.channel_id = c.id
                 WHERE c.is_enabled = 1) as total_tokes,
                -- Activity in last 24h only from enabled channels
                (SELECT COUNT(*) FROM tokes_activity_log al
                 JOIN tokes_channels c ON al.channel_id = c.id
                 WHERE al.logged_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
                 AND c.is_enabled = 1) as activity_24h
        `);

        // Recent errors - only from enabled channels
        const [recentErrors] = await pool.execute(
            `SELECT al.* FROM tokes_activity_log al
             JOIN tokes_channels c ON al.channel_id = c.id
             WHERE al.event_type = 'error' AND c.is_enabled = 1
             ORDER BY al.logged_at DESC
             LIMIT 20`
        );

        // Recent channel joins (these are already properly scoped)
        const [recentChannels] = await pool.execute(
            `SELECT c.*, u.primary_name as owner_name
             FROM tokes_channels c
             JOIN tokes_users u ON c.owner_id = u.id
             ORDER BY c.added_at DESC
             LIMIT 20`
        );

        res.render('tokes-bot/admin', {
            title: 'Admin Dashboard - CertiFriedUtility',
            user: req.session.tokesUser,
            stats,
            recentErrors,
            recentChannels
        });
    } catch (error) {
        logger.error('[Tokes Bot] Admin page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load admin dashboard'
        });
    }
});

/**
 * GET /tokes-bot/admin/commands
 * Global command management (Owner only)
 */
router.get('/tokes-bot/admin/commands', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        // Get all commands
        const [commands] = await pool.execute(`
            SELECT * FROM tokes_global_command_config
            ORDER BY category, command_key
        `);

        res.render('tokes-bot/admin-commands', {
            title: 'Command Management - CertiFriedUtility',
            user: req.session.tokesUser,
            commands
        });
    } catch (error) {
        logger.error('[Tokes Bot] Admin commands page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load commands'
        });
    }
});

/**
 * GET /tokes-bot/admin/analytics
 * Analytics dashboard (Owner only)
 */
router.get('/tokes-bot/admin/analytics', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        res.render('tokes-bot/admin-analytics', {
            title: 'Analytics Dashboard - CertiFriedUtility',
            user: req.session.tokesUser
        });
    } catch (error) {
        logger.error('[Tokes Bot] Admin analytics page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load analytics dashboard'
        });
    }
});

/**
 * GET /tokes-bot/admin/moderation
 * Moderation queue (Owner only)
 */
router.get('/tokes-bot/admin/moderation', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        res.render('tokes-bot/admin-moderation', {
            title: 'Content Moderation - CertiFriedUtility',
            user: req.session.tokesUser
        });
    } catch (error) {
        logger.error('[Tokes Bot] Admin moderation page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load moderation dashboard'
        });
    }
});

/**
 * GET /tokes-bot/admin/users
 * User management (Owner only)
 */
router.get('/tokes-bot/admin/users', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        res.render('tokes-bot/admin-users', {
            title: 'User Management - CertiFriedUtility',
            user: req.session.tokesUser
        });
    } catch (error) {
        logger.error('[Tokes Bot] Admin users page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load user management'
        });
    }
});

/**
 * GET /tokes-bot/admin/health
 * Channel health monitor (Owner only)
 */
router.get('/tokes-bot/admin/health', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        res.render('tokes-bot/admin-health', {
            title: 'Channel Health - CertiFriedUtility',
            user: req.session.tokesUser
        });
    } catch (error) {
        logger.error('[Tokes Bot] Admin health page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load health monitor'
        });
    }
});

/**
 * GET /tokes-bot/admin/sessions
 * Session management (Owner only)
 */
router.get('/tokes-bot/admin/sessions', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        res.render('tokes-bot/admin-sessions', {
            title: 'Session Management - CertiFriedUtility',
            user: req.session.tokesUser
        });
    } catch (error) {
        logger.error('[Tokes Bot] Admin sessions page error', { error: error.message });
        res.status(500).render('tokes-bot/error', {
            title: 'Error - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            error: 'Failed to load session management'
        });
    }
});

/**
 * GET /tokes-bot/status
 * Public status page
 */
router.get('/tokes-bot/status', async (req, res) => {
    try {
        // Get bot status info
        const botStatus = {
            twitch: global.certiFriedBot?.twitchBot?.isConnected || false,
            kick: global.certiFriedBot?.kickBot?.isConnected || false
        };

        const [[stats]] = await pool.execute(`
            SELECT
                (SELECT COUNT(*) FROM tokes_channels WHERE is_enabled = 1) as active_channels,
                (SELECT COUNT(*) FROM tokes_sessions WHERE status = 'active') as active_sessions
        `);

        res.render('tokes-bot/status', {
            title: 'Bot Status - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            botStatus,
            stats
        });
    } catch (error) {
        logger.error('[Tokes Bot] Status page error', { error: error.message });
        res.render('tokes-bot/status', {
            title: 'Bot Status - CertiFriedUtility',
            user: req.session?.tokesUser || null,
            botStatus: { twitch: false, kick: false },
            stats: { active_channels: 0, active_sessions: 0 }
        });
    }
});

// ============================================================
// CHANNEL MANAGEMENT API
// ============================================================

/**
 * POST /tokes-bot/api/channels
 * Add a new channel for the bot to join
 */
router.post('/tokes-bot/api/channels', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { platform, channelName, connectionId } = req.body;

        if (!platform || !channelName || !connectionId) {
            return res.status(400).json({ error: 'Missing required fields: platform, channelName, connectionId' });
        }

        if (!['twitch', 'kick'].includes(platform)) {
            return res.status(400).json({ error: 'Invalid platform' });
        }

        // Verify the connection belongs to this user
        const [[connection]] = await pool.execute(
            'SELECT id, platform_id FROM tokes_platform_connections WHERE id = ? AND user_id = ? AND platform = ?',
            [connectionId, user.id, platform]
        );

        if (!connection) {
            return res.status(403).json({ error: 'Invalid connection or access denied' });
        }

        // Check if channel already exists
        const [[existing]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE platform = ? AND channel_name = ?',
            [platform, channelName.toLowerCase()]
        );

        if (existing) {
            return res.status(409).json({ error: 'Channel already registered' });
        }

        // Get channel ID from platform (use the connection's platform_id for now)
        const channelId = connection.platform_id;

        // Create the channel
        const [result] = await pool.execute(
            `INSERT INTO tokes_channels
                (owner_id, connection_id, platform, channel_id, channel_name, is_enabled, command_prefix)
             VALUES (?, ?, ?, ?, ?, 1, '!')`,
            [user.id, connectionId, platform, channelId, channelName.toLowerCase()]
        );

        // Try to have the bot join the channel
        if (global.certiFriedBot) {
            if (platform === 'twitch' && global.certiFriedBot.twitchBot?.isConnected) {
                await global.certiFriedBot.twitchBot.joinChannel(channelName);
            } else if (platform === 'kick' && global.certiFriedBot.kickBot?.isConnected) {
                await global.certiFriedBot.kickBot.joinChannel(channelName, channelId);
            }
        }

        logger.info('[Tokes Bot] Channel added', { userId: user.id, platform, channelName });

        res.json({
            success: true,
            channelId: result.insertId,
            message: `Channel ${channelName} added successfully`
        });

    } catch (error) {
        logger.error('[Tokes Bot] Add channel error', { error: error.message });
        res.status(500).json({ error: 'Failed to add channel' });
    }
});

/**
 * DELETE /tokes-bot/api/channels/:channelId
 * Remove a channel
 */
router.delete('/tokes-bot/api/channels/:channelId', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId } = req.params;

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id, platform, channel_name FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        // Have the bot leave the channel
        if (global.certiFriedBot) {
            if (channel.platform === 'twitch' && global.certiFriedBot.twitchBot?.isConnected) {
                await global.certiFriedBot.twitchBot.leaveChannel(channel.channel_name);
            } else if (channel.platform === 'kick' && global.certiFriedBot.kickBot?.isConnected) {
                await global.certiFriedBot.kickBot.leaveChannel(channel.channel_name);
            }
        }

        // Delete the channel
        await pool.execute('DELETE FROM tokes_channels WHERE id = ?', [channelId]);

        logger.info('[Tokes Bot] Channel removed', { userId: user.id, channelId, channelName: channel.channel_name });

        res.json({ success: true, message: 'Channel removed' });

    } catch (error) {
        logger.error('[Tokes Bot] Remove channel error', { error: error.message });
        res.status(500).json({ error: 'Failed to remove channel' });
    }
});

/**
 * PATCH /tokes-bot/api/channels/:channelId
 * Update channel settings
 */
router.patch('/tokes-bot/api/channels/:channelId', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId } = req.params;
        const { is_enabled, command_prefix, cooldown_global, cooldown_user, features_enabled } = req.body;

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        // Build update query
        const updates = [];
        const params = [];

        if (typeof is_enabled === 'boolean') {
            updates.push('is_enabled = ?');
            params.push(is_enabled ? 1 : 0);
        }
        if (command_prefix && command_prefix.length <= 5) {
            updates.push('command_prefix = ?');
            params.push(command_prefix);
        }
        if (typeof cooldown_global === 'number') {
            updates.push('cooldown_global = ?');
            params.push(Math.max(0, Math.min(60, cooldown_global)));
        }
        if (typeof cooldown_user === 'number') {
            updates.push('cooldown_user = ?');
            params.push(Math.max(0, Math.min(300, cooldown_user)));
        }
        if (features_enabled) {
            updates.push('features_enabled = ?');
            params.push(JSON.stringify(features_enabled));
        }

        // Handle bot account assignment
        if (req.body.bot_connection_id !== undefined) {
            if (req.body.bot_connection_id === null || req.body.bot_connection_id === '') {
                // Remove bot account
                updates.push('bot_connection_id = NULL');
            } else {
                // Verify the bot connection belongs to this user and is marked as bot
                const [[botConn]] = await pool.execute(
                    `SELECT id FROM tokes_platform_connections
                     WHERE id = ? AND user_id = ? AND is_bot_account = 1`,
                    [req.body.bot_connection_id, user.id]
                );
                if (botConn) {
                    updates.push('bot_connection_id = ?');
                    params.push(req.body.bot_connection_id);
                } else {
                    return res.status(400).json({ error: 'Invalid bot account' });
                }
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        params.push(channelId);
        await pool.execute(
            `UPDATE tokes_channels SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        res.json({ success: true, message: 'Channel updated' });

    } catch (error) {
        logger.error('[Tokes Bot] Update channel error', { error: error.message });
        res.status(500).json({ error: 'Failed to update channel' });
    }
});

// ============================================================
// CHANNEL COMMAND API
// ============================================================

/**
 * POST /tokes-bot/api/channels/:channelId/commands/:commandKey/toggle
 * Toggle a command for a specific channel
 */
router.post('/tokes-bot/api/channels/:channelId/commands/:commandKey/toggle', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId, commandKey } = req.params;
        const { enabled } = req.body;

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        // Verify command exists
        const [[command]] = await pool.execute(
            'SELECT command_key FROM tokes_global_command_config WHERE command_key = ?',
            [commandKey]
        );

        if (!command) {
            return res.status(404).json({ error: 'Command not found' });
        }

        // Upsert channel command config
        await pool.execute(`
            INSERT INTO tokes_channel_commands (channel_id, command_key, is_enabled)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE is_enabled = ?
        `, [channelId, commandKey, enabled ? 1 : 0, enabled ? 1 : 0]);

        // Invalidate channel command cache
        invalidateChannelCache(channelId);

        res.json({ success: true, enabled: !!enabled });

    } catch (error) {
        logger.error('[Tokes Bot] Toggle command error', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle command' });
    }
});

/**
 * PUT /tokes-bot/api/channels/:channelId/commands/:commandKey
 * Update command configuration for a channel
 */
router.put('/tokes-bot/api/channels/:channelId/commands/:commandKey', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId, commandKey } = req.params;
        const { custom_aliases, custom_response, cooldown_override, mod_only } = req.body;

        logger.info('[Tokes Bot] Update command request', {
            userId: user?.id,
            channelId,
            commandKey,
            custom_aliases,
            cooldown_override
        });

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            logger.warn('[Tokes Bot] Channel access denied', { userId: user?.id, channelId });
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        // Upsert channel command config
        await pool.execute(`
            INSERT INTO tokes_channel_commands
            (channel_id, command_key, custom_aliases, custom_response, cooldown_override, mod_only)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            custom_aliases = VALUES(custom_aliases),
            custom_response = VALUES(custom_response),
            cooldown_override = VALUES(cooldown_override),
            mod_only = VALUES(mod_only),
            updated_at = CURRENT_TIMESTAMP
        `, [
            channelId,
            commandKey,
            custom_aliases ? JSON.stringify(custom_aliases) : null,
            custom_response || null,
            cooldown_override || null,
            mod_only ? 1 : 0
        ]);

        // Invalidate channel command cache
        invalidateChannelCache(channelId);

        res.json({ success: true, message: 'Command updated' });

    } catch (error) {
        logger.error('[Tokes Bot] Update command error', { error: error.message });
        res.status(500).json({ error: 'Failed to update command' });
    }
});

// ============================================================
// CUSTOM COMMANDS API
// ============================================================

/**
 * GET /tokes-bot/api/channels/:channelId/custom
 * List custom commands for a channel
 */
router.get('/tokes-bot/api/channels/:channelId/custom', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId } = req.params;

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        const [commands] = await pool.execute(
            'SELECT * FROM tokes_custom_commands WHERE channel_id = ? ORDER BY command_name',
            [channelId]
        );

        res.json({ commands });

    } catch (error) {
        logger.error('[Tokes Bot] List custom commands error', { error: error.message });
        res.status(500).json({ error: 'Failed to load custom commands' });
    }
});

/**
 * POST /tokes-bot/api/channels/:channelId/custom
 * Create a custom command
 */
router.post('/tokes-bot/api/channels/:channelId/custom', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId } = req.params;
        const { command_name, response, cooldown, mod_only } = req.body;

        // Validate inputs
        const nameValidation = validateCommandName(command_name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        const responseValidation = validateCommandResponse(response);
        if (!responseValidation.valid) {
            return res.status(400).json({ error: responseValidation.error });
        }

        const cooldownValidation = validateCooldown(cooldown);
        if (!cooldownValidation.valid) {
            return res.status(400).json({ error: cooldownValidation.error });
        }

        const modOnlyValidation = validateBoolean(mod_only, false);

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        // Check if command name conflicts with built-in commands
        const [[globalCmd]] = await pool.execute(
            'SELECT command_key, default_aliases FROM tokes_global_command_config WHERE command_key = ?',
            [nameValidation.value]
        );

        if (globalCmd) {
            return res.status(409).json({ error: 'Command name conflicts with built-in command' });
        }

        // Check for alias conflicts
        const [allAliases] = await pool.execute('SELECT default_aliases FROM tokes_global_command_config');
        for (const row of allAliases) {
            const aliases = JSON.parse(row.default_aliases || '[]');
            if (aliases.includes(nameValidation.value)) {
                return res.status(409).json({ error: 'Command name conflicts with built-in alias' });
            }
        }

        // Create the custom command with validated inputs
        const [result] = await pool.execute(
            `INSERT INTO tokes_custom_commands
            (channel_id, command_name, response, cooldown, mod_only, created_by)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [channelId, nameValidation.value, responseValidation.value, cooldownValidation.value, modOnlyValidation.value ? 1 : 0, user.name]
        );

        // Invalidate channel command cache
        invalidateChannelCache(channelId);

        res.json({
            success: true,
            commandId: result.insertId,
            message: `Command !${nameValidation.value} created`
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Command already exists' });
        }
        logger.error('[Tokes Bot] Create custom command error', { error: error.message });
        res.status(500).json({ error: 'Failed to create command' });
    }
});

/**
 * PUT /tokes-bot/api/channels/:channelId/custom/:cmdId
 * Update a custom command
 */
router.put('/tokes-bot/api/channels/:channelId/custom/:cmdId', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId, cmdId } = req.params;
        const { response, cooldown, mod_only, is_enabled } = req.body;

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        // Verify command exists for this channel
        const [[cmd]] = await pool.execute(
            'SELECT id FROM tokes_custom_commands WHERE id = ? AND channel_id = ?',
            [cmdId, channelId]
        );

        if (!cmd) {
            return res.status(404).json({ error: 'Command not found' });
        }

        // Update the command
        await pool.execute(
            `UPDATE tokes_custom_commands
            SET response = ?, cooldown = ?, mod_only = ?, is_enabled = ?
            WHERE id = ?`,
            [response, cooldown || 5, mod_only ? 1 : 0, is_enabled !== false ? 1 : 0, cmdId]
        );

        // Invalidate channel command cache
        invalidateChannelCache(channelId);

        res.json({ success: true, message: 'Command updated' });

    } catch (error) {
        logger.error('[Tokes Bot] Update custom command error', { error: error.message });
        res.status(500).json({ error: 'Failed to update command' });
    }
});

/**
 * DELETE /tokes-bot/api/channels/:channelId/custom/:cmdId
 * Delete a custom command
 */
router.delete('/tokes-bot/api/channels/:channelId/custom/:cmdId', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { channelId, cmdId } = req.params;

        // Verify ownership
        const [[channel]] = await pool.execute(
            'SELECT id FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        // Delete the command
        const [result] = await pool.execute(
            'DELETE FROM tokes_custom_commands WHERE id = ? AND channel_id = ?',
            [cmdId, channelId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Command not found' });
        }

        // Invalidate channel command cache
        invalidateChannelCache(channelId);

        res.json({ success: true, message: 'Command deleted' });

    } catch (error) {
        logger.error('[Tokes Bot] Delete custom command error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete command' });
    }
});

// ============================================================
// GLOBAL ADMIN API
// ============================================================

/**
 * POST /tokes-bot/api/admin/commands/:commandKey/toggle
 * Toggle a command globally (Owner only)
 */
router.post('/tokes-bot/api/admin/commands/:commandKey/toggle', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { commandKey } = req.params;
        const { enabled } = req.body;

        await pool.execute(
            'UPDATE tokes_global_command_config SET is_enabled = ?, updated_by = ? WHERE command_key = ?',
            [enabled ? 1 : 0, req.session.tokesUser.id, commandKey]
        );

        // Invalidate global command cache
        invalidateGlobalCache();

        logger.info('[Tokes Bot] Command toggled globally', {
            commandKey,
            enabled,
            by: req.session.tokesUser.name
        });

        res.json({ success: true, enabled: !!enabled });

    } catch (error) {
        logger.error('[Tokes Bot] Global toggle command error', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle command' });
    }
});

/**
 * PUT /tokes-bot/api/admin/commands/:commandKey
 * Update global command configuration (Owner only)
 */
router.put('/tokes-bot/api/admin/commands/:commandKey', requireTokesAuth, requireOwner, async (req, res) => {
    try {
        const { commandKey } = req.params;
        const { default_aliases, default_response, cooldown_default, mod_only, broadcaster_only, description } = req.body;

        await pool.execute(`
            UPDATE tokes_global_command_config
            SET default_aliases = ?, default_response = ?, cooldown_default = ?,
                mod_only = ?, broadcaster_only = ?, description = ?, updated_by = ?
            WHERE command_key = ?
        `, [
            default_aliases ? JSON.stringify(default_aliases) : null,
            default_response || null,
            cooldown_default || 5,
            mod_only ? 1 : 0,
            broadcaster_only ? 1 : 0,
            description || null,
            req.session.tokesUser.id,
            commandKey
        ]);

        // Invalidate global command cache
        invalidateGlobalCache();

        logger.info('[Tokes Bot] Global command updated', {
            commandKey,
            by: req.session.tokesUser.name
        });

        res.json({ success: true, message: 'Command updated' });

    } catch (error) {
        logger.error('[Tokes Bot] Global update command error', { error: error.message });
        res.status(500).json({ error: 'Failed to update command' });
    }
});

// ============================================================
// PROFILE & DATA MANAGEMENT API
// ============================================================

/**
 * PUT /tokes-bot/api/profile
 * Update user profile preferences
 */
router.put('/tokes-bot/api/profile', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;
        const { show_on_leaderboard, profile_bio, favorite_strain, preferred_piece, timezone } = req.body;

        await pool.execute(`
            UPDATE tokes_profiles
            SET show_on_leaderboard = ?, profile_bio = ?, favorite_strain = ?,
                preferred_piece = ?, timezone = ?
            WHERE platform = ? AND platform_user_id = ?
        `, [
            show_on_leaderboard !== false ? 1 : 0,
            profile_bio || null,
            favorite_strain || null,
            preferred_piece || null,
            timezone || null,
            user.platform,
            user.platformId
        ]);

        res.json({ success: true, message: 'Profile updated' });

    } catch (error) {
        logger.error('[Tokes Bot] Update profile error', { error: error.message });
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

/**
 * POST /tokes-bot/api/channels/:channelId/leave
 * Leave a channel and delete all associated data
 */
router.post('/tokes-bot/api/channels/:channelId/leave', requireTokesAuth, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const user = req.session.tokesUser;
        const { channelId } = req.params;

        // Verify ownership
        const [[channel]] = await connection.execute(
            'SELECT id, platform, channel_name FROM tokes_channels WHERE id = ? AND owner_id = ?',
            [channelId, user.id]
        );

        if (!channel) {
            connection.release();
            return res.status(404).json({ error: 'Channel not found or access denied' });
        }

        await connection.beginTransaction();

        // Log deletion request
        await connection.execute(`
            INSERT INTO tokes_data_deletion_requests
            (user_id, channel_id, request_type, status)
            VALUES (?, ?, 'channel_leave', 'processing')
        `, [user.id, channelId]);

        // Have bot leave the channel
        if (global.certiFriedBot) {
            if (channel.platform === 'twitch' && global.certiFriedBot.twitchBot?.isConnected) {
                await global.certiFriedBot.twitchBot.leaveChannel(channel.channel_name);
            } else if (channel.platform === 'kick' && global.certiFriedBot.kickBot?.isConnected) {
                await global.certiFriedBot.kickBot.leaveChannel(channel.channel_name);
            }
        }

        // Delete associated data (foreign keys will cascade)
        await connection.execute('DELETE FROM tokes_channels WHERE id = ?', [channelId]);

        // Update deletion request status
        await connection.execute(`
            UPDATE tokes_data_deletion_requests
            SET status = 'completed', processed_at = NOW(),
                details = JSON_OBJECT('channel_name', ?)
            WHERE channel_id = ? AND status = 'processing'
        `, [channel.channel_name, channelId]);

        await connection.commit();

        logger.info('[Tokes Bot] Channel left and data deleted', {
            userId: user.id,
            channelId,
            channelName: channel.channel_name
        });

        res.json({ success: true, message: `Left channel ${channel.channel_name} and deleted all data` });

    } catch (error) {
        await connection.rollback();
        logger.error('[Tokes Bot] Leave channel error', { error: error.message });
        res.status(500).json({ error: 'Failed to leave channel' });
    } finally {
        connection.release();
    }
});

/**
 * POST /tokes-bot/api/delete-account
 * Request full account deletion
 */
router.post('/tokes-bot/api/delete-account', requireTokesAuth, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const user = req.session.tokesUser;

        await connection.beginTransaction();

        // Log deletion request
        await connection.execute(`
            INSERT INTO tokes_data_deletion_requests
            (user_id, request_type, status)
            VALUES (?, 'full_account', 'processing')
        `, [user.id]);

        // Get all user's channels to have bot leave them
        const [channels] = await connection.execute(
            'SELECT id, platform, channel_name FROM tokes_channels WHERE owner_id = ?',
            [user.id]
        );

        // Have bot leave all channels
        for (const channel of channels) {
            if (global.certiFriedBot) {
                if (channel.platform === 'twitch' && global.certiFriedBot.twitchBot?.isConnected) {
                    await global.certiFriedBot.twitchBot.leaveChannel(channel.channel_name);
                } else if (channel.platform === 'kick' && global.certiFriedBot.kickBot?.isConnected) {
                    await global.certiFriedBot.kickBot.leaveChannel(channel.channel_name);
                }
            }
        }

        // Delete all user data (cascades will handle related tables)
        await connection.execute('DELETE FROM tokes_channels WHERE owner_id = ?', [user.id]);
        await connection.execute('DELETE FROM tokes_profiles WHERE platform = ? AND platform_user_id = ?',
            [user.platform, user.platformId]);
        await connection.execute('DELETE FROM tokes_platform_connections WHERE user_id = ?', [user.id]);
        await connection.execute('DELETE FROM tokes_users WHERE id = ?', [user.id]);

        await connection.commit();

        // Clear session
        req.session.tokesUser = null;

        logger.info('[Tokes Bot] Account deleted', { userId: user.id, name: user.name });

        res.json({ success: true, message: 'Account and all data deleted' });

    } catch (error) {
        await connection.rollback();
        logger.error('[Tokes Bot] Delete account error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete account' });
    } finally {
        connection.release();
    }
});

/**
 * GET /tokes-bot/api/export-data
 * Export all user data (GDPR)
 */
router.get('/tokes-bot/api/export-data', requireTokesAuth, async (req, res) => {
    try {
        const user = req.session.tokesUser;

        // Get user data
        const [[userData]] = await pool.execute(
            'SELECT * FROM tokes_users WHERE id = ?',
            [user.id]
        );

        // Get profile data
        const [[profile]] = await pool.execute(
            'SELECT * FROM tokes_profiles WHERE platform = ? AND platform_user_id = ?',
            [user.platform, user.platformId]
        );

        // Get connections
        const [connections] = await pool.execute(
            'SELECT platform, platform_name, connected_at FROM tokes_platform_connections WHERE user_id = ?',
            [user.id]
        );

        // Get channels
        const [channels] = await pool.execute(
            'SELECT platform, channel_name, added_at FROM tokes_channels WHERE owner_id = ?',
            [user.id]
        );

        // Get channel stats
        const [channelStats] = await pool.execute(
            `SELECT c.channel_name, cs.tokes, cs.sessions_joined, cs.trivia_wins
             FROM tokes_channel_stats cs
             JOIN tokes_channels c ON cs.channel_id = c.id
             WHERE cs.platform_user_id = ?`,
            [user.platformId]
        );

        // Get spark claims
        const [sparkClaims] = await pool.execute(
            'SELECT claim_date, reward_tokes, streak_bonus FROM tokes_spark_claims WHERE platform_user_id = ? ORDER BY claim_date DESC LIMIT 100',
            [user.platformId]
        );

        const exportData = {
            exported_at: new Date().toISOString(),
            user: userData,
            profile,
            connections,
            channels,
            channel_stats: channelStats,
            spark_claims: sparkClaims
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="tokes-data-export-${user.id}.json"`);
        res.json(exportData);

    } catch (error) {
        logger.error('[Tokes Bot] Export data error', { error: error.message });
        res.status(500).json({ error: 'Failed to export data' });
    }
});

// ============================================================
// LEGACY REDIRECT
// ============================================================

// Redirect old /twitch-bot URLs to /tokes-bot
router.get('/twitch-bot*', (req, res) => {
    const newPath = req.originalUrl.replace('/twitch-bot', '/tokes-bot');
    res.redirect(301, newPath);
});

export default router;
