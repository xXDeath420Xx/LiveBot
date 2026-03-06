import {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ChannelType,
    AttachmentBuilder
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { crossPollinateStreamer } from '../../utils/streamer-cross-pollinate.js';
import * as twitchApi from '../../utils/platforms/twitch.js';
import * as kickApi from '../../utils/platforms/kick.js';
import * as youtubeApi from '../../utils/platforms/youtube.js';
import * as facebookApi from '../../utils/platforms/facebook.js';
import * as instagramApi from '../../utils/platforms/instagram.js';
import * as tiktokApi from '../../utils/platforms/tiktok.js';
import * as trovoApi from '../../utils/platforms/trovo.js';

export const platformChoices = [
    { name: 'Twitch', value: 'twitch' },
    { name: 'Kick', value: 'kick' },
    { name: 'YouTube', value: 'youtube' },
    { name: 'TikTok', value: 'tiktok' },
    { name: 'Trovo', value: 'trovo' },
    { name: 'Facebook', value: 'facebook' },
    { name: 'Instagram', value: 'instagram' }
];

const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    youtube: youtubeApi,
    facebook: facebookApi,
    instagram: instagramApi,
    tiktok: tiktokApi,
    trovo: trovoApi
};

export async function handleSetup(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel('channel');
    const liveRole = interaction.options.getRole('live-role');
    const message = interaction.options.getString('message');

    let connection;
    try {
        connection = await pool.getConnection();

        const [existing] = await connection.query(
            'SELECT * FROM guilds WHERE guild_id = ?',
            [interaction.guild.id]
        );

        const updates = [];
        const values = [];

        if (channel) {
            updates.push('announcement_channel_id = ?');
            values.push(channel.id);
        }

        if (liveRole) {
            updates.push('live_role_id = ?');
            values.push(liveRole.id);
        }

        if (message) {
            updates.push('custom_announcement_message = ?');
            values.push(message);
        }

        if (updates.length === 0) {
            return await interaction.editReply('No settings specified. Please provide at least one option.');
        }

        if (existing.length > 0) {
            await connection.query(
                `UPDATE guilds SET ${updates.join(', ')} WHERE guild_id = ?`,
                [...values, interaction.guild.id]
            );
        } else {
            const fields = ['guild_id'];
            const placeholders = ['?'];
            const insertValues = [interaction.guild.id];

            if (channel) {
                fields.push('announcement_channel_id');
                placeholders.push('?');
                insertValues.push(channel.id);
            }
            if (liveRole) {
                fields.push('live_role_id');
                placeholders.push('?');
                insertValues.push(liveRole.id);
            }
            if (message) {
                fields.push('custom_announcement_message');
                placeholders.push('?');
                insertValues.push(message);
            }

            await connection.query(
                `INSERT INTO guilds (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`,
                insertValues
            );
        }

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('Stream Announcement Settings Updated')
            .setDescription('Your stream notification settings have been configured.')
            .setTimestamp();

        if (channel) {
            embed.addFields({ name: 'Announcement Channel', value: `<#${channel.id}>`, inline: true });
        }
        if (liveRole) {
            embed.addFields({ name: 'Live Role', value: `<@&${liveRole.id}>`, inline: true });
        }
        if (message) {
            embed.addFields({ name: 'Custom Message', value: message, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });

        logger.info('[Streamer Setup] Settings updated', {
            guildId: interaction.guild.id,
            channel: channel?.id,
            role: liveRole?.id,
            category: 'streams'
        });

    } catch (error) {
        logger.error('[Streamer Setup] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred while updating settings. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

export async function handleAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username').trim();
    const discordUser = interaction.options.getUser('discord-user');

    let connection;
    try {
        connection = await pool.getConnection();

        const api = platformModules[platform];
        if (!api) {
            return await interaction.editReply(`Platform ${platform} is not supported yet.`);
        }

        let platformUserId = null;
        let canonicalUsername = username;

        try {
            if (platform === 'twitch') {
                const user = await twitchApi.getTwitchUser(username);
                if (!user) {
                    return await interaction.editReply(`Twitch user "${username}" not found.`);
                }
                platformUserId = user.id;
                canonicalUsername = user.login;
            } else if (platform === 'kick') {
                const user = await kickApi.getKickUser(username);
                if (!user) {
                    return await interaction.editReply(`Kick user "${username}" not found.`);
                }
                platformUserId = String(user.id);
                canonicalUsername = user.slug || username;
            } else if (platform === 'youtube') {
                platformUserId = username;
                canonicalUsername = username;
            } else {
                platformUserId = username;
                canonicalUsername = username;
            }
        } catch (error) {
            logger.error(`[Streamer Add] Error fetching ${platform} user:`, { error, category: 'streams' });
            return await interaction.editReply(`Could not verify ${platform} user "${username}". Please check the username and try again.`);
        }

        const [existingStreamer] = await connection.query(
            'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
            [platform, platformUserId]
        );

        let streamerId;

        if (existingStreamer.length > 0) {
            streamerId = existingStreamer[0].streamer_id;
        } else {
            const [result] = await connection.query(
                'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)',
                [platform, platformUserId, canonicalUsername, discordUser?.id || null]
            );
            streamerId = result.insertId;
        }

        const [existingSub] = await connection.query(
            'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
            [interaction.guild.id, streamerId]
        );

        if (existingSub.length > 0) {
            return await interaction.editReply(`${canonicalUsername} on ${platform} is already being tracked in this server.`);
        }

        await connection.query(
            'INSERT INTO subscriptions (guild_id, streamer_id) VALUES (?, ?)',
            [interaction.guild.id, streamerId]
        );

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('Streamer Added')
            .setDescription(`Successfully added **${canonicalUsername}** from **${platform}** to your tracked streamers!`)
            .setTimestamp();

        if (discordUser) {
            embed.addFields({ name: 'Linked Discord User', value: `<@${discordUser.id}>`, inline: true });
        }

        // Cross-pollinate to other servers where this user is a member
        const crossAdded = await crossPollinateStreamer(streamerId, discordUser?.id, interaction.guild.id);
        if (crossAdded.length > 0) {
            embed.addFields({
                name: 'Auto-added to other servers',
                value: `Also tracking in ${crossAdded.length} additional server(s)`,
                inline: true
            });
        }

        await interaction.editReply({ embeds: [embed] });

        logger.info('[Streamer Add] Streamer added', {
            guildId: interaction.guild.id,
            platform,
            username: canonicalUsername,
            crossPollinated: crossAdded.length,
            category: 'streams'
        });

    } catch (error) {
        logger.error('[Streamer Add] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred while adding the streamer. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

export async function handleRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username').trim().toLowerCase();

    let connection;
    try {
        connection = await pool.getConnection();

        const [streamers] = await connection.query(
            'SELECT streamer_id, username FROM streamers WHERE platform = ? AND LOWER(username) = ?',
            [platform, username]
        );

        if (streamers.length === 0) {
            return await interaction.editReply(`No ${platform} streamer found with username "${username}".`);
        }

        const streamerId = streamers[0].streamer_id;

        const [result] = await connection.query(
            'DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
            [interaction.guild.id, streamerId]
        );

        if (result.affectedRows === 0) {
            return await interaction.editReply(`${streamers[0].username} on ${platform} was not being tracked in this server.`);
        }

        await connection.query(
            'DELETE FROM live_announcements WHERE guild_id = ? AND streamer_id = ?',
            [interaction.guild.id, streamerId]
        );

        const embed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('Streamer Removed')
            .setDescription(`Successfully removed **${streamers[0].username}** from **${platform}** from your tracked streamers.`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        logger.info('[Streamer Remove] Streamer removed', {
            guildId: interaction.guild.id,
            platform,
            username: streamers[0].username,
            category: 'streams'
        });

    } catch (error) {
        logger.error('[Streamer Remove] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred while removing the streamer. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

export async function handleList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const platform = interaction.options.getString('platform');

    let connection;
    try {
        connection = await pool.getConnection();

        let query = `
            SELECT s.platform, s.username, s.discord_user_id,
                   (SELECT COUNT(*) FROM live_announcements WHERE streamer_id = s.streamer_id AND guild_id = ?) as is_live
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE sub.guild_id = ?
        `;
        const params = [interaction.guild.id, interaction.guild.id];

        if (platform) {
            query += ' AND s.platform = ?';
            params.push(platform);
        }

        query += ' ORDER BY is_live DESC, s.platform, s.username';

        const [streamers] = await connection.query(query, params);

        if (streamers.length === 0) {
            const msg = platform
                ? `No ${platform} streamers are being tracked in this server.`
                : 'No streamers are being tracked in this server.';
            return await interaction.editReply(msg);
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(platform ? `Tracked ${platform.charAt(0).toUpperCase() + platform.slice(1)} Streamers` : 'Tracked Streamers')
            .setTimestamp();

        const liveCount = streamers.filter(s => s.is_live > 0).length;
        embed.setDescription(`Tracking **${streamers.length}** streamers (${liveCount} currently live)`);

        const byPlatform = {};
        for (const streamer of streamers) {
            if (!byPlatform[streamer.platform]) {
                byPlatform[streamer.platform] = [];
            }
            byPlatform[streamer.platform].push(streamer);
        }

        for (const [plat, list] of Object.entries(byPlatform)) {
            const lines = list.map(s => {
                const status = s.is_live > 0 ? '\ud83d\udfe2' : '\u26ab';
                const user = s.discord_user_id ? ` (<@${s.discord_user_id}>)` : '';
                return `${status} ${s.username}${user}`;
            });

            embed.addFields({
                name: `${plat.charAt(0).toUpperCase() + plat.slice(1)} (${list.length})`,
                value: lines.join('\n') || 'None',
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Streamer List] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred while fetching the streamer list. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

export async function handleCheckLive(interaction) {
    await interaction.deferReply({ ephemeral: true });

    let connection;
    try {
        connection = await pool.getConnection();

        const [liveStreamers] = await connection.query(`
            SELECT s.platform, s.username, s.discord_user_id, s.platform_user_id
            FROM live_announcements la
            JOIN streamers s ON la.streamer_id = s.streamer_id
            WHERE la.guild_id = ?
            GROUP BY s.streamer_id
        `, [interaction.guild.id]);

        if (liveStreamers.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('No Live Streamers')
                .setDescription('None of your tracked streamers are currently live.')
                .setTimestamp();

            return await interaction.editReply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle(`\ud83d\udd34 ${liveStreamers.length} Streamer${liveStreamers.length > 1 ? 's' : ''} Currently Live`)
            .setTimestamp();

        const platformUrls = {
            twitch: (username) => `https://twitch.tv/${username}`,
            kick: (username) => `https://kick.com/${username}`,
            youtube: (id) => `https://youtube.com/channel/${id}`,
            tiktok: (username) => `https://tiktok.com/@${username}`,
            trovo: (username) => `https://trovo.live/s/${username}`,
            facebook: (username) => `https://facebook.com/gaming/${username}`,
            instagram: (username) => `https://instagram.com/${username}`
        };

        const lines = liveStreamers.map(s => {
            const url = platformUrls[s.platform]
                ? platformUrls[s.platform](s.platform === 'youtube' ? s.platform_user_id : s.username)
                : '#';
            const user = s.discord_user_id ? ` (<@${s.discord_user_id}>)` : '';
            return `\ud83d\udfe2 [${s.username}](${url}) - ${s.platform}${user}`;
        });

        embed.setDescription(lines.join('\n'));

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Streamer Check Live] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred while checking live streamers. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

export async function handleEdit(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username').trim().toLowerCase();

    let connection;
    try {
        connection = await pool.getConnection();

        const [rows] = await connection.query(`
            SELECT s.streamer_id, s.username, s.platform, s.discord_user_id,
                   sub.subscription_id, sub.announcement_channel_id, sub.custom_message,
                   sub.live_role_id, sub.delete_on_end, sub.notify_videos,
                   sub.video_announcement_channel_id
            FROM streamers s
            JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
            WHERE s.platform = ? AND LOWER(s.username) = ? AND sub.guild_id = ?
        `, [platform, username, interaction.guild.id]);

        if (rows.length === 0) {
            return await interaction.editReply(`No ${platform} streamer found with username "${username}" in this server.`);
        }

        const streamer = rows[0];

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Edit Settings: ${streamer.username}`)
            .setDescription(`Configure announcement settings for **${streamer.username}** on **${platform}**`)
            .addFields(
                {
                    name: 'Live Stream Announcements',
                    value: streamer.announcement_channel_id
                        ? `<#${streamer.announcement_channel_id}>`
                        : 'Default channel',
                    inline: true
                },
                {
                    name: 'Live Role',
                    value: streamer.live_role_id
                        ? `<@&${streamer.live_role_id}>`
                        : 'Default role',
                    inline: true
                },
                {
                    name: 'Delete on End',
                    value: streamer.delete_on_end ? '\u2705 Enabled' : '\u274c Disabled',
                    inline: true
                }
            );

        if (platform === 'tiktok') {
            embed.addFields(
                {
                    name: 'Video Post Notifications',
                    value: streamer.notify_videos ? '\u2705 Enabled' : '\u274c Disabled',
                    inline: true
                },
                {
                    name: 'Video Announcement Channel',
                    value: streamer.video_announcement_channel_id
                        ? `<#${streamer.video_announcement_channel_id}>`
                        : 'Not set',
                    inline: true
                },
                { name: '\u200b', value: '\u200b', inline: true }
            );
        }

        if (streamer.custom_message) {
            embed.addFields({
                name: 'Custom Message',
                value: streamer.custom_message.substring(0, 1024),
                inline: false
            });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('edit_setting')
            .setPlaceholder('Select a setting to edit');

        const options = [
            {
                label: 'Live Announcement Channel',
                description: 'Set channel for live stream announcements',
                value: 'announcement_channel',
                emoji: '\ud83d\udce2'
            },
            {
                label: 'Custom Message',
                description: 'Set custom announcement message',
                value: 'custom_message',
                emoji: '\ud83d\udcac'
            },
            {
                label: 'Live Role',
                description: 'Set role to assign when live',
                value: 'live_role',
                emoji: '\ud83c\udfad'
            },
            {
                label: 'Delete on End',
                description: 'Toggle auto-delete announcements when stream ends',
                value: 'delete_on_end',
                emoji: '\ud83d\uddd1\ufe0f'
            }
        ];

        if (platform === 'tiktok') {
            options.push(
                {
                    label: 'Video Notifications',
                    description: 'Toggle TikTok video post notifications',
                    value: 'notify_videos',
                    emoji: '\ud83c\udfac'
                },
                {
                    label: 'Video Announcement Channel',
                    description: 'Set channel for TikTok video announcements',
                    value: 'video_announcement_channel',
                    emoji: '\ud83d\udcf9'
                }
            );
        }

        selectMenu.addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const response = await interaction.editReply({
            embeds: [embed],
            components: [row]
        });

        const collector = response.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 300000,
            filter: i => i.user.id === interaction.user.id
        });

        collector.on('collect', async (menuInteraction) => {
            const setting = menuInteraction.values[0];

            if (setting === 'announcement_channel') {
                await handleChannelSetting(menuInteraction, streamer, 'announcement_channel_id', 'Live Announcement Channel');
            } else if (setting === 'video_announcement_channel') {
                await handleChannelSetting(menuInteraction, streamer, 'video_announcement_channel_id', 'Video Announcement Channel');
            } else if (setting === 'custom_message') {
                await handleCustomMessage(menuInteraction, streamer);
            } else if (setting === 'live_role') {
                await handleRoleSetting(menuInteraction, streamer);
            } else if (setting === 'delete_on_end') {
                await handleToggleSetting(menuInteraction, streamer, 'delete_on_end', 'Delete on End');
            } else if (setting === 'notify_videos') {
                await handleToggleSetting(menuInteraction, streamer, 'notify_videos', 'Video Notifications');
            }
        });

        collector.on('end', () => {
            interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (error) {
        logger.error('[Streamer Edit] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred while loading streamer settings. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

async function handleChannelSetting(interaction, streamer, columnName, settingName) {
    const channels = interaction.guild.channels.cache.filter(
        c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
    );

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_channel')
        .setPlaceholder(`Select channel for ${settingName}`);

    const options = [
        {
            label: 'Use Default Channel',
            description: 'Use server default channel',
            value: 'default',
            emoji: '\u2699\ufe0f'
        }
    ];

    const channelArray = Array.from(channels.values()).slice(0, 24);
    channelArray.forEach(channel => {
        options.push({
            label: `#${channel.name}`,
            value: channel.id,
            emoji: '\ud83d\udcdd'
        });
    });

    selectMenu.addOptions(options);
    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.update({
        content: `Select a channel for **${settingName}**:`,
        components: [row],
        embeds: []
    });

    const response = await interaction.fetchReply();
    const channelCollector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: i => i.user.id === interaction.user.id
    });

    channelCollector.on('collect', async (selectInteraction) => {
        const channelId = selectInteraction.values[0] === 'default' ? null : selectInteraction.values[0];

        let connection;
        try {
            connection = await pool.getConnection();
            await connection.query(
                `UPDATE subscriptions SET ${columnName} = ? WHERE subscription_id = ?`,
                [channelId, streamer.subscription_id]
            );

            await selectInteraction.update({
                content: `\u2705 ${settingName} updated to ${channelId ? `<#${channelId}>` : 'default channel'}!`,
                components: [],
                embeds: []
            });

            logger.info(`[Streamer Edit] Updated ${columnName}`, {
                streamerId: streamer.streamer_id,
                setting: columnName,
                value: channelId,
                category: 'streams'
            });
        } catch (error) {
            logger.error('[Streamer Edit] Error updating channel:', { error, category: 'streams' });
            await selectInteraction.update({
                content: '\u274c Failed to update channel setting.',
                components: [],
                embeds: []
            });
        } finally {
            if (connection) connection.release();
        }
    });
}

async function handleCustomMessage(interaction, streamer) {
    const isTikTok = streamer.platform.toLowerCase() === 'tiktok';

    let helpText = '\ud83d\udcac Please type your custom message in chat.\n\n**Available variables:**\n';

    if (isTikTok) {
        helpText += '`{username}` - Streamer name\n`{description}` - Video caption/description\n`{title}` - Video title\n`{url}` - Video URL (will auto-embed)\n\n';
        helpText += '**Example for TikTok:**\n```\n{username} uploaded a new TikTok!\n\n{description}\n\n@everyone\n```\n';
    } else {
        helpText += '`{username}` - Streamer name\n`{url}` - Stream URL\n`{game}` - Game/category\n`{title}` - Stream title\n\n';
        helpText += '**Example for live streams:**\n```\nHey @everyone, {username} is live playing {game}!\n```\n';
    }

    helpText += '\nType `clear` to remove custom message, or `cancel` to abort.';

    await interaction.update({
        content: helpText,
        components: [],
        embeds: []
    });

    const filter = m => m.author.id === interaction.user.id;
    const collected = await interaction.channel.awaitMessages({
        filter,
        max: 1,
        time: 60000,
        errors: ['time']
    }).catch(() => null);

    if (!collected) {
        return await interaction.editReply({
            content: '\u23f1\ufe0f Timeout - custom message update cancelled.',
            components: []
        });
    }

    const message = collected.first();
    await message.delete().catch(() => {});

    if (message.content.toLowerCase() === 'cancel') {
        return await interaction.editReply({
            content: '\u274c Custom message update cancelled.',
            components: []
        });
    }

    const customMessage = message.content.toLowerCase() === 'clear' ? null : message.content;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.query(
            'UPDATE subscriptions SET custom_message = ? WHERE subscription_id = ?',
            [customMessage, streamer.subscription_id]
        );

        await interaction.editReply({
            content: customMessage
                ? `\u2705 Custom message updated!\n\n**Preview:** ${customMessage}`
                : '\u2705 Custom message cleared - using default.',
            components: []
        });

        logger.info('[Streamer Edit] Updated custom message', {
            streamerId: streamer.streamer_id,
            category: 'streams'
        });
    } catch (error) {
        logger.error('[Streamer Edit] Error updating custom message:', { error, category: 'streams' });
        await interaction.editReply({
            content: '\u274c Failed to update custom message.',
            components: []
        });
    } finally {
        if (connection) connection.release();
    }
}

async function handleRoleSetting(interaction, streamer) {
    const roles = interaction.guild.roles.cache.filter(r => !r.managed && r.name !== '@everyone');

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_role')
        .setPlaceholder('Select role to assign when live');

    const options = [
        {
            label: 'Use Default Role',
            description: 'Use server default live role',
            value: 'default',
            emoji: '\u2699\ufe0f'
        }
    ];

    const roleArray = Array.from(roles.values()).slice(0, 24);
    roleArray.forEach(role => {
        options.push({
            label: role.name,
            value: role.id,
            emoji: '\ud83c\udfad'
        });
    });

    selectMenu.addOptions(options);
    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.update({
        content: 'Select a role to assign when this streamer goes live:',
        components: [row],
        embeds: []
    });

    const response = await interaction.fetchReply();
    const roleCollector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: i => i.user.id === interaction.user.id
    });

    roleCollector.on('collect', async (selectInteraction) => {
        const roleId = selectInteraction.values[0] === 'default' ? null : selectInteraction.values[0];

        let connection;
        try {
            connection = await pool.getConnection();
            await connection.query(
                'UPDATE subscriptions SET live_role_id = ? WHERE subscription_id = ?',
                [roleId, streamer.subscription_id]
            );

            await selectInteraction.update({
                content: `\u2705 Live role updated to ${roleId ? `<@&${roleId}>` : 'default role'}!`,
                components: [],
                embeds: []
            });

            logger.info('[Streamer Edit] Updated live role', {
                streamerId: streamer.streamer_id,
                roleId,
                category: 'streams'
            });
        } catch (error) {
            logger.error('[Streamer Edit] Error updating role:', { error, category: 'streams' });
            await selectInteraction.update({
                content: '\u274c Failed to update role setting.',
                components: [],
                embeds: []
            });
        } finally {
            if (connection) connection.release();
        }
    });
}

async function handleToggleSetting(interaction, streamer, columnName, settingName) {
    const currentValue = streamer[columnName];
    const newValue = currentValue ? 0 : 1;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.query(
            `UPDATE subscriptions SET ${columnName} = ? WHERE subscription_id = ?`,
            [newValue, streamer.subscription_id]
        );

        await interaction.update({
            content: `\u2705 **${settingName}** is now ${newValue ? '**enabled** \u2705' : '**disabled** \u274c'}!`,
            components: [],
            embeds: []
        });

        logger.info(`[Streamer Edit] Toggled ${columnName}`, {
            streamerId: streamer.streamer_id,
            setting: columnName,
            value: newValue,
            category: 'streams'
        });
    } catch (error) {
        logger.error('[Streamer Edit] Error toggling setting:', { error, category: 'streams' });
        await interaction.update({
            content: `\u274c Failed to update ${settingName}.`,
            components: [],
            embeds: []
        });
    } finally {
        if (connection) connection.release();
    }
}

export async function handleMassAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const platform = interaction.options.getString('platform');
    const usernamesStr = interaction.options.getString('usernames');
    const usernames = [...new Set(usernamesStr.split(',').map(u => u.trim()).filter(u => u.length > 0))];

    if (usernames.length === 0) {
        return await interaction.editReply('Please provide at least one username.');
    }

    if (usernames.length > 50) {
        return await interaction.editReply('You can only add up to 50 streamers at once.');
    }

    const added = [];
    const failed = [];
    const skipped = [];

    let connection;
    try {
        connection = await pool.getConnection();

        for (const username of usernames) {
            try {
                const api = platformModules[platform];
                if (!api) {
                    failed.push(`${username} (platform not supported)`);
                    continue;
                }

                let platformUserId = null;
                let canonicalUsername = username;

                if (platform === 'twitch') {
                    const user = await twitchApi.getTwitchUser(username);
                    if (!user) {
                        failed.push(`${username} (not found)`);
                        continue;
                    }
                    platformUserId = user.id;
                    canonicalUsername = user.login;
                } else if (platform === 'kick') {
                    const user = await kickApi.getKickUser(username);
                    if (!user) {
                        failed.push(`${username} (not found)`);
                        continue;
                    }
                    platformUserId = String(user.id);
                    canonicalUsername = user.slug || username;
                } else {
                    platformUserId = username;
                }

                const [existingStreamer] = await connection.query(
                    'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
                    [platform, platformUserId]
                );

                let streamerId;
                if (existingStreamer.length > 0) {
                    streamerId = existingStreamer[0].streamer_id;
                } else {
                    const [result] = await connection.query(
                        'INSERT INTO streamers (platform, platform_user_id, username) VALUES (?, ?, ?)',
                        [platform, platformUserId, canonicalUsername]
                    );
                    streamerId = result.insertId;
                }

                const [existingSub] = await connection.query(
                    'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                    [interaction.guild.id, streamerId]
                );

                if (existingSub.length > 0) {
                    skipped.push(canonicalUsername);
                    continue;
                }

                await connection.query(
                    'INSERT INTO subscriptions (guild_id, streamer_id) VALUES (?, ?)',
                    [interaction.guild.id, streamerId]
                );

                added.push(canonicalUsername);

            } catch (error) {
                logger.error(`[Streamer Mass Add] Error adding ${username}:`, { error, category: 'streams' });
                failed.push(`${username} (error)`);
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Mass Add Report')
            .setTimestamp();

        if (added.length > 0) {
            embed.addFields({
                name: `\u2705 Added (${added.length})`,
                value: added.join(', ').substring(0, 1024),
                inline: false
            });
        }

        if (skipped.length > 0) {
            embed.addFields({
                name: `\u23ed\ufe0f Skipped - Already Tracked (${skipped.length})`,
                value: skipped.join(', ').substring(0, 1024),
                inline: false
            });
        }

        if (failed.length > 0) {
            embed.addFields({
                name: `\u274c Failed (${failed.length})`,
                value: failed.join(', ').substring(0, 1024),
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Streamer Mass Add] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred during mass add. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

export async function handleMassRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const platform = interaction.options.getString('platform');
    const usernamesStr = interaction.options.getString('usernames');
    const usernames = [...new Set(usernamesStr.split(',').map(u => u.trim().toLowerCase()).filter(u => u.length > 0))];

    if (usernames.length === 0) {
        return await interaction.editReply('Please provide at least one username.');
    }

    const removed = [];
    const notFound = [];

    let connection;
    try {
        connection = await pool.getConnection();

        for (const username of usernames) {
            try {
                const [streamers] = await connection.query(
                    'SELECT streamer_id, username FROM streamers WHERE platform = ? AND LOWER(username) = ?',
                    [platform, username]
                );

                if (streamers.length === 0) {
                    notFound.push(username);
                    continue;
                }

                const streamerId = streamers[0].streamer_id;

                const [result] = await connection.query(
                    'DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                    [interaction.guild.id, streamerId]
                );

                if (result.affectedRows > 0) {
                    await connection.query(
                        'DELETE FROM live_announcements WHERE guild_id = ? AND streamer_id = ?',
                        [interaction.guild.id, streamerId]
                    );
                    removed.push(streamers[0].username);
                } else {
                    notFound.push(username);
                }

            } catch (error) {
                logger.error(`[Streamer Mass Remove] Error removing ${username}:`, { error, category: 'streams' });
                notFound.push(`${username} (error)`);
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('Mass Remove Report')
            .setTimestamp();

        if (removed.length > 0) {
            embed.addFields({
                name: `\u2705 Removed (${removed.length})`,
                value: removed.join(', ').substring(0, 1024),
                inline: false
            });
        }

        if (notFound.length > 0) {
            embed.addFields({
                name: `\u274c Not Found (${notFound.length})`,
                value: notFound.join(', ').substring(0, 1024),
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Streamer Mass Remove] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred during mass remove. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}

export async function handleClear(interaction) {
    const platform = interaction.options.getString('platform');

    const confirmButton = new ButtonBuilder()
        .setCustomId('confirm_clear')
        .setLabel('Yes, Clear All')
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('cancel_clear')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder()
        .addComponents(confirmButton, cancelButton);

    const warningMsg = platform
        ? `Are you sure you want to remove ALL **${platform}** streamers from this server? This cannot be undone!`
        : 'Are you sure you want to remove ALL tracked streamers from this server? This cannot be undone!';

    const response = await interaction.reply({
        content: warningMsg,
        components: [row],
        ephemeral: true,
        fetchReply: true
    });

    const collectorFilter = i => i.user.id === interaction.user.id;

    try {
        const confirmation = await response.awaitMessageComponent({
            filter: collectorFilter,
            time: 60000,
            componentType: ComponentType.Button
        });

        if (confirmation.customId === 'confirm_clear') {
            await confirmation.deferUpdate();

            let connection;
            try {
                connection = await pool.getConnection();

                let query = 'DELETE sub FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ?';
                const params = [interaction.guild.id];

                if (platform) {
                    query += ' AND s.platform = ?';
                    params.push(platform);
                }

                const [result] = await connection.query(query, params);

                let announceQuery = 'DELETE la FROM live_announcements la JOIN streamers s ON la.streamer_id = s.streamer_id WHERE la.guild_id = ?';
                const announceParams = [interaction.guild.id];

                if (platform) {
                    announceQuery += ' AND s.platform = ?';
                    announceParams.push(platform);
                }

                await connection.query(announceQuery, announceParams);

                const msg = platform
                    ? `Successfully removed ${result.affectedRows} **${platform}** streamer subscriptions.`
                    : `Successfully removed ${result.affectedRows} streamer subscriptions.`;

                await interaction.editReply({
                    content: msg,
                    components: []
                });

            } catch (error) {
                logger.error('[Streamer Clear] Error:', { error, category: 'streams' });
                await interaction.editReply({
                    content: 'An error occurred while clearing streamers.',
                    components: []
                });
            } finally {
                if (connection) connection.release();
            }

        } else {
            await confirmation.update({
                content: 'Clear operation cancelled.',
                components: []
            });
        }

    } catch (error) {
        await interaction.editReply({
            content: 'Confirmation timeout - clear operation cancelled.',
            components: []
        });
    }
}

export async function handleImport(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const file = interaction.options.getAttachment('file');

    if (!file.name.endsWith('.csv')) {
        return await interaction.editReply('Please provide a CSV file.');
    }

    try {
        const response = await fetch(file.url);
        const csvText = await response.text();

        const lines = csvText.split('\n').filter(line => line.trim().length > 0);
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

        if (!headers.includes('platform') || !headers.includes('username')) {
            return await interaction.editReply('CSV must contain "platform" and "username" columns.');
        }

        const platformIdx = headers.indexOf('platform');
        const usernameIdx = headers.indexOf('username');
        const discordUserIdx = headers.indexOf('discord_user_id');

        const added = [];
        const failed = [];
        const skipped = [];

        let connection;
        try {
            connection = await pool.getConnection();

            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',').map(v => v.trim());
                const platform = values[platformIdx];
                const username = values[usernameIdx];
                const discordUserId = discordUserIdx >= 0 ? values[discordUserIdx] : null;

                if (!platform || !username) {
                    failed.push(`Row ${i + 1} (missing data)`);
                    continue;
                }

                try {
                    const api = platformModules[platform];
                    if (!api) {
                        failed.push(`${username} (platform not supported)`);
                        continue;
                    }

                    let platformUserId = username;
                    let canonicalUsername = username;

                    if (platform === 'twitch') {
                        const user = await twitchApi.getTwitchUser(username);
                        if (user) {
                            platformUserId = user.id;
                            canonicalUsername = user.login;
                        }
                    } else if (platform === 'kick') {
                        const user = await kickApi.getKickUser(username);
                        if (user) {
                            platformUserId = String(user.id);
                            canonicalUsername = user.slug || username;
                        }
                    }

                    const [existingStreamer] = await connection.query(
                        'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
                        [platform, platformUserId]
                    );

                    let streamerId;
                    if (existingStreamer.length > 0) {
                        streamerId = existingStreamer[0].streamer_id;
                    } else {
                        const [result] = await connection.query(
                            'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)',
                            [platform, platformUserId, canonicalUsername, discordUserId]
                        );
                        streamerId = result.insertId;
                    }

                    const [existingSub] = await connection.query(
                        'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                        [interaction.guild.id, streamerId]
                    );

                    if (existingSub.length > 0) {
                        skipped.push(canonicalUsername);
                        continue;
                    }

                    await connection.query(
                        'INSERT INTO subscriptions (guild_id, streamer_id) VALUES (?, ?)',
                        [interaction.guild.id, streamerId]
                    );

                    added.push(canonicalUsername);

                } catch (error) {
                    logger.error(`[Streamer Import] Error importing ${username}:`, { error, category: 'streams' });
                    failed.push(`${username} (error)`);
                }
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('CSV Import Report')
                .setTimestamp();

            if (added.length > 0) {
                embed.addFields({
                    name: `\u2705 Added (${added.length})`,
                    value: added.join(', ').substring(0, 1024),
                    inline: false
                });
            }

            if (skipped.length > 0) {
                embed.addFields({
                    name: `\u23ed\ufe0f Skipped (${skipped.length})`,
                    value: skipped.join(', ').substring(0, 1024),
                    inline: false
                });
            }

            if (failed.length > 0) {
                embed.addFields({
                    name: `\u274c Failed (${failed.length})`,
                    value: failed.join(', ').substring(0, 1024),
                    inline: false
                });
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error('[Streamer Import] Error:', { error, category: 'streams' });
            await interaction.editReply('An error occurred during import. Please try again.');
        } finally {
            if (connection) connection.release();
        }

    } catch (error) {
        logger.error('[Streamer Import] Error fetching CSV:', { error, category: 'streams' });
        await interaction.editReply('Failed to read CSV file. Please try again.');
    }
}

export async function handleExport(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const platform = interaction.options.getString('platform');

    let connection;
    try {
        connection = await pool.getConnection();

        let query = `
            SELECT s.platform, s.username, s.discord_user_id
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE sub.guild_id = ?
        `;
        const params = [interaction.guild.id];

        if (platform) {
            query += ' AND s.platform = ?';
            params.push(platform);
        }

        query += ' ORDER BY s.platform, s.username';

        const [streamers] = await connection.query(query, params);

        if (streamers.length === 0) {
            return await interaction.editReply('No streamers to export.');
        }

        const csv = ['platform,username,discord_user_id'];
        for (const streamer of streamers) {
            csv.push(`${streamer.platform},${streamer.username},${streamer.discord_user_id || ''}`);
        }

        const csvContent = csv.join('\n');
        const buffer = Buffer.from(csvContent, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, {
            name: `streamers_${interaction.guild.id}_${Date.now()}.csv`
        });

        await interaction.editReply({
            content: `Exported ${streamers.length} streamer(s) to CSV.`,
            files: [attachment]
        });

    } catch (error) {
        logger.error('[Streamer Export] Error:', { error, category: 'streams' });
        await interaction.editReply('An error occurred while exporting. Please try again.');
    } finally {
        if (connection) connection.release();
    }
}
