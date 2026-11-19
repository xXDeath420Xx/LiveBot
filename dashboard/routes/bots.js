import express from 'express';
import pool from '../../utils/db.js';
import encryption from '../../utils/encryption.js';
import { requireBotOwner, requireBotCreator, requireBotOwnerOrGuildAdmin } from '../../utils/auth-middleware.js';
import logger from '../../utils/logger.js';
import { Client } from 'discord.js';
import { testBotConnection } from '../../utils/bot-validator.js';
import { isSuperAdmin } from '../../utils/constants.js';

const router = express.Router();

/**
 * Middleware to check if user owns the bot
 */
async function requireBotOwnership(req, res, next) {
    try {
        const { botId } = req.params;

        const [bots] = await pool.execute(
            'SELECT owner_user_id FROM custom_bots WHERE bot_id = ?',
            [botId]
        );

        if (bots.length === 0) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        if (bots[0].owner_user_id !== req.user.id) {
            return res.status(403).json({ error: 'You do not own this bot' });
        }

        next();
    } catch (error) {
        logger.error('[API Bots] Error checking bot ownership:', error);
        return res.status(500).json({ error: 'Failed to verify bot ownership' });
    }
}

/**
 * Get user's custom bots (bot creators can see their own bots)
 */
router.get('/api/bots', requireBotCreator, async (req, res) => {
    try {
        // Bot creators can only see their own bots
        const [bots] = await pool.execute(`
            SELECT
                bot_id,
                bot_name,
                client_id,
                owner_user_id,
                enabled,
                approved,
                created_at,
                updated_at
            FROM custom_bots
            WHERE owner_user_id = ?
            ORDER BY created_at DESC
        `, [req.user.id]);

        // Get status for each bot, including live username/avatar from Discord
        const botManager = global.botManager;
        const botsWithStatus = bots.map(bot => {
            const status = botManager ? botManager.getBotStatus(bot.bot_id) : null;
            // Build avatar URL: prefer live avatar, then construct from hash, then default
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
                // Use live Discord username/avatar when bot is online, fall back to stored name
                bot_name: (status?.isReady && status?.username) ? status.username : bot.bot_name,
                bot_avatar: botAvatar,
                status
            };
        });

        res.json(botsWithStatus);
    } catch (error) {
        logger.error('[API Bots] Error fetching bots:', error);
        res.status(500).json({ error: 'Failed to fetch bots' });
    }
});

/**
 * Owner of the bot (with bot creator permission) or a super-admin. Used by every per-bot action
 * on /bot-management, so the owner console can act on all bots through the same endpoints.
 */
async function requireBotAccess(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized - Please log in' });
    if (isSuperAdmin(req.user.id)) {
        const [rows] = await pool.execute('SELECT 1 FROM custom_bots WHERE bot_id = ?', [req.params.botId]).catch(() => [[]]);
        if (!rows.length && req.params.botId !== 'default') return res.status(404).json({ error: 'Bot not found' });
        return next();
    }
    return requireBotCreator(req, res, () => requireBotOwnership(req, res, next));
}

/** Creator or super-admin (list endpoints). */
async function requireCreatorOrSuperAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized - Please log in' });
    if (isSuperAdmin(req.user.id)) return next();
    return requireBotCreator(req, res, next);
}

function avatarFor(botId, status) {
    if (status?.avatar) return status.avatar;
    if (status?.avatarHash) return `https://cdn.discordapp.com/avatars/${botId}/${status.avatarHash}.png?size=128`;
    try { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(botId) >> 22n) % 6n)}.png`; } catch { return null; }
}

/**
 * GET /api/bots/fleet?scope=mine|all — everything /bot-management shows for each bot:
 * state (online / connecting / offline / disabled / pending), the last error the bot manager
 * recorded, and every server it serves: assigned in guild_bot_mapping and/or actually joined.
 * scope=all (every owner's bots) is super-admin only.
 */
router.get('/api/bots/fleet', requireCreatorOrSuperAdmin, async (req, res) => {
    try {
        const superAdmin = isSuperAdmin(req.user.id);
        const all = superAdmin && req.query.scope === 'all';
        const [bots] = await pool.execute(`
            SELECT bot_id, bot_name, client_id, owner_user_id, enabled, approved, approval_notes, created_at
              FROM custom_bots ${all ? '' : 'WHERE owner_user_id = ?'}
             ORDER BY created_at DESC`, all ? [] : [req.user.id]);
        const ids = bots.map(b => b.bot_id);
        const [maps] = ids.length
            ? await pool.query('SELECT guild_id, bot_id, assigned_at FROM guild_bot_mapping WHERE bot_id IN (?)', [ids])
            : [[]];
        const mapsByBot = new Map();
        for (const m of maps) {
            if (!mapsByBot.has(m.bot_id)) mapsByBot.set(m.bot_id, []);
            mapsByBot.get(m.bot_id).push(m);
        }

        const bm = global.botManager;
        const mainClient = req.app.locals.client;
        const ownerNames = new Map();
        if (all) {
            const owners = [...new Set(bots.map(b => b.owner_user_id).filter(Boolean))];
            await Promise.all(owners.map(async id => {
                const u = mainClient?.users.cache.get(id) || await mainClient?.users.fetch(id).catch(() => null);
                ownerNames.set(id, u ? (u.globalName || u.username) : null);
            }));
        }

        const out = bots.map(bot => {
            const status = bm ? bm.getBotStatus(bot.bot_id) : null;
            const client = bm?.getClient?.(bot.bot_id) || null;
            const error = bm?.getBotError ? bm.getBotError(bot.bot_id) : null;
            let state;
            if (!bot.approved) state = 'pending';
            else if (!bot.enabled) state = 'disabled';
            else if (!status) state = 'offline';
            else state = status.isReady ? 'online' : 'connecting';

            const mapped = mapsByBot.get(bot.bot_id) || [];
            const servers = new Map();
            for (const m of mapped) {
                const g = client?.guilds.cache.get(m.guild_id) || bm?.getGuildFromAnyClient?.(m.guild_id) || null;
                servers.set(m.guild_id, {
                    id: m.guild_id, name: g?.name || null, icon: g?.iconURL?.({ size: 64 }) || null,
                    members: g?.memberCount || null, mapped: true,
                    present: !!client?.guilds.cache.has(m.guild_id), assignedAt: m.assigned_at,
                });
            }
            if (client?.isReady?.()) {
                for (const g of client.guilds.cache.values()) {
                    if (servers.has(g.id)) continue;
                    servers.set(g.id, { id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), members: g.memberCount || null, mapped: false, present: true, assignedAt: null });
                }
            }
            const list = [...servers.values()].sort((a, b) => (b.members || 0) - (a.members || 0));
            const appId = bot.client_id || bot.bot_id;
            return {
                bot_id: bot.bot_id,
                name: (status?.isReady && status.username && status.username !== 'Unknown') ? status.username : bot.bot_name,
                avatar: avatarFor(bot.bot_id, status),
                owner_user_id: bot.owner_user_id,
                owner_name: all ? (ownerNames.get(bot.owner_user_id) || null) : null,
                mine: bot.owner_user_id === req.user.id,
                enabled: !!bot.enabled,
                approved: !!bot.approved,
                approval_notes: bot.approved ? null : (bot.approval_notes || null),
                created_at: bot.created_at,
                state,
                uptime_ms: status?.isReady ? (status.uptime || 0) : null,
                error: (error && state !== 'disabled') ? error : null,
                servers: list,
                counts: { assigned: mapped.length, joined: list.filter(s => s.present).length, waiting: list.filter(s => s.mapped && !s.present).length },
                invite_url: `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&permissions=1643797540086&scope=bot+applications.commands`,
            };
        });

        res.json({
            success: true,
            scope: all ? 'all' : 'mine',
            superAdmin,
            canCreate: !!req.user.canCreateBots || superAdmin,
            bots: out,
        });
    } catch (error) {
        logger.error('[API Bots] fleet failed:', error);
        res.status(500).json({ error: 'Failed to load bots' });
    }
});

/**
 * Add a new custom bot (bot creators can add bots)
 */
router.post('/api/bots', requireBotCreator, async (req, res) => {
    try {
        // Check max_bots limit before creating
        const perms = req.botCreatorPermissions;
        if (perms && perms.max_bots !== null) {
            const [botCount] = await pool.execute(
                'SELECT COUNT(*) as count FROM custom_bots WHERE owner_user_id = ?',
                [req.user.id]
            );
            if (botCount[0].count >= perms.max_bots) {
                return res.status(403).json({
                    error: 'Maximum bot limit reached',
                    message: `You can only create ${perms.max_bots} custom bot(s)`
                });
            }
        }

        const { bot_name, client_id, bot_token, client_secret } = req.body;

        if (!client_id || !bot_token) {
            return res.status(400).json({ error: 'Missing required fields: client_id, bot_token' });
        }

        // Validate client_id (Discord snowflake - 17-20 digits)
        if (typeof client_id !== 'string' || !/^\d{17,20}$/.test(client_id)) {
            return res.status(400).json({ error: 'Invalid client_id format' });
        }

        // Test the bot token with comprehensive validation
        let bot_id;
        let botInfo;
        try {
            botInfo = await testBotConnection(bot_token);
            bot_id = botInfo.id;

            logger.info('[API Bots] Bot connection test passed:', {
                bot_id,
                tag: botInfo.tag,
                guilds: botInfo.guilds
            });
        } catch (validationError) {
            logger.error('[API Bots] Bot validation failed:', validationError);
            return res.status(400).json({
                error: 'Bot validation failed',
                details: validationError.message
            });
        }

        // Use the actual Discord bot username (fall back to user-provided name if any)
        const resolved_bot_name = botInfo.username || bot_name || `Bot ${bot_id}`;

        // Check if bot already exists
        const [existing] = await pool.execute(
            'SELECT bot_id FROM custom_bots WHERE bot_id = ?',
            [bot_id]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'Bot already exists in the system' });
        }

        // Check bot creator permissions and current bot count
        const [permissions] = await pool.execute(
            'SELECT max_bots FROM bot_creator_permissions WHERE user_id = ? AND can_create_bots = 1',
            [req.user.id]
        );

        const [userBots] = await pool.execute(
            'SELECT COUNT(*) as bot_count FROM custom_bots WHERE owner_user_id = ?',
            [req.user.id]
        );

        const maxBots = permissions[0]?.max_bots;
        const currentBotCount = userBots[0]?.bot_count || 0;

        // Check if user has reached their bot limit (null = unlimited)
        if (maxBots !== null && currentBotCount >= maxBots) {
            return res.status(403).json({
                error: `You have reached your bot limit (${maxBots} bots). Please delete a bot or contact an administrator.`
            });
        }

        // Encrypt the token
        const encryptedToken = encryption.encrypt(bot_token);

        // Auto-approve and enable for bot creators
        const approved = permissions.length > 0 ? 1 : 0;
        const enabled = permissions.length > 0 ? 1 : 0;

        // Store in database
        await pool.execute(`
            INSERT INTO custom_bots (bot_id, bot_name, bot_token, client_id, client_secret, owner_user_id, enabled, approved)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            bot_id,
            resolved_bot_name,
            JSON.stringify(encryptedToken),
            client_id,
            client_secret || null,
            req.user.id,
            enabled,
            approved
        ]);

        const statusMessage = approved
            ? 'Bot added successfully and is now active!'
            : 'Bot added successfully! It is pending super admin approval before it can be used.';

        logger.info(`[API Bots] Custom bot ${bot_id} (${resolved_bot_name}) added by ${req.user.username} - ${approved ? 'auto-approved' : 'pending approval'}`);

        res.json({
            success: true,
            bot_id,
            bot_name: resolved_bot_name,
            approved,
            enabled,
            message: statusMessage
        });

    } catch (error) {
        logger.error('[API Bots] Error adding bot:', error);
        res.status(500).json({ error: 'Failed to add bot' });
    }
});

/**
 * Update custom bot (bot owners can update their own bots)
 */
router.put('/api/bots/:botId', requireBotAccess, async (req, res) => {
    try {
        const { botId } = req.params;
        const { bot_name, client_secret, enabled } = req.body;

        if (botId === 'default') {
            return res.status(400).json({ error: 'Cannot modify default bot' });
        }

        const updates = [];
        const values = [];

        if (bot_name !== undefined) {
            updates.push('bot_name = ?');
            values.push(bot_name);
        }
        if (client_secret !== undefined) {
            updates.push('client_secret = ?');
            values.push(client_secret);
        }
        if (enabled !== undefined) {
            updates.push('enabled = ?');
            values.push(enabled ? 1 : 0);

            // If disabling, remove from bot manager
            if (!enabled && global.botManager) {
                try {
                    await global.botManager.removeCustomBot(botId);
                } catch (error) {
                    logger.warn(`[API Bots] Bot ${botId} not loaded in manager:`, error.message);
                }
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }

        values.push(botId);

        await pool.execute(`
            UPDATE custom_bots
            SET ${updates.join(', ')}
            WHERE bot_id = ?
        `, values);

        // Turning a bot back on used to only flip the column: the bot manager never loaded it,
        // so it stayed offline until the next restart.
        if (enabled && global.botManager && !global.botManager.getClient(botId)) {
            const [[cfg]] = await pool.execute('SELECT bot_id, bot_name, bot_token, approved FROM custom_bots WHERE bot_id = ?', [botId]);
            const [maps] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [botId]);
            if (cfg?.approved && maps.length) {
                try {
                    await global.botManager.addCustomBot({ bot_id: cfg.bot_id, bot_name: cfg.bot_name, bot_token: JSON.parse(cfg.bot_token), guild_ids: maps.map(m => m.guild_id) });
                } catch (e) {
                    logger.warn(`[API Bots] Bot ${botId} enabled but failed to start: ${e.message}`);
                    return res.json({ success: true, started: false, message: `Turned on, but it could not log in: ${e.message}` });
                }
            }
        }

        logger.info(`[API Bots] Bot ${botId} updated by ${req.user.username}`);

        res.json({ success: true, message: 'Bot updated successfully' });

    } catch (error) {
        logger.error('[API Bots] Error updating bot:', error);
        res.status(500).json({ error: 'Failed to update bot' });
    }
});

/**
 * Delete custom bot (bot owners can delete their own bots)
 */
router.delete('/api/bots/:botId', requireBotAccess, async (req, res) => {
    try {
        const { botId } = req.params;

        if (botId === 'default') {
            return res.status(400).json({ error: 'Cannot delete default bot' });
        }

        // Remove from bot manager
        if (global.botManager) {
            try {
                await global.botManager.removeCustomBot(botId);
            } catch (error) {
                logger.warn(`[API Bots] Bot ${botId} not loaded in manager:`, error.message);
            }
        }

        // Delete from database (cascade will handle mappings)
        await pool.execute('DELETE FROM custom_bots WHERE bot_id = ?', [botId]);

        logger.info(`[API Bots] Bot ${botId} deleted by ${req.user.username}`);

        res.json({ success: true, message: 'Bot deleted successfully' });

    } catch (error) {
        logger.error('[API Bots] Error deleting bot:', error);
        res.status(500).json({ error: 'Failed to delete bot' });
    }
});

/**
 * Assign bot to guild
 */
router.post('/api/bots/:botId/assign', requireBotOwnerOrGuildAdmin, async (req, res) => {
    try {
        const { botId } = req.params;
        const { guildId } = req.body;

        if (!guildId) {
            return res.status(400).json({ error: 'Guild ID required' });
        }

        if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) {
            return res.status(400).json({ error: 'Invalid guild ID' });
        }

        // Verify bot exists (or is default)
        if (botId !== 'default') {
            const [bots] = await pool.execute(
                'SELECT * FROM custom_bots WHERE bot_id = ? AND enabled = 1',
                [botId]
            );

            if (bots.length === 0) {
                return res.status(404).json({ error: 'Bot not found or disabled' });
            }
            // Security: requireBotOwnerOrGuildAdmin only proves the caller administers the guild,
            // so any server admin could take over someone else's custom bot for their server.
            if (!isSuperAdmin(req.user.id) && bots[0].owner_user_id !== req.user.id) {
                return res.status(403).json({ error: 'You can only assign bots you own.' });
            }
        }

        // Saving an unchanged assignment used to run the whole hand-over below, deleting every
        // live announcement in the server so the stream checker re-posted them.
        const [[current]] = await pool.execute('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);
        if ((current?.bot_id || 'default') === botId) {
            return res.json({ success: true, unchanged: true, message: 'Already assigned.' });
        }

        // Get the old bot client BEFORE updating mapping (for cleanup)
        const oldBotClient = global.botManager?.getClientForGuild(guildId);

        // Assign bot to guild
        if (botId === 'default') {
            // Remove any custom bot mapping to use default
            await pool.execute('DELETE FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);
        } else {
            await pool.execute(`
                INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE bot_id = ?, assigned_by = ?, assigned_at = CURRENT_TIMESTAMP
            `, [guildId, botId, req.user.id, botId, req.user.id]);
        }

        // Update bot manager mapping
        if (global.botManager) {
            global.botManager.updateGuildMapping(guildId, botId);

            // If bot not yet loaded, load it
            if (botId !== 'default' && !global.botManager.getClient(botId)) {
                const [botConfig] = await pool.execute(
                    'SELECT * FROM custom_bots WHERE bot_id = ?',
                    [botId]
                );

                if (botConfig.length > 0) {
                    const [mappings] = await pool.execute(
                        'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                        [botId]
                    );

                    await global.botManager.addCustomBot({
                        bot_id: botConfig[0].bot_id,
                        bot_name: botConfig[0].bot_name,
                        bot_token: JSON.parse(botConfig[0].bot_token),
                        guild_ids: mappings.map(m => m.guild_id)
                    });
                }
            }
        }

        // Transfer stream announcements to the new bot
        try {
            logger.info(`[API Bots] Transferring stream announcements for guild ${guildId} to new bot ${botId}`);

            // Get all live announcements for this guild
            const [announcements] = await pool.execute(
                'SELECT * FROM live_announcements WHERE guild_id = ?',
                [guildId]
            );

            if (announcements.length > 0) {
                logger.info(`[API Bots] Found ${announcements.length} live announcements to transfer`);

                // Delete old webhook messages using the old bot client
                for (const announcement of announcements) {
                    try {
                        if (oldBotClient) {
                            const channel = await oldBotClient.channels.fetch(announcement.channel_id).catch(() => null);
                            if (channel && channel.isTextBased()) {
                                const message = await channel.messages.fetch(announcement.message_id).catch(() => null);
                                if (message) {
                                    await message.delete().catch(() => null);
                                    logger.info(`[API Bots] Deleted old announcement message ${announcement.message_id}`);
                                }
                            }
                        }
                    } catch (error) {
                        logger.warn(`[API Bots] Failed to delete old announcement message ${announcement.message_id}:`, error.message);
                    }
                }

                // Clear announcements from database - they'll be recreated by the new bot's stream checker
                await pool.execute('DELETE FROM live_announcements WHERE guild_id = ?', [guildId]);
                logger.info(`[API Bots] Cleared ${announcements.length} announcements from database. Stream checker will recreate them with new bot.`);
            } else {
                logger.info(`[API Bots] No live announcements to transfer for guild ${guildId}`);
            }
        } catch (transferError) {
            logger.error(`[API Bots] Error transferring announcements:`, transferError);
            // Don't fail the whole operation if transfer fails
        }

        logger.info(`[API Bots] Guild ${guildId} assigned to bot ${botId} by ${req.user.username}`);

        res.json({ success: true, message: `Guild assigned to ${botId === 'default' ? 'default bot' : 'custom bot'}. Stream announcements will be recreated shortly.` });

    } catch (error) {
        logger.error('[API Bots] Error assigning bot:', error);
        res.status(500).json({ error: 'Failed to assign bot' });
    }
});

/**
 * Get bot assignment for guild
 */
router.get('/api/guilds/:guildId/bot', async (req, res) => {
    try {
        const { guildId } = req.params;

        if (!req.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Check if user has access to this guild
        const userGuild = req.user.guilds?.find(g => g.id === guildId);
        if (!userGuild) {
            return res.status(403).json({ error: 'Access denied to this guild' });
        }

        const [mappings] = await pool.execute(
            'SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?',
            [guildId]
        );

        const botId = mappings.length > 0 ? mappings[0].bot_id : 'default';

        const status = global.botManager ? global.botManager.getBotStatus(botId) : null;

        res.json({
            guildId,
            botId,
            status
        });

    } catch (error) {
        logger.error('[API Bots] Error fetching guild bot:', error);
        res.status(500).json({ error: 'Failed to fetch guild bot' });
    }
});

/**
 * Get bot status
 */
router.get('/api/bots/:botId/status', requireBotAccess, async (req, res) => {
    try {
        const { botId } = req.params;

        // Try live status from bot manager first
        if (global.botManager) {
            const status = global.botManager.getBotStatus(botId);
            if (status) {
                return res.json(status);
            }
        }

        // Bot not loaded in memory — fall back to database info
        const [bots] = await pool.execute(
            'SELECT bot_id, bot_name, client_id, created_at, approved FROM custom_bots WHERE bot_id = ?',
            [botId]
        );

        if (bots.length === 0) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const bot = bots[0];
        res.json({
            botId: bot.bot_id,
            isDefault: false,
            isReady: false,
            guilds: 0,
            users: 0,
            uptime: null,
            assignedGuilds: [],
            username: bot.bot_name,
            discriminator: '0000',
            avatar: null,
            approved: bot.approved
        });

    } catch (error) {
        logger.error('[API Bots] Error fetching bot status:', error);
        res.status(500).json({ error: 'Failed to fetch bot status' });
    }
});

/**
 * POST /api/bots/:botId/reconnect — log the bot out and in again (owner or super-admin).
 * For a bot that failed to log in at startup or dropped its session; it was a restart before.
 */
const reconnecting = new Set();
router.post('/api/bots/:botId/reconnect', requireBotAccess, async (req, res) => {
    const { botId } = req.params;
    const bm = global.botManager;
    if (!bm) return res.status(503).json({ error: 'The bot manager is not running.' });
    if (reconnecting.has(botId)) return res.status(409).json({ error: 'Already reconnecting.' });
    try {
        const [[bot]] = await pool.execute('SELECT bot_id, bot_name, bot_token, enabled, approved FROM custom_bots WHERE bot_id = ?', [botId]);
        if (!bot) return res.status(404).json({ error: 'Bot not found' });
        if (!bot.approved || !bot.enabled) return res.status(409).json({ error: 'Turn the bot on first.' });
        const [maps] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [botId]);
        if (!maps.length) return res.status(409).json({ error: 'Assign the bot to a server first.' });
        reconnecting.add(botId);
        if (bm.getClient(botId)) await bm.removeCustomBot(botId).catch(e => logger.warn(`[API Bots] reconnect remove ${botId}: ${e.message}`));
        await bm.addCustomBot({ bot_id: bot.bot_id, bot_name: bot.bot_name, bot_token: JSON.parse(bot.bot_token), guild_ids: maps.map(m => m.guild_id) });
        logger.info(`[API Bots] Bot ${botId} reconnected by ${req.user.username}`);
        res.json({ success: true, message: `${bot.bot_name} is back online.` });
    } catch (error) {
        logger.error(`[API Bots] reconnect ${botId} failed: ${error.message}`);
        res.status(502).json({ error: `Could not log in: ${error.message}` });
    } finally {
        reconnecting.delete(botId);
    }
});

export default router;
