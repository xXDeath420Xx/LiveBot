import express from 'express';
import pool from '../../../../utils/db.js';
import encryption from '../../../../utils/encryption.js';
import logger from '../../../../utils/logger.js';
import { testBotConnection } from '../../../../utils/bot-validator.js';

const router = express.Router({ mergeParams: true });

/**
 * GET / — Get the guild's custom bot info (if any)
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [mapping] = await pool.execute(
            'SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?',
            [guildId]
        );

        if (mapping.length === 0) {
            return res.json({ hasCustomBot: false });
        }

        const botId = mapping[0].bot_id;
        const [bots] = await pool.execute(
            'SELECT bot_id, bot_name, owner_user_id, enabled, approved, self_service, created_at FROM custom_bots WHERE bot_id = ?',
            [botId]
        );

        if (bots.length === 0) {
            return res.json({ hasCustomBot: false });
        }

        const bot = bots[0];
        const status = global.botManager?.getBotStatus(bot.bot_id) || null;

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

        // Check if the default bot is also in this guild
        const defaultClient = global.botManager?.getDefaultClient?.();
        const defaultBotInGuild = defaultClient ? defaultClient.guilds.cache.has(guildId) : false;

        res.json({
            hasCustomBot: true,
            defaultBotPresent: defaultBotInGuild,
            bot: {
                bot_id: bot.bot_id,
                bot_name: (status?.isReady && status?.username) ? status.username : bot.bot_name,
                bot_avatar: botAvatar,
                owner_user_id: bot.owner_user_id,
                enabled: bot.enabled,
                approved: bot.approved,
                self_service: bot.self_service,
                created_at: bot.created_at,
                is_online: status?.isReady || false
            }
        });
    } catch (error) {
        logger.error('[Custom Bot API] Error fetching bot info:', error);
        res.status(500).json({ error: 'Failed to fetch bot info' });
    }
});

/**
 * POST / — Create and assign a self-service custom bot for this guild
 */
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { bot_token, client_id } = req.body;

        if (!bot_token || !client_id) {
            return res.status(400).json({ error: 'Bot token and Application ID are required' });
        }

        if (typeof client_id !== 'string' || !/^\d{17,20}$/.test(client_id)) {
            return res.status(400).json({ error: 'Invalid Application ID format (must be 17-20 digit snowflake)' });
        }

        // Check if guild already has a custom bot — if so, remove it first
        const [existing] = await pool.execute(
            'SELECT gbm.bot_id, cb.self_service FROM guild_bot_mapping gbm JOIN custom_bots cb ON gbm.bot_id = cb.bot_id WHERE gbm.guild_id = ?',
            [guildId]
        );
        if (existing.length > 0) {
            const oldBotId = existing[0].bot_id;
            const oldIsSelfService = existing[0].self_service === 1;

            // Clean up old bot's announcements
            try {
                const oldClient = global.botManager?.getClientForGuild(guildId);
                const [anns] = await pool.execute('SELECT * FROM live_announcements WHERE guild_id = ?', [guildId]);
                for (const ann of anns) {
                    try {
                        if (oldClient) {
                            const ch = await oldClient.channels.fetch(ann.channel_id).catch(() => null);
                            if (ch?.isTextBased()) {
                                const msg = await ch.messages.fetch(ann.message_id).catch(() => null);
                                if (msg) await msg.delete().catch(() => null);
                            }
                        }
                    } catch { /* best effort */ }
                }
                await pool.execute('DELETE FROM live_announcements WHERE guild_id = ?', [guildId]);
            } catch { /* non-fatal */ }

            // Remove old mapping
            await pool.execute('DELETE FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);

            // Remove old bot from manager
            if (global.botManager) {
                try {
                    const [otherMappings] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [oldBotId]);
                    if (otherMappings.length === 0) {
                        await global.botManager.removeCustomBot(oldBotId).catch(() => {});
                    } else {
                        global.botManager.updateGuildMapping(guildId, 'default');
                    }
                } catch { /* non-fatal */ }
            }

            // Delete old bot record if self-service and no other guilds use it
            if (oldIsSelfService) {
                const [remaining] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [oldBotId]);
                if (remaining.length === 0) {
                    await pool.execute('DELETE FROM custom_bots WHERE bot_id = ?', [oldBotId]);
                }
            }

            logger.info(`[Custom Bot API] Replaced old bot ${oldBotId} in guild ${guildId}`);
        }

        // Validate the bot token
        let botInfo;
        try {
            botInfo = await testBotConnection(bot_token);
        } catch (validationError) {
            return res.status(400).json({
                error: 'Bot validation failed',
                details: validationError.message
            });
        }

        const bot_id = botInfo.id;

        // Check if this bot is already registered in the system
        const [existingBot] = await pool.execute(
            'SELECT bot_id, owner_user_id FROM custom_bots WHERE bot_id = ?',
            [bot_id]
        );
        if (existingBot.length > 0) {
            return res.status(400).json({ error: 'This bot is already registered in the system.' });
        }

        // Encrypt and store
        const encryptedToken = encryption.encrypt(bot_token);
        const botName = botInfo.username || `Bot ${bot_id}`;

        await pool.execute(`
            INSERT INTO custom_bots (bot_id, bot_name, bot_token, client_id, owner_user_id, enabled, approved, self_service)
            VALUES (?, ?, ?, ?, ?, 1, 1, 1)
        `, [bot_id, botName, JSON.stringify(encryptedToken), client_id, req.user.id]);

        await pool.execute(`
            INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by)
            VALUES (?, ?, ?)
        `, [guildId, bot_id, req.user.id]);

        // Start the bot immediately
        if (global.botManager) {
            try {
                const [mappings] = await pool.execute(
                    'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                    [bot_id]
                );
                await global.botManager.addCustomBot({
                    bot_id,
                    bot_token: encryptedToken,
                    guild_ids: mappings.map(m => m.guild_id)
                });
                global.botManager.updateGuildMapping(guildId, bot_id);
            } catch (startError) {
                logger.error(`[Custom Bot API] Bot created but failed to start: ${startError.message}`);
                // Don't fail the request — bot is in DB, will start on next PM2 restart
            }
        }

        logger.info(`[Custom Bot API] Self-service bot ${bot_id} (${botName}) created by ${req.user.username} for guild ${guildId}`);

        res.json({
            success: true,
            bot_id,
            bot_name: botName,
            message: 'Custom bot set up successfully and is now active!'
        });
    } catch (error) {
        logger.error('[Custom Bot API] Error creating bot:', error);
        res.status(500).json({ error: 'Failed to set up custom bot' });
    }
});

/**
 * DELETE / — Remove a self-service custom bot from this guild
 */
router.delete('/', async (req, res) => {
    try {
        const { guildId } = req.params;

        // Get the bot assigned to this guild
        const [mapping] = await pool.execute(
            'SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?',
            [guildId]
        );
        if (mapping.length === 0) {
            return res.status(404).json({ error: 'No custom bot assigned to this server' });
        }

        const botId = mapping[0].bot_id;

        // Look up bot info
        const [bots] = await pool.execute(
            'SELECT bot_id, self_service, owner_user_id FROM custom_bots WHERE bot_id = ?',
            [botId]
        );
        if (bots.length === 0) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const isSelfService = bots[0].self_service === 1;

        // Clean up live announcements for this guild
        try {
            const oldBotClient = global.botManager?.getClientForGuild(guildId);
            const [announcements] = await pool.execute(
                'SELECT * FROM live_announcements WHERE guild_id = ?',
                [guildId]
            );
            for (const ann of announcements) {
                try {
                    if (oldBotClient) {
                        const channel = await oldBotClient.channels.fetch(ann.channel_id).catch(() => null);
                        if (channel?.isTextBased()) {
                            const msg = await channel.messages.fetch(ann.message_id).catch(() => null);
                            if (msg) await msg.delete().catch(() => null);
                        }
                    }
                } catch { /* best effort */ }
            }
            await pool.execute('DELETE FROM live_announcements WHERE guild_id = ?', [guildId]);
        } catch (cleanupError) {
            logger.warn(`[Custom Bot API] Announcement cleanup error: ${cleanupError.message}`);
        }

        // Remove bot from manager
        if (global.botManager) {
            try {
                // Check if this bot is used by any OTHER guilds before removing entirely
                const [otherMappings] = await pool.execute(
                    'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ? AND guild_id != ?',
                    [botId, guildId]
                );
                if (otherMappings.length === 0) {
                    await global.botManager.removeCustomBot(botId);
                } else {
                    // Just remove this guild's mapping
                    global.botManager.updateGuildMapping(guildId, 'default');
                }
            } catch (e) {
                logger.warn(`[Custom Bot API] Bot manager cleanup: ${e.message}`);
            }
        }

        // Remove guild mapping
        await pool.execute('DELETE FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);

        // Only delete the bot record itself if it's self-service AND no other guilds use it
        // Managed bots stay in the system — they may be assigned to other guilds
        if (isSelfService) {
            const [remainingMappings] = await pool.execute(
                'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                [botId]
            );
            if (remainingMappings.length === 0) {
                await pool.execute('DELETE FROM custom_bots WHERE bot_id = ?', [botId]);
            }
        }

        logger.info(`[Custom Bot API] Self-service bot ${botId} removed from guild ${guildId} by ${req.user.username}`);

        res.json({ success: true, message: 'Custom bot removed. The server will now use the default bot.' });
    } catch (error) {
        logger.error('[Custom Bot API] Error removing bot:', error);
        res.status(500).json({ error: 'Failed to remove custom bot' });
    }
});

export default router;
