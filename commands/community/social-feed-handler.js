import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

// ── Reddit handlers ──

export async function handleRedditAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subreddit = interaction.options.getString('subreddit').replace(/^r\//, '');
    const channel = interaction.options.getChannel('channel');

    try {
        const [existing] = await pool.execute(
            'SELECT * FROM reddit_feeds WHERE guild_id = ? AND subreddit = ?',
            [interaction.guild.id, subreddit]
        );

        if (existing.length > 0) {
            return await interaction.editReply(`\u274c Already subscribed to r/${subreddit}`);
        }

        await pool.execute(
            'INSERT INTO reddit_feeds (guild_id, channel_id, subreddit) VALUES (?, ?, ?)',
            [interaction.guild.id, channel.id, subreddit]
        );

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('\u2705 Reddit Feed Added')
            .setDescription(`Successfully subscribed to **r/${subreddit}**`)
            .addFields(
                { name: 'Subreddit', value: `r/${subreddit}`, inline: true },
                { name: 'Channel', value: `<#${channel.id}>`, inline: true }
            )
            .setFooter({ text: 'New posts will be checked every 15 minutes' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        logger.info(`[Feeds] Reddit feed added: r/${subreddit} -> #${channel.name}`, { guild: interaction.guild.name });
    } catch (error) {
        logger.error('[Feeds] Failed to add Reddit feed', { error: error.message, subreddit });
        await interaction.editReply('\u274c Failed to add Reddit feed. Please try again.');
    }
}

export async function handleRedditRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subreddit = interaction.options.getString('subreddit').replace(/^r\//, '');

    try {
        const [result] = await pool.execute(
            'DELETE FROM reddit_feeds WHERE guild_id = ? AND subreddit = ?',
            [interaction.guild.id, subreddit]
        );

        if (result.affectedRows === 0) {
            return await interaction.editReply(`\u274c Not subscribed to r/${subreddit}`);
        }

        const embed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('\ud83d\uddd1\ufe0f Reddit Feed Removed')
            .setDescription(`Successfully unsubscribed from **r/${subreddit}**`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        logger.info(`[Feeds] Reddit feed removed: r/${subreddit}`, { guild: interaction.guild.name });
    } catch (error) {
        logger.error('[Feeds] Failed to remove Reddit feed', { error: error.message, subreddit });
        await interaction.editReply('\u274c Failed to remove Reddit feed. Please try again.');
    }
}

export async function handleRedditList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const [feeds] = await pool.execute(
            'SELECT * FROM reddit_feeds WHERE guild_id = ?',
            [interaction.guild.id]
        );

        if (feeds.length === 0) {
            return await interaction.editReply('No Reddit feeds configured for this server.');
        }

        const embed = new EmbedBuilder()
            .setColor('#FF4500')
            .setTitle('\ud83d\udccb Reddit Feed Subscriptions')
            .setDescription(`Currently monitoring ${feeds.length} subreddit(s)`)
            .setTimestamp();

        for (const feed of feeds) {
            embed.addFields({
                name: `r/${feed.subreddit}`,
                value: `Channel: <#${feed.channel_id}>\nLast Post: ${feed.last_post_id || 'None'}`,
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Feeds] Failed to list Reddit feeds', { error: error.message });
        await interaction.editReply('\u274c Failed to list Reddit feeds. Please try again.');
    }
}

// ── YouTube handlers ──

export async function handleYoutubeAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const channelId = interaction.options.getString('channel-id');
    const channel = interaction.options.getChannel('channel');

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
            .setColor('#57F287')
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

    try {
        const [result] = await pool.execute(
            'DELETE FROM youtube_feeds WHERE guild_id = ? AND youtube_channel_id = ?',
            [interaction.guild.id, channelId]
        );

        if (result.affectedRows === 0) {
            return await interaction.editReply('\u274c Not subscribed to this YouTube channel');
        }

        const embed = new EmbedBuilder()
            .setColor('#ED4245')
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
            .setColor('#FF0000')
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
