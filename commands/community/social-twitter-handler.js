import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { validateUser, getUserTweets, getUserProfile } from '../../utils/platforms/twitter-api.js';
import { addTwitterFeed, removeTwitterFeed, getTwitterFeeds, updateTwitterFeed } from '../../core/twitter-feed.js';
import logger from '../../utils/logger.js';

function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

export async function handleTwitterAdd(interaction) {
    await interaction.deferReply();

    const username = interaction.options.getString('username').replace(/^@/, '').toLowerCase();
    const channel = interaction.options.getChannel('channel');
    const filterRetweets = interaction.options.getBoolean('filter_retweets') ?? true;
    const filterReplies = interaction.options.getBoolean('filter_replies') ?? true;
    const mediaOnly = interaction.options.getBoolean('media_only') ?? false;
    const customMessage = interaction.options.getString('custom_message');

    try {
        const validation = await validateUser(username);
        if (!validation.valid) {
            return interaction.editReply({
                content: `Could not find Twitter user **@${username}**. Make sure the username is correct.`,
                ephemeral: true
            });
        }

        await addTwitterFeed(interaction.guildId, channel.id, username, {
            filterRetweets, filterReplies, mediaOnly, includeImages: true, customMessage
        });

        const embed = new EmbedBuilder()
            .setColor('#1DA1F2')
            .setTitle('Twitter Feed Added')
            .setDescription(`Now tracking **@${username}**`)
            .addFields(
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Filter Retweets', value: filterRetweets ? 'Yes' : 'No', inline: true },
                { name: 'Filter Replies', value: filterReplies ? 'Yes' : 'No', inline: true },
                { name: 'Media Only', value: mediaOnly ? 'Yes' : 'No', inline: true }
            )
            .setFooter({ text: 'Tweets will be checked every 5 minutes' })
            .setTimestamp();

        if (customMessage) {
            embed.addFields({ name: 'Custom Message', value: customMessage, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Twitter] Add error:', error);
        if (error.message.includes('Already tracking')) {
            return interaction.editReply({
                content: `Already tracking **@${username}** in this server. Use \`/social twitter edit\` to change settings.`
            });
        }
        await interaction.editReply({ content: `Failed to add Twitter feed: ${error.message}` });
    }
}

export async function handleTwitterRemove(interaction) {
    await interaction.deferReply();

    const username = interaction.options.getString('username').replace(/^@/, '').toLowerCase();

    try {
        const removed = await removeTwitterFeed(interaction.guildId, username);
        if (!removed) {
            return interaction.editReply({ content: `Not tracking **@${username}** in this server.` });
        }

        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Twitter Feed Removed')
            .setDescription(`Stopped tracking **@${username}**`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Twitter] Remove error:', error);
        await interaction.editReply({ content: `Failed to remove Twitter feed: ${error.message}` });
    }
}

export async function handleTwitterList(interaction) {
    await interaction.deferReply();

    try {
        const feeds = await getTwitterFeeds(interaction.guildId);
        if (feeds.length === 0) {
            return interaction.editReply({
                content: 'No Twitter feeds configured for this server. Use `/social twitter add` to start tracking users.'
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#1DA1F2')
            .setTitle('Twitter Feeds')
            .setDescription(`Tracking **${feeds.length}** Twitter user(s)`)
            .setTimestamp();

        for (const feed of feeds.slice(0, 25)) {
            const filters = [];
            if (feed.filter_retweets) filters.push('No RTs');
            if (feed.filter_replies) filters.push('No Replies');
            if (feed.filter_media_only) filters.push('Media Only');

            embed.addFields({
                name: `@${feed.twitter_username}`,
                value: `Channel: <#${feed.channel_id}>\nFilters: ${filters.length > 0 ? filters.join(', ') : 'None'}`,
                inline: true
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Twitter] List error:', error);
        await interaction.editReply({ content: `Failed to list Twitter feeds: ${error.message}` });
    }
}

export async function handleTwitterEdit(interaction) {
    await interaction.deferReply();

    const username = interaction.options.getString('username').replace(/^@/, '').toLowerCase();
    const channel = interaction.options.getChannel('channel');
    const filterRetweets = interaction.options.getBoolean('filter_retweets');
    const filterReplies = interaction.options.getBoolean('filter_replies');
    const mediaOnly = interaction.options.getBoolean('media_only');
    const includeImages = interaction.options.getBoolean('include_images');
    let customMessage = interaction.options.getString('custom_message');

    if (customMessage?.toLowerCase() === 'none') customMessage = null;

    try {
        const options = {};
        if (channel) options.channelId = channel.id;
        if (filterRetweets !== null) options.filterRetweets = filterRetweets;
        if (filterReplies !== null) options.filterReplies = filterReplies;
        if (mediaOnly !== null) options.mediaOnly = mediaOnly;
        if (includeImages !== null) options.includeImages = includeImages;
        if (customMessage !== undefined) options.customMessage = customMessage;

        const updated = await updateTwitterFeed(interaction.guildId, username, options);
        if (!updated) {
            return interaction.editReply({ content: `Not tracking **@${username}** in this server.` });
        }

        const embed = new EmbedBuilder()
            .setColor('#1DA1F2')
            .setTitle('Twitter Feed Updated')
            .setDescription(`Updated settings for **@${username}**`)
            .setTimestamp();

        const changes = [];
        if (channel) changes.push(`Channel: <#${channel.id}>`);
        if (filterRetweets !== null) changes.push(`Filter Retweets: ${filterRetweets ? 'Yes' : 'No'}`);
        if (filterReplies !== null) changes.push(`Filter Replies: ${filterReplies ? 'Yes' : 'No'}`);
        if (mediaOnly !== null) changes.push(`Media Only: ${mediaOnly ? 'Yes' : 'No'}`);
        if (includeImages !== null) changes.push(`Include Images: ${includeImages ? 'Yes' : 'No'}`);
        if (customMessage !== undefined) changes.push(`Custom Message: ${customMessage || 'Cleared'}`);

        embed.addFields({ name: 'Changes', value: changes.join('\n'), inline: false });
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Twitter] Edit error:', error);
        await interaction.editReply({ content: `Failed to update Twitter feed: ${error.message}` });
    }
}

export async function handleTwitterTest(interaction) {
    await interaction.deferReply();

    const username = interaction.options.getString('username').replace(/^@/, '').toLowerCase();

    try {
        const tweets = await getUserTweets(username, 1);
        if (!tweets || tweets.length === 0) {
            return interaction.editReply({
                content: `Could not fetch tweets for **@${username}**. The user may not exist or has no recent tweets.`
            });
        }

        const tweet = tweets[0];
        const profile = await getUserProfile(username);

        const embed = new EmbedBuilder()
            .setColor('#1DA1F2')
            .setAuthor({
                name: `${tweet.author?.name || username} (@${tweet.author?.username || username})`,
                iconURL: profile?.avatar || tweet.author?.avatar || 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png',
                url: `https://twitter.com/${username}`
            })
            .setDescription(tweet.text?.substring(0, 4096) || 'No text')
            .setTimestamp(new Date(tweet.created_at));

        if (tweet.media && tweet.media.length > 0) {
            const image = tweet.media.find(m => m.type === 'image' || m.type === 'photo');
            if (image) embed.setImage(image.url);
        }

        if (tweet.metrics) {
            const metricsText = [];
            if (tweet.metrics.likes > 0) metricsText.push(`${formatNumber(tweet.metrics.likes)} Likes`);
            if (tweet.metrics.retweets > 0) metricsText.push(`${formatNumber(tweet.metrics.retweets)} RTs`);
            if (tweet.metrics.replies > 0) metricsText.push(`${formatNumber(tweet.metrics.replies)} Replies`);
            if (metricsText.length > 0) embed.setFooter({ text: metricsText.join(' | ') });
        }

        const tweetUrl = tweet.url || `https://twitter.com/${username}/status/${tweet.id}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('View on Twitter').setStyle(ButtonStyle.Link).setURL(tweetUrl)
        );

        await interaction.editReply({ content: '**Preview of latest tweet:**', embeds: [embed], components: [row] });
    } catch (error) {
        logger.error('[Twitter] Test error:', error);
        await interaction.editReply({ content: `Failed to fetch tweets: ${error.message}` });
    }
}

export async function handleTwitterLookup(interaction) {
    await interaction.deferReply();

    const username = interaction.options.getString('username').replace(/^@/, '').toLowerCase();

    try {
        const validation = await validateUser(username);
        if (!validation.valid) {
            return interaction.editReply({ content: `Could not find Twitter user **@${username}**.` });
        }

        const profile = await getUserProfile(username);
        const tweets = await getUserTweets(username, 5);

        const embed = new EmbedBuilder()
            .setColor('#1DA1F2')
            .setTitle(`@${username}`)
            .setURL(`https://twitter.com/${username}`)
            .setThumbnail(profile?.avatar || 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png');

        if (profile?.name) embed.setAuthor({ name: profile.name });

        if (profile) {
            const fields = [];
            if (profile.followers) fields.push({ name: 'Followers', value: formatNumber(profile.followers), inline: true });
            if (profile.following) fields.push({ name: 'Following', value: formatNumber(profile.following), inline: true });
            if (fields.length > 0) embed.addFields(fields);
        }

        if (tweets && tweets.length > 0) {
            const totalLikes = tweets.reduce((sum, t) => sum + (t.metrics?.likes || 0), 0);
            const totalRTs = tweets.reduce((sum, t) => sum + (t.metrics?.retweets || 0), 0);
            embed.addFields(
                { name: 'Recent Activity', value: `Last ${tweets.length} tweets`, inline: false },
                { name: 'Total Likes', value: formatNumber(totalLikes), inline: true },
                { name: 'Total RTs', value: formatNumber(totalRTs), inline: true }
            );
            const latest = tweets[0];
            const latestPreview = latest.text?.substring(0, 100) + (latest.text?.length > 100 ? '...' : '');
            embed.addFields({ name: 'Latest Tweet', value: latestPreview || 'No text', inline: false });
        }

        const feeds = await getTwitterFeeds(interaction.guildId);
        const isTracked = feeds.some(f => f.twitter_username.toLowerCase() === username);
        embed.setFooter({ text: isTracked ? 'This user is being tracked in this server' : 'Use /social twitter add to track this user' });
        embed.setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('View on Twitter').setStyle(ButtonStyle.Link).setURL(`https://twitter.com/${username}`)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (error) {
        logger.error('[Twitter] Lookup error:', error);
        await interaction.editReply({ content: `Failed to look up user: ${error.message}` });
    }
}

export async function handleTwitterAutocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'username') {
        try {
            const feeds = await getTwitterFeeds(interaction.guildId);
            const choices = feeds
                .map(f => f.twitter_username)
                .filter(u => u.toLowerCase().includes(focusedOption.value.toLowerCase()))
                .slice(0, 25);
            await interaction.respond(choices.map(username => ({ name: `@${username}`, value: username })));
        } catch (error) {
            await interaction.respond([]);
        }
    }
}
