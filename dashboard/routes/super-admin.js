import express from 'express';
import pool from '../../utils/db.js';
import { requireSuperAdmin } from '../../utils/auth-middleware.js';
import logger from '../../utils/logger.js';
import encryption from '../../utils/encryption.js';
import { fullBotTest, testBotConnection } from '../../utils/bot-validator.js';

const router = express.Router();

// ===========================
// BOT CREATOR PERMISSIONS
// ===========================

/**
 * Get all bot creator permissions
 */
router.get('/api/super-admin/permissions', requireSuperAdmin, async (req, res) => {
    try {
        const [permissions] = await pool.execute(`
            SELECT
                bcp.*,
                u.username,
                u.discriminator,
                u.avatar,
                (SELECT COUNT(*) FROM custom_bots WHERE owner_user_id = bcp.user_id) as bot_count
            FROM bot_creator_permissions bcp
            LEFT JOIN users u ON u.discord_id = bcp.user_id
            ORDER BY bcp.created_at DESC
        `);

        // Fetch usernames from Discord for users not in database
        const client = req.app.locals.client;
        for (const perm of permissions) {
            if (!perm.username && client) {
                try {
                    const user = await client.users.fetch(perm.user_id).catch(() => null);
                    if (user) {
                        perm.username = user.username;
                        perm.discriminator = user.discriminator;
                        perm.avatar = user.avatar;
                    }
                } catch (err) {
                    logger.warn(`[Super Admin] Could not fetch user ${perm.user_id} from Discord`);
                }
            }
        }

        res.json(permissions);
    } catch (error) {
        logger.error('[Super Admin] Error fetching permissions:', error);
        res.status(500).json({ error: 'Failed to fetch permissions' });
    }
});

/**
 * Grant bot creator permission to user
 */
router.post('/api/super-admin/permissions', requireSuperAdmin, async (req, res) => {
    try {
        const { user_id, max_bots } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'User ID required' });
        }

        await pool.execute(`
            INSERT INTO bot_creator_permissions (user_id, can_create_bots, max_bots)
            VALUES (?, 1, ?)
            ON DUPLICATE KEY UPDATE can_create_bots = 1, max_bots = ?
        `, [user_id, max_bots || null, max_bots || null]);

        logger.info(`[Super Admin] Granted bot creator permission to ${user_id} by ${req.user.username}`);

        res.json({ success: true, message: 'Permission granted successfully' });
    } catch (error) {
        logger.error('[Super Admin] Error granting permission:', error);
        res.status(500).json({ error: 'Failed to grant permission' });
    }
});

/**
 * Update bot creator permission
 */
router.put('/api/super-admin/permissions/:userId', requireSuperAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { can_create_bots, max_bots } = req.body;

        const updates = [];
        const values = [];

        if (can_create_bots !== undefined) {
            updates.push('can_create_bots = ?');
            values.push(can_create_bots ? 1 : 0);
        }
        if (max_bots !== undefined) {
            updates.push('max_bots = ?');
            values.push(max_bots || null);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }

        values.push(userId);

        await pool.execute(`
            UPDATE bot_creator_permissions
            SET ${updates.join(', ')}
            WHERE user_id = ?
        `, values);

        logger.info(`[Super Admin] Updated permission for ${userId} by ${req.user.username}`);

        res.json({ success: true, message: 'Permission updated successfully' });
    } catch (error) {
        logger.error('[Super Admin] Error updating permission:', error);
        res.status(500).json({ error: 'Failed to update permission' });
    }
});

/**
 * Revoke bot creator permission
 */
router.delete('/api/super-admin/permissions/:userId', requireSuperAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        await pool.execute('DELETE FROM bot_creator_permissions WHERE user_id = ?', [userId]);

        logger.info(`[Super Admin] Revoked permission for ${userId} by ${req.user.username}`);

        res.json({ success: true, message: 'Permission revoked successfully' });
    } catch (error) {
        logger.error('[Super Admin] Error revoking permission:', error);
        res.status(500).json({ error: 'Failed to revoke permission' });
    }
});

// ===========================
// BOT MANAGEMENT & APPROVAL
// ===========================

/**
 * Get all custom bots (super admin can see ALL bots)
 */
router.get('/api/super-admin/bots', requireSuperAdmin, async (req, res) => {
    try {
        const [bots] = await pool.execute(`
            SELECT
                cb.*,
                u.username as owner_username,
                u.discriminator as owner_discriminator,
                (SELECT COUNT(*) FROM guild_bot_mapping WHERE bot_id = cb.bot_id) as guild_count
            FROM custom_bots cb
            LEFT JOIN users u ON u.discord_id = cb.owner_user_id
            ORDER BY cb.created_at DESC
        `);

        // Fetch owner usernames from Discord for users not in database
        const client = req.app.locals.client;
        for (const bot of bots) {
            if (!bot.owner_username && client) {
                try {
                    const user = await client.users.fetch(bot.owner_user_id).catch(() => null);
                    if (user) {
                        bot.owner_username = user.username;
                        bot.owner_discriminator = user.discriminator;
                    }
                } catch (err) {
                    logger.warn(`[Super Admin] Could not fetch user ${bot.owner_user_id} from Discord`);
                }
            }
        }

        // Get status for each bot, using live Discord username/avatar when available
        const botManager = global.botManager;
        const botsWithStatus = bots.map(bot => {
            const status = botManager ? botManager.getBotStatus(bot.bot_id) : null;
            let botAvatar = null;
            if (status?.isReady) {
                if (status.avatar) {
                    botAvatar = status.avatar;
                } else if (status.avatarHash) {
                    botAvatar = `https://cdn.discordapp.com/avatars/${bot.bot_id}/${status.avatarHash}.png?size=128`;
                } else {
                    botAvatar = `https://cdn.discordapp.com/embed/avatars/${(BigInt(bot.bot_id) >> 22n) % 6n}.png`;
                }
            }
            return {
                ...bot,
                bot_name: (status?.isReady && status?.username) ? status.username : bot.bot_name,
                bot_avatar: botAvatar,
                status
            };
        });

        res.json(botsWithStatus);
    } catch (error) {
        logger.error('[Super Admin] Error fetching bots:', error);
        res.status(500).json({ error: 'Failed to fetch bots' });
    }
});

/**
 * Approve/reject custom bot
 */
router.post('/api/super-admin/bots/:botId/approve', requireSuperAdmin, async (req, res) => {
    try {
        const { botId } = req.params;
        const { approved, approval_notes } = req.body;

        // Get bot configuration
        const [botConfig] = await pool.execute(
            'SELECT * FROM custom_bots WHERE bot_id = ?',
            [botId]
        );

        if (botConfig.length === 0) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const bot = botConfig[0];

        // If approving, run comprehensive validation first
        if (approved) {
            logger.info(`[Super Admin] Running validation tests for bot ${botId} (${bot.bot_name})...`);

            try {
                // Decrypt bot token
                const encryptedToken = JSON.parse(bot.bot_token);
                const decryptedToken = encryption.decrypt(encryptedToken);

                // Run full bot validation test
                const validationReport = await fullBotTest(decryptedToken, botId, bot.bot_name);

                logger.info(`[Super Admin] ✓ Bot ${botId} passed all validation tests`);

                // Store validation report in approval notes
                const validationNotes = approval_notes
                    ? `${approval_notes}\n\nValidation Report:\n- Connected: ✓\n- Bot ID: ${validationReport.phases.connection.id}\n- Tag: ${validationReport.phases.connection.tag}\n- Guilds: ${validationReport.phases.connection.guilds}`
                    : `Auto-approved after validation\n\nValidation Report:\n- Connected: ✓\n- Bot ID: ${validationReport.phases.connection.id}\n- Tag: ${validationReport.phases.connection.tag}\n- Guilds: ${validationReport.phases.connection.guilds}`;

                // Update database with approval
                await pool.execute(`
                    UPDATE custom_bots
                    SET approved = 1, approval_notes = ?, enabled = 1
                    WHERE bot_id = ?
                `, [validationNotes, botId]);

                // Load bot into bot manager
                if (global.botManager) {
                    const [mappings] = await pool.execute(
                        'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                        [botId]
                    );

                    if (mappings.length > 0) {
                        try {
                            await global.botManager.addCustomBot({
                                bot_id: bot.bot_id,
                                bot_token: encryptedToken,
                                guild_ids: mappings.map(m => m.guild_id)
                            });

                            logger.info(`[Super Admin] ✓ Bot ${botId} loaded into bot manager with ${mappings.length} guild(s)`);
                        } catch (managerError) {
                            // Rollback approval if bot manager fails
                            logger.error(`[Super Admin] ✗ Failed to load bot into manager, rolling back approval:`, managerError);

                            await pool.execute(`
                                UPDATE custom_bots
                                SET approved = 0, enabled = 0, approval_notes = ?
                                WHERE bot_id = ?
                            `, [`Failed to initialize: ${managerError.message}`, botId]);

                            return res.status(500).json({
                                error: 'Bot validation passed but failed to initialize',
                                details: managerError.message,
                                rollback: true
                            });
                        }
                    } else {
                        logger.info(`[Super Admin] Bot ${botId} approved but has no guild mappings yet`);
                    }
                }

                logger.info(`[Super Admin] ✓ Bot ${botId} approved by ${req.user.username}`);

                res.json({
                    success: true,
                    message: 'Bot approved successfully and passed all validation tests',
                    validation: validationReport
                });

            } catch (validationError) {
                // Validation failed - reject the bot
                logger.error(`[Super Admin] ✗ Bot ${botId} failed validation:`, validationError);

                const rejectionNotes = `FAILED VALIDATION: ${validationError.message}\n\n${approval_notes || ''}`;

                await pool.execute(`
                    UPDATE custom_bots
                    SET approved = 0, approval_notes = ?, enabled = 0
                    WHERE bot_id = ?
                `, [rejectionNotes, botId]);

                return res.status(400).json({
                    error: 'Bot failed validation tests',
                    details: validationError.message,
                    validation_failed: true
                });
            }
        } else {
            // Manual rejection by super admin
            await pool.execute(`
                UPDATE custom_bots
                SET approved = 0, approval_notes = ?, enabled = 0
                WHERE bot_id = ?
            `, [approval_notes || 'Rejected by super admin', botId]);

            // Remove from bot manager if loaded
            if (global.botManager) {
                try {
                    await global.botManager.removeCustomBot(botId);
                } catch (error) {
                    logger.warn(`[Super Admin] Bot ${botId} not in manager:`, error.message);
                }
            }

            logger.info(`[Super Admin] Bot ${botId} rejected by ${req.user.username}`);

            res.json({
                success: true,
                message: 'Bot rejected successfully'
            });
        }

    } catch (error) {
        logger.error('[Super Admin] Error in approval process:', error);
        res.status(500).json({ error: 'Failed to update bot approval' });
    }
});

/**
 * Test bot connection and validation without approving
 */
router.post('/api/super-admin/bots/:botId/test', requireSuperAdmin, async (req, res) => {
    try {
        const { botId } = req.params;

        // Get bot configuration
        const [botConfig] = await pool.execute(
            'SELECT * FROM custom_bots WHERE bot_id = ?',
            [botId]
        );

        if (botConfig.length === 0) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const bot = botConfig[0];

        logger.info(`[Super Admin] Manual test requested for bot ${botId} (${bot.bot_name}) by ${req.user.username}`);

        try {
            // Decrypt bot token
            const encryptedToken = JSON.parse(bot.bot_token);
            const decryptedToken = encryption.decrypt(encryptedToken);

            // Run full bot validation test
            const validationReport = await fullBotTest(decryptedToken, botId, bot.bot_name);

            logger.info(`[Super Admin] ✓ Bot ${botId} test completed successfully`);

            res.json({
                success: true,
                message: 'Bot test completed successfully',
                report: validationReport
            });

        } catch (validationError) {
            logger.error(`[Super Admin] ✗ Bot ${botId} test failed:`, validationError);

            res.status(400).json({
                success: false,
                error: 'Bot test failed',
                details: validationError.message
            });
        }

    } catch (error) {
        logger.error('[Super Admin] Error testing bot:', error);
        res.status(500).json({ error: 'Failed to test bot' });
    }
});

/**
 * Force enable/disable bot
 */
router.post('/api/super-admin/bots/:botId/toggle', requireSuperAdmin, async (req, res) => {
    try {
        const { botId} = req.params;
        const { enabled } = req.body;

        await pool.execute(
            'UPDATE custom_bots SET enabled = ? WHERE bot_id = ?',
            [enabled ? 1 : 0, botId]
        );

        // Update bot manager
        if (!enabled && global.botManager) {
            try {
                await global.botManager.removeCustomBot(botId);
            } catch (error) {
                logger.warn(`[Super Admin] Bot ${botId} not in manager:`, error.message);
            }
        } else if (enabled && global.botManager) {
            const [botConfig] = await pool.execute(
                'SELECT * FROM custom_bots WHERE bot_id = ? AND approved = 1',
                [botId]
            );

            if (botConfig.length > 0) {
                const [mappings] = await pool.execute(
                    'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                    [botId]
                );

                if (mappings.length > 0) {
                    await global.botManager.addCustomBot({
                        bot_id: botConfig[0].bot_id,
                        bot_token: JSON.parse(botConfig[0].bot_token),
                        guild_ids: mappings.map(m => m.guild_id)
                    });
                }
            }
        }

        logger.info(`[Super Admin] Bot ${botId} ${enabled ? 'enabled' : 'disabled'} by ${req.user.username}`);

        res.json({ success: true, message: `Bot ${enabled ? 'enabled' : 'disabled'} successfully` });
    } catch (error) {
        logger.error('[Super Admin] Error toggling bot:', error);
        res.status(500).json({ error: 'Failed to toggle bot' });
    }
});

/**
 * Force delete any custom bot
 */
router.delete('/api/super-admin/bots/:botId', requireSuperAdmin, async (req, res) => {
    try {
        const { botId } = req.params;

        // Remove from bot manager
        if (global.botManager) {
            try {
                await global.botManager.removeCustomBot(botId);
            } catch (error) {
                logger.warn(`[Super Admin] Bot ${botId} not in manager:`, error.message);
            }
        }

        // Delete from database
        await pool.execute('DELETE FROM custom_bots WHERE bot_id = ?', [botId]);

        logger.info(`[Super Admin] Bot ${botId} force deleted by ${req.user.username}`);

        res.json({ success: true, message: 'Bot deleted successfully' });
    } catch (error) {
        logger.error('[Super Admin] Error deleting bot:', error);
        res.status(500).json({ error: 'Failed to delete bot' });
    }
});

/**
 * Get system statistics
 */
router.get('/api/super-admin/stats', requireSuperAdmin, async (req, res) => {
    try {
        const [[botStats]] = await pool.execute(`
            SELECT
                COUNT(*) as total_bots,
                SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved_bots,
                SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_bots,
                SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as pending_approval
            FROM custom_bots
        `);

        const [[permStats]] = await pool.execute(`
            SELECT
                COUNT(*) as total_creators,
                SUM(CASE WHEN can_create_bots = 1 THEN 1 ELSE 0 END) as active_creators
            FROM bot_creator_permissions
        `);

        const [[guildStats]] = await pool.execute(`
            SELECT COUNT(DISTINCT guild_id) as guilds_with_custom_bots
            FROM guild_bot_mapping
        `);

        res.json({
            bots: botStats,
            creators: permStats,
            guilds: guildStats
        });
    } catch (error) {
        logger.error('[Super Admin] Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

/**
 * Get system statistics for super admin dashboard
 * Frontend expects: totalGuilds, totalUsers, liveStreamers, uptime, memoryUsage
 */
router.get('/api/admin/stats', requireSuperAdmin, async (req, res) => {
    try {
        const client = req.app.locals.client;
        const botManager = global.botManager;

        if (!client) {
            return res.status(500).json({ error: 'Bot client not available' });
        }

        // Get all unique guild IDs (from both main bot and custom bots)
        const mainBotGuildIds = new Set(client.guilds.cache.keys());

        // Get guilds with custom bots
        const [customBotGuilds] = await pool.execute(`
            SELECT DISTINCT guild_id FROM guild_bot_mapping
        `);

        // Combine all unique guild IDs
        const allGuildIds = new Set([
            ...mainBotGuildIds,
            ...customBotGuilds.map(row => row.guild_id)
        ]);

        const totalGuilds = allGuildIds.size;

        // Get total users from ALL bot instances (main + custom)
        let totalUsers = 0;

        // Add users from main bot
        client.guilds.cache.forEach(guild => {
            totalUsers += guild.memberCount || 0;
        });

        // Add users from custom bots
        if (botManager) {
            const allBotStatuses = botManager.getAllBotStatuses();
            for (const status of allBotStatuses) {
                if (status && !status.isDefault && status.isReady) {
                    // Get the custom bot client
                    const customClient = botManager.clients.get(status.botId);
                    if (customClient && customClient.guilds) {
                        customClient.guilds.cache.forEach(guild => {
                            totalUsers += guild.memberCount || 0;
                        });
                    }
                }
            }
        }

        // Get live streamers count
        let liveStreamers = 0;
        try {
            const [liveRows] = await pool.execute(`
                SELECT COUNT(DISTINCT streamer_id) as live_count
                FROM live_announcements
            `);
            liveStreamers = liveRows[0]?.live_count || 0;
        } catch (err) {
            logger.warn('[Admin Stats] Could not fetch live streamers:', err.message);
        }

        // Get bot uptime in seconds
        const uptime = Math.floor(client.uptime / 1000);

        // Get memory usage in MB
        const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

        // Get custom bots count if bot manager available
        let customBotsOnline = 0;
        if (botManager) {
            const allStatuses = botManager.getAllBotStatuses();
            customBotsOnline = allStatuses.filter(s => s && !s.isDefault && s.isReady).length;
        }

        res.json({
            success: true,
            stats: {
                totalGuilds,
                totalUsers,
                liveStreamers,
                uptime,
                memoryUsage,
                customBotsOnline
            }
        });

    } catch (error) {
        logger.error('[Admin Stats] Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Get all bot managers
router.get('/api/super-admin/bot-managers', requireSuperAdmin, async (req, res) => {
    try {
        const client = req.app.locals.client;
        const [managers] = await pool.execute(`
            SELECT user_id, created_at FROM bot_creator_permissions
        `);

        // Fetch Discord usernames for each manager
        const managersWithUsernames = await Promise.all(managers.map(async (manager) => {
            try {
                const user = await client.users.fetch(manager.user_id);
                return {
                    ...manager,
                    username: user.username,
                    discriminator: user.discriminator,
                    avatar: user.displayAvatarURL()
                };
            } catch (error) {
                logger.warn(`[Super Admin] Could not fetch user ${manager.user_id}:`, error.message);
                return {
                    ...manager,
                    username: 'Unknown User',
                    discriminator: '0000',
                    avatar: null
                };
            }
        }));

        res.json({
            success: true,
            managers: managersWithUsernames
        });
    } catch (error) {
        logger.error('[Super Admin] Error fetching bot managers:', error);
        res.status(500).json({ error: 'Failed to fetch bot managers' });
    }
});

// Add bot manager
router.post('/api/super-admin/bot-managers', requireSuperAdmin, async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        await pool.execute(`
            INSERT INTO bot_creator_permissions (user_id)
            VALUES (?)
            ON DUPLICATE KEY UPDATE user_id = user_id
        `, [userId]);

        res.json({
            success: true,
            message: 'Bot manager added successfully'
        });
    } catch (error) {
        logger.error('[Super Admin] Error adding bot manager:', error);
        res.status(500).json({ error: 'Failed to add bot manager' });
    }
});

// Remove bot manager
router.delete('/api/super-admin/bot-managers/:userId', requireSuperAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        await pool.execute(`
            DELETE FROM bot_creator_permissions WHERE user_id = ?
        `, [userId]);

        res.json({
            success: true,
            message: 'Bot manager removed successfully'
        });
    } catch (error) {
        logger.error('[Super Admin] Error removing bot manager:', error);
        res.status(500).json({ error: 'Failed to remove bot manager' });
    }
});

// Get all custom bots
router.get('/api/super-admin/all-bots', requireSuperAdmin, async (req, res) => {
    try {
        const client = req.app.locals.client;
        const botManager = global.botManager;

        // Get all bots from database
        const [dbBots] = await pool.execute(`
            SELECT * FROM custom_bots ORDER BY created_at DESC
        `);

        // Get runtime status from botManager and fetch owner info
        const bots = await Promise.all(dbBots.map(async (bot) => {
            let status = 'offline';
            let guilds = 0;
            let avatar = null;
            let username = bot.bot_name || 'Unknown Bot';
            let owner_username = 'Unknown Owner';

            // Get bot runtime status
            if (botManager) {
                const botStatus = botManager.getBotStatus(bot.bot_id);
                if (botStatus) {
                    status = botStatus.isReady ? 'online' : 'ready';
                    guilds = botStatus.guilds || 0;
                    avatar = botStatus.avatar;
                    username = botStatus.username || username;
                }
            }

            // Fetch owner username from Discord
            if (bot.owner_user_id && client) {
                try {
                    const owner = await client.users.fetch(bot.owner_user_id);
                    owner_username = owner.username;
                } catch (error) {
                    logger.warn(`[Super Admin] Could not fetch owner ${bot.owner_user_id}:`, error.message);
                }
            }

            return {
                ...bot,
                status,
                guilds,
                avatar,
                username,
                owner_username
            };
        }));

        res.json({
            success: true,
            bots
        });
    } catch (error) {
        logger.error('[Super Admin] Error fetching all bots:', error);
        res.status(500).json({ error: 'Failed to fetch bots' });
    }
});

// ===========================
// REFRESH GUILDS FROM DISCORD
// ===========================

/**
 * POST /api/super-admin/refresh-guilds
 * Re-fetch the user's guild list from Discord API using their stored access token,
 * then update the session so subsequent requests have fresh data.
 */
router.post('/api/super-admin/refresh-guilds', requireSuperAdmin, async (req, res) => {
    try {
        const accessToken = req.user?.accessToken;
        if (!accessToken) {
            return res.status(401).json({ error: 'No access token stored. Please log out and log back in.' });
        }

        const response = await fetch('https://discord.com/api/v10/users/@me/guilds', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!response.ok) {
            if (response.status === 401) {
                return res.status(401).json({ error: 'Discord token expired. Please log out and log back in.' });
            }
            return res.status(response.status).json({ error: `Discord API error: ${response.status}` });
        }

        const guilds = await response.json();
        req.user.guilds = guilds;

        // Persist updated guilds into the session
        req.session.passport.user.guilds = guilds;
        await new Promise((resolve, reject) => {
            req.session.save(err => err ? reject(err) : resolve());
        });

        logger.info(`[Super Admin] Refreshed guild list for ${req.user.username}: ${guilds.length} guilds`);

        res.json({ success: true, guildCount: guilds.length });
    } catch (error) {
        logger.error('[Super Admin] Error refreshing guilds:', error);
        res.status(500).json({ error: 'Failed to refresh guilds from Discord' });
    }
});

// ===========================
// MY GUILDS (ADMIN/OWNER)
// ===========================

/**
 * Get all guilds where the authenticated user is Administrator or Owner,
 * with bot presence status for each guild.
 */
router.get('/api/super-admin/my-guilds', requireSuperAdmin, async (req, res) => {
    try {
        const userGuilds = req.user.guilds || [];
        const client = req.app.locals.client;
        const botClientId = process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;

        // Filter guilds where user is Owner or has Administrator permission (0x8)
        const adminGuilds = userGuilds.filter(g => {
            return g.owner || ((parseInt(g.permissions) & 0x8) === 0x8);
        });

        // Collect all guild IDs served by ANY bot (main + custom)
        const botManager = global.botManager;
        const allBotGuildIds = new Set();

        // Main bot guilds (from cache)
        if (client?.guilds?.cache) {
            client.guilds.cache.forEach((_, guildId) => allBotGuildIds.add(guildId));
        }

        // Custom bot guilds (from cache)
        if (botManager) {
            for (const [botId, botClient] of botManager.clients.entries()) {
                if (botClient.isReady() && botClient.guilds?.cache) {
                    botClient.guilds.cache.forEach((_, guildId) => allBotGuildIds.add(guildId));
                }
            }
        }

        // Also check guild_bot_mapping DB table as fallback (cache may not be populated yet after restart)
        try {
            const [dbMappings] = await pool.execute('SELECT DISTINCT guild_id FROM guild_bot_mapping');
            for (const row of dbMappings) {
                allBotGuildIds.add(row.guild_id);
            }
        } catch (e) { /* db fallback failed, rely on cache */ }

        // Build guild list with bot presence info (checks ALL bot instances)
        const guilds = adminGuilds.map(g => {
            // Try to get member count from whichever bot is in the guild
            let memberCount = null;
            const mainGuild = client?.guilds.cache.get(g.id);
            if (mainGuild) {
                memberCount = mainGuild.memberCount;
            } else if (botManager) {
                // Check custom bots for member count
                for (const [, botClient] of botManager.clients.entries()) {
                    const customGuild = botClient.guilds?.cache?.get(g.id);
                    if (customGuild) {
                        memberCount = customGuild.memberCount;
                        break;
                    }
                }
            }

            const roleCategory = g.owner ? 'Owner' : 'Administrator';
            const rolePriority = g.owner ? 0 : 1;

            return {
                id: g.id,
                name: g.name,
                icon: g.icon,
                owner: g.owner,
                memberCount,
                botPresent: allBotGuildIds.has(g.id),
                iconUrl: g.icon
                    ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`
                    : null,
                roleCategory,
                rolePriority
            };
        });

        // Sort: Owner first, then Admin; within each, bot present first, then alphabetically
        guilds.sort((a, b) => {
            if (a.rolePriority !== b.rolePriority) return a.rolePriority - b.rolePriority;
            if (a.botPresent !== b.botPresent) return a.botPresent ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        res.json({
            success: true,
            guilds,
            botClientId,
            totalGuilds: guilds.length,
            withBot: guilds.filter(g => g.botPresent).length,
            withoutBot: guilds.filter(g => !g.botPresent).length
        });
    } catch (error) {
        logger.error('[Super Admin] Error fetching my guilds:', error);
        res.status(500).json({ error: 'Failed to fetch guilds' });
    }
});

// ===========================
// DEPLOY BOT TO GUILD
// ===========================

/**
 * Deploy an existing custom bot to a guild.
 * Creates guild_bot_mapping and returns the invite URL for that bot.
 */
router.post('/api/super-admin/deploy-existing-bot', requireSuperAdmin, async (req, res) => {
    try {
        const { botId, guildId } = req.body;

        if (!botId || !guildId) {
            return res.status(400).json({ error: 'Bot ID and Guild ID are required' });
        }

        // Verify bot exists and is approved+enabled
        const [bots] = await pool.execute(
            'SELECT bot_id, bot_name, client_id, bot_token FROM custom_bots WHERE bot_id = ? AND approved = 1 AND enabled = 1',
            [botId]
        );

        if (bots.length === 0) {
            return res.status(404).json({ error: 'Bot not found or not approved/enabled' });
        }

        const bot = bots[0];

        // Upsert guild_bot_mapping
        await pool.execute(`
            INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE bot_id = ?, assigned_by = ?, assigned_at = CURRENT_TIMESTAMP
        `, [guildId, botId, req.user.id, botId, req.user.id]);

        // Update in-memory mapping
        if (global.botManager) {
            global.botManager.updateGuildMapping(guildId, botId);

            // Load bot if not already running
            if (!global.botManager.getClient(botId)) {
                const [mappings] = await pool.execute(
                    'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                    [botId]
                );

                try {
                    await global.botManager.addCustomBot({
                        bot_id: bot.bot_id,
                        bot_token: typeof bot.bot_token === 'string' ? JSON.parse(bot.bot_token) : bot.bot_token,
                        guild_ids: mappings.map(m => m.guild_id)
                    });
                } catch (loadError) {
                    logger.warn(`[Super Admin] Bot ${botId} assigned but failed to load:`, loadError.message);
                }
            }
        }

        const clientId = bot.client_id || botId;
        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot+applications.commands&guild_id=${guildId}&disable_guild_select=true`;

        logger.info(`[Super Admin] Bot ${botId} (${bot.bot_name}) deployed to guild ${guildId} by ${req.user.username}`);

        res.json({
            success: true,
            inviteUrl,
            botName: bot.bot_name,
            clientId
        });
    } catch (error) {
        logger.error('[Super Admin] Error deploying existing bot:', error);
        res.status(500).json({ error: 'Failed to deploy bot' });
    }
});

/**
 * Quick-register a new custom bot, assign it to a guild, and return the invite URL.
 * Super admin is auto-approved.
 */
router.post('/api/super-admin/deploy-new-bot', requireSuperAdmin, async (req, res) => {
    try {
        const { botName, botToken, guildId } = req.body;

        if (!botName || !botToken || !guildId) {
            return res.status(400).json({ error: 'Bot name, token, and guild ID are required' });
        }

        // Validate bot name
        if (typeof botName !== 'string' || botName.length < 1 || botName.length > 100 ||
            !/^[a-zA-Z0-9\s_-]+$/.test(botName)) {
            return res.status(400).json({ error: 'Invalid bot name (1-100 characters, alphanumeric, spaces, dashes, underscores)' });
        }

        // Test the bot token
        let botInfo;
        try {
            botInfo = await testBotConnection(botToken);
            logger.info(`[Super Admin] New bot token validated: ${botInfo.tag} (${botInfo.id})`);
        } catch (validationError) {
            return res.status(400).json({
                error: 'Bot token validation failed',
                details: validationError.message
            });
        }

        const botId = botInfo.id;

        // Check if bot already exists
        const [existing] = await pool.execute(
            'SELECT bot_id, bot_name FROM custom_bots WHERE bot_id = ?',
            [botId]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                error: `Bot already registered as "${existing[0].bot_name}". Use the Existing Bot tab instead.`,
                existingBotId: existing[0].bot_id
            });
        }

        // Encrypt token and store bot (auto-approved for super admin)
        // Use actual Discord username, fall back to user-provided name
        const resolvedBotName = botInfo.username || botName;
        const encryptedToken = encryption.encrypt(botToken);

        await pool.execute(`
            INSERT INTO custom_bots (bot_id, bot_name, bot_token, client_id, owner_user_id, enabled, approved)
            VALUES (?, ?, ?, ?, ?, 1, 1)
        `, [botId, resolvedBotName, JSON.stringify(encryptedToken), botId, req.user.id]);

        // Assign to guild
        await pool.execute(`
            INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE bot_id = ?, assigned_by = ?, assigned_at = CURRENT_TIMESTAMP
        `, [guildId, botId, req.user.id, botId, req.user.id]);

        // Load into bot manager
        if (global.botManager) {
            try {
                await global.botManager.addCustomBot({
                    bot_id: botId,
                    bot_name: botName,
                    bot_token: encryptedToken,
                    guild_ids: [guildId]
                });
                logger.info(`[Super Admin] New bot ${botId} loaded into bot manager`);
            } catch (loadError) {
                logger.warn(`[Super Admin] Bot ${botId} registered but failed to load:`, loadError.message);
            }
        }

        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${botId}&permissions=8&scope=bot+applications.commands&guild_id=${guildId}&disable_guild_select=true`;

        logger.info(`[Super Admin] New bot ${botId} (${botName}) registered and deployed to guild ${guildId} by ${req.user.username}`);

        res.json({
            success: true,
            inviteUrl,
            botId,
            botName,
            clientId: botId
        });
    } catch (error) {
        logger.error('[Super Admin] Error deploying new bot:', error);
        res.status(500).json({ error: 'Failed to register and deploy bot' });
    }
});

// ===========================
// GLOBAL BAN MANAGEMENT
// ===========================

/**
 * Get all global ban entries (paginated)
 */
router.get('/api/super-admin/global-ban/entries', requireSuperAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 25, severity, category, active, search, sort, order } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = 'SELECT * FROM global_ban_entries WHERE 1=1';
        const params = [];

        if (active !== undefined) {
            query += ' AND active = ?';
            params.push(active === 'true' || active === '1' ? 1 : 0);
        }
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
        if (req.query.search_id) {
            query += ' AND id = ?';
            params.push(parseInt(req.query.search_id));
        }

        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [[countResult]] = await pool.execute(countQuery, params);

        // Sortable columns (whitelist to prevent SQL injection)
        const sortableColumns = {
            user_id: 'user_id',
            username: 'username',
            severity: 'severity',
            category: 'category',
            reason: 'reason',
            reporter_name: 'reporter_name',
            evidence: 'evidence',
            created_at: 'created_at',
        };
        const sortCol = sortableColumns[sort] || 'created_at';
        const sortDir = order === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), offset);

        const [entries] = await pool.execute(query, params);

        res.json({
            success: true,
            entries,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult.total,
                pages: Math.ceil(countResult.total / parseInt(limit))
            }
        });
    } catch (error) {
        logger.error('[Super Admin] Global ban entries error:', error);
        res.status(500).json({ error: 'Failed to fetch entries' });
    }
});

/**
 * Create a new global ban entry
 */
router.post('/api/super-admin/global-ban/entries', requireSuperAdmin, async (req, res) => {
    try {
        const { user_id, severity, category, reason, evidence, expires_at } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const [result] = await pool.execute(
            `INSERT INTO global_ban_entries (user_id, severity, category, reason, evidence, source, reporter_id, verified, active, expires_at)
             VALUES (?, ?, ?, ?, ?, 'system', ?, 1, 1, ?)`,
            [
                user_id,
                severity || 'medium',
                category || 'other',
                reason || null,
                evidence ? JSON.stringify(Array.isArray(evidence) ? evidence : [evidence]) : null,
                req.user.id,
                expires_at || null
            ]
        );

        // Log the action
        await pool.execute(
            `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
             VALUES (?, 'system', ?, 'entry_created', ?, ?)`,
            [result.insertId, user_id, req.user.id, `Super-admin created: ${category} (${severity})`]
        );

        logger.info(`[Super Admin] Global ban entry created for ${user_id} by ${req.user.username}`);
        res.json({ success: true, entryId: result.insertId });
    } catch (error) {
        logger.error('[Super Admin] Create global ban entry error:', error);
        res.status(500).json({ error: 'Failed to create entry' });
    }
});

/**
 * Update a global ban entry
 */
router.put('/api/super-admin/global-ban/entries/:id', requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { severity, category, reason, active, verified, expires_at } = req.body;

        const updates = [];
        const values = [];

        if (severity !== undefined) { updates.push('severity = ?'); values.push(severity); }
        if (category !== undefined) { updates.push('category = ?'); values.push(category); }
        if (reason !== undefined) { updates.push('reason = ?'); values.push(reason); }
        if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }
        if (verified !== undefined) { updates.push('verified = ?'); values.push(verified ? 1 : 0); }
        if (expires_at !== undefined) { updates.push('expires_at = ?'); values.push(expires_at || null); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);
        await pool.execute(`UPDATE global_ban_entries SET ${updates.join(', ')} WHERE id = ?`, values);

        // Log the action
        const action = active === false ? 'entry_removed' : 'entry_created';
        await pool.execute(
            `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
             VALUES (?, 'system', (SELECT user_id FROM global_ban_entries WHERE id = ?), ?, ?, ?)`,
            [id, id, action, req.user.id, `Super-admin updated entry #${id}`]
        );

        logger.info(`[Super Admin] Global ban entry #${id} updated by ${req.user.username}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Super Admin] Update global ban entry error:', error);
        res.status(500).json({ error: 'Failed to update entry' });
    }
});

/**
 * Delete a global ban entry
 */
router.delete('/api/super-admin/global-ban/entries/:id', requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get entry info before deleting for the log
        const [[entry]] = await pool.execute('SELECT user_id FROM global_ban_entries WHERE id = ?', [id]);

        const [result] = await pool.execute('DELETE FROM global_ban_entries WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Entry not found' });
        }

        if (entry) {
            await pool.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, 'system', ?, 'entry_removed', ?, ?)`,
                [id, entry.user_id, req.user.id, `Super-admin deleted entry #${id}`]
            );
        }

        logger.info(`[Super Admin] Global ban entry #${id} deleted by ${req.user.username}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Super Admin] Delete global ban entry error:', error);
        res.status(500).json({ error: 'Failed to delete entry' });
    }
});

/**
 * Bulk import global ban entries from CSV
 */
router.post('/api/super-admin/global-ban/import', requireSuperAdmin, async (req, res) => {
    try {
        const { rows } = req.body;

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'No rows provided' });
        }

        if (rows.length > 5000) {
            return res.status(400).json({ error: 'Maximum 5000 rows per import' });
        }

        const validSeverities = ['critical', 'high', 'medium', 'low'];
        const validCategories = ['phishing', 'scam', 'spam', 'raid', 'harassment', 'selfbot', 'mass_dm', 'impersonation', 'other'];
        const userIdRegex = /^\d{17,20}$/;

        let imported = 0;
        let skipped = 0;
        const errors = [];

        // Get existing active user IDs to skip duplicates
        const [existingEntries] = await pool.execute('SELECT user_id FROM global_ban_entries WHERE active = 1');
        const existingIds = new Set(existingEntries.map(e => e.user_id));

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const userId = String(row.user_id || '').trim();

            if (!userId) {
                errors.push({ row: i + 1, error: 'Missing user_id' });
                continue;
            }

            if (!userIdRegex.test(userId)) {
                errors.push({ row: i + 1, user_id: userId, error: 'Invalid user_id format (must be 17-20 digits)' });
                continue;
            }

            if (existingIds.has(userId)) {
                skipped++;
                continue;
            }

            const severity = validSeverities.includes(row.severity) ? row.severity : 'medium';
            const category = validCategories.includes(row.category) ? row.category : 'scam';
            const reason = row.reason || 'Imported from CSV';
            const evidence = row.evidence ? JSON.stringify([row.evidence]) : null;

            try {
                await pool.execute(
                    `INSERT INTO global_ban_entries (user_id, severity, category, reason, evidence, source, reporter_id, verified, active)
                     VALUES (?, ?, ?, ?, ?, 'csv_import', ?, 1, 1)`,
                    [userId, severity, category, reason, evidence, req.user.id]
                );
                existingIds.add(userId);
                imported++;
            } catch (insertErr) {
                if (insertErr.code === 'ER_DUP_ENTRY') {
                    skipped++;
                } else {
                    errors.push({ row: i + 1, user_id: userId, error: insertErr.message });
                }
            }
        }

        // Log the import action
        await pool.execute(
            `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
             VALUES (NULL, 'system', ?, 'csv_import', ?, ?)`,
            [req.user.id, req.user.id, `CSV import: ${imported} imported, ${skipped} skipped, ${errors.length} errors`]
        );

        // Refresh ban cache
        const client = req.app.locals.client;
        if (client && client.globalBanManager) {
            await client.globalBanManager.loadBanCache();
        }

        logger.info(`[Super Admin] CSV import by ${req.user.username}: ${imported} imported, ${skipped} skipped, ${errors.length} errors`);
        res.json({ success: true, imported, skipped, errors: errors.slice(0, 50) });
    } catch (error) {
        logger.error('[Super Admin] CSV import error:', error);
        res.status(500).json({ error: 'Failed to import entries' });
    }
});

/**
 * Get global ban reports (paginated)
 */
router.get('/api/super-admin/global-ban/reports', requireSuperAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 25, status } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = 'SELECT * FROM global_ban_reports WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [[countResult]] = await pool.execute(countQuery, params);

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [reports] = await pool.execute(query, params);

        res.json({
            success: true,
            reports,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult.total,
                pages: Math.ceil(countResult.total / parseInt(limit))
            }
        });
    } catch (error) {
        logger.error('[Super Admin] Global ban reports error:', error);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

/**
 * Review a report (approve/deny)
 */
router.put('/api/super-admin/global-ban/reports/:id', requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['approved', 'denied'].includes(status)) {
            return res.status(400).json({ error: 'Status must be approved or denied' });
        }

        const [[report]] = await pool.execute('SELECT * FROM global_ban_reports WHERE id = ?', [id]);
        if (!report) {
            return res.status(404).json({ error: 'Report not found' });
        }

        await pool.execute(
            `UPDATE global_ban_reports SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
            [status, req.user.id, id]
        );

        // If approved, create a global ban entry
        if (status === 'approved') {
            const [result] = await pool.execute(
                `INSERT INTO global_ban_entries (user_id, severity, category, reason, evidence, source, reporter_id, source_guild_id, verified, active)
                 VALUES (?, ?, ?, ?, ?, 'manual_report', ?, ?, 1, 1)`,
                [report.target_user_id, report.severity, report.category, report.reason, report.evidence, report.reporter_id, report.reporter_guild_id]
            );

            await pool.execute(
                'UPDATE global_ban_reports SET global_ban_entry_id = ? WHERE id = ?',
                [result.insertId, id]
            );

            await pool.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, 'system', ?, 'report_approved', ?, ?)`,
                [result.insertId, report.target_user_id, req.user.id, `Super-admin approved report #${id}`]
            );
        } else {
            await pool.execute(
                `INSERT INTO global_ban_action_log (guild_id, user_id, action, performed_by, details)
                 VALUES ('system', ?, 'report_denied', ?, ?)`,
                [report.target_user_id, req.user.id, `Super-admin denied report #${id}`]
            );
        }

        logger.info(`[Super Admin] Report #${id} ${status} by ${req.user.username}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Super Admin] Review report error:', error);
        res.status(500).json({ error: 'Failed to review report' });
    }
});

/**
 * Get global ban appeals (paginated)
 */
router.get('/api/super-admin/global-ban/appeals', requireSuperAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 25, status } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = `SELECT a.*, e.severity, e.category, e.reason as ban_reason
                     FROM global_ban_appeals a
                     JOIN global_ban_entries e ON a.global_ban_entry_id = e.id
                     WHERE 1=1`;
        const params = [];

        if (status) {
            query += ' AND a.status = ?';
            params.push(status);
        }

        const countQuery = `SELECT COUNT(*) as total FROM global_ban_appeals a WHERE 1=1${status ? ' AND a.status = ?' : ''}`;
        const [[countResult]] = await pool.execute(countQuery, status ? [status] : []);

        query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [appeals] = await pool.execute(query, params);

        res.json({
            success: true,
            appeals,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult.total,
                pages: Math.ceil(countResult.total / parseInt(limit))
            }
        });
    } catch (error) {
        logger.error('[Super Admin] Global ban appeals error:', error);
        res.status(500).json({ error: 'Failed to fetch appeals' });
    }
});

/**
 * Review an appeal (approve/deny)
 */
router.put('/api/super-admin/global-ban/appeals/:id', requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, response } = req.body;

        if (!['approved', 'denied'].includes(status)) {
            return res.status(400).json({ error: 'Status must be approved or denied' });
        }

        const [[appeal]] = await pool.execute('SELECT * FROM global_ban_appeals WHERE id = ?', [id]);
        if (!appeal) {
            return res.status(404).json({ error: 'Appeal not found' });
        }

        await pool.execute(
            `UPDATE global_ban_appeals SET status = ?, reviewer_id = ?, reviewer_response = ?, reviewed_at = NOW() WHERE id = ?`,
            [status, req.user.id, response || null, id]
        );

        if (status === 'approved') {
            await pool.execute('UPDATE global_ban_entries SET active = 0, appeal_approved = 1 WHERE id = ?', [appeal.global_ban_entry_id]);
            await pool.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, 'system', ?, 'appeal_approved', ?, ?)`,
                [appeal.global_ban_entry_id, appeal.user_id, req.user.id, response || 'Appeal approved by super-admin']
            );
        } else {
            await pool.execute(
                `INSERT INTO global_ban_action_log (global_ban_entry_id, guild_id, user_id, action, performed_by, details)
                 VALUES (?, 'system', ?, 'appeal_denied', ?, ?)`,
                [appeal.global_ban_entry_id, appeal.user_id, req.user.id, response || 'Appeal denied by super-admin']
            );
        }

        logger.info(`[Super Admin] Appeal #${id} ${status} by ${req.user.username}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Super Admin] Review appeal error:', error);
        res.status(500).json({ error: 'Failed to review appeal' });
    }
});

/**
 * Get global ban statistics
 */
router.get('/api/super-admin/global-ban/stats', requireSuperAdmin, async (req, res) => {
    try {
        const [[totalActive]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_entries WHERE active = 1');
        const [[totalInactive]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_entries WHERE active = 0');
        const [[pendingReports]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_reports WHERE status = "pending"');
        const [[pendingAppeals]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_appeals WHERE status IN ("pending","under_review")');
        const [[enabledGuilds]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_config WHERE enabled = 1');
        const [[totalActions]] = await pool.execute('SELECT COUNT(*) as count FROM global_ban_action_log');

        const [bySeverity] = await pool.execute(
            'SELECT severity, COUNT(*) as count FROM global_ban_entries WHERE active = 1 GROUP BY severity'
        );
        const [byCategory] = await pool.execute(
            'SELECT category, COUNT(*) as count FROM global_ban_entries WHERE active = 1 GROUP BY category ORDER BY count DESC'
        );
        const [bySource] = await pool.execute(
            'SELECT source, COUNT(*) as count FROM global_ban_entries WHERE active = 1 GROUP BY source'
        );
        const [recentActions] = await pool.execute(
            'SELECT action, COUNT(*) as count FROM global_ban_action_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY action ORDER BY count DESC'
        );

        res.json({
            success: true,
            stats: {
                activeEntries: totalActive.count,
                inactiveEntries: totalInactive.count,
                pendingReports: pendingReports.count,
                pendingAppeals: pendingAppeals.count,
                enabledGuilds: enabledGuilds.count,
                totalActions: totalActions.count,
                bySeverity,
                byCategory,
                bySource,
                recentActions
            }
        });
    } catch (error) {
        logger.error('[Super Admin] Global ban stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

/**
 * Get action log (paginated, all guilds)
 */
router.get('/api/super-admin/global-ban/action-log', requireSuperAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const [logs] = await pool.execute(
            'SELECT * FROM global_ban_action_log ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [parseInt(limit), offset]
        );

        const [[countResult]] = await pool.execute('SELECT COUNT(*) as total FROM global_ban_action_log');

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
        logger.error('[Super Admin] Global ban action log error:', error);
        res.status(500).json({ error: 'Failed to fetch action log' });
    }
});

export default router;
