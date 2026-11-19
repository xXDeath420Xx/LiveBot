import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { resolveYouTubeChannelId } from '../../utils/platforms/youtube-resolve.js';

// The Reddit handlers were removed with the Reddit subcommands (H-650; Reddit closed its API to new apps).

// ── YouTube handlers ──

export async function handleYoutubeAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const typed = interaction.options.getString('channel-id');
    const channel = interaction.options.getChannel('channel');

    // A link, @handle or name becomes the UC… id the checker polls (H-669: it used to be saved as typed).
    let channelId;
    try {
        ({ channelId } = await resolveYouTubeChannelId(typed));
    } catch (resolveErr) {
        return await interaction.editReply(`❌ ${resolveErr.message}`);
    }

    try {
        const [existing] = await pool.execute(
            'SELECT * FROM youtube_feeds WHERE guild_id = ? AND youtube_channel_id = ?',
            [interaction.guild.id, channelId]
        );

        if (existing.length > 0) {
            return await interaction.editReply('\u274c Already subscribed to this YouTube channel');
        }

        await pool.execute(
            'INSERT INTO youtube_feeds (guild_id, discord_channel_id, youtube_channel_id) VALUES (?, ?, ?)',
            [interaction.guild.id, channel.id, channelId]
        );

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('\u2705 YouTube Feed Added')
            .setDescription('Successfully subscribed to YouTube channel')
            .addFields(
                { name: 'Channel ID', value: channelId, inline: false },
                { name: 'Discord Channel', value: `<#${channel.id}>`, inline: true }
            )
            .setFooter({ text: 'New videos will be checked every 15 minutes' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        logger.info(`[Feeds] YouTube feed added: ${channelId} -> #${channel.name}`, { guild: interaction.guild.name });
    } catch (error) {
        logger.error('[Feeds] Failed to add YouTube feed', { error: error.message, channelId });
        await interaction.editReply('\u274c Failed to add YouTube feed. Please try again.');
    }
}

export async function handleYoutubeRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const channelId = interaction.options.getString('channel-id');
    // Feeds are stored by UC… id; a link or @handle is looked up, and the text as typed still matches old rows.
    let resolvedId = null;
    try { ({ channelId: resolvedId } = await resolveYouTubeChannelId(channelId)); } catch { /* match the text as typed */ }

    try {
        const [result] = await pool.execute(
            'DELETE FROM youtube_feeds WHERE guild_id = ? AND youtube_channel_id IN (?, ?)',
            [interaction.guild.id, channelId, resolvedId || channelId]
        );

        if (result.affectedRows === 0) {
            return await interaction.editReply('\u274c Not subscribed to this YouTube channel');
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('\ud83d\uddd1\ufe0f YouTube Feed Removed')
            .setDescription('Successfully unsubscribed from YouTube channel')
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        logger.info(`[Feeds] YouTube feed removed: ${channelId}`, { guild: interaction.guild.name });
    } catch (error) {
        logger.error('[Feeds] Failed to remove YouTube feed', { error: error.message, channelId });
        await interaction.editReply('\u274c Failed to remove YouTube feed. Please try again.');
    }
}

export async function handleYoutubeList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const [feeds] = await pool.execute(
            'SELECT * FROM youtube_feeds WHERE guild_id = ?',
            [interaction.guild.id]
        );

        if (feeds.length === 0) {
            return await interaction.editReply('No YouTube feeds configured for this server.');
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('\ud83d\udccb YouTube Feed Subscriptions')
            .setDescription(`Currently monitoring ${feeds.length} YouTube channel(s)`)
            .setTimestamp();

        for (const feed of feeds) {
            embed.addFields({
                name: feed.channel_name || feed.youtube_channel_id,
                value: `Channel: <#${feed.discord_channel_id}>\nChannel ID: ${feed.youtube_channel_id}\nLast Video: ${feed.last_video_id || 'None'}`,
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Feeds] Failed to list YouTube feeds', { error: error.message });
        await interaction.editReply('\u274c Failed to list YouTube feeds. Please try again.');
    }
}
