"use strict";
const discord_js_1 = require("discord.js");
const { db } = require('../utils/db');
const { logger } = require('../utils/logger');
class ContextMenuManager {
    constructor(client) {
        this.menus = new Map();
        this.client = client;
    }
    async init() {
        logger.info('[ContextMenu] Initializing Context Menu Manager...');
        await this.registerDefaultMenus();
        logger.info('[ContextMenu] Context Menu Manager initialized');
    }
    async registerDefaultMenus() {
        this.registerMenu('User Info', discord_js_1.ApplicationCommandType.User, async (interaction) => {
            if (!interaction.isUserContextMenuCommand())
                return;
            const user = interaction.targetUser;
            const member = interaction.targetMember;
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x3498DB)
                .setTitle(`User Information: ${user.tag}`)
                .setThumbnail(user.displayAvatarURL())
                .addFields({ name: 'User ID', value: user.id, inline: true }, { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true }, { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true })
                .setTimestamp();
            if (member && typeof member === 'object' && 'joinedTimestamp' in member) {
                embed.addFields({ name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true }, { name: 'Roles', value: member.roles.cache.size.toString(), inline: true }, { name: 'Nickname', value: member.nickname || 'None', inline: true });
            }
            await interaction.reply({ embeds: [embed], ephemeral: true });
            await this.logUsage(interaction.guildId, 'User Info', interaction.user.id, user.id);
        });
        this.registerMenu('Avatar', discord_js_1.ApplicationCommandType.User, async (interaction) => {
            if (!interaction.isUserContextMenuCommand())
                return;
            const user = interaction.targetUser;
            const avatarURL = user.displayAvatarURL({ size: 4096, forceStatic: false });
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x3498DB)
                .setTitle(`${user.tag}'s Avatar`)
                .setImage(avatarURL)
                .setDescription(`[Download](${avatarURL})`);
            await interaction.reply({ embeds: [embed], ephemeral: true });
            await this.logUsage(interaction.guildId, 'Avatar', interaction.user.id, user.id);
        });
        this.registerMenu('Report Message', discord_js_1.ApplicationCommandType.Message, async (interaction) => {
            if (!interaction.isMessageContextMenuCommand())
                return;
            const message = interaction.targetMessage;
            const [[logConfig]] = await db.execute('SELECT * FROM log_config WHERE guild_id = ?', [interaction.guildId]);
            if (!logConfig || !logConfig.mod_log_channel) {
                return interaction.reply({
                    content: '❌ No moderation log channel configured.',
                    ephemeral: true
                });
            }
            const logChannel = await interaction.guild.channels.fetch(logConfig.mod_log_channel).catch(() => null);
            if (!logChannel || !logChannel.isTextBased()) {
                return interaction.reply({
                    content: '❌ Moderation log channel not found.',
                    ephemeral: true
                });
            }
            const reportEmbed = new discord_js_1.EmbedBuilder()
                .setColor(0xE74C3C)
                .setTitle('⚠️ Message Reported')
                .addFields({ name: 'Reported By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true }, { name: 'Author', value: `${message.author.tag} (${message.author.id})`, inline: true }, { name: 'Channel', value: `<#${message.channel.id}>`, inline: true }, { name: 'Message Content', value: message.content.substring(0, 1000) || '*No content*', inline: false }, { name: 'Message Link', value: `[Jump to Message](${message.url})`, inline: false })
                .setTimestamp();
            await logChannel.send({ embeds: [reportEmbed] });
            await interaction.reply({
                content: '✅ Message has been reported to moderators.',
                ephemeral: true
            });
            await this.logUsage(interaction.guildId, 'Report Message', interaction.user.id, message.id);
        });
        this.registerMenu('Pin Message', discord_js_1.ApplicationCommandType.Message, async (interaction) => {
            if (!interaction.isMessageContextMenuCommand())
                return;
            const message = interaction.targetMessage;
            if (!interaction.memberPermissions?.has(discord_js_1.PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({
                    content: '❌ You need Manage Messages permission to pin messages.',
                    ephemeral: true
                });
            }
            if (message.pinned) {
                await message.unpin();
                await interaction.reply({ content: '✅ Message unpinned!', ephemeral: true });
            }
            else {
                await message.pin();
                await interaction.reply({ content: '✅ Message pinned!', ephemeral: true });
            }
            await this.logUsage(interaction.guildId, 'Pin Message', interaction.user.id, message.id);
        });
        logger.info('[ContextMenu] Registered default context menus');
    }
    registerMenu(name, type, handler) {
        this.menus.set(name, { type, handler });
    }
    async handleContextMenu(interaction) {
        const menu = this.menus.get(interaction.commandName);
        if (!menu)
            return;
        try {
            await menu.handler(interaction);
        }
        catch (error) {
            logger.error(`[ContextMenu] Error handling ${interaction.commandName}:`, error);
            const reply = { content: '❌ An error occurred while processing this action.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply);
            }
            else {
                await interaction.reply(reply);
            }
        }
    }
    async logUsage(guildId, menuName, userId, targetId) {
        try {
            await db.execute(`INSERT INTO context_menu_usage (guild_id, menu_name, user_id, target_id)
                 VALUES (?, ?, ?, ?)`, [guildId, menuName, userId, targetId]);
        }
        catch (error) {
            logger.error('[ContextMenu] Error logging usage:', error);
        }
    }
    getMenuCommands() {
        const commands = [];
        for (const [name, menu] of this.menus) {
            commands.push(new discord_js_1.ContextMenuCommandBuilder()
                .setName(name)
                .setType(menu.type)
                .toJSON());
        }
        return commands;
    }
    shutdown() {
        this.menus.clear();
        logger.info('[ContextMenu] Context Menu Manager shut down');
    }
}
module.exports = ContextMenuManager;
