/**
 * Lockdown Command - Emergency Channel/Server Lockdown
 * Based on Wick & Dyno bot features
 * Allows moderators to quickly lock channels during raids/emergencies
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { db } = require('../utils/db');
const { logger } = require('../utils/logger');

module.exports = {
    category: 'Moderation',
    data: new SlashCommandBuilder()
        .setName('lockdown')
        .setDescription('Emergency lockdown commands for channels or entire server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Lock a specific channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Channel to lock (current channel if not specified)')
                        .setRequired(false)
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement))
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Reason for lockdown')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('server')
                .setDescription('Lock ALL channels in the server (EMERGENCY ONLY)')
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Reason for server-wide lockdown')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('unlock')
                .setDescription('Unlock a previously locked channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Channel to unlock (current channel if not specified)')
                        .setRequired(false)
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('unlock-all')
                .setDescription('Unlock all locked channels in the server'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show currently locked channels')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'channel':
                return await lockChannel(interaction);
            case 'server':
                return await lockServer(interaction);
            case 'unlock':
                return await unlockChannel(interaction);
            case 'unlock-all':
                return await unlockAll(interaction);
            case 'status':
                return await showLockdownStatus(interaction);
        }
    },
};

async function lockChannel(interaction) {
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
        // Get @everyone role
        const everyoneRole = interaction.guild.roles.everyone;

        // Store original permissions
        const originalPerms = targetChannel.permissionOverwrites.cache.get(everyoneRole.id);

        // Lock the channel (deny Send Messages / Connect)
        await targetChannel.permissionOverwrites.edit(everyoneRole, {
            SendMessages: false,
            Connect: false,
            AddReactions: false
        });

        // Store lockdown in database
        await db.execute(
            `INSERT INTO lockdowns (guild_id, channel_id, locked_by, reason, locked_at, original_perms)
             VALUES (?, ?, ?, ?, NOW(), ?)
             ON DUPLICATE KEY UPDATE
                locked_by = VALUES(locked_by),
                reason = VALUES(reason),
                locked_at = NOW(),
                original_perms = VALUES(original_perms)`,
            [
                interaction.guild.id,
                targetChannel.id,
                interaction.user.id,
                reason,
                JSON.stringify(originalPerms ? originalPerms.toJSON() : null)
            ]
        );

        logger.info(`[Lockdown] Channel ${targetChannel.name} locked by ${interaction.user.tag}`, {
            guildId: interaction.guild.id,
            channelId: targetChannel.id,
            userId: interaction.user.id,
            reason,
            category: 'moderation'
        });

        // Send lockdown announcement in channel
        await targetChannel.send({
            embeds: [{
                color: 0xFF0000,
                title: '🔒 Channel Locked',
                description: `This channel has been locked by ${interaction.user}.`,
                fields: [
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.tag, inline: true },
                    { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ],
                footer: { text: 'Please wait for further instructions from moderators.' }
            }]
        });

        return interaction.reply({
            content: `✅ Successfully locked ${targetChannel}.\n**Reason:** ${reason}`,
            ephemeral: true
        });

    } catch (error) {
        logger.error('[Lockdown] Error locking channel:', error);
        return interaction.reply({
            content: '❌ Failed to lock channel. Make sure I have the Manage Channels permission.',
            ephemeral: true
        });
    }
}

async function lockServer(interaction) {
    const reason = interaction.options.getString('reason') || 'Emergency lockdown';

    await interaction.reply({
        content: '🔒 **SERVER-WIDE LOCKDOWN INITIATED**\nLocking all channels... This may take a moment.',
        ephemeral: true
    });

    try {
        const everyoneRole = interaction.guild.roles.everyone;
        let lockedCount = 0;

        // Get all text and voice channels
        const channels = interaction.guild.channels.cache.filter(c =>
            c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildVoice ||
            c.type === ChannelType.GuildAnnouncement
        );

        for (const [channelId, channel] of channels) {
            try {
                // Store original permissions
                const originalPerms = channel.permissionOverwrites.cache.get(everyoneRole.id);

                // Lock channel
                await channel.permissionOverwrites.edit(everyoneRole, {
                    SendMessages: false,
                    Connect: false,
                    AddReactions: false
                });

                // Store in database
                await db.execute(
                    `INSERT INTO lockdowns (guild_id, channel_id, locked_by, reason, locked_at, original_perms)
                     VALUES (?, ?, ?, ?, NOW(), ?)
                     ON DUPLICATE KEY UPDATE
                        locked_by = VALUES(locked_by),
                        reason = VALUES(reason),
                        locked_at = NOW()`,
                    [
                        interaction.guild.id,
                        channel.id,
                        interaction.user.id,
                        reason,
                        JSON.stringify(originalPerms ? originalPerms.toJSON() : null)
                    ]
                );

                lockedCount++;
            } catch (err) {
                logger.error(`[Lockdown] Failed to lock channel ${channel.name}:`, err);
            }
        }

        logger.info(`[Lockdown] Server-wide lockdown by ${interaction.user.tag}`, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            channelsLocked: lockedCount,
            reason,
            category: 'moderation'
        });

        return interaction.editReply({
            content: `✅ **SERVER LOCKDOWN COMPLETE**\n🔒 Locked ${lockedCount} channels.\n**Reason:** ${reason}`,
            ephemeral: true
        });

    } catch (error) {
        logger.error('[Lockdown] Error during server lockdown:', error);
        return interaction.editReply({
            content: '❌ Server lockdown failed. Check bot permissions.',
            ephemeral: true
        });
    }
}

async function unlockChannel(interaction) {
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

    try {
        // Get lockdown data from database
        const [[lockdownData]] = await db.execute(
            'SELECT * FROM lockdowns WHERE guild_id = ? AND channel_id = ?',
            [interaction.guild.id, targetChannel.id]
        );

        const everyoneRole = interaction.guild.roles.everyone;

        if (lockdownData && lockdownData.original_perms) {
            // Restore original permissions
            const originalPerms = JSON.parse(lockdownData.original_perms);
            if (originalPerms) {
                await targetChannel.permissionOverwrites.edit(everyoneRole, originalPerms);
            } else {
                // No original perms stored, just remove lockdown
                await targetChannel.permissionOverwrites.edit(everyoneRole, {
                    SendMessages: null,
                    Connect: null,
                    AddReactions: null
                });
            }
        } else {
            // No stored data, just unlock
            await targetChannel.permissionOverwrites.edit(everyoneRole, {
                SendMessages: null,
                Connect: null,
                AddReactions: null
            });
        }

        // Remove from database
        await db.execute(
            'DELETE FROM lockdowns WHERE guild_id = ? AND channel_id = ?',
            [interaction.guild.id, targetChannel.id]
        );

        logger.info(`[Lockdown] Channel ${targetChannel.name} unlocked by ${interaction.user.tag}`, {
            guildId: interaction.guild.id,
            channelId: targetChannel.id,
            userId: interaction.user.id,
            category: 'moderation'
        });

        // Send unlock announcement
        await targetChannel.send({
            embeds: [{
                color: 0x00FF00,
                title: '🔓 Channel Unlocked',
                description: `This channel has been unlocked by ${interaction.user}.`,
                fields: [
                    { name: 'Moderator', value: interaction.user.tag, inline: true },
                    { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ],
                footer: { text: 'You can now send messages again.' }
            }]
        });

        return interaction.reply({
            content: `✅ Successfully unlocked ${targetChannel}.`,
            ephemeral: true
        });

    } catch (error) {
        logger.error('[Lockdown] Error unlocking channel:', error);
        return interaction.reply({
            content: '❌ Failed to unlock channel.',
            ephemeral: true
        });
    }
}

async function unlockAll(interaction) {
    await interaction.reply({
        content: '🔓 **UNLOCKING ALL CHANNELS**\nRemoving lockdowns... This may take a moment.',
        ephemeral: true
    });

    try {
        // Get all locked channels for this guild
        const [lockedChannels] = await db.execute(
            'SELECT * FROM lockdowns WHERE guild_id = ?',
            [interaction.guild.id]
        );

        const everyoneRole = interaction.guild.roles.everyone;
        let unlockedCount = 0;

        for (const lockdownData of lockedChannels) {
            try {
                const channel = await interaction.guild.channels.fetch(lockdownData.channel_id).catch(() => null);
                if (!channel) continue;

                // Restore original permissions if available
                if (lockdownData.original_perms) {
                    const originalPerms = JSON.parse(lockdownData.original_perms);
                    if (originalPerms) {
                        await channel.permissionOverwrites.edit(everyoneRole, originalPerms);
                    }
                } else {
                    await channel.permissionOverwrites.edit(everyoneRole, {
                        SendMessages: null,
                        Connect: null,
                        AddReactions: null
                    });
                }

                unlockedCount++;
            } catch (err) {
                logger.error(`[Lockdown] Failed to unlock channel ${lockdownData.channel_id}:`, err);
            }
        }

        // Clear all lockdowns from database
        await db.execute(
            'DELETE FROM lockdowns WHERE guild_id = ?',
            [interaction.guild.id]
        );

        logger.info(`[Lockdown] All channels unlocked by ${interaction.user.tag}`, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            channelsUnlocked: unlockedCount,
            category: 'moderation'
        });

        return interaction.editReply({
            content: `✅ **ALL CHANNELS UNLOCKED**\n🔓 Unlocked ${unlockedCount} channels.`,
            ephemeral: true
        });

    } catch (error) {
        logger.error('[Lockdown] Error unlocking all channels:', error);
        return interaction.editReply({
            content: '❌ Failed to unlock all channels.',
            ephemeral: true
        });
    }
}

async function showLockdownStatus(interaction) {
    try {
        const [lockedChannels] = await db.execute(
            'SELECT * FROM lockdowns WHERE guild_id = ? ORDER BY locked_at DESC',
            [interaction.guild.id]
        );

        if (lockedChannels.length === 0) {
            return interaction.reply({
                content: '✅ No channels are currently locked.',
                ephemeral: true
            });
        }

        const channelList = await Promise.all(lockedChannels.map(async (lock) => {
            const channel = await interaction.guild.channels.fetch(lock.channel_id).catch(() => null);
            const locker = await interaction.client.users.fetch(lock.locked_by).catch(() => null);

            return `🔒 ${channel || `Unknown Channel (${lock.channel_id})`}\n   **Locked by:** ${locker?.tag || 'Unknown'}\n   **Reason:** ${lock.reason}\n   **Time:** <t:${Math.floor(new Date(lock.locked_at).getTime() / 1000)}:R>`;
        }));

        return interaction.reply({
            embeds: [{
                color: 0xFF9900,
                title: `🔒 Lockdown Status - ${interaction.guild.name}`,
                description: `**${lockedChannels.length}** channel(s) currently locked:\n\n${channelList.join('\n\n')}`,
                footer: { text: 'Use /lockdown unlock or /lockdown unlock-all to remove lockdowns' }
            }],
            ephemeral: true
        });

    } catch (error) {
        logger.error('[Lockdown] Error showing status:', error);
        return interaction.reply({
            content: '❌ Failed to retrieve lockdown status.',
            ephemeral: true
        });
    }
}
