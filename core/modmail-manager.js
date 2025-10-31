"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const discord_js_1 = require("discord.js");
class ModmailManager {
    constructor(client) {
        this.client = client;
        this.activeThreads = new Map();
        logger_1.default.info('[ModmailManager] Modmail manager initialized');
    }
    async getConfig(guildId) {
        try {
            const [[config]] = await db_1.default.execute('SELECT * FROM modmail_config WHERE guild_id = ?', [guildId]);
            return config || null;
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to get config: ${error.message}`, { guildId });
            return null;
        }
    }
    async handleMessage(message) {
        // Route to handleDM if it's a DM
        if (!message.guild) {
            return await this.handleDM(message);
        }
        // Otherwise ignore guild messages
    }
    async handleDM(message) {
        try {
            if (message.author.bot)
                return;
            if (message.guild)
                return; // Not a DM
            // Find guild where user has an open thread or can create one
            const guilds = this.client.guilds.cache.filter(g => g.members.cache.has(message.author.id));
            for (const [guildId, guild] of guilds) {
                const config = await this.getConfig(guildId);
                if (!config || !config.enabled)
                    continue;
                // Check for existing thread
                const [[existingThread]] = await db_1.default.execute('SELECT * FROM modmail_threads WHERE guild_id = ? AND user_id = ? AND status = "open"', [guildId, message.author.id]);
                if (existingThread) {
                    await this.forwardMessageToStaff(message, existingThread, guild, config);
                    return;
                }
                // Create new thread
                await this.createThread(message, guild, config);
                return;
            }
            // No guild found with modmail enabled
            await message.reply('❌ Modmail is not configured for any servers you\'re in.');
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to handle DM: ${error.message}`);
        }
    }
    async createThread(message, guild, config) {
        try {
            const category = guild.channels.cache.get(config.category_id);
            if (!category) {
                await message.reply('❌ Modmail is not properly configured. Please contact an administrator.');
                return;
            }
            // Create thread channel
            const threadChannel = await guild.channels.create({
                name: `modmail-${message.author.username}`,
                type: discord_js_1.ChannelType.GuildText,
                parent: category.id,
                topic: `Modmail thread for ${message.author.tag} (${message.author.id})`,
                permissionOverwrites: [
                    {
                        id: guild.id,
                        deny: [discord_js_1.PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: this.client.user.id,
                        allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages]
                    }
                ]
            });
            // Add staff role permission if configured
            if (config.staff_role_id) {
                await threadChannel.permissionOverwrites.create(config.staff_role_id, {
                    ViewChannel: true,
                    SendMessages: true
                });
            }
            // Save thread to database
            const [result] = await db_1.default.execute(`INSERT INTO modmail_threads (guild_id, user_id, channel_id, status)
                VALUES (?, ?, ?, 'open')`, [guild.id, message.author.id, threadChannel.id]);
            const threadId = result.insertId;
            this.activeThreads.set(message.author.id, { threadId, channelId: threadChannel.id, guildId: guild.id });
            // Send welcome embed in channel
            const welcomeEmbed = new discord_js_1.EmbedBuilder()
                .setColor('#5865F2')
                .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
                .setTitle('📬 New Modmail Thread')
                .setDescription(`**User:** ${message.author} (${message.author.id})\n**Account Created:** <t:${Math.floor(message.author.createdTimestamp / 1000)}:R>`)
                .addFields({ name: 'Initial Message', value: message.content || '*No content*' })
                .setTimestamp();
            if (message.attachments.size > 0) {
                welcomeEmbed.addFields({
                    name: 'Attachments',
                    value: message.attachments.map(a => a.url).join('\n')
                });
            }
            await threadChannel.send({ embeds: [welcomeEmbed] });
            // Log message
            await this.logMessage(threadId, message.author.id, 'user', message.content, message.attachments);
            // Send greeting to user
            await message.reply(config.greeting_message || 'Thank you for contacting the staff team. Your message has been received!');
            logger_1.default.info(`[ModmailManager] Created modmail thread for ${message.author.tag}`, {
                guildId: guild.id,
                userId: message.author.id,
                threadId
            });
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to create thread: ${error.message}`);
            await message.reply('❌ Failed to create modmail thread. Please try again later.').catch(() => { });
        }
    }
    async forwardMessageToStaff(message, thread, guild, config) {
        try {
            const channel = guild.channels.cache.get(thread.channel_id);
            if (!channel) {
                await message.reply('❌ Your modmail thread was deleted. Creating a new one...');
                await this.createThread(message, guild, config);
                return;
            }
            const embed = new discord_js_1.EmbedBuilder()
                .setColor('#3498DB')
                .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
                .setDescription(message.content || '*No content*')
                .setTimestamp();
            if (message.attachments.size > 0) {
                embed.addFields({
                    name: 'Attachments',
                    value: message.attachments.map(a => a.url).join('\n')
                });
            }
            await channel.send({ embeds: [embed] });
            // Log message
            await this.logMessage(thread.id, message.author.id, 'user', message.content, message.attachments);
            await message.react('✅');
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to forward message: ${error.message}`);
        }
    }
    async handleStaffReply(message, threadChannel) {
        try {
            // Find thread by channel ID
            const [[thread]] = await db_1.default.execute('SELECT * FROM modmail_threads WHERE channel_id = ? AND status = "open"', [threadChannel.id]);
            if (!thread)
                return false;
            const user = await this.client.users.fetch(thread.user_id).catch(() => null);
            if (!user) {
                await message.reply('❌ Could not find user. They may have left all mutual servers.');
                return true;
            }
            // Send to user
            const embed = new discord_js_1.EmbedBuilder()
                .setColor('#57F287')
                .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
                .setDescription(message.content || '*No content*')
                .setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() || undefined })
                .setTimestamp();
            if (message.attachments.size > 0) {
                embed.addFields({
                    name: 'Attachments',
                    value: message.attachments.map(a => a.url).join('\n')
                });
            }
            await user.send({ embeds: [embed] });
            // Log message
            await this.logMessage(thread.id, message.author.id, 'staff', message.content, message.attachments);
            await message.react('✅');
            return true;
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to handle staff reply: ${error.message}`);
            await message.reply('❌ Failed to send message to user.').catch(() => { });
            return true;
        }
    }
    async closeThread(threadId, closedBy, reason = 'No reason provided') {
        try {
            const [[thread]] = await db_1.default.execute('SELECT * FROM modmail_threads WHERE id = ?', [threadId]);
            if (!thread)
                return false;
            const config = await this.getConfig(thread.guild_id);
            // Update database
            await db_1.default.execute('UPDATE modmail_threads SET status = "closed", closed_at = NOW(), closed_by = ? WHERE id = ?', [closedBy, threadId]);
            // Remove from active threads
            this.activeThreads.delete(thread.user_id);
            // Send closing message to user
            const user = await this.client.users.fetch(thread.user_id).catch(() => null);
            if (user) {
                const closeMessage = config?.close_message || 'This modmail thread has been closed. Thank you for contacting us!';
                await user.send(`${closeMessage}\n\n**Reason:** ${reason}`).catch(() => { });
            }
            // Delete or archive channel
            const guild = this.client.guilds.cache.get(thread.guild_id);
            if (guild) {
                const channel = guild.channels.cache.get(thread.channel_id);
                if (channel) {
                    // Send closure message in channel
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor('#ED4245')
                        .setTitle('🔒 Thread Closed')
                        .setDescription(`Closed by <@${closedBy}>`)
                        .addFields({ name: 'Reason', value: reason })
                        .setTimestamp();
                    await channel.send({ embeds: [embed] });
                    // Delete after 10 seconds
                    setTimeout(async () => {
                        await channel.delete('Modmail thread closed').catch(() => { });
                    }, 10000);
                }
            }
            logger_1.default.info(`[ModmailManager] Closed modmail thread ${threadId}`, {
                threadId,
                closedBy
            });
            return true;
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to close thread: ${error.message}`);
            return false;
        }
    }
    async logMessage(threadId, authorId, authorType, content, attachments) {
        try {
            const attachmentData = attachments.size > 0
                ? JSON.stringify(Array.from(attachments.values()).map(a => ({ url: a.url, name: a.name })))
                : null;
            await db_1.default.execute(`INSERT INTO modmail_messages (thread_id, author_id, author_type, message_content, attachments)
                VALUES (?, ?, ?, ?, ?)`, [threadId, authorId, authorType, content, attachmentData]);
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to log message: ${error.message}`);
        }
    }
    async getThreadMessages(threadId) {
        try {
            const [messages] = await db_1.default.execute('SELECT * FROM modmail_messages WHERE thread_id = ? ORDER BY timestamp ASC', [threadId]);
            return messages;
        }
        catch (error) {
            logger_1.default.error(`[ModmailManager] Failed to get thread messages: ${error.message}`);
            return [];
        }
    }
    isModmailChannel(channelId) {
        return Array.from(this.activeThreads.values()).some(t => t.channelId === channelId);
    }
}
exports.default = ModmailManager;
